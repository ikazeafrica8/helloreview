import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import { createFakeAttachmentStorage, createFakeMalwareScanner } from '../../packages/adapters/dist/index.js'
import {
  AttachmentAccessService,
  AttachmentIngestService,
  AttachmentRepository,
  inspectAttachmentFile,
} from '../../apps/api/dist/modules/attachments/index.js'
import { seedPhase8Workflow, syntheticPng } from '../helpers/phase8-seed.mjs'

describe('attachment attack and authorization boundary', () => {
  test.each([
    ['double extension', 'proof.png.exe', 'image/png', syntheticPng(), 1_024, 'DOUBLE_EXTENSION'],
    ['signature spoof', 'proof.png', 'image/png', Buffer.from('MZ executable'), 1_024, 'TYPE_SIGNATURE_MISMATCH'],
    ['declared mismatch', 'proof.pdf', 'application/pdf', syntheticPng(), 1_024, 'TYPE_SIGNATURE_MISMATCH'],
    ['oversize', 'proof.png', 'image/png', syntheticPng(), 4, 'FILE_TOO_LARGE'],
  ])(
    'rejects %s before a scanner or downstream consumer',
    (_label, filename, declaredType, bytes, maxBytes, reasonCode) => {
      expect(inspectAttachmentFile({ filename, declaredType, bytes, maxBytes })).toEqual({
        accepted: false,
        reasonCode,
      })
    },
  )

  test('returns indistinguishable failures for cross-owner and missing-object access', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      const storage = createFakeAttachmentStorage(Buffer.alloc(32, 10))
      const repository = new AttachmentRepository()
      const access = new AttachmentAccessService(pool, repository, storage, 300)
      try {
        const owner = await seedPhase8Workflow(pool, 'security-owner')
        const attacker = await seedPhase8Workflow(pool, 'security-attacker')
        const grant = await access.issueUploadGrant({
          workflowId: owner.workflowId,
          participantId: owner.participantId,
          expectedDeclaredType: 'image/png',
          maxBytes: 1_024,
          now: owner.now,
          expiresAt: new Date(owner.now.getTime() + 60_000),
        })
        const clean = await new AttachmentIngestService(
          pool,
          repository,
          access,
          storage,
          createFakeMalwareScanner([{ status: 'clean' }]),
          1_024,
        ).ingest({
          uploadToken: grant.token,
          workflowId: owner.workflowId,
          participantId: owner.participantId,
          sourceMessageReference: 'security-message',
          providerReference: 'security-provider-object',
          filename: 'proof.png',
          declaredType: 'image/png',
          bytes: syntheticPng(),
          receivedAt: owner.now,
        })

        const crossOwner = access.issueReadGrant({
          attachmentId: clean.evidence.id,
          workflowId: attacker.workflowId,
          participantId: attacker.participantId,
          now: new Date(owner.now.getTime() + 1_000),
        })
        const missing = access.issueReadGrant({
          attachmentId: randomUUID(),
          workflowId: attacker.workflowId,
          participantId: attacker.participantId,
          now: new Date(owner.now.getTime() + 1_000),
        })
        await expect(crossOwner).rejects.toMatchObject({ reasonCode: 'OWNERSHIP_MISMATCH' })
        await expect(missing).rejects.toMatchObject({ reasonCode: 'OWNERSHIP_MISMATCH' })

        const valid = await access.issueReadGrant({
          attachmentId: clean.evidence.id,
          workflowId: owner.workflowId,
          participantId: owner.participantId,
          now: new Date(owner.now.getTime() + 2_000),
        })
        await expect(
          access.consumeReadGrant({
            token: valid.token,
            workflowId: attacker.workflowId,
            participantId: attacker.participantId,
            now: new Date(owner.now.getTime() + 2_100),
          }),
        ).rejects.toMatchObject({ reasonCode: 'GRANT_INVALID' })
        await expect(
          access.consumeReadGrant({
            token: `hr_att_${'x'.repeat(43)}`,
            workflowId: attacker.workflowId,
            participantId: attacker.participantId,
            now: new Date(owner.now.getTime() + 2_100),
          }),
        ).rejects.toMatchObject({ reasonCode: 'GRANT_INVALID' })

        const columns = (
          await pool.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name IN ('attachments', 'attachment_access_grants')`,
          )
        ).rows.map((row) => row.column_name)
        expect(columns).not.toContain('signed_url')
        expect(columns).not.toContain('storage_credential')
        expect(columns).not.toContain('raw_token')
      } finally {
        await pool.end()
      }
    })
  })
})
