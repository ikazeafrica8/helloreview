import { describe, expect, test } from 'vitest'
import { MESSAGE_PURPOSES } from './purposes.js'
import { OUTBOUND_CHANNELS, buildDedupeKey } from './dedupe-key.js'

describe('buildDedupeKey', () => {
  test('round-trips the PRD §17.4 logical example exactly', () => {
    expect(
      buildDedupeKey({
        channel: OUTBOUND_CHANNELS.KAKAO,
        workflowId: 'wf_123',
        applicationId: 'app_456',
        campaignId: 'camp_789',
        purpose: MESSAGE_PURPOSES.GUIDELINE_DELIVERY,
        contentVersion: 'guideline_v4',
      }),
    ).toBe('KAKAO|wf_123|app_456|camp_789|GUIDELINE_DELIVERY|guideline_v4')
  })

  test('includes participant, business-event, and authorization identity in canonical order', () => {
    const input = {
      channel: OUTBOUND_CHANNELS.KAKAO,
      workflowId: 'wf_1',
      participantId: 'participant_2',
      applicationId: 'app_3',
      campaignId: 'campaign_4',
      purpose: MESSAGE_PURPOSES.GUIDELINE_REDELIVERY,
      contentVersion: 'guideline_v5',
      businessEventVersion: 'event_v6',
      authorizedRedeliveryId: 'approval_7',
    } as const

    expect(buildDedupeKey(input)).toBe(
      'KAKAO|wf_1|participant_2|app_3|campaign_4|GUIDELINE_REDELIVERY|guideline_v5|event_v6|approval_7',
    )
    expect(buildDedupeKey(input)).toBe(buildDedupeKey(input))
  })

  test('omits every optional scope without empty separators', () => {
    expect(
      buildDedupeKey({
        channel: OUTBOUND_CHANNELS.KAKAO,
        workflowId: 'wf_minimal',
        purpose: MESSAGE_PURPOSES.SYSTEM_DELAY_NOTICE,
        contentVersion: 'template_v1',
      }),
    ).toBe('KAKAO|wf_minimal|SYSTEM_DELAY_NOTICE|template_v1')
  })

  test.each([
    ['empty', ''],
    ['surrounding whitespace', ' wf_1'],
    ['separator injection', 'wf|1'],
  ])('rejects %s segments', (_label, workflowId) => {
    expect(() =>
      buildDedupeKey({
        channel: OUTBOUND_CHANNELS.KAKAO,
        workflowId,
        purpose: MESSAGE_PURPOSES.SYSTEM_DELAY_NOTICE,
        contentVersion: 'template_v1',
      }),
    ).toThrow('invalid workflowId dedupe-key segment')
  })
})
