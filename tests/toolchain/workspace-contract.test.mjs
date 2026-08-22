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

/** Every source file under the given roots, skipping generated and vendored trees. */
const sourceFiles = (roots) => {
  const SKIP = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', '.next', 'migrations'])
  const out = []
  const walk = (absolute, relative) => {
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const childAbsolute = join(absolute, entry.name)
      const childRelative = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(childAbsolute, childRelative)
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(childRelative)
    }
  }
  for (const root of roots) walk(join(ROOT, root), root)
  return out
}

describe('naming conventions', () => {
  test('every source filename is kebab-case', () => {
    // SPEC.md §6 Naming: "Files kebab-case." Enforced here rather than through a lint plugin,
    // because that would mean adding a dependency for one rule and SPEC.md §8 puts dependency
    // additions under Ask first.
    //
    // The stem is everything before the first dot, so compound extensions that carry meaning —
    // guideline-gate.spec.ts, eslint.config.js, campaign-config.module.ts — are checked on the
    // part that names the file, not on the suffixes.
    const offenders = sourceFiles(['apps', 'packages', 'tools', 'tests'])
      .filter((path) => {
        const basename = path.slice(path.lastIndexOf('/') + 1)
        // Throwaway test fixtures are generated, not authored, and are gitignored.
        if (basename.startsWith('__')) return false
        const stem = basename.slice(0, basename.indexOf('.'))
        return !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem)
      })
      .sort()

    assert.deepEqual(offenders, [], `these filenames are not kebab-case:\n  ${offenders.join('\n  ')}`)
  })
})

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
