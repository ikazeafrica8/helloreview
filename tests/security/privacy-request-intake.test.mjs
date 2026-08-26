import { describe, expect, test } from 'vitest'
import {
  PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
  PRIVACY_REQUEST_SCOPE_VERSION,
  PrivacyRequestService,
} from '../../apps/api/dist/modules/privacy-ops/index.js'

describe('T96 privacy-request intake safety', () => {
  test('rejects raw contact data before the request or audit evidence is stored', async () => {
    const databaseMustNotBeReached = {
      connect: () => {
        throw new Error('database reached before privacy input validation')
      },
    }
    const service = new PrivacyRequestService(databaseMustNotBeReached)
    await expect(
      service.intake({
        requestReference: 'privacy-request:pseudo:security',
        requesterReference: '010-1234-5678',
        claimedParticipantId: null,
        requestType: 'unspecified',
        scope: {
          schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
          state: 'unconfirmed',
          subjectReference: 'participant:pseudo:security',
          dataClasses: [],
          campaignReferences: [],
          workflowReferences: [],
        },
        deadlinePolicy: null,
        assigneeId: null,
        evidence: {
          schemaVersion: PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
          channel: 'kakao',
          reference: 'message:pseudo:security',
        },
        actorType: 'participant',
        actorReference: 'participant:pseudo:security',
        sourceAuthorized: true,
        correlationId: 'cor:privacy:security',
        occurredAt: new Date('2026-08-26T07:05:00.000Z'),
      }),
    ).rejects.toMatchObject({ reasonCode: 'PRIVACY_REQUEST_REQUESTER_REFERENCE_INVALID' })
  })
})
