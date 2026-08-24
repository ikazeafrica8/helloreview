// Unit tier: exhaustive pre-activation configuration validation (T25, FR-CAM-006, PRD §16.4).

import { describe, expect, test } from 'vitest'
import { validateCampaignActivation } from '../../apps/api/src/modules/campaign-config/activation-validator.ts'
import { CAMPAIGN_CONFIG_REASON } from '../../apps/api/src/modules/campaign-config/reason-codes.ts'

const routeCases = [
  ['shipping', 'not_applicable', 'shipping', 'shipping', 'SHIPPING_ADDRESS_REQUEST'],
  ['payback', 'not_applicable', 'payback', 'payback', 'PAYBACK_CONSENT_REQUEST'],
  ['visit', 'visit_a', 'visit_a', 'reservation', 'VISIT_A_INSTRUCTIONS'],
  ['visit', 'visit_b', 'visit_b', 'reservation', 'VISIT_B_INSTRUCTIONS'],
  ['visit', 'visit_c', 'visit_c', 'reservation', 'VISIT_C_APPROVAL_STATUS'],
]

const completeSnapshot = (campaignType, visitMethod, routeRule, routeTemplate) => ({
  campaignType,
  visitMethod,
  publishedRuleTypes: ['selection', 'guideline', routeRule],
  reservationWindowCount: campaignType === 'visit' ? 1 : 0,
  activeTemplatePurposeCodes: [
    'SELECTION_RESULT',
    'GUIDELINE_DELIVERY',
    routeTemplate,
    ...(visitMethod === 'visit_c' ? ['VISIT_C_BOOKING_INSTRUCTIONS'] : []),
    // An old/unknown database value is ignored rather than crashing activation diagnostics.
    'PURPOSE_WRITTEN_BY_A_NEWER_DEPLOYMENT',
  ],
  hasPublishedGuidelineVersion: true,
})

describe('campaign activation routes', () => {
  test.each(routeCases)('%s / %s resolves to %s when fully configured', (type, method, route, rule, template) => {
    const result = validateCampaignActivation(completeSnapshot(type, method, rule, template))
    expect(result).toEqual({ canActivate: true, route, issues: [] })
  })

  test.each([
    ['shipping', 'visit_a', 'shipping:visit_a'],
    ['payback', 'visit_c', 'payback:visit_c'],
    ['visit', 'not_applicable', 'visit:not_applicable'],
  ])('rejects the invalid §16.4 pair %s / %s', (campaignType, visitMethod, item) => {
    const result = validateCampaignActivation({
      campaignType,
      visitMethod,
      publishedRuleTypes: ['selection', 'guideline'],
      reservationWindowCount: 1,
      activeTemplatePurposeCodes: ['SELECTION_RESULT', 'GUIDELINE_DELIVERY'],
      hasPublishedGuidelineVersion: true,
    })

    expect(result.canActivate).toBe(false)
    expect(result.route).toBeNull()
    expect(result.issues).toEqual([
      {
        reasonCode: CAMPAIGN_CONFIG_REASON.INVALID_CAMPAIGN_ROUTE,
        requirement: 'route',
        item,
      },
    ])
  })
})

describe('complete missing-item reporting', () => {
  test('a blank Visit C snapshot returns every rule, window, template and guideline issue', () => {
    const result = validateCampaignActivation({
      campaignType: 'visit',
      visitMethod: 'visit_c',
      publishedRuleTypes: [],
      reservationWindowCount: 0,
      activeTemplatePurposeCodes: [],
      hasPublishedGuidelineVersion: false,
    })

    expect(result.canActivate).toBe(false)
    expect(result.route).toBe('visit_c')
    expect(result.issues).toEqual([
      { reasonCode: 'MISSING_RULE_VERSION', requirement: 'rule', item: 'selection' },
      { reasonCode: 'MISSING_RULE_VERSION', requirement: 'rule', item: 'guideline' },
      { reasonCode: 'MISSING_RULE_VERSION', requirement: 'rule', item: 'reservation' },
      {
        reasonCode: 'MISSING_RESERVATION_WINDOWS',
        requirement: 'reservation_windows',
        item: 'reservation_windows',
      },
      { reasonCode: 'MISSING_MESSAGE_TEMPLATE', requirement: 'template', item: 'SELECTION_RESULT' },
      { reasonCode: 'MISSING_MESSAGE_TEMPLATE', requirement: 'template', item: 'GUIDELINE_DELIVERY' },
      { reasonCode: 'MISSING_MESSAGE_TEMPLATE', requirement: 'template', item: 'VISIT_C_APPROVAL_STATUS' },
      {
        reasonCode: 'MISSING_MESSAGE_TEMPLATE',
        requirement: 'template',
        item: 'VISIT_C_BOOKING_INSTRUCTIONS',
      },
      { reasonCode: 'MISSING_GUIDELINE_VERSION', requirement: 'guideline', item: 'guideline_version' },
    ])
  })

  test('reports all remaining omissions rather than stopping after the first', () => {
    const result = validateCampaignActivation({
      campaignType: 'payback',
      visitMethod: 'not_applicable',
      publishedRuleTypes: ['selection'],
      reservationWindowCount: 0,
      activeTemplatePurposeCodes: ['SELECTION_RESULT'],
      hasPublishedGuidelineVersion: false,
    })

    expect(result.issues.map(({ reasonCode, item }) => `${reasonCode}:${item}`)).toEqual([
      'MISSING_RULE_VERSION:guideline',
      'MISSING_RULE_VERSION:payback',
      'MISSING_MESSAGE_TEMPLATE:GUIDELINE_DELIVERY',
      'MISSING_MESSAGE_TEMPLATE:PAYBACK_CONSENT_REQUEST',
      'MISSING_GUIDELINE_VERSION:guideline_version',
    ])
  })

  test('duplicate inventory entries do not create duplicate requirements', () => {
    const result = validateCampaignActivation({
      campaignType: 'shipping',
      visitMethod: 'not_applicable',
      publishedRuleTypes: ['selection', 'selection', 'guideline', 'shipping', 'shipping'],
      reservationWindowCount: 0,
      activeTemplatePurposeCodes: [
        'SELECTION_RESULT',
        'SELECTION_RESULT',
        'GUIDELINE_DELIVERY',
        'SHIPPING_ADDRESS_REQUEST',
      ],
      hasPublishedGuidelineVersion: true,
    })

    expect(result).toEqual({ canActivate: true, route: 'shipping', issues: [] })
  })
})
