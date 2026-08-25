import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import { createFakeAttachmentStorage, createFakeMalwareScanner } from '../../packages/adapters/dist/index.js'
import {
  AttachmentAccessService,
  AttachmentIngestService,
  AttachmentLifecycleService,
  AttachmentRepository,
} from '../../apps/api/dist/modules/attachments/index.js'
import { seedPhase8Workflow, syntheticPng } from '../helpers/phase8-seed.mjs'

const issueUpload = (access, ids, suffix, overrides = {}) =>
  access.issueUploadGrant({
    workflowId: ids.workflowId,
    participantId: ids.participantId,
    expectedDeclaredType: 'image/png',
    maxBytes: 1_024,
    now: new Date(ids.now.getTime() + suffix * 100),
    expiresAt: new Date(ids.now.getTime() + suffix * 100 + 60_000),
    ...overrides,
  })

const ingestInput = (ids, token, suffix, overrides = {}) => ({
  uploadToken: token,
  workflowId: ids.workflowId,
  participantId: ids.participantId,
  sourceMessageReference: `message-phase8-${suffix}`,
  providerReference: `provider-attachment-phase8-${suffix}`,
  filename: 'reservation.png',
  declaredType: 'image/png',
  bytes: syntheticPng(),
  receivedAt: new Date(ids.now.getTime() + suffix * 100),
  ...overrides,
})

