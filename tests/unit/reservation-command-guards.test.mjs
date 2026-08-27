import { describe, expect, test, vi } from 'vitest'
import { ReservationService, VisitAReservationService } from '../../apps/api/src/modules/reservation/index.ts'

const occurredAt = new Date('2026-08-26T01:00:00.000Z')

const reservationInput = (overrides = {}) => ({
  workflowId: '0a4c62d0-91bd-46d1-a8a5-4343a2832e25',
  participantId: '2c6e84f2-b3df-48f3-8ac7-6565c4a54047',
  source: 'participant',
  sourceReference: 'reservation-message-1',
  extractionProvenance: {},
  reservedDate: '2026-08-27',
  reservedTime: '14:00:00',
  timezone: 'Asia/Seoul',
  businessReference: 'test-business',
  visitMethod: 'visit_a',
  status: 'pending',
  cancellationReason: null,
  validationState: 'pending',
  validationAuthority: 'none',
  ruleVersion: null,
  validationEvidence: {},
  actorType: 'participant',
  actorReference: 'masked-participant',
  authorized: true,
  occurredAt,
  ...overrides,
})

describe('reservation command safety guards', () => {
  test('rejects incomplete deterministic validation and cancellation evidence before storage', async () => {
    const pool = { connect: vi.fn(), query: vi.fn() }
    const service = new ReservationService(pool)

    await expect(
      service.recordVersion(reservationInput({ validationAuthority: 'deterministic_rules' })),
    ).rejects.toMatchObject({ reasonCode: 'RESERVATION_RULE_VERSION_REQUIRED' })
    await expect(service.recordVersion(reservationInput({ status: 'cancelled' }))).rejects.toMatchObject({
      reasonCode: 'RESERVATION_CANCELLATION_REASON_REQUIRED',
    })

    expect(pool.connect).not.toHaveBeenCalled()
    expect(pool.query).not.toHaveBeenCalled()
  })

  test('rejects malformed Visit A source and lifecycle commands before extraction or storage', async () => {
    const pool = { connect: vi.fn(), query: vi.fn() }
    const dateTimes = { extract: vi.fn() }
    const reservations = { recordVersionInTransaction: vi.fn() }
    const intents = { enqueueIntent: vi.fn() }
    const service = new VisitAReservationService(pool, dateTimes, reservations, intents)
    const command = {
      workflowId: '0a4c62d0-91bd-46d1-a8a5-4343a2832e25',
      participantId: '2c6e84f2-b3df-48f3-8ac7-6565c4a54047',
      sourceEventId: ' ',
      text: '2026년 8월 27일 오후 2시에 예약했어요',
      messageTimestamp: occurredAt,
      businessName: 'test-business',
      businessBranch: null,
      recipientReference: 'masked-kakao',
      correctionTemplateVersion: 1,
      templateVersion: 1,
      participantReference: 'masked-participant',
      automationActorId: 'reservation-automation',
      occurredAt,
    }

    await expect(service.intake(command)).rejects.toMatchObject({ reasonCode: 'RESERVATION_SOURCE_REQUIRED' })
    await expect(service.cancel({ ...command, reasonCode: 'free form reason' })).rejects.toMatchObject({
      reasonCode: 'RESERVATION_CANCELLATION_REASON_INVALID',
    })

    expect(dateTimes.extract).not.toHaveBeenCalled()
    expect(pool.connect).not.toHaveBeenCalled()
    expect(pool.query).not.toHaveBeenCalled()
  })
})
