// Remove every build output, so the next build starts from nothing.
//
// `tsc` emits but never un-emits. When a source file is deleted or moved, its compiled .js, .d.ts
// and .map stay in dist forever, and nothing in the normal workflow notices:
//
//   - the build still succeeds, because tsc only looks at what exists in src;
//   - typecheck still passes, for the same reason;
//   - COVERAGE still counts them, because vitest.config.ts deliberately includes dist/**/*.js in
//     order to remap the integration tier's measurements back through the source maps.
//
// That third point is what makes this a correctness problem rather than untidiness. After T8 moved
// the per-app config loaders into packages/config, four orphaned modules stayed in dist and were
// being reported as real, uncovered application code. The coverage number was measuring files that
// no longer existed.
//
// `pnpm clean` is the manual fix; tests/integration/build-output.test.mjs is the automatic guard
// that says when it is needed.

import { rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = dirname(import.meta.dirname)
const WORKSPACE_ROOTS = ['apps', 'packages']

let removed = 0

for (const group of WORKSPACE_ROOTS) {
  const groupDir = join(ROOT, group)
  if (!existsSync(groupDir)) continue

  for (const workspace of readdirSync(groupDir)) {
    // tsbuildinfo too: an incremental build consults it and can decide there is nothing to do,
    // which would leave a just-cleaned dist empty and the build reporting success.
    for (const output of ['dist', 'tsconfig.tsbuildinfo', '.turbo']) {
      const target = join(groupDir, workspace, output)
      if (!existsSync(target)) continue
      rmSync(target, { recursive: true, force: true })
      process.stdout.write(`  removed ${group}/${workspace}/${output}\n`)
      removed += 1
    }
  }
}

process.stdout.write(
  removed === 0 ? '  nothing to clean\n' : `  cleaned ${String(removed)} build output(s) — run \`pnpm build\` next\n`,
)
