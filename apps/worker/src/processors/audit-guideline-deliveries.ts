import type { Job } from 'bullmq'
import type { JobHandler } from '../runtime.js'

export type GuidelineDeliveryAuditor = Readonly<{
  auditBatch: (now: Date, limit?: number) => Promise<Readonly<{ inspected: number }>>
}>

/** Queue adapter kept independent from the API implementation; production injects the auditor port. */
export const createAuditGuidelineDeliveriesHandler =
  (auditor: GuidelineDeliveryAuditor, now: () => Date = () => new Date()): JobHandler =>
  async (_job: Job): Promise<void> => {
    await auditor.auditBatch(now())
  }
