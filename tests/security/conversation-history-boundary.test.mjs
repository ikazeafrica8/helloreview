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

const PARTICIPANT_TEXT = '제 전화번호는 010-5555-1111 이고 서울시 강남구에 살아요'

const prepared = async (pool, suffix) => {
  const ids = await seedConversationWorkflow(pool, suffix)
  const conversations = new ConversationService(pool)
  const messages = new InboundMessageService(pool)
  const { conversation } = await conversations.observe({
    provider: 'kakao_fixture',
    providerConversationId: `thread-${suffix}`,
    observedAt: conversationAt(),
    actorReference: 'system:security-test',
  })
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
  const recorded = await messages.record({
    conversationId: conversation.id,
    providerMessageId: `m-${suffix}`,
    participantId: ids.participantId,
    workflowId: ids.workflowId,
    messageKind: 'text',
    bodyText: PARTICIPANT_TEXT,
    providerSentAt: conversationAt(2),
    receivedAt: conversationAt(2),
  })
  return { ids, conversation, conversations, messages, recorded }
}

describe('T135 conversation history security boundary', () => {
  test('refuses to rewrite or delete any append-only conversation history', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const { conversation, recorded, ids } = await prepared(pool, 'immutable')
        await new SecretCommentEvidenceService(pool).append({
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          status: 'claimed',
          reasonCode: 'SECRET_COMMENT_CLAIMED',
          actorReference: 'system:intake',
          occurredAt: conversationAt(3),
        })

        // The ENABLE ALWAYS triggers hold even for the migration owner, which a REVOKE cannot reach.
        await expect(
          pool.query(`UPDATE inbound_messages SET body_text = 'rewritten' WHERE id = $1`, [recorded.message.id]),
        ).rejects.toThrow(/append-only/)
        await expect(pool.query(`DELETE FROM inbound_messages WHERE id = $1`, [recorded.message.id])).rejects.toThrow(
          /append-only/,
        )
        await expect(
          pool.query(`UPDATE conversation_events SET reason_code = 'REWRITTEN' WHERE conversation_id = $1`, [
            conversation.id,
          ]),
        ).rejects.toThrow(/append-only/)
        await expect(
          pool.query(`DELETE FROM conversation_events WHERE conversation_id = $1`, [conversation.id]),
        ).rejects.toThrow(/append-only/)
        await expect(
          pool.query(`UPDATE secret_comment_evidence_versions SET status = 'claimed' WHERE workflow_id = $1`, [
            ids.workflowId,
          ]),
        ).rejects.toThrow(/append-only/)
        // Nothing references conversation_events, so TRUNCATE reaches the trigger rather than
        // being stopped earlier by a foreign key.
        await expect(pool.query(`TRUNCATE conversation_events`)).rejects.toThrow(/append-only/)
        // inbound_messages is referenced by attachments and secret-comment evidence, so the foreign
        // key refuses first. Either way it cannot be emptied.
        await expect(pool.query(`TRUNCATE inbound_messages`)).rejects.toThrow(
          /append-only|referenced in a foreign key constraint/,
        )

        // The mutable head is still writable — its history is what is frozen.
        await expect(
          pool.query(`UPDATE conversations SET last_observed_at = $2 WHERE id = $1`, [
            conversation.id,
            conversationAt(9),
          ]),
        ).resolves.toBeTruthy()
      } finally {
        await pool.end()
      }
    })
  })

  test('never returns participant message text from a conversation read path', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const { conversation, conversations, messages, recorded } = await prepared(pool, 'nodisclosure')

        const surfaces = [
          await conversations.current('kakao_fixture', 'thread-nodisclosure'),
          await conversations.history(conversation.id),
          await messages.thread(conversation.id),
          recorded,
        ]
        for (const surface of surfaces) {
          const serialized = JSON.stringify(surface)
          expect(serialized).not.toContain(PARTICIPANT_TEXT)
          expect(serialized).not.toContain('010-5555-1111')
          expect(serialized).toContainNoPii()
        }

        // The text really is stored — this is a disclosure boundary, not a claim that nothing is kept.
        expect(
          (await pool.query(`SELECT body_text FROM inbound_messages WHERE id = $1`, [recorded.message.id])).rows[0]
            .body_text,
        ).toBe(PARTICIPANT_TEXT)
      } finally {
        await pool.end()
      }
    })
  })

  test('keeps the operator timeline projection free of message bodies', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const { ids, conversation } = await prepared(pool, 'timeline')
        await new SecretCommentEvidenceService(pool).append({
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          status: 'claimed',
          reasonCode: 'SECRET_COMMENT_CLAIMED',
          actorReference: 'system:intake',
          occurredAt: conversationAt(3),
        })

        // The same UNION the admin timeline runs, checked for what it must not carry.
        const projected = await pool.query(
          `SELECT m.id, 'messages' AS category, 'INBOUND_MESSAGE_RECEIVED' AS event_code,
                  m.classified_purpose_code AS reason_code, m.message_kind::text AS state_code
             FROM inbound_messages m WHERE m.workflow_id = $1
           UNION ALL
           SELECT v.id, 'secret_comment_evidence', 'SECRET_COMMENT_EVIDENCE_' || upper(v.status::text),
                  v.reason_code, v.status::text
             FROM secret_comment_evidence_versions v WHERE v.workflow_id = $1`,
          [ids.workflowId],
        )
        expect(projected.rows).toHaveLength(2)
        const serialized = JSON.stringify(projected.rows)
        expect(serialized).not.toContain(PARTICIPANT_TEXT)
        expect(serialized).not.toContain('010-5555-1111')
        expect(serialized).toContainNoPii()
        expect(conversation.id).toBeTypeOf('string')
      } finally {
        await pool.end()
      }
    })
  })

  test('cannot bind a workflow to an unattributed conversation', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedConversationWorkflow(pool, 'unattributed')
        const conversations = new ConversationService(pool)
        const { conversation } = await conversations.observe({
          provider: 'kakao_fixture',
          providerConversationId: 'thread-unattributed',
          observedAt: conversationAt(),
          actorReference: 'system:security-test',
        })
        await expect(
          conversations.bindWorkflow({
            conversationId: conversation.id,
            workflowId: ids.workflowId,
            evidenceCategory: 'VERIFIED',
            actorReference: 'system:identity',
            occurredAt: conversationAt(1),
          }),
        ).rejects.toMatchObject({ reasonCode: 'CONVERSATION_PARTICIPANT_REQUIRED' })

        // And the database refuses it too, so a direct writer cannot route around the service.
        await expect(
          pool.query(`UPDATE conversations SET workflow_id = $2 WHERE id = $1`, [conversation.id, ids.workflowId]),
        ).rejects.toThrow(/conversations_binding_coherence/)
      } finally {
        await pool.end()
      }
    })
  })
})
