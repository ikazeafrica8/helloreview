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

describe('Phase 8 secure attachment journey', () => {
  test('one-time upload becomes clean workflow evidence and one short-lived owner read', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      const storage = createFakeAttachmentStorage(Buffer.alloc(32, 11))
      const repository = new AttachmentRepository()
      const access = new AttachmentAccessService(pool, repository, storage, 300)
      const lifecycle = new AttachmentLifecycleService(pool, repository, storage)
      try {
        const ids = await seedPhase8Workflow(pool, 'e2e')
        const upload = await access.issueUploadGrant({
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          expectedDeclaredType: 'image/png',
          maxBytes: 1_024,
          now: ids.now,
          expiresAt: new Date(ids.now.getTime() + 60_000),
        })
        const ingested = await new AttachmentIngestService(
          pool,
          repository,
          access,
          storage,
          createFakeMalwareScanner([{ status: 'clean' }]),
          1_024,
        ).ingest({
          uploadToken: upload.token,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          sourceMessageReference: 'e2e-inbound-message',
          providerReference: 'e2e-provider-attachment',
          filename: 'reservation.png',
          declaredType: 'image/png',
          bytes: syntheticPng(),
          receivedAt: ids.now,
        })
        expect(ingested.securityState).toBe('clean')
        await expect(
          lifecycle.linkCleanEvidence({
            attachmentId: ingested.evidence.id,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            actorReference: 'workflow-core-e2e',
            occurredAt: new Date(ids.now.getTime() + 1_000),
          }),
        ).resolves.toEqual({ linked: true })

        const read = await access.issueReadGrant({
          attachmentId: ingested.evidence.id,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          now: new Date(ids.now.getTime() + 2_000),
        })
        const signed = await access.consumeReadGrant({
          token: read.token,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          now: new Date(ids.now.getTime() + 2_100),
        })
        await expect(
          storage.readSigned({
            signedReference: signed.signedReference,
            contentHash: ingested.evidence.contentHash,
            now: new Date(ids.now.getTime() + 2_200),
          }),
        ).resolves.toEqual(syntheticPng())

        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM attachment_lifecycle_events
                WHERE attachment_id = $1 AND event_type = 'evidence_linked'`,
              [ingested.evidence.id],
            )
          ).rows[0].count,
        ).toBe(1)
        expect((await pool.query(`SELECT count(*)::integer AS count FROM workflow_events`)).rows[0].count).toBe(0)
        expect((await pool.query(`SELECT count(*)::integer AS count FROM attachment_grant_events`)).rows[0].count).toBe(
          5,
        )
      } finally {
        await pool.end()
      }
    })
  })
})
