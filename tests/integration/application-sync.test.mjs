// Integration tier: authoritative website application synchronization and reconciliation (T26/T27).

import { beforeAll, describe, expect, test } from 'vitest'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const addCampaign = async (pool, code) => {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, starts_at, ends_at)
     VALUES ($1, $2, 'payback', 'not_applicable', now(), now() + interval '30 days')
     RETURNING id`,
    [code, `Campaign ${code}`],
  )
  return String(rows[0].id)
}

const applicationSnapshot = (campaignId, overrides = {}) => ({
  sourceSystem: 'helloreview_website',
  sourceApplicationId: 'app-integration-1',
  campaignId,
  status: 'received',
  applicantName: '통합 테스트',
  phoneNormalized: '+821012345678',
  submittedAt: new Date('2026-08-24T01:00:00Z'),
  sourceVersion: 1,
  sourceEventId: 'evt-integration-1',
  sourceOccurredAt: new Date('2026-08-24T01:00:01Z'),
  ...overrides,
})

describe('T26/T27 application synchronization', () => {
  beforeAll(() => {
    for (const workspace of [
      'packages/contracts',
      'packages/adapters',
      'packages/db',
      'packages/testing',
      'apps/api',
    ]) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('replay, polling, freshness, bounded no-match and source failure preserve one timeline', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { createFakeWebsiteApplicationSource, WEBSITE_SOURCE_FAILURES } = await importBuilt(
      'packages/adapters/dist/index.js',
    )
    const { ApplicationSyncService, ApplicationReconciliationService } = await importBuilt(
      'apps/api/dist/modules/application-sync/index.js',
    )
    const { Pool } = await import('pg')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url, max: 6 })
      const source = createFakeWebsiteApplicationSource()
      const synchronization = new ApplicationSyncService(pool)
      const reconciliation = new ApplicationReconciliationService(pool, synchronization, source, {
        retryWindowMs: 120_000,
        retryIntervalMs: 30_000,
        freshnessThresholdMs: 60_000,
      })

      try {
        // T26: the same create event is one projection and one logical change; a newer event updates
        // that projection and preserves both source event ids and source occurrence times.
        const campaignId = await addCampaign(pool, 't26-sync')
        const createdSnapshot = applicationSnapshot(campaignId)
        const createdEvent = source.emitCreated(createdSnapshot)

        await expect(synchronization.synchronizeEvent(createdEvent)).resolves.toMatchObject({
          outcome: 'applied',
          status: 'received',
          sourceVersion: 1,
        })
        await expect(synchronization.synchronizeEvent(createdEvent)).resolves.toMatchObject({
          outcome: 'duplicate',
          sourceVersion: 1,
        })

        const updatedSnapshot = applicationSnapshot(campaignId, {
          status: 'matched',
          sourceVersion: 2,
          sourceEventId: 'evt-integration-2',
          sourceOccurredAt: new Date('2026-08-24T01:05:00Z'),
        })
        await expect(synchronization.synchronizeEvent(source.emitUpdated(updatedSnapshot))).resolves.toMatchObject({
          outcome: 'applied',
          status: 'matched',
          sourceVersion: 2,
        })

        const projection = await pool.query(
          `SELECT source_application_id, status, source_status, source_version,
                  last_source_event_id, last_source_occurred_at
             FROM applications WHERE campaign_id = $1`,
          [campaignId],
        )
        expect(projection.rows).toHaveLength(1)
        expect(projection.rows[0]).toMatchObject({
          source_application_id: 'app-integration-1',
          status: 'matched',
          source_status: 'matched',
          source_version: 2,
          last_source_event_id: 'evt-integration-2',
        })
        expect(projection.rows[0].last_source_occurred_at).toEqual(new Date('2026-08-24T01:05:00Z'))

        const history = await pool.query(
          `SELECT source_event_id, source_occurred_at, source_version, application_status
             FROM application_changes
            WHERE application_id = (SELECT id FROM applications WHERE campaign_id = $1)
            ORDER BY source_version`,
          [campaignId],
        )
        expect(history.rows).toHaveLength(2)
        expect(history.rows.map((row) => row.source_event_id)).toEqual(['evt-integration-1', 'evt-integration-2'])
        expect(history.rows.map((row) => row.source_occurred_at)).toEqual([
          new Date('2026-08-24T01:00:01Z'),
          new Date('2026-08-24T01:05:00Z'),
        ])
        await expect(pool.query(`UPDATE application_changes SET changed_fields = '[]'::jsonb`)).rejects.toThrow(
          /append-only/,
        )

        const enumStates = await pool.query(`SELECT unnest(enum_range(NULL::application_status))::text AS status`)
        expect(enumStates.rows.map((row) => row.status)).toEqual([
          'received',
          'completed',
          'matched',
          'ambiguous',
          'cancelled',
          'synchronized_late',
        ])

        // T27: an empty first poll remains pending. A record appearing on the next due attempt is
        // synchronized late, and a webhook for that same source version creates no second change.
        const delayedCampaignId = await addCampaign(pool, 't27-delayed')
        const claimedAt = new Date('2026-08-24T02:00:00Z')
        const request = await reconciliation.begin({
          sourceSystem: source.sourceSystem,
          campaignId: delayedCampaignId,
          claimedAt,
        })
        expect(request).toMatchObject({ status: 'pending', attemptCount: 0 })

        const firstAttempt = await reconciliation.attempt(request.reconciliationId, claimedAt)
        expect(firstAttempt).toMatchObject({ status: 'pending', attempted: true, attemptCount: 1 })
        const earlyAttempt = await reconciliation.attempt(request.reconciliationId, new Date('2026-08-24T02:00:10Z'))
        expect(earlyAttempt).toMatchObject({ status: 'pending', attempted: false, attemptCount: 1 })

        const delayedSnapshot = applicationSnapshot(delayedCampaignId, {
          sourceApplicationId: 'app-delayed-1',
          submittedAt: new Date('2026-08-24T02:00:05Z'),
          sourceEventId: 'evt-poll-version-1',
          sourceOccurredAt: new Date('2026-08-24T02:00:06Z'),
        })
        source.put(delayedSnapshot)
        const resolvedAt = new Date('2026-08-24T02:00:30Z')
        const resolved = await reconciliation.attempt(request.reconciliationId, resolvedAt)
        expect(resolved).toMatchObject({ status: 'resolved', attempted: true, attemptCount: 2 })

        const synchronizedLate = await pool.query(
          `SELECT id, status, source_status, source_version
             FROM applications
            WHERE source_system = $1 AND source_application_id = $2`,
          [source.sourceSystem, 'app-delayed-1'],
        )
        expect(synchronizedLate.rows).toHaveLength(1)
        expect(synchronizedLate.rows[0]).toMatchObject({
          status: 'synchronized_late',
          source_status: 'received',
          source_version: 1,
        })

        const lateWebhook = source.emitCreated({
          ...delayedSnapshot,
          sourceEventId: 'evt-webhook-late-version-1',
          sourceOccurredAt: new Date('2026-08-24T02:00:40Z'),
        })
        await expect(synchronization.synchronizeEvent(lateWebhook)).resolves.toMatchObject({
          outcome: 'stale',
          status: 'synchronized_late',
          sourceVersion: 1,
        })
        const delayedHistory = await pool.query(
          `SELECT count(*)::integer AS count FROM application_changes WHERE application_id = $1`,
          [synchronizedLate.rows[0].id],
        )
        expect(delayedHistory.rows[0].count).toBe(1)

        const fresh = await reconciliation.freshness(source.sourceSystem, resolvedAt)
        expect(fresh).toMatchObject({
          lastSuccessfulReconciliationAt: resolvedAt,
          ageMs: 0,
          stale: false,
          consecutiveFailureCount: 0,
        })
        const stale = await reconciliation.freshness(source.sourceSystem, new Date(resolvedAt.getTime() + 60_001))
        expect(stale.stale).toBe(true)

        // A successful empty read becomes no_match only at the deadline, never on the first claim.
        const noMatchCampaignId = await addCampaign(pool, 't27-no-match')
        const noMatchAt = new Date('2026-08-24T03:00:00Z')
        const noMatchRequest = await reconciliation.begin({
          sourceSystem: source.sourceSystem,
          campaignId: noMatchCampaignId,
          claimedAt: noMatchAt,
        })
        await expect(reconciliation.attempt(noMatchRequest.reconciliationId, noMatchAt)).resolves.toMatchObject({
          status: 'pending',
          attemptCount: 1,
        })
        await expect(
          reconciliation.attempt(noMatchRequest.reconciliationId, new Date(noMatchAt.getTime() + 120_000)),
        ).resolves.toMatchObject({ status: 'no_match', attemptCount: 2 })

        // An outage at the deadline is not misreported as a confident no-match conclusion.
        const failedCampaignId = await addCampaign(pool, 't27-failed')
        const failedAt = new Date('2026-08-24T04:00:00Z')
        const failedRequest = await reconciliation.begin({
          sourceSystem: source.sourceSystem,
          campaignId: failedCampaignId,
          claimedAt: failedAt,
        })
        source.failNextRead(WEBSITE_SOURCE_FAILURES.UNAVAILABLE)
        await expect(reconciliation.attempt(failedRequest.reconciliationId, failedAt)).resolves.toMatchObject({
          status: 'pending',
          reasonCode: WEBSITE_SOURCE_FAILURES.UNAVAILABLE,
        })
        const afterFailure = await reconciliation.freshness(source.sourceSystem, failedAt)
        expect(afterFailure).toMatchObject({
          consecutiveFailureCount: 1,
          lastFailureReason: WEBSITE_SOURCE_FAILURES.UNAVAILABLE,
        })

        source.failNextRead(WEBSITE_SOURCE_FAILURES.UNAVAILABLE)
        await expect(
          reconciliation.attempt(failedRequest.reconciliationId, new Date(failedAt.getTime() + 120_000)),
        ).resolves.toMatchObject({
          status: 'failed',
          reasonCode: WEBSITE_SOURCE_FAILURES.UNAVAILABLE,
        })
      } finally {
        await pool.end()
      }
    })
  }, 300_000)
})
