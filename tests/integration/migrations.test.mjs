// Integration tier: the migrations actually apply to a fresh database (T9).
//
// Runs against an ephemeral container, not the dev stack — so it proves the migrations work from
// nothing, which is what a new developer and CI both do, and what `db:migrate` against an
// already-migrated dev database can never demonstrate.

import { test, describe, beforeAll, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))

const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))

// pathToFileURL: on Windows a dynamic import() of an absolute path fails with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, because the loader reads "D:" as a URL scheme.
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

describe('database migrations', () => {
  beforeAll(() => {
    for (const workspace of ['packages/db', 'packages/testing']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('apply cleanly to an empty database, and are idempotent', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      // Running again must be a no-op rather than an error: this is what every process startup and
      // every CI job does.
      await applyMigrations(postgres.url)

      const { Client } = await import('pg')
      const client = new Client({ connectionString: postgres.url })
      await client.connect()
      try {
        const extensions = await client.query(
          "select extname from pg_extension where extname in ('citext','pg_trgm') order by extname",
        )
        expect(extensions.rows.map((row) => row.extname)).toEqual(['citext', 'pg_trgm'])

        const types = await client.query(
          "select typname from pg_type where typname in ('campaign_type','visit_method') order by typname",
        )
        expect(types.rows.map((row) => row.typname)).toEqual(['campaign_type', 'visit_method'])

        // The §16.4 routing table branches on exactly these values, so an unrecognized campaign
        // type must be impossible to store rather than discovered later by a rules engine that has
        // no sensible answer for it.
        const values = await client.query(
          "select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'campaign_type' order by e.enumsortorder",
        )
        expect(values.rows.map((row) => row.enumlabel)).toEqual(['shipping', 'payback', 'visit'])
      } finally {
        await client.end()
      }
    })
  })

  test('there is no db:push script anywhere', () => {
    // Push diffs a schema straight into a live database with no reviewable artifact. SPEC.md §8 puts
    // schema changes under Ask first, and a migration is the thing a human reads before it runs.
    const { scripts = {} } = readJson('package.json')
    expect(Object.keys(scripts)).not.toContain('db:push')
    expect(JSON.stringify(scripts)).not.toContain('drizzle-kit push')
  })

  test('drizzle-kit check agrees the migration journal is consistent', () => {
    // `generate` exits 0 even when it fails; `check` genuinely exits non-zero on a journal
    // collision, which is why it is the one worth running in CI.
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'packages', 'db', 'node_modules', 'drizzle-kit', 'bin.cjs'), 'check'],
      { cwd: join(ROOT, 'packages', 'db'), encoding: 'utf8', env: process.env, timeout: 120_000 },
    )
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
  })
})
