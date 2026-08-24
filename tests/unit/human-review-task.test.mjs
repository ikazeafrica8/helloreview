// Unit tier: T32 minimal, masked and automation-pausing human-review task creation.

import { describe, expect, test, vi } from 'vitest'
import { HumanReviewTaskService } from '../../apps/api/dist/modules/human-tasks/index.js'

describe('human-review task creation', () => {
  test('persists a masked case packet, high priority and an automation pause', async () => {
    const createdAt = new Date('2026-08-24T10:30:00Z')
    const query = vi.fn(async (_sql, values) => ({
      rows: [
        {
          id: 'task-a',
          workflow_reference: values[0],
          identity_resolution_id: values[1],
          reason_code: values[2],
          priority: values[3],
          status: 'open',
          case_packet: JSON.parse(values[4]),
          automation_paused: true,
          created_at: values[6],
        },
      ],
    }))
    const service = new HumanReviewTaskService()
    const task = await service.createIdentityReviewTask(
      { query },
      {
        workflowReference: 'pre-workflow:contact-a',
        identityResolutionId: 'resolution-a',
        reasonCode: 'IDENTITY_AMBIGUOUS',
        stateCode: 'ambiguous',
        evidenceCodes: ['phone_campaign', 'normalized_phone_campaign'],
        recommendationCode: 'VERIFY_IDENTITY_WITHOUT_DISCLOSURE',
        createdAt,
      },
    )
    expect(task).toMatchObject({ priority: 'high', status: 'open', automationPaused: true, createdAt })
    expect(task.casePacket).toEqual({
      stateCode: 'ambiguous',
      summaryCode: 'IDENTITY_AMBIGUOUS',
      evidenceCodes: ['phone_campaign', 'normalized_phone_campaign'],
      allowedActionCodes: ['VERIFY_IDENTITY', 'KEEP_AUTOMATION_PAUSED'],
      recommendationCode: 'VERIFY_IDENTITY_WITHOUT_DISCLOSURE',
    })
    const persistedPacket = query.mock.calls[0][1][4]
    expect(persistedPacket).not.toContain('applicantName')
    expect(persistedPacket).not.toContain('blogUrl')
    expect(persistedPacket).not.toContain('+821012345678')
  })
})
