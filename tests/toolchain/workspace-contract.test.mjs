// Toolchain contract for T1.
//
// These assertions lock the strictness settings SPEC.md §2 requires. They are the
// kind of thing that regresses silently during a config edit, so they are checked
// by the build rather than by review.
//
// Runs on node:test because the Vitest harness does not exist until T7; this file
// moves into the unit tier then.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = dirname(dirname(import.meta.dirname))

const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))

/** Minimal reader for the flat `packages:` list in pnpm-workspace.yaml — avoids a YAML dependency. */
const readWorkspaceGlobs = () =>
  readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n')
    .map((line) => line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/)?.[1])
    .filter((glob) => glob !== undefined)

/** Every directory matched by an `apps/*` or `packages/*` style glob. */
const workspaceDirs = () =>
  readWorkspaceGlobs()
    .filter((glob) => glob.endsWith('/*'))
    .map((glob) => glob.slice(0, -2))
    .filter((parent) => existsSync(join(ROOT, parent)))
    .flatMap((parent) =>
      readdirSync(join(ROOT, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`),
    )

describe('workspace resolution', () => {
  test('pnpm-workspace.yaml declares the apps and packages globs', () => {
    const globs = readWorkspaceGlobs()
    assert.ok(globs.includes('apps/*'), `expected apps/* in workspace globs, got ${globs.join(', ')}`)
    assert.ok(globs.includes('packages/*'), `expected packages/* in workspace globs, got ${globs.join(', ')}`)
  })

  test('both globs resolve to at least one real workspace', () => {
    const dirs = workspaceDirs()
    assert.ok(
      dirs.some((dir) => dir.startsWith('apps/')),
      'apps/* resolved to no workspace',
    )
    assert.ok(
      dirs.some((dir) => dir.startsWith('packages/')),
      'packages/* resolved to no workspace',
    )
  })

  test('every workspace has a package.json and a tsconfig.json', () => {
    for (const dir of workspaceDirs()) {
      assert.ok(existsSync(join(ROOT, dir, 'package.json')), `${dir} is missing package.json`)
      assert.ok(existsSync(join(ROOT, dir, 'tsconfig.json')), `${dir} is missing tsconfig.json`)
    }
  })
})

describe('root manifest', () => {
  test('is private, so the monorepo root can never be published', () => {
    assert.equal(readJson('package.json').private, true)
  })

  test('pins the package manager and a Node floor', () => {
    const pkg = readJson('package.json')
    assert.match(pkg.packageManager ?? '', /^pnpm@\d+\.\d+\.\d+/, 'packageManager must pin an exact pnpm version')
    assert.ok(pkg.engines?.node, 'engines.node must declare a supported Node range')
  })

  test('exposes the typecheck and build commands SPEC.md §4 requires', () => {
    const { scripts = {} } = readJson('package.json')
    for (const script of ['build', 'typecheck']) {
      assert.ok(scripts[script], `package.json is missing the "${script}" script`)
    }
  })
})

describe('compiler contract', () => {
  // SPEC.md §2: "TypeScript 5.x, strict mode, noUncheckedIndexedAccess".
  // exactOptionalPropertyTypes matters here specifically because the §14.2 state
  // dimensions distinguish an absent field from one explicitly set to undefined.
  const REQUIRED_STRICTNESS = ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']

  test('tsconfig.base.json enables every required strictness flag', () => {
    const { compilerOptions } = readJson('tsconfig.base.json')
    for (const flag of REQUIRED_STRICTNESS) {
      assert.equal(compilerOptions[flag], true, `tsconfig.base.json must set "${flag}": true`)
    }
  })

  test('tsconfig.base.json forbids implicit fallthrough and missing returns', () => {
    const { compilerOptions } = readJson('tsconfig.base.json')
    // The §16.9 guideline gate switches exhaustively on campaign type; a fallthrough
    // there would mean a workflow silently reaching "ready".
    assert.equal(compilerOptions.noFallthroughCasesInSwitch, true)
    assert.equal(compilerOptions.noImplicitReturns, true)
  })

  test('every workspace inherits the base config rather than redefining strictness', () => {
    for (const dir of workspaceDirs()) {
      const tsconfig = readJson(join(dir, 'tsconfig.json'))
      assert.match(
        tsconfig.extends ?? '',
        /tsconfig\.base\.json$/,
        `${dir}/tsconfig.json must extend tsconfig.base.json`,
      )
      for (const flag of REQUIRED_STRICTNESS) {
        assert.equal(
          tsconfig.compilerOptions?.[flag],
          undefined,
          `${dir}/tsconfig.json overrides "${flag}"; strictness belongs only in the base config`,
        )
      }
    }
  })
})
