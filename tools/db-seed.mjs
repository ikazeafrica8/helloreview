// `pnpm db:seed` — load fixture data.
//
// Nothing to seed yet: fixtures belong with the schema they populate, so campaigns and rules arrive
// with T21, message templates with T24. This exists now because SPEC.md §4 names the command and
// db:reset calls it — an absent script would make `pnpm db:reset` fail for a missing step rather
// than for a real problem.
//
// The connection is resolved even though nothing uses it yet, deliberately. Seeding writes fixture
// rows, which is owner work on the same footing as a migration, so it belongs on
// DATABASE_MIGRATION_URL rather than the application's credential. Resolving it here means the day
// T21 adds real fixtures, the variable is already the right one — rather than someone reaching for
// DATABASE_URL because that is what was in scope.

import { requireMigrationUrl } from './db-target.mjs'

requireMigrationUrl('db:seed')

process.stdout.write('  seed: nothing to load yet — fixtures arrive with T21 campaigns and T24 templates\n')
