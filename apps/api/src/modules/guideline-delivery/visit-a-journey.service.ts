import { Injectable } from '@nestjs/common'
import {
  VisitAReservationService,
  type VisitAReservationIntakeInput,
  type VisitAReservationIntakeResult,
} from '../reservation/index.js'
import { GuidelineDeliveryService, type GuidelineDeliveryRequestResult } from './guideline-delivery.service.js'

export type VisitAJourneyInput = VisitAReservationIntakeInput & Readonly<{ guidelineTemplateVersion: number }>

export type VisitAJourneyResult = Readonly<{
  reservation: VisitAReservationIntakeResult
  guideline?: GuidelineDeliveryRequestResult
}>

/** T87 composition boundary: extraction can propose facts; only a valid deterministic result can request delivery. */
@Injectable()
export class VisitAJourneyService {
  constructor(
    private readonly reservations: VisitAReservationService,
    private readonly guidelines: GuidelineDeliveryService,
  ) {}

  async process(input: VisitAJourneyInput): Promise<VisitAJourneyResult> {
    const reservation = await this.reservations.intake(input)
    if (reservation.route !== 'ready' || reservation.validation === undefined) return { reservation }
    const guideline = await this.guidelines.request({
      workflowId: input.workflowId,
      channel: 'KAKAO',
      recipientReference: input.recipientReference,
      templateVersion: input.guidelineTemplateVersion,
      triggeringEventId: input.sourceEventId,
      actorId: input.automationActorId,
      occurredAt: input.occurredAt,
      consentTermsVersion: null,
      activeTermsVersion: null,
      safeScreenshotReceived: true,
      criticalFieldsExtracted: true,
      shippingPrerequisitesSatisfied: true,
      paybackPrerequisitesSatisfied: true,
      reservationValidation: reservation.validation,
    })
    return { reservation, guideline }
  }
}
