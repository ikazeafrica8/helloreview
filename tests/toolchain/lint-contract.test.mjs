// Lint and format contract for T2.
//
// The config-shape assertions below are cheap but weak — they prove a rule is written down, not
// that it fires. The two behavioural tests at the bottom are the real proof: they run ESLint
// against a real fixture and against the real tree.
//
// Runs on node:test because the Vitest harness does not exist until T7.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))

const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
const readText = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8')

/** Run the locally installed ESLint. Returns the result rather than throwing on a non-zero exit. */
const runEslint = (...args) =>
  spawnSync(process.execPath, [join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // A cold type-aware run has to build the TypeScript program first.
    timeout: 180_000,
  })

describe('lint and format toolchain', () => {
  test('eslint.config.js exists as an ESM flat config', () => {
    assert.ok(existsSync(join(ROOT, 'eslint.config.js')), 'eslint.config.js is missing')
    const source = readText('eslint.config.js')
    assert.match(source, /export default/, 'flat config must have a default export')
    // .eslintignore is inert in ESLint 10 — ignores belong in the config itself.
    assert.ok(!existsSync(join(ROOT, '.eslintignore')), '.eslintignore is inert; use globalIgnores')
  })

  test('a root tsconfig covers the files no workspace owns', () => {
    // Under projectService, a .ts file that no tsconfig includes is a hard parsing error rather
    // than a skipped file. tests/, tools/ and root config files belong to no workspace, so
    // without this T7 and T9 would each break the lint run when they add files.
    assert.ok(existsSync(join(ROOT, 'tsconfig.json')), 'root tsconfig.json is missing')
    const tsconfig = readJson('tsconfig.json')
    const include = (tsconfig.include ?? []).join(' ')
    for (const fragment of ['tests', 'tools']) {
      assert.match(include, new RegExp(fragment), `root tsconfig must include ${fragment}`)
    }
  })

  test('the toolchain dependencies are declared at the root', () => {
    const { devDependencies = {} } = readJson('package.json')
    for (const dep of ['eslint', '@eslint/js', 'typescript-eslint', 'prettier', 'eslint-config-prettier', 'globals']) {
      assert.ok(devDependencies[dep], `package.json must declare devDependency "${dep}"`)
    }
  })

  test('typescript stays pinned below 6 — typescript-eslint throws at import time on TS 7', () => {
    const { devDependencies = {} } = readJson('package.json')
    assert.match(
      devDependencies.typescript ?? '',
      /^[~^]?5\./,
      'typescript must stay on 5.x: typescript-eslint 8.x peer-caps at <6.1.0 and THROWS on TS 7, ' +
        'which kills the whole lint run rather than degrading it',
    )
  })

  test('the command surface from SPEC.md §4 exists', () => {
    const { scripts = {} } = readJson('package.json')
    for (const script of ['lint', 'lint:fix', 'format', 'format:check', 'verify']) {
      assert.ok(scripts[script], `package.json is missing the "${script}" script`)
    }
  })

  test('verify chains all four tiers and short-circuits on failure', () => {
    const { scripts = {} } = readJson('package.json')
    const verify = scripts.verify ?? ''
    for (const tier of ['typecheck', 'lint', 'test:unit', 'test:transitions']) {
      assert.match(verify, new RegExp(tier.replace(':', ':')), `verify must run ${tier}`)
    }
    assert.match(verify, /&&/, 'verify must chain with && so a failing step stops the gate')
    // `pnpm run --sequential a b c` runs only the FIRST script, passes the rest as argv, and
    // exits 0 — which would make this pre-commit gate silently report success.
    assert.ok(!verify.includes('--sequential'), 'pnpm run --sequential runs only the first script and exits 0')
  })

  test('every tier verify names is either implemented or explicitly pending', () => {
    const { scripts = {} } = readJson('package.json')
    for (const tier of ['test:unit', 'test:transitions']) {
      assert.ok(scripts[tier], `"${tier}" is named by verify, so it must exist as a script`)
    }
    // A pending tier must announce itself, never quietly exit 0.
    assert.ok(existsSync(join(ROOT, 'tools', 'pending-tier.mjs')), 'tools/pending-tier.mjs is missing')
  })

  test('prettier pins LF and does not reformat the lockfile', () => {
    const prettierrc = readJson('.prettierrc')
    assert.equal(
      prettierrc.endOfLine,
      'lf',
      'endOfLine must be "lf" to match .gitattributes; "auto" lets CRLF pass --check',
    )
    assert.ok(existsSync(join(ROOT, '.prettierignore')), '.prettierignore is missing')
    const ignored = readText('.prettierignore')
    assert.match(ignored, /pnpm-lock\.yaml/, 'pnpm format would otherwise rewrite the lockfile')
  })

  // ------------------------------------------------------------------ behavioural

  test('T2 criterion 2: ESLint rejects an `as` cast applied to unknown', (t) => {
    // The fixture goes inside a workspace src/ because that is the only path set with type
    // information, and no-unsafe-type-assertion needs a type checker.
    const fixture = join(ROOT, 'apps', 'api', 'src', '__lint-probe.ts')
    writeFileSync(
      fixture,
      ['const raw: unknown = JSON.parse("{}")', 'export const parsed = raw as { id: string }', ''].join('\n'),
    )
    t.after(() => rmSync(fixture, { force: true }))

    const result = runEslint('apps/api/src/__lint-probe.ts', '--format', 'json')
    assert.notEqual(result.status, 0, 'ESLint should have rejected an `as` cast on an unknown value')
    assert.match(
      result.stdout,
      /no-unsafe-type-assertion/,
      'the rejection must come from @typescript-eslint/no-unsafe-type-assertion, which is in NO preset ' +
        'and must be enabled by name',
    )
  })

  test('ESLint runs clean on the current tree', () => {
    const result = runEslint('.', '--max-warnings=0')
    assert.equal(
      result.status,
      0,
      `lint must pass on the committed tree.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  })
})