describe('secure attachment persistence, access, and lifecycle', () => {
  test('keeps evidence append-only, grants single-use, reads ownership-bound, and deletion policy-gated', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      const storage = createFakeAttachmentStorage(Buffer.alloc(32, 8))
      const repository = new AttachmentRepository()
      const access = new AttachmentAccessService(pool, repository, storage, 300)
      const lifecycle = new AttachmentLifecycleService(pool, repository, storage)
      try {
        const ids = await seedPhase8Workflow(pool, 'secure-flow')
        const raceGrant = await issueUpload(access, ids, 0)
        const raced = await Promise.allSettled([
          access.consumeUploadGrant({
            token: raceGrant.token,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            declaredType: 'image/png',
            sizeBytes: syntheticPng().byteLength,
            now: ids.now,
          }),
          access.consumeUploadGrant({
            token: raceGrant.token,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            declaredType: 'image/png',
            sizeBytes: syntheticPng().byteLength,
            now: ids.now,
          }),
        ])
        expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1)

        const grant = await issueUpload(access, ids, 1)
        const ingest = new AttachmentIngestService(
          pool,
          repository,
          access,
          storage,
          createFakeMalwareScanner([{ status: 'clean' }]),
          1_024,
        )
        const clean = await ingest.ingest(ingestInput(ids, grant.token, 1))
        expect(clean).toMatchObject({ securityState: 'clean', deduplicated: false })
        expect(storage.storedObjectCount()).toBe(1)

        const securityHistory = await pool.query(
          `SELECT state, reason_code FROM attachment_security_events WHERE attachment_id = $1 ORDER BY occurred_at, id`,
          [clean.evidence.id],
        )
        expect(securityHistory.rows).toEqual([
          { state: 'quarantined', reason_code: 'ATTACHMENT_QUARANTINED' },
          { state: 'scanning', reason_code: 'ATTACHMENT_SCANNING' },
          { state: 'clean', reason_code: 'ATTACHMENT_CLEAN' },
        ])
        expect(
          JSON.stringify((await pool.query(`SELECT * FROM attachments WHERE id = $1`, [clean.evidence.id])).rows),
        ).not.toContain(syntheticPng().toString('base64'))
        await expect(
          pool.query(`UPDATE attachments SET provider_reference = 'rewritten' WHERE id = $1`, [clean.evidence.id]),
        ).rejects.toThrow(/append-only/)
        await expect(
          pool.query(`DELETE FROM attachment_security_events WHERE attachment_id = $1`, [clean.evidence.id]),
        ).rejects.toThrow(/append-only/)

        await expect(
          lifecycle.linkCleanEvidence({
            attachmentId: clean.evidence.id,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            actorReference: 'workflow-core-test',
            occurredAt: new Date(ids.now.getTime() + 1_000),
          }),
        ).resolves.toEqual({ linked: true })

        const other = await seedPhase8Workflow(pool, 'other-owner')
        const read = await access.issueReadGrant({
          attachmentId: clean.evidence.id,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          now: new Date(ids.now.getTime() + 2_000),
        })
        await expect(
          access.consumeReadGrant({
            token: read.token,
            workflowId: other.workflowId,
            participantId: other.participantId,
            now: new Date(ids.now.getTime() + 2_100),
          }),
        ).rejects.toMatchObject({ reasonCode: 'GRANT_INVALID' })
        const signed = await access.consumeReadGrant({
          token: read.token,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          now: new Date(ids.now.getTime() + 2_200),
        })
        await expect(
          storage.readSigned({
            signedReference: signed.signedReference,
            contentHash: clean.evidence.contentHash,
            now: new Date(ids.now.getTime() + 2_300),
          }),
        ).resolves.toEqual(syntheticPng())
        await expect(
          access.consumeReadGrant({
            token: read.token,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            now: new Date(ids.now.getTime() + 2_400),
          }),
        ).rejects.toMatchObject({ reasonCode: 'GRANT_INVALID' })

        const missingPolicy = await lifecycle.deleteWhenEligible({
          attachmentId: clean.evidence.id,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          policyReference: null,
          operationId: 'missing-policy',
          actorReference: 'privacy-test',
          occurredAt: new Date(ids.now.getTime() + 3_000),
        })
        expect(missingPolicy).toEqual({
          decision: { allowed: false, reasonCode: 'RETENTION_POLICY_MISSING' },
          objectDeleted: false,
        })
        expect(storage.storedObjectCount()).toBe(1)

        await lifecycle.setLegalHold({
          attachmentId: clean.evidence.id,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          holdReference: 'legal-hold-case-1',
          active: true,
          actorReference: 'privacy-test',
          occurredAt: new Date(ids.now.getTime() + 4_000),
        })
        const held = await lifecycle.deleteWhenEligible({
          attachmentId: clean.evidence.id,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          policyReference: 'approved-policy-v1',
          operationId: 'held-policy',
          actorReference: 'privacy-test',
          occurredAt: new Date(ids.now.getTime() + 5_000),
        })
        expect(held.decision).toEqual({ allowed: false, reasonCode: 'LEGAL_HOLD_ACTIVE' })
        expect(storage.storedObjectCount()).toBe(1)

        await lifecycle.setLegalHold({
          attachmentId: clean.evidence.id,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          holdReference: 'legal-hold-case-1',
          active: false,
          actorReference: 'privacy-test',
          occurredAt: new Date(ids.now.getTime() + 6_000),
        })
        const deleted = await lifecycle.deleteWhenEligible({
          attachmentId: clean.evidence.id,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          policyReference: 'approved-policy-v1',
          operationId: 'approved-delete',
          actorReference: 'privacy-test',
          occurredAt: new Date(ids.now.getTime() + 7_000),
        })
        expect(deleted).toEqual({
          decision: { allowed: true, reasonCode: 'DELETION_ELIGIBLE' },
          objectDeleted: true,
        })
        expect(storage.storedObjectCount()).toBe(0)
      } finally {
        await pool.end()
      }
    })
  })

  test('retains infected and scanner-failed files in quarantine evidence for operator review', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      const storage = createFakeAttachmentStorage(Buffer.alloc(32, 9))
      const repository = new AttachmentRepository()
      const access = new AttachmentAccessService(pool, repository, storage, 300)
      const lifecycle = new AttachmentLifecycleService(pool, repository, storage)
      try {
        const ids = await seedPhase8Workflow(pool, 'unsafe')
        const infectedGrant = await issueUpload(access, ids, 1)
        const failedGrant = await issueUpload(access, ids, 2)
        const infected = await new AttachmentIngestService(
          pool,
          repository,
          access,
          storage,
          createFakeMalwareScanner([{ status: 'infected', threatCode: 'EICAR_TEST' }]),
          1_024,
        ).ingest(ingestInput(ids, infectedGrant.token, 1))
        const scanFailed = await new AttachmentIngestService(
          pool,
          repository,
          access,
          storage,
          createFakeMalwareScanner([{ status: 'error', failureCode: 'SCANNER_TIMEOUT' }]),
          1_024,
        ).ingest(ingestInput(ids, failedGrant.token, 2, { bytes: Buffer.concat([syntheticPng(), Buffer.from([5])]) }))
        expect(infected.securityState).toBe('rejected')
        expect(scanFailed.securityState).toBe('scan_failed')
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM attachment_lifecycle_events
                WHERE event_type = 'operator_review_required'`,
            )
          ).rows[0].count,
        ).toBe(2)
        await expect(
          access.issueReadGrant({
            attachmentId: infected.evidence.id,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            now: new Date(ids.now.getTime() + 5_000),
          }),
        ).rejects.toMatchObject({ reasonCode: 'ATTACHMENT_NOT_CLEAN' })
        await expect(
          lifecycle.linkCleanEvidence({
            attachmentId: infected.evidence.id,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            actorReference: 'workflow-core-test',
            occurredAt: new Date(ids.now.getTime() + 6_000),
          }),
        ).rejects.toMatchObject({ reasonCode: 'ATTACHMENT_NOT_CLEAN' })
        expect(storage.storedObjectCount()).toBe(2)
      } finally {
        await pool.end()
      }
    })
  })
})
