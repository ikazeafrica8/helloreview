import { describe, expect, test } from 'vitest'
import { planWorkflowCorrection } from '../../apps/api/dist/modules/workflow-core/index.js'

const baseline = () => ({
  application: 'application_requested',
  selection: 'not_reviewed',
  campaign_type: 'shipping',
  visit_method: 'not_applicable',
  secret_comment: 'not_claimed',
  payback_consent: 'not_applicable',
  business_approval: 'not_required',
  shipping: 'address_requested',
  reservation: 'not_applicable',
  guideline: 'not_ready',
  human_handoff: 'not_required',
  automation_mode: 'active',
})

const currentApplicationEvent = (overrides = {}) => ({
  dimension: 'application',
  targetState: 'application_requested',
  result: 'success',
  superseded: false,
  ...overrides,
})

describe('workflow correction and supersession policy', () => {
  test('an eligible correction preserves the prior snapshot and declares fail-closed re-evaluation', () => {
    const snapshot = baseline()
    const plan = planWorkflowCorrection(
      snapshot,
      { dimension: 'application', to: 'not_applied' },
      currentApplicationEvent(),
    )
    expect(plan).toMatchObject({
      approved: true,
      reasonCode: 'WORKFLOW_CORRECTION_APPLIED',
      sideEffects: ['REEVALUATE_GUIDELINE_READINESS'],
      criticalIncidentRequired: false,
      nextSnapshot: { application: 'not_applied' },
    })
    expect(snapshot.application).toBe('application_requested')
    expect(plan.nextSnapshot).not.toBe(snapshot)
  })

  test.each([
    ['missing prior event', undefined],
    ['wrong dimension', currentApplicationEvent({ dimension: 'selection' })],
    ['non-current target', currentApplicationEvent({ targetState: 'application_pending' })],
    ['rejected event', currentApplicationEvent({ result: 'rejected' })],
    ['already superseded', currentApplicationEvent({ superseded: true })],
  ])('%s cannot be corrected', (_name, prior) => {
    const snapshot = baseline()
    const plan = planWorkflowCorrection(snapshot, { dimension: 'application', to: 'not_applied' }, prior)
    expect(plan).toMatchObject({
      approved: false,
      reasonCode: 'WORKFLOW_CORRECTION_EVENT_NOT_CURRENT',
      sideEffects: [],
      criticalIncidentRequired: false,
    })
    expect(plan.nextSnapshot).toBe(snapshot)
  })

  test('a no-op correction is rejected without side effects', () => {
    const snapshot = baseline()
    const plan = planWorkflowCorrection(
      snapshot,
      { dimension: 'application', to: 'application_requested' },
      currentApplicationEvent(),
    )
    expect(plan).toMatchObject({
      approved: false,
      reasonCode: 'WORKFLOW_CORRECTION_TARGET_INVALID',
      sideEffects: [],
    })
    expect(plan.nextSnapshot).toBe(snapshot)
  })

  test('invalidating a delivered guideline declares a critical incident as well as re-evaluation', () => {
    const snapshot = { ...baseline(), guideline: 'delivered' }
    const plan = planWorkflowCorrection(
      snapshot,
      { dimension: 'guideline', to: 'delivery_failed' },
      {
        dimension: 'guideline',
        targetState: 'delivered',
        result: 'success',
        superseded: false,
      },
    )
    expect(plan).toMatchObject({
      approved: true,
      criticalIncidentRequired: true,
      sideEffects: ['REEVALUATE_GUIDELINE_READINESS', 'CREATE_CRITICAL_INCIDENT'],
      nextSnapshot: { guideline: 'delivery_failed' },
    })
  })

  test.each([
    [{ dimension: 'selection', to: 'manually_selected' }, 'not_reviewed'],
    [{ dimension: 'payback_consent', to: 'agreed' }, 'not_requested'],
    [{ dimension: 'business_approval', to: 'approved' }, 'pending'],
    [{ dimension: 'reservation', to: 'valid' }, 'validation_pending'],
    [{ dimension: 'guideline', to: 'delivered' }, 'not_ready'],
    [{ dimension: 'automation_mode', to: 'active' }, 'paused_by_rule'],
  ])('does not permit generic correction to manufacture protected state %j', (change, currentState) => {
    const snapshot = { ...baseline(), [change.dimension]: currentState }
    const plan = planWorkflowCorrection(snapshot, change, {
      dimension: change.dimension,
      targetState: currentState,
      result: 'success',
      superseded: false,
    })
    expect(plan).toMatchObject({
      approved: false,
      reasonCode: 'WORKFLOW_CORRECTION_PROTECTED_INVARIANT',
      sideEffects: [],
    })
    expect(plan.nextSnapshot).toBe(snapshot)
  })
})
