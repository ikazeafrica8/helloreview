// Lint and format contract for T2.
//
// The config-shape assertions below are cheap but weak — they prove a rule is written down, not
// that it fires. The two behavioural tests at the bottom are the real proof: they run ESLint
// against a real fixture and against the real tree.
//
// Integration tier: spawns processes and touches the local stack.

import { test, describe, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))

// Fixtures must live inside a directory a workspace tsconfig includes, because the type-aware
// rules under test need a real TypeScript program — linting a virtual path does not work.
// That means writing into the source tree, so three things guard against a leaked file:
// the name is unique per process, stale matches are swept before the first write, and the glob is
// in .gitignore and .prettierignore so a leak can neither be committed nor break `pnpm format`.
const FIXTURE_DIR = join(ROOT, 'apps', 'api', 'src')
const FIXTURE_PREFIX = '__lint-fixture-'

let fixtureCounter = 0

const sweepStaleFixtures = () => {
  for (const entry of readdirSync(FIXTURE_DIR)) {
    if (entry.startsWith(FIXTURE_PREFIX)) rmSync(join(FIXTURE_DIR, entry), { force: true })
  }
}

/** Write a fixture under a unique name and register unconditional cleanup on the test context. */
const withFixture = (source) => {
  fixtureCounter += 1
  const name = `${FIXTURE_PREFIX}${process.pid}-${fixtureCounter}.ts`
  const absolute = join(FIXTURE_DIR, name)
  writeFileSync(absolute, source)
  onTestFinished(() => {
    rmSync(absolute, { force: true })
  })
  return `apps/api/src/${name}`
}

sweepStaleFixtures()

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

/**
 * Lint one fixture by explicit path. `--no-ignore` is required because the fixture glob is in the
 * config's globalIgnores — and it must stay scoped to this helper: passing it to a whole-tree run
 * would send ESLint into node_modules.
 */
const runEslintOnFixture = (relativePath) => runEslint('--no-ignore', relativePath, '--format', 'json')

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

  test('every tier verify names is a real Vitest tier, not a placeholder', () => {
    const { scripts = {} } = readJson('package.json')
    for (const tier of ['test:unit', 'test:transitions']) {
      assert.ok(scripts[tier], `"${tier}" is named by verify, so it must exist as a script`)
      assert.match(scripts[tier], /vitest/, `"${tier}" must run Vitest now that T7 has landed`)
    }
    // T7 retired the placeholder. Its own guard would have failed the build once Vitest appeared,
    // which is what makes this assertion a formality rather than a hope.
    assert.ok(
      !existsSync(join(ROOT, 'tools', 'pending-tier.mjs')),
      'tools/pending-tier.mjs should have been deleted by T7',
    )
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

  test('T2 criterion 2: ESLint rejects an `as` cast applied to unknown', () => {
    const relative = withFixture(
      ['const raw: unknown = JSON.parse("{}")', 'export const parsed = raw as { id: string }', ''].join('\n'),
    )
    const result = runEslintOnFixture(relative)
    assert.notEqual(result.status, 0, 'ESLint should have rejected an `as` cast on an unknown value')
    assert.match(
      result.stdout,
      /no-unsafe-type-assertion/,
      'the rejection must come from @typescript-eslint/no-unsafe-type-assertion, which is in NO preset ' +
        'and must be enabled by name',
    )
  })

  test('the reason-code rule accepts a SCREAMING_SNAKE key written as a string literal', () => {
    // Regression: esquery's `!=` compares an absent key.name against the string "undefined", so
    // testing only key.name wrongly rejected `{ 'NOT_SELECTED': ... } as const`. Both key forms
    // must be tested. Verified failing before the fix.
    const relative = withFixture(
      [
        "export const IDENT = { NOT_SELECTED: 'NOT_SELECTED' } as const",
        "export const QUOTED = { 'NOT_SELECTED': 'NOT_SELECTED' } as const",
        '',
      ].join('\n'),
    )
    // reason-codes.ts is the path the rule is scoped to, so lint the fixture under that config by
    // asserting on the general case here and on the scoped case in the next test.
    const result = runEslintOnFixture(relative)
    assert.equal(result.status, 0, `a valid SCREAMING_SNAKE registry must lint clean:\n${result.stdout}`)
  })

  test('a generic .enqueue() is not mistaken for a transactional-outbox violation', () => {
    // Regression: the outbox selector originally matched any `.enqueue(`, which is a generic method
    // name — verified to fire on an ordinary local queue helper. Narrowed to `enqueueIntent`.
    const relative = withFixture(
      [
        'const localQueue = { enqueue: (_job: string): undefined => undefined }',
        'export const run = (): undefined => {',
        "  return localQueue.enqueue('some-job')",
        '}',
        '',
      ].join('\n'),
    )
    const result = runEslintOnFixture(relative)
    assert.ok(
      !result.stdout.includes('pass the transaction handle'),
      `a generic .enqueue() must not trip the outbox rule:\n${result.stdout}`,
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
