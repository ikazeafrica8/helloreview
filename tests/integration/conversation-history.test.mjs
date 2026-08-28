import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  ConversationService,
  InboundMessageService,
  SecretCommentEvidenceService,
} from '../../apps/api/dist/modules/conversations/index.js'
import { conversationAt, seedConversationWorkflow } from '../helpers/conversation-seed.mjs'

const services = (pool) => ({
  conversations: new ConversationService(pool),
  messages: new InboundMessageService(pool),
  evidence: new SecretCommentEvidenceService(pool),
})

const observe = (overrides = {}) => ({
  provider: 'kakao_fixture',
  providerConversationId: 'thread-1',
  observedAt: conversationAt(),
  actorReference: 'system:conversation-test',
  ...overrides,
})

describe('T135 durable conversation and evidence history', () => {
  test('collapses a provider redelivery of one thread and keeps two providers separate', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        await seedConversationWorkflow(pool, 'observe')
        const { conversations } = services(pool)

        const first = await conversations.observe(observe())
        expect(first.created).toBe(true)
        const replay = await conversations.observe(observe({ observedAt: conversationAt(5) }))
        expect(replay.created).toBe(false)
        expect(replay.conversation.id).toBe(first.conversation.id)
        expect(replay.conversation.lastObservedAt.toISOString()).toBe(conversationAt(5).toISOString())

        // An out-of-order redelivery must not rewind the observation window.
        const late = await conversations.observe(observe({ observedAt: conversationAt(1) }))
        expect(late.conversation.lastObservedAt.toISOString()).toBe(conversationAt(5).toISOString())

        // The same thread number from a different provider is a different conversation.
        const otherProvider = await conversations.observe(observe({ provider: 'aligo_fixture' }))
        expect(otherProvider.created).toBe(true)
        expect(otherProvider.conversation.id).not.toBe(first.conversation.id)

        expect((await conversations.history(first.conversation.id)).map((event) => event.eventType)).toEqual([
          'observed',
        ])
      } finally {
        await pool.end()
      }
    })
  })

  test('preserves the previous belief when a conversation is reassigned to another participant', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedConversationWorkflow(pool, 'rebind')
        const { conversations } = services(pool)
        const { conversation } = await conversations.observe(observe())

        await conversations.bindParticipant({
          conversationId: conversation.id,
          participantId: ids.participantId,
          channelIdentityId: ids.channelIdentityId,
          campaignId: ids.campaignId,
          evidenceCategory: 'VERIFIED',
          actorReference: 'system:identity',
          occurredAt: conversationAt(1),
        })
        const rebound = await conversations.bindParticipant({
          conversationId: conversation.id,
          participantId: ids.otherParticipantId,
          evidenceCategory: 'OPERATOR_CORRECTION',
          actorReference: 'operator:pseudo:1',
          occurredAt: conversationAt(2),
        })
        expect(rebound.participantId).toBe(ids.otherParticipantId)

        const history = await conversations.history(conversation.id)
        expect(history.map((event) => event.eventType)).toEqual([
          'observed',
          'participant_bound',
          'participant_rebound',
        ])
        const rebind = (
          await pool.query(
            `SELECT from_participant_id, to_participant_id, evidence_category
               FROM conversation_events WHERE event_type = 'participant_rebound'`,
          )
        ).rows[0]
        expect(rebind).toMatchObject({
          from_participant_id: ids.participantId,
          to_participant_id: ids.otherParticipantId,
          evidence_category: 'OPERATOR_CORRECTION',
        })
      } finally {
        await pool.end()
      }
    })
  })

  test('records closed, ambiguous, and deleted lifecycles and refuses to reopen a deleted thread', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        await seedConversationWorkflow(pool, 'lifecycle')
        const { conversations } = services(pool)
        const { conversation } = await conversations.observe(observe())
        const lifecycle = (state, occurredAt) =>
          conversations.recordLifecycle({
            conversationId: conversation.id,
            state,
            evidenceCategory: 'PROVIDER_SIGNAL',
            actorReference: 'system:provider',
            occurredAt,
          })

        expect((await lifecycle('ambiguous', conversationAt(1))).state).toBe('ambiguous')
        expect((await lifecycle('active', conversationAt(2))).state).toBe('active')
        expect((await lifecycle('closed_by_provider', conversationAt(3))).state).toBe('closed_by_provider')
        expect((await lifecycle('deleted_by_provider', conversationAt(4))).state).toBe('deleted_by_provider')
        await expect(lifecycle('active', conversationAt(5))).rejects.toMatchObject({
          reasonCode: 'CONVERSATION_TERMINAL_STATE',
        })

        expect((await conversations.history(conversation.id)).map((event) => event.eventType)).toEqual([
          'observed',
          'marked_ambiguous',
          'ambiguity_resolved',
          'closed_by_provider',
          'deleted_by_provider',
        ])
      } finally {
        await pool.end()
      }
    })
  })

  test('separates a provider retry from a participant repeating themselves', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedConversationWorkflow(pool, 'messages')
        const { conversations, messages } = services(pool)
        const { conversation } = await conversations.observe(observe())
        await conversations.bindParticipant({
          conversationId: conversation.id,
          participantId: ids.participantId,
          evidenceCategory: 'VERIFIED',
          actorReference: 'system:identity',
          occurredAt: conversationAt(1),
        })
        await conversations.bindWorkflow({
          conversationId: conversation.id,
          workflowId: ids.workflowId,
          evidenceCategory: 'VERIFIED',
          actorReference: 'system:identity',
          occurredAt: conversationAt(1),
        })

        const record = (providerMessageId, bodyText, minutes) =>
          messages.record({
            conversationId: conversation.id,
            providerMessageId,
            participantId: ids.participantId,
            workflowId: ids.workflowId,
            messageKind: 'text',
            bodyText,
            classifiedPurposeCode: 'PARTICIPANT_QUESTION',
            providerSentAt: conversationAt(minutes),
            receivedAt: conversationAt(minutes),
          })

        const first = await record('m1', '예약 언제까지 하면 되나요?', 2)
        expect(first.deduplicated).toBe(false)

        // The SAME provider message id is one message arriving twice.
        const retry = await record('m1', '예약 언제까지 하면 되나요?', 2)
        expect(retry.deduplicated).toBe(true)
        expect(retry.message.id).toBe(first.message.id)

        // The same words under a NEW provider message id is a second participant action.
        const repeated = await record('m2', '예약 언제까지 하면 되나요?', 3)
        expect(repeated.deduplicated).toBe(false)
        expect(repeated.message.id).not.toBe(first.message.id)
        expect(repeated.message.contentDigest).toBe(first.message.contentDigest)
        expect(await messages.repeatedContentCount(conversation.id, first.message.contentDigest)).toBe(2)
        expect((await messages.thread(conversation.id)).map((message) => message.providerMessageId)).toEqual([
          'm1',
          'm2',
        ])
      } finally {
        await pool.end()
      }
    })
  })

  test('versions secret-comment evidence, supersedes a replacement screenshot, and stays supporting-only', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedConversationWorkflow(pool, 'evidence')
        const { evidence } = services(pool)

        const claimed = await evidence.append({
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          status: 'claimed',
          reasonCode: 'SECRET_COMMENT_CLAIMED',
          actorReference: 'system:intake',
          occurredAt: conversationAt(1),
        })
        expect(claimed).toMatchObject({ version: 1, supportingOnly: true, supersedesVersionId: null })

        await expect(
          evidence.append({
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            status: 'screenshot_received',
            reasonCode: 'SECRET_COMMENT_SCREENSHOT',
            actorReference: 'system:intake',
            occurredAt: conversationAt(2),
          }),
        ).rejects.toMatchObject({ reasonCode: 'SECRET_COMMENT_EVIDENCE_SCREENSHOT_REQUIRED' })

        await expect(
          evidence.append({
            workflowId: ids.workflowId,
            participantId: ids.otherParticipantId,
            status: 'claimed',
            reasonCode: 'SECRET_COMMENT_CLAIMED',
            actorReference: 'system:intake',
            occurredAt: conversationAt(2),
          }),
        ).rejects.toMatchObject({ reasonCode: 'SECRET_COMMENT_EVIDENCE_WORKFLOW_MISMATCH' })

        await expect(
          evidence.append({
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            status: 'rejected',
            reasonCode: 'SECRET_COMMENT_REJECTED',
            actorReference: 'system:intake',
            occurredAt: conversationAt(0),
          }),
        ).rejects.toMatchObject({ reasonCode: 'SECRET_COMMENT_EVIDENCE_STALE_EVENT' })

        const superseding = await evidence.append({
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          status: 'rejected',
          reasonCode: 'SECRET_COMMENT_UNREADABLE',
          actorReference: 'operator:pseudo:2',
          occurredAt: conversationAt(3),
        })
        expect(superseding).toMatchObject({ version: 2, supersedesVersionId: claimed.id })
        expect((await evidence.current(ids.workflowId))?.version).toBe(2)
        expect((await evidence.history(ids.workflowId)).map((item) => item.version)).toEqual([1, 2])

        // The evidence model has no column that could carry authority, and the CHECK pins the flag.
        const columns = (
          await pool.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'secret_comment_evidence_versions'`,
          )
        ).rows.map((row) => row.column_name)
        for (const forbidden of ['application_id', 'selection_state', 'verified', 'approval_state', 'match_category'])
          expect(columns).not.toContain(forbidden)
        await expect(
          pool.query(
            `INSERT INTO secret_comment_evidence_versions (
             workflow_id, participant_id, version, status, reason_code, supporting_only, actor_reference, occurred_at
           ) VALUES ($1,$2,99,'claimed','SECRET_COMMENT_CLAIMED',false,'system:test',$3)`,
            [ids.workflowId, ids.participantId, conversationAt(4)],
          ),
        ).rejects.toThrow(/secret_comment_evidence_versions_supporting_only/)
      } finally {
        await pool.end()
      }
    })
  })

  test('links an attachment to the message it arrived on without exposing a storage path', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedConversationWorkflow(pool, 'attachment')
        const { conversations, messages } = services(pool)
        const { conversation } = await conversations.observe(observe())
        await conversations.bindParticipant({
          conversationId: conversation.id,
          participantId: ids.participantId,
          evidenceCategory: 'VERIFIED',
          actorReference: 'system:identity',
          occurredAt: conversationAt(1),
        })
        const recorded = await messages.record({
          conversationId: conversation.id,
          providerMessageId: 'm-attachment',
          participantId: ids.participantId,
          workflowId: ids.workflowId,
          messageKind: 'attachment',
          providerSentAt: conversationAt(2),
          receivedAt: conversationAt(2),
        })
        await pool.query(
          `INSERT INTO attachments (
             workflow_id, participant_id, source_message_reference, provider_reference,
             declared_type, detected_type, size_bytes, content_hash, storage_reference,
             inbound_message_id, created_at
           ) VALUES ($1,$2,$3,'provider-ref-1','image/png','image/png',2048,$4,'object://opaque/1',$5,$6)`,
          [
            ids.workflowId,
            ids.participantId,
            recorded.message.id,
            'a'.repeat(64),
            recorded.message.id,
            conversationAt(2),
          ],
        )
        const linked = (
          await pool.query(
            `SELECT a.inbound_message_id, a.storage_reference FROM attachments a WHERE a.workflow_id = $1`,
            [ids.workflowId],
          )
        ).rows[0]
        expect(linked.inbound_message_id).toBe(recorded.message.id)
        expect(linked.storage_reference).not.toMatch(/^https?:\/\//)

        // The screenshot and the claim reference each other through ids only.
        const attachmentId = (await pool.query(`SELECT id FROM attachments WHERE workflow_id = $1`, [ids.workflowId]))
          .rows[0].id
        const { evidence } = services(pool)
        const withScreenshot = await evidence.append({
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          status: 'screenshot_received',
          inboundMessageId: recorded.message.id,
          attachmentId,
          reasonCode: 'SECRET_COMMENT_SCREENSHOT',
          actorReference: 'system:intake',
          occurredAt: conversationAt(3),
        })
        expect(withScreenshot).toMatchObject({ attachmentId, inboundMessageId: recorded.message.id, version: 1 })
      } finally {
        await pool.end()
      }
    })
  })
})
