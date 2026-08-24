import { describe, expect, test } from 'vitest'
import {
  MUTABLE_WORKFLOW_DIMENSIONS,
  WORKFLOW_STATES,
  applyWorkflowStateChange,
  initialWorkflowSnapshot,
  isStateForDimension,
} from '../../apps/api/dist/modules/workflow-core/index.js'

describe('workflow state model', () => {
  test.each([
    ['shipping', 'not_applicable', 'address_requested', 'not_applicable', 'not_applicable', 'not_required'],
    ['payback', 'not_applicable', 'not_applicable', 'not_requested', 'not_applicable', 'not_required'],
    ['visit', 'visit_a', 'not_applicable', 'not_applicable', 'not_started', 'not_required'],
    ['visit', 'visit_b', 'not_applicable', 'not_applicable', 'not_started', 'not_required'],
    ['visit', 'visit_c', 'not_applicable', 'not_applicable', 'not_started', 'not_requested'],
  ])('initializes %s/%s explicitly', (campaignType, visitMethod, shipping, consent, reservation, approval) => {
    expect(initialWorkflowSnapshot({ campaignType, visitMethod })).toMatchObject({
      application: 'not_applied',
      selection: 'not_reviewed',
      campaign_type: campaignType,
      visit_method: visitMethod,
      shipping,
      payback_consent: consent,
      reservation,
      business_approval: approval,
      guideline: 'not_ready',
      human_handoff: 'not_required',
      automation_mode: 'active',
    })
  })

  test('refuses incoherent campaign and visit method pairs', () => {
    expect(() => initialWorkflowSnapshot({ campaignType: 'visit', visitMethod: 'not_applicable' })).toThrow(
      /explicit visit method/,
    )
    expect(() => initialWorkflowSnapshot({ campaignType: 'shipping', visitMethod: 'visit_a' })).toThrow(
      /not_applicable/,
    )
  })

  test('every mutable dimension updates immutably and accepts only its declared states', () => {
    const baseline = initialWorkflowSnapshot({ campaignType: 'payback', visitMethod: 'not_applicable' })
    for (const dimension of MUTABLE_WORKFLOW_DIMENSIONS) {
      const to = WORKFLOW_STATES[dimension].at(-1)
      expect(isStateForDimension(dimension, to)).toBe(true)
      expect(isStateForDimension(dimension, '__unknown__')).toBe(false)
      const next = applyWorkflowStateChange(baseline, { dimension, to })
      expect(next).not.toBe(baseline)
      expect(next[dimension]).toBe(to)
      expect(baseline[dimension]).not.toBe('__unknown__')
    }
  })
})
