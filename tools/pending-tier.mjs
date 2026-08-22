// A verify tier that SPEC.md §4 names but whose owning task has not run yet.
//
// SPEC.md §4 fixes the composition of `pnpm verify`: typecheck, lint, test:unit, test:transitions.
// Two of those tiers do not exist until T7. The options were to omit them from the chain (which
// means rewriting the gate at T7, and running an incomplete gate until then) or to stub them as
// `exit 0` (which means the gate reports success for work nobody has done). This script is the
// third option: the chain is complete and final from T2 onward, the missing tier announces itself
// on every run, and the placeholder cannot outlive the task that replaces it.
//
// Expiry is the point. Once Vitest is in the tree, T7 has landed and any tier still routed here is
// an unfinished rewire, so this exits non-zero and fails `pnpm verify` rather than continuing to
// wave the run through.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = dirname(import.meta.dirname)

/**
 * Every tier `pnpm verify` names that is not yet implemented, and the task that will implement it.
 * Removing an entry here is part of landing that task.
 */
const PENDING_TIERS = {
  'test:unit': {
    task: 'T7',
    becomes: 'the Vitest unit tier (SPEC.md §7: pure functions, no I/O, no containers)',
  },
  'test:transitions': {
    task: 'T7',
    becomes: 'the Vitest transition tier (SPEC.md §7: every §14.5 legal and §14.6 illegal transition)',
  },
}

/**
 * Evidence that the owning task has landed. Checked against the repository rather than against
 * node_modules, so the answer is the same before and after install.
 */
const landedEvidence = () => {
  const evidence = []

  const declaresVitest = (manifestPath) => {
    if (!existsSync(manifestPath)) return false
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return Object.hasOwn({ ...manifest.dependencies, ...manifest.devDependencies }, 'vitest')
  }

  if (declaresVitest(join(ROOT, 'package.json'))) {
    evidence.push('the root manifest declares a "vitest" dependency')
  }

  // Any workspace, not just the root. T7 may well declare vitest inside packages/testing and put
  // no config at the root, and a guard that only looked at the root would then keep waving both
  // tiers through while announcing they are pending.
  for (const group of ['apps', 'packages']) {
    const groupDir = join(ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (declaresVitest(join(groupDir, entry.name, 'package.json'))) {
        evidence.push(`${group}/${entry.name} declares a "vitest" dependency`)
      }
    }
  }

  for (const config of ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.workspace.ts']) {
    if (existsSync(join(ROOT, config))) {
      evidence.push(`${config} exists`)
    }
  }
  return evidence
}

const tier = process.argv[2]

// A typo in a package.json script must not read as "nothing to do here".
if (tier === undefined || !Object.hasOwn(PENDING_TIERS, tier)) {
  process.stderr.write(
    `pending-tier: ${JSON.stringify(tier ?? null)} is not a pending tier. ` +
      `Known pending tiers: ${Object.keys(PENDING_TIERS).join(', ')}.\n` +
      'Either the script name in package.json is wrong, or this tier has already been implemented ' +
      'and the placeholder should have been removed.\n',
  )
  process.exit(2)
}

const { task, becomes } = PENDING_TIERS[tier]
const evidence = landedEvidence()

if (evidence.length > 0) {
  process.stderr.write(
    `pending-tier: EXPIRED. ${task} has landed — ${evidence.join(', ')} — but the "${tier}" script in ` +
      'package.json still points at this placeholder.\n' +
      `Point "${tier}" at ${becomes} and delete its entry from tools/pending-tier.mjs.\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `NOTICE  ${tier} is a pending verify tier: nothing to run yet. ${task} makes it ${becomes}.\n` +
    `        The gate is green because this tier is empty, not because it passed.\n`,
)
