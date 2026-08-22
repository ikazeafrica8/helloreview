// `pnpm db:seed` — load fixture data.
//
// Nothing to seed yet: fixtures belong with the schema they populate, so campaigns and rules arrive
// with T21, message templates with T24. This exists now because SPEC.md §4 names the command and
// db:reset calls it — an absent script would make `pnpm db:reset` fail for a missing step rather
// than for a real problem.
process.stdout.write('  seed: nothing to load yet — fixtures arrive with T21 campaigns and T24 templates\n')
