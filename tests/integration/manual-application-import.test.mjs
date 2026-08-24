// Integration tier: pilot CSV fallback when the outsourced website exposes no integration surface.

import { beforeAll, describe, expect, test } from 'vitest'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const header = [
  'application_id',
  'campaign_code',
  'application_status',
  'applicant_name',
  'phone_normalized',
  'blog_url',
  'blogger_level',
  'blog_daily_visitors',
  'blogger_region',
  'submitted_at',
  'updated_at',
].join(',')

const csv = ({
  applicationId = 'manual-app-1',
  campaignCode = 'manual-pilot',
  status = 'received',
  name = 'Pilot Applicant',
  bloggerLevel = '1',
  blogDailyVisitors = '1250',
  bloggerRegion = '서울',
  updatedAt = '2026-08-24T01:05:00Z',
} = {}) =>
  `${header}\n${[
    applicationId,
    campaignCode,
    status,
    name,
    '+821012345678',
    'https://blog.example/pilot',
    bloggerLevel,
    blogDailyVisitors,
    bloggerRegion,
    '2026-08-24T01:00:00Z',
    updatedAt,
  ].join(',')}\n`

describe('manual application CSV pilot fallback', () => {
  beforeAll(() => {
    for (const workspace of ['packages/adapters', 'packages/db', 'packages/testing', 'apps/api']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('imports a full snapshot idempotently and refuses rollback from an older row', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { ApplicationSyncService, ManualCsvImportService, APPLICATION_IMPORT_FAILURES } = await importBuilt(
      'apps/api/dist/modules/application-sync/index.js',
    )
    const { Pool } = await import('pg')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url, max: 6 })
      const synchronization = new ApplicationSyncService(pool)
      const importer = new ManualCsvImportService(
        pool,
        synchronization,
        'integration-import-key-at-least-16-characters',
      )

      try {
        await pool.query(
          `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
           VALUES ('manual-pilot', 'Manual Pilot', 'payback', 'not_applicable', now(), now() + interval '30 days')`,
        )

        const firstContent = csv()
        const firstExportedAt = new Date('2026-08-24T01:10:00Z')
        const firstImportedAt = new Date('2026-08-24T01:11:00Z')
        const first = await importer.importCsv({
          content: firstContent,
          sourceSystem: 'helloreview_website',
          exportedAt: firstExportedAt,
          importedAt: firstImportedAt,
        })
        expect(first).toMatchObject({
          rowCount: 1,
          appliedCount: 1,
          duplicateCount: 0,
          staleCount: 0,
          replayed: false,
        })

        const replay = await importer.importCsv({
          content: firstContent,
          sourceSystem: 'helloreview_website',
          exportedAt: firstExportedAt,
          importedAt: new Date('2026-08-24T01:12:00Z'),
        })
        expect(replay).toMatchObject({ batchId: first.batchId, replayed: true, appliedCount: 1 })

        const unchangedLaterExport = await importer.importCsv({
          content: csv({ updatedAt: '2026-08-24T01:12:00Z' }),
          sourceSystem: 'helloreview_website',
          exportedAt: new Date('2026-08-24T01:13:00Z'),
          importedAt: new Date('2026-08-24T01:14:00Z'),
        })
        expect(unchangedLaterExport).toMatchObject({ duplicateCount: 1, appliedCount: 0, replayed: false })

        const newer = await importer.importCsv({
          content: csv({
            status: 'completed',
            bloggerLevel: '2',
            blogDailyVisitors: '2000',
            bloggerRegion: '경기',
            updatedAt: '2026-08-24T01:15:00Z',
          }),
          sourceSystem: 'helloreview_website',
          exportedAt: new Date('2026-08-24T01:20:00Z'),
          importedAt: new Date('2026-08-24T01:21:00Z'),
        })
        expect(newer).toMatchObject({ appliedCount: 1, replayed: false })

        const older = await importer.importCsv({
          content: csv({ name: 'Older Snapshot', updatedAt: '2026-08-24T01:04:00Z' }),
          sourceSystem: 'helloreview_website',
          exportedAt: new Date('2026-08-24T01:22:00Z'),
          importedAt: new Date('2026-08-24T01:23:00Z'),
        })
        expect(older).toMatchObject({ staleCount: 1, appliedCount: 0, replayed: false })

        const projection = await pool.query(
          `SELECT status, source_status, source_version, applicant_name, blogger_level,
                  blog_daily_visitors, blogger_region, last_source_occurred_at
             FROM applications WHERE source_application_id = 'manual-app-1'`,
        )
        expect(projection.rows).toHaveLength(1)
        expect(projection.rows[0]).toMatchObject({
          status: 'synchronized_late',
          source_status: 'completed',
          source_version: 2,
          applicant_name: 'Pilot Applicant',
          blogger_level: 2,
          blog_daily_visitors: 2000,
          blogger_region: '경기',
          last_source_occurred_at: new Date('2026-08-24T01:15:00Z'),
        })

        const evidence = await pool.query(
          `SELECT
             (SELECT count(*)::integer FROM application_changes) AS changes,
             (SELECT count(*)::integer FROM application_import_batches) AS batches`,
        )
        expect(evidence.rows[0]).toMatchObject({ changes: 2, batches: 4 })

        const freshness = await pool.query(
          `SELECT last_attempted_at, last_successful_reconciliation_at
             FROM application_source_freshness WHERE source_system = 'helloreview_website'`,
        )
        expect(freshness.rows[0]).toMatchObject({
          last_attempted_at: new Date('2026-08-24T01:23:00Z'),
          last_successful_reconciliation_at: new Date('2026-08-24T01:22:00Z'),
        })

        const applicationCountBefore = await pool.query('SELECT count(*)::integer AS count FROM applications')
        await expect(
          importer.importCsv({
            content: csv({ applicationId: 'unknown-campaign-app', campaignCode: 'does-not-exist' }),
            sourceSystem: 'helloreview_website',
            exportedAt: new Date('2026-08-24T01:24:00Z'),
            importedAt: new Date('2026-08-24T01:25:00Z'),
          }),
        ).rejects.toMatchObject({ reasonCode: APPLICATION_IMPORT_FAILURES.UNKNOWN_CAMPAIGN })
        const applicationCountAfter = await pool.query('SELECT count(*)::integer AS count FROM applications')
        expect(applicationCountAfter.rows[0].count).toBe(applicationCountBefore.rows[0].count)
      } finally {
        await pool.end()
      }
    })
  }, 300_000)
})
