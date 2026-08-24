import { describe, expect, test, vi } from 'vitest'
import { createAuditGuidelineDeliveriesHandler } from '../../apps/worker/dist/processors/index.js'

describe('independent guideline-delivery audit worker', () => {
  test('runs the injected auditor with the worker clock', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const auditBatch = vi.fn().mockResolvedValue({ inspected: 2 })
    const handler = createAuditGuidelineDeliveriesHandler({ auditBatch }, () => now)

    await handler()

    expect(auditBatch).toHaveBeenCalledOnce()
    expect(auditBatch).toHaveBeenCalledWith(now)
  })
})
