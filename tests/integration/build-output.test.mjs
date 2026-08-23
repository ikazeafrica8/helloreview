// Integration tier: dist must reflect src, and nothing else.
//
// This exists because of a specific measurement bug rather than a tidiness preference.
// vitest.config.ts deliberately INCLUDES `dist/**/*.js` in coverage, so that the integration
// tier — which boots the compiled app — has its measurements remapped back through the source maps
// onto the TypeScript sources. That is the right call, and it has a consequence: anything sitting
// in dist is treated as real application code.
//
// `tsc` emits but never un-emits. So two things silently corrupted that number:
//
//   1. T8 moved the per-app config loaders into packages/config. Four compiled modules stayed
//      behind in dist and kept being reported as real, uncovered code, with dangling source maps
//      pointing at files that no longer existed.
//   2. The lint-contract tests write throwaway .ts fixtures into apps/api/src. A build that raced a
//      live fixture compiled it, and while the fixture was always deleted the emitted output was
//      not — 88 such files had accumulated.
//
// Neither showed up as a failure anywhere. The build passed, typecheck passed, every test passed;
// only the coverage percentage was wrong, and a wrong coverage percentage is invisible by nature.

import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'

const ROOT = dirname(dirname(import.meta.dirname))

/** Every compiled .js under a workspace's dist, as paths relative to that dist. */
const emittedFiles = (distDir) => {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry)
      if (statSync(absolute).isDirectory()) {
        walk(absolute)
        continue
      }
      // Forward slashes regardless of platform: these paths go into a failure message and get
      // pasted into a shell, and Windows' backslashes would make that message unusable there.
      if (entry.endsWith('.js')) found.push(relative(distDir, absolute).split(sep).join('/'))
    }
  }
  walk(distDir)
  return found
}

/** Workspaces that compile TypeScript from src to dist. */
const builtWorkspaces = () => {
  const found = []
  for (const group of ['apps', 'packages']) {
    for (const workspace of readdirSync(join(ROOT, group))) {
      const base = join(ROOT, group, workspace)
      if (existsSync(join(base, 'dist')) && existsSync(join(base, 'src'))) found.push(`${group}/${workspace}`)
    }
  }
  return found
}

describe('build output', () => {
  test('every compiled module still has a source file', () => {
    // The guard for staleness. A .js whose .ts is gone is a module that was deleted or moved and
    // left a ghost behind — one that coverage still counts.
    const orphans = []

    for (const workspace of builtWorkspaces()) {
      const distDir = join(ROOT, workspace, 'dist')
      for (const emitted of emittedFiles(distDir)) {
        const source = join(ROOT, workspace, 'src', emitted.replace(/\.js$/, '.ts'))
        if (!existsSync(source)) orphans.push(`${workspace}/dist/${emitted}`)
      }
    }

    assert.deepEqual(
      orphans,
      [],
      `${String(orphans.length)} compiled module(s) have no source file. tsc never removes output for a\n` +
        'deleted source, and coverage counts dist/**/*.js as real code — so these are being measured.\n' +
        'Run `pnpm clean && pnpm build`.\n\n' +
        orphans.map((path) => `    - ${path}`).join('\n'),
    )
  })

  test('no compiled module is OLDER than the source it was built from', () => {
    // The guard for the whole class of bug M1 belonged to.
    //
    // A test that imports or spawns dist verifies whatever was last built. If that is not the
    // source under review, the test is measuring history. Measured: gutting the payload size limit
    // in raw-body.middleware.ts left typecheck, lint and 254 unit tests green, because nothing in
    // `pnpm verify` rebuilt apps/api.
    //
    // The test scripts now build first, which is the real fix. This is the check that says so —
    // it fails if that ever stops happening, whatever the reason.
    const stale = []

    for (const workspace of builtWorkspaces()) {
      const distDir = join(ROOT, workspace, 'dist')
      for (const emitted of emittedFiles(distDir)) {
        const source = join(ROOT, workspace, 'src', emitted.replace(/\.js$/, '.ts'))
        if (!existsSync(source)) continue

        const sourceTime = statSync(source).mtimeMs
        const builtTime = statSync(join(distDir, emitted)).mtimeMs
        // A one-second tolerance: some filesystems record whole seconds, so a build that ran
        // immediately after an edit can legitimately share its timestamp.
        if (sourceTime > builtTime + 1000) {
          stale.push(
            `${workspace}/${emitted} (source is ${String(Math.round((sourceTime - builtTime) / 1000))}s newer)`,
          )
        }
      }
    }

    assert.deepEqual(
      stale,
      [],
      `${String(stale.length)} compiled module(s) are older than their source. Any test importing or\n` +
        'spawning dist is verifying code that is not the code under review. Run `pnpm build`.\n\n' +
        stale.map((path) => `    - ${path}`).join('\n'),
    )
  })

  test('no lint fixture has been compiled into dist', () => {
    // Narrower and more pointed than the orphan check above, because the fix is different: the
    // sweep in lint-contract.test.mjs clears these. Note that excluding the glob in
    // apps/api/tsconfig.json — the obvious-looking fix — breaks the lint tests instead, because the
    // type-aware rules need the fixture inside a real TypeScript program to fire at all.
    const leaked = []

    for (const workspace of builtWorkspaces()) {
      const distDir = join(ROOT, workspace, 'dist')
      for (const emitted of readdirSync(distDir)) {
        if (emitted.startsWith('__lint-fixture-')) leaked.push(`${workspace}/dist/${emitted}`)
      }
    }

    assert.deepEqual(
      leaked,
      [],
      `${String(leaked.length)} lint-fixture artifact(s) leaked into dist. The fixture glob must stay in\n` +
        "apps/api/tsconfig.json's exclude so tsc never emits for it.\n\n" +
        leaked.map((path) => `    - ${path}`).join('\n'),
    )
  })
})
