import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  buildHumanReviewCasePacket,
  HumanReviewOperationsService,
  HUMAN_REVIEW_REASON,
} from '../../apps/api/dist/modules/human-tasks/index.js'
import {
  HumanOwnershipService,
  MessageTemplateRepository,
  OutboundIntentService,
} from '../../apps/api/dist/modules/messaging/index.js'
import {
  AutomationPauseService,
  HumanHandoffProjectionService,
} from '../../apps/api/dist/modules/workflow-core/index.js'
import { seedPhase6Workflow } from '../helpers/phase6-seed.mjs'

const serviceFor = (pool) =>
  new HumanReviewOperationsService(
    pool,
    new OutboundIntentService(new MessageTemplateRepository()),
    new HumanOwnershipService(pool),
    new AutomationPauseService(pool),
    new HumanHandoffProjectionService(),
  )

describe('T95 complete human-handoff journey', () => {
  test('deduplicates, denies unauthorized and stale work, then resumes only after current validation', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase6Workflow(pool, 't95-handoff')
        await pool.query(
          `INSERT INTO message_templates (
             purpose_code, version, status, legal_classification, body,
             approved_by, approved_at, activated_at
           ) VALUES ('HUMAN_HANDOFF_HOLDING',1,'active','service_notice',
                     '담당자가 확인하고 있습니다.','legal_t95',$1,$1)`,
          [ids.now],
        )
        const packet = buildHumanReviewCasePacket({
          workflowReference: ids.workflowId,
          workflowStateCode: 'HUMAN_REVIEW_REQUIRED',
          maskedIdentity: {
            participantReference: 'participant:masked:t95',
            displayName: '테**',
            phone: '010-****-9999',
          },
          application: { reference: 'application:pseudo:t95', lifecycleStatusCode: 'RECEIVED' },
          campaign: { reference: 'campaign:pseudo:t95', typeCode: 'SHIPPING' },
          summaryCode: HUMAN_REVIEW_REASON.COMPLAINT,
          evidence: [
            {
              evidenceCode: 'PARTICIPANT_MESSAGE',
              reference: 'message:pseudo:t95',
              observedAt: ids.now.toISOString(),
            },
          ],
          rules: [{ ruleCode: 'COMPLAINT_HANDOFF', resultCode: 'REQUIRED', version: 'handoff-v1' }],
          allowedActionCodes: ['SEND_APPROVED_MESSAGE', 'RETURN_TO_AUTOMATION'],
          priority: 'high',
          recommendationCode: 'OPERATOR_REVIEW_REQUIRED',
          createdAt: ids.now,
        })
        const service = serviceFor(pool)
        const openCommand = {
          workflowId: ids.workflowId,
          expectedWorkflowVersion: 0,
          reasonCode: HUMAN_REVIEW_REASON.COMPLAINT,
          casePacket: packet,
          recipientReference: 'kakao:pseudo:t95',
          channel: 'KAKAO',
          holdingTemplateVersion: 1,
          actorType: 'system',
          actorId: 'handoff_router_t95',
          correlationId: 'cor:t95:open',
          deduplicationKey: `handoff:${ids.workflowId}:t95`,
          occurredAt: ids.now,
          slaPolicy: null,
        }
        const opened = await service.openEpisode(openCommand)
        expect(await service.openEpisode(openCommand)).toMatchObject({
          deduplicated: true,
          task: { id: opened.task.id },
        })
        expect(
          (
            await pool.query(
              `SELECT human_handoff_state, automation_mode_state, version
                 FROM workflow_instances WHERE id = $1`,
              [ids.workflowId],
            )
          ).rows[0],
        ).toEqual({ human_handoff_state: 'queued', automation_mode_state: 'paused_for_human', version: 2 })

        await expect(
          service.assign({
            taskId: opened.task.id,
            operatorId: 'operator:pseudo:t95',
            authorized: false,
            expectedWorkflowVersion: 2,
            reasonCode: 'OPERATOR_CLAIMED',
            correlationId: 'cor:t95:unauthorized-assign',
            occurredAt: new Date(ids.now.getTime() + 30_000),
          }),
        ).rejects.toMatchObject({ reasonCode: 'HUMAN_REVIEW_OPERATOR_NOT_AUTHORIZED' })
        const assigned = await service.assign({
          taskId: opened.task.id,
          operatorId: 'operator:pseudo:t95',
          authorized: true,
          expectedWorkflowVersion: 2,
          reasonCode: 'OPERATOR_CLAIMED',
          correlationId: 'cor:t95:assign',
          occurredAt: new Date(ids.now.getTime() + 60_000),
        })
        expect(assigned).toMatchObject({ status: 'in_progress', assigneeId: 'operator:pseudo:t95' })

        const resolution = (overrides = {}) => ({
          taskId: opened.task.id,
          operatorId: 'operator:pseudo:t95',
          authorized: true,
          expectedWorkflowVersion: 4,
          resolutionCode: 'COMPLAINT_REVIEWED',
          resolutionReason: 'Operator reviewed current workflow evidence.',
          validation: {
            optOutClear: true,
            requiredEvidenceCurrent: true,
            deterministicReadinessPassed: true,
            policyVersion: 'human-return-v1',
            evaluatedAt: new Date(ids.now.getTime() + 89_000),
          },
          correlationId: 'cor:t95:resolve',
          occurredAt: new Date(ids.now.getTime() + 90_000),
          ...overrides,
        })
        await expect(
          service.resolveAndReturn(
            resolution({
              expectedWorkflowVersion: 2,
              correlationId: 'cor:t95:stale-resume',
            }),
          ),
        ).rejects.toMatchObject({ reasonCode: 'HUMAN_REVIEW_RESUME_STATE_INVALID' })
        await expect(
          service.resolveAndReturn(
            resolution({
              validation: {
                ...resolution().validation,
                requiredEvidenceCurrent: false,
                evaluatedAt: new Date(ids.now.getTime() + 99_000),
              },
              correlationId: 'cor:t95:incomplete-resume',
              occurredAt: new Date(ids.now.getTime() + 100_000),
            }),
          ),
        ).rejects.toMatchObject({ reasonCode: 'HUMAN_REVIEW_RESUME_STATE_INVALID' })

        expect(
          await service.resolveAndReturn(
            resolution({
              validation: {
                ...resolution().validation,
                evaluatedAt: new Date(ids.now.getTime() + 109_000),
              },
              occurredAt: new Date(ids.now.getTime() + 110_000),
            }),
          ),
        ).toMatchObject({ status: 'resolved' })
        expect(
          (
            await pool.query(
              `SELECT human_handoff_state, automation_mode_state, version
                 FROM workflow_instances WHERE id = $1`,
              [ids.workflowId],
            )
          ).rows[0],
        ).toEqual({ human_handoff_state: 'returned_to_automation', automation_mode_state: 'active', version: 6 })
        expect(
          (
            await pool.query(
              `SELECT event_type FROM human_review_task_events
                WHERE task_id = $1 ORDER BY occurred_at, event_type`,
              [opened.task.id],
            )
          ).rows.map((row) => row.event_type),
        ).toEqual([
          'created',
          'holding_queued',
          'assigned',
          'resume_rejected',
          'resume_rejected',
          'resolution_recorded',
          'returned_to_automation',
        ])
        expect(
          (await pool.query(`SELECT count(*)::integer AS count FROM human_review_holding_messages`)).rows[0].count,
        ).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })
})
