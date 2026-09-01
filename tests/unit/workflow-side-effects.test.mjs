import { describe, expect, test, vi } from 'vitest'
import {
  WORKFLOW_SIDE_EFFECT_DISPATCH_REASON,
  WorkflowSideEffectDispatchError,
  assertWorkflowSideEffectHandlerCoverage,
  createWorkflowSideEffectDispatcher,
} from '../../apps/worker/dist/processors/index.js'
import { WORKFLOW_SIDE_EFFECT } from '../../packages/workflow-runtime/dist/index.js'

const effectId = '11111111-1111-4111-8111-111111111111'
const workflowId = '22222222-2222-4222-8222-222222222222'
const workflowEventId = '33333333-3333-4333-8333-333333333333'
const participantId = '44444444-4444-4444-8444-444444444444'
const campaignId = '55555555-5555-4555-8555-555555555555'
const completedAt = new Date('2026-09-01T02:00:00Z')

const harness = (overrides = {}, paused = false) => {
  const state = {
    effect: {
      id: effectId,
      workflow_id: workflowId,
      workflow_event_id: workflowEventId,
      dimension: 'application',
      effect_code: WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING,
      participant_id: participantId,
      campaign_id: campaignId,
      campaign_type: 'shipping',
      automation_mode_state: 'active',
      current_workflow_version: 1,
      source_workflow_version: 1,
      source_event_kind: 'initialized',
      source_trigger_code: 'WORKFLOW_INITIALIZED',
      campaign_status: 'active',
      ...overrides,
    },
    status: 'pending',
    reasonCode: null,
  }
  const tx = {
    query: async (sql, values = []) => {
      if (sql.includes('FROM workflow_side_effects s')) {
        return { rows: state.status === 'pending' ? [{ ...state.effect }] : [] }
      }
      if (sql.includes('FROM automation_pauses')) return { rows: paused ? [{ id: 'pause' }] : [] }
      if (sql.startsWith('UPDATE workflow_side_effects')) {
        state.status = values[1]
        state.reasonCode = values[2]
        return { rows: [{ id: effectId }] }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  return { state, db: { transaction: async (operation) => operation(tx) } }
}

describe('workflow side effect dispatcher', () => {
  test('claims and completes a registered deterministic handler exactly once', async () => {
    const testHarness = harness()
    const handler = vi.fn(async () => ({ status: 'completed' }))
    const dispatcher = createWorkflowSideEffectDispatcher({
      db: testHarness.db,
      handlers: { [WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING]: handler },
      now: () => completedAt,
    })

    await expect(dispatcher.dispatchOne(effectId)).resolves.toMatchObject({ status: 'completed', effectId })
    await expect(dispatcher.dispatchOne(effectId)).resolves.toEqual({ status: 'idle' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(testHarness.state).toMatchObject({ status: 'completed', reasonCode: null })
  })

  test('suppresses stale and human-owned effects without invoking their handler', async () => {
    const staleHarness = harness({ current_workflow_version: 2 })
    const humanHarness = harness({ automation_mode_state: 'human_owned' })
    const handler = vi.fn(async () => ({ status: 'completed' }))
    const handlers = { [WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING]: handler }

    await expect(
      createWorkflowSideEffectDispatcher({ db: staleHarness.db, handlers }).dispatchOne(),
    ).resolves.toMatchObject({
      status: 'suppressed',
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.STALE_WORKFLOW_VERSION,
    })
    await expect(
      createWorkflowSideEffectDispatcher({ db: humanHarness.db, handlers }).dispatchOne(),
    ).resolves.toMatchObject({
      status: 'suppressed',
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.HUMAN_OWNERSHIP_ACTIVE,
    })
    expect(handler).not.toHaveBeenCalled()
  })

  test('leaves a paused effect pending for a later retry', async () => {
    const testHarness = harness({}, true)
    const handler = vi.fn(async () => ({ status: 'completed' }))
    const dispatcher = createWorkflowSideEffectDispatcher({
      db: testHarness.db,
      handlers: { [WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING]: handler },
    })

    await expect(dispatcher.dispatchBatch()).resolves.toEqual({ inspected: 1, finalized: 0, blocked: true })
    expect(testHarness.state.status).toBe('pending')
    expect(handler).not.toHaveBeenCalled()
  })

  test('leaves handler-deferred work pending without treating it as a failure', async () => {
    const testHarness = harness()
    const dispatcher = createWorkflowSideEffectDispatcher({
      db: testHarness.db,
      handlers: {
        [WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING]: async () => ({
          status: 'blocked',
          reasonCode: 'IDENTITY_MATCHING_CANDIDATE_RESOLUTION_PENDING',
        }),
      },
    })

    await expect(dispatcher.dispatchOne()).resolves.toMatchObject({
      status: 'blocked',
      reasonCode: 'IDENTITY_MATCHING_CANDIDATE_RESOLUTION_PENDING',
    })
    expect(testHarness.state.status).toBe('pending')
  })

  test('cancels closed-campaign work and leaves handler failures pending for retry', async () => {
    const closedHarness = harness({ campaign_status: 'closed' })
    await expect(
      createWorkflowSideEffectDispatcher({ db: closedHarness.db, handlers: {} }).dispatchOne(),
    ).resolves.toMatchObject({ status: 'cancelled', reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.CAMPAIGN_CLOSED })
    expect(closedHarness.state.status).toBe('cancelled')

    const retryHarness = harness()
    const failure = Object.assign(new Error('temporary internal dependency failure'), {
      reasonCode: 'INTERNAL_DEPENDENCY_UNAVAILABLE',
    })
    const dispatcher = createWorkflowSideEffectDispatcher({
      db: retryHarness.db,
      handlers: { [WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING]: async () => Promise.reject(failure) },
    })
    await expect(dispatcher.dispatchOne()).rejects.toBe(failure)
    expect(retryHarness.state.status).toBe('pending')
  })

  test('allows safety-control work through a pause but fails closed for missing handlers', async () => {
    const controlHarness = harness(
      { effect_code: WORKFLOW_SIDE_EFFECT.CREATE_HUMAN_TASK, automation_mode_state: 'human_owned' },
      true,
    )
    const handler = vi.fn(async () => ({ status: 'completed' }))
    const dispatcher = createWorkflowSideEffectDispatcher({
      db: controlHarness.db,
      handlers: { [WORKFLOW_SIDE_EFFECT.CREATE_HUMAN_TASK]: handler },
    })
    await expect(dispatcher.dispatchOne()).resolves.toMatchObject({ status: 'completed' })
    expect(handler).toHaveBeenCalledTimes(1)

    const missingHarness = harness()
    await expect(
      createWorkflowSideEffectDispatcher({ db: missingHarness.db, handlers: {} }).dispatchOne(),
    ).rejects.toMatchObject({ reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.HANDLER_MISSING })
    expect(missingHarness.state.status).toBe('pending')
  })

  test('requires complete handler coverage before a future startup binding', () => {
    expect(() => assertWorkflowSideEffectHandlerCoverage({})).toThrowError(WorkflowSideEffectDispatchError)
  })
})
