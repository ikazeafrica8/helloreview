// Unit tier: exhaustive pre-activation configuration validation (T25, FR-CAM-006, PRD §16.4).

import { describe, expect, test } from 'vitest'
import { validateCampaignActivation } from '../../apps/api/src/modules/campaign-config/activation-validator.ts'
import { CAMPAIGN_CONFIG_REASON } from '../../apps/api/src/modules/campaign-config/reason-codes.ts'

/** Every purpose a route can send, owned and audited — the T136 baseline for a complete snapshot. */
const ownedPurposes = (...purposeStems) =>
  purposeStems.map((purposeStem) => ({
    purposeStem,
    authoritativeSender: 'helloreview_platform',
    triggerAudited: true,
  }))

const journeyReady = {
  hasCurrentApplicationUrl: true,
  hasCurrentBusinessPhone: true,
  hasCurrentBookingUrl: true,
  hasValidSelectionPolicy: true,
}

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
    'APPLICATION_REQUEST',
    'SELECTION_RESULT',
    'GUIDELINE_DELIVERY',
    routeTemplate,
    ...(campaignType === 'payback' ? ['PAYBACK_CONSENT_CLARIFICATION'] : []),
    ...(visitMethod === 'visit_c' ? ['VISIT_C_BOOKING_INSTRUCTIONS'] : []),
    // An old/unknown database value is ignored rather than crashing activation diagnostics.
    'PURPOSE_WRITTEN_BY_A_NEWER_DEPLOYMENT',
  ],
  hasPublishedGuidelineVersion: true,
  ...journeyReady,
  purposeOwnerships: ownedPurposes(
    'APPLICATION_REQUEST',
    'SELECTION_RESULT',
    'GUIDELINE_DELIVERY',
    routeTemplate,
    ...(campaignType === 'payback' ? ['PAYBACK_CONSENT_CLARIFICATION'] : []),
    ...(visitMethod === 'visit_c' ? ['VISIT_C_BOOKING_INSTRUCTIONS'] : []),
  ),
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
      activeTemplatePurposeCodes: ['APPLICATION_REQUEST', 'SELECTION_RESULT', 'GUIDELINE_DELIVERY'],
      hasPublishedGuidelineVersion: true,
      ...journeyReady,
      purposeOwnerships: ownedPurposes('APPLICATION_REQUEST', 'SELECTION_RESULT', 'GUIDELINE_DELIVERY'),
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
      hasCurrentApplicationUrl: false,
      hasCurrentBusinessPhone: false,
      hasCurrentBookingUrl: false,
      hasValidSelectionPolicy: false,
      purposeOwnerships: [],
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
      { reasonCode: 'MISSING_MESSAGE_TEMPLATE', requirement: 'template', item: 'APPLICATION_REQUEST' },
      { reasonCode: 'MISSING_MESSAGE_TEMPLATE', requirement: 'template', item: 'SELECTION_RESULT' },
      { reasonCode: 'MISSING_MESSAGE_TEMPLATE', requirement: 'template', item: 'GUIDELINE_DELIVERY' },
      { reasonCode: 'MISSING_MESSAGE_TEMPLATE', requirement: 'template', item: 'VISIT_C_APPROVAL_STATUS' },
      {
        reasonCode: 'MISSING_MESSAGE_TEMPLATE',
        requirement: 'template',
        item: 'VISIT_C_BOOKING_INSTRUCTIONS',
      },
      { reasonCode: 'MISSING_GUIDELINE_VERSION', requirement: 'guideline', item: 'guideline_version' },
      { reasonCode: 'MISSING_APPLICATION_URL', requirement: 'journey_configuration', item: 'application_url' },
      { reasonCode: 'MISSING_BOOKING_URL', requirement: 'business_contact', item: 'booking_url' },
      { reasonCode: 'MISSING_SENDER_OWNERSHIP', requirement: 'sender_ownership', item: 'APPLICATION_REQUEST' },
      { reasonCode: 'MISSING_SENDER_OWNERSHIP', requirement: 'sender_ownership', item: 'SELECTION_RESULT' },
      { reasonCode: 'MISSING_SENDER_OWNERSHIP', requirement: 'sender_ownership', item: 'GUIDELINE_DELIVERY' },
      { reasonCode: 'MISSING_SENDER_OWNERSHIP', requirement: 'sender_ownership', item: 'VISIT_C_APPROVAL_STATUS' },
      {
        reasonCode: 'MISSING_SENDER_OWNERSHIP',
        requirement: 'sender_ownership',
        item: 'VISIT_C_BOOKING_INSTRUCTIONS',
      },
      { reasonCode: 'INVALID_SELECTION_POLICY', requirement: 'selection_policy', item: 'selection_policy' },
    ])
  })

  test('reports all remaining omissions rather than stopping after the first', () => {
    const result = validateCampaignActivation({
      campaignType: 'payback',
      visitMethod: 'not_applicable',
      publishedRuleTypes: ['selection'],
      reservationWindowCount: 0,
      activeTemplatePurposeCodes: ['APPLICATION_REQUEST', 'SELECTION_RESULT'],
      hasPublishedGuidelineVersion: false,
      ...journeyReady,
      purposeOwnerships: ownedPurposes(
        'APPLICATION_REQUEST',
        'SELECTION_RESULT',
        'GUIDELINE_DELIVERY',
        'PAYBACK_CONSENT_REQUEST',
        'PAYBACK_CONSENT_CLARIFICATION',
      ),
    })

    expect(result.issues.map(({ reasonCode, item }) => `${reasonCode}:${item}`)).toEqual([
      'MISSING_RULE_VERSION:guideline',
      'MISSING_RULE_VERSION:payback',
      'MISSING_MESSAGE_TEMPLATE:GUIDELINE_DELIVERY',
      'MISSING_MESSAGE_TEMPLATE:PAYBACK_CONSENT_REQUEST',
      'MISSING_MESSAGE_TEMPLATE:PAYBACK_CONSENT_CLARIFICATION',
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
        'APPLICATION_REQUEST',
        'SELECTION_RESULT',
        'SELECTION_RESULT',
        'GUIDELINE_DELIVERY',
        'SHIPPING_ADDRESS_REQUEST',
      ],
      hasPublishedGuidelineVersion: true,
      ...journeyReady,
      purposeOwnerships: ownedPurposes(
        'APPLICATION_REQUEST',
        'SELECTION_RESULT',
        'GUIDELINE_DELIVERY',
        'SHIPPING_ADDRESS_REQUEST',
      ),
    })

    expect(result).toEqual({ canActivate: true, route: 'shipping', issues: [] })
  })
})

describe('T136 journey configuration and sender ownership', () => {
  const shipping = (overrides = {}) => ({
    ...completeSnapshot('shipping', 'not_applicable', 'shipping', 'SHIPPING_ADDRESS_REQUEST'),
    ...overrides,
  })
  const codes = (result) => result.issues.map(({ reasonCode, item }) => `${reasonCode}:${item}`)

  test('refuses activation without a current application URL, whatever the route', () => {
    expect(codes(validateCampaignActivation(shipping({ hasCurrentApplicationUrl: false })))).toEqual([
      'MISSING_APPLICATION_URL:application_url',
    ])
  })

  test('requires a business phone for Visit A and a booking URL for Visit B and C only', () => {
    const visit = (visitMethod, template, overrides) => ({
      ...completeSnapshot('visit', visitMethod, 'reservation', template),
      ...overrides,
    })
    expect(
      codes(validateCampaignActivation(visit('visit_a', 'VISIT_A_INSTRUCTIONS', { hasCurrentBusinessPhone: false }))),
    ).toEqual(['MISSING_BUSINESS_PHONE:business_phone'])
    expect(
      codes(validateCampaignActivation(visit('visit_b', 'VISIT_B_INSTRUCTIONS', { hasCurrentBookingUrl: false }))),
    ).toEqual(['MISSING_BOOKING_URL:booking_url'])
    expect(
      codes(validateCampaignActivation(visit('visit_c', 'VISIT_C_APPROVAL_STATUS', { hasCurrentBookingUrl: false }))),
    ).toEqual(['MISSING_BOOKING_URL:booking_url'])
    // A shipping campaign has no business to phone or book, so neither is required.
    expect(
      validateCampaignActivation(shipping({ hasCurrentBusinessPhone: false, hasCurrentBookingUrl: false })).canActivate,
    ).toBe(true)
    // Visit A is not sent to a booking URL, and Visit B is not told to phone.
    expect(
      validateCampaignActivation(visit('visit_a', 'VISIT_A_INSTRUCTIONS', { hasCurrentBookingUrl: false })).canActivate,
    ).toBe(true)
    expect(
      validateCampaignActivation(visit('visit_b', 'VISIT_B_INSTRUCTIONS', { hasCurrentBusinessPhone: false }))
        .canActivate,
    ).toBe(true)
  })

  test('names every purpose that has no authoritative sender', () => {
    expect(codes(validateCampaignActivation(shipping({ purposeOwnerships: [] })))).toEqual([
      'MISSING_SENDER_OWNERSHIP:APPLICATION_REQUEST',
      'MISSING_SENDER_OWNERSHIP:SELECTION_RESULT',
      'MISSING_SENDER_OWNERSHIP:GUIDELINE_DELIVERY',
      'MISSING_SENDER_OWNERSHIP:SHIPPING_ADDRESS_REQUEST',
    ])
  })

  test('refuses a platform ownership claim whose legacy trigger was never audited', () => {
    const ownerships = ownedPurposes(
      'APPLICATION_REQUEST',
      'SELECTION_RESULT',
      'GUIDELINE_DELIVERY',
      'SHIPPING_ADDRESS_REQUEST',
    ).map((ownership) =>
      ownership.purposeStem === 'SELECTION_RESULT' ? { ...ownership, triggerAudited: false } : ownership,
    )
    expect(codes(validateCampaignActivation(shipping({ purposeOwnerships: ownerships })))).toEqual([
      'UNAUDITED_SENDER_OWNERSHIP:SELECTION_RESULT',
    ])
  })

  test('accepts the legacy website trigger owning a purpose during cutover, audited or not', () => {
    const legacy = ownedPurposes(
      'APPLICATION_REQUEST',
      'SELECTION_RESULT',
      'GUIDELINE_DELIVERY',
      'SHIPPING_ADDRESS_REQUEST',
    ).map((ownership) => ({ ...ownership, authoritativeSender: 'website_legacy_trigger', triggerAudited: false }))
    expect(validateCampaignActivation(shipping({ purposeOwnerships: legacy })).canActivate).toBe(true)

    const manual = legacy.map((ownership) => ({ ...ownership, authoritativeSender: 'operator_manual' }))
    expect(validateCampaignActivation(shipping({ purposeOwnerships: manual })).canActivate).toBe(true)
  })

  test('refuses activation when the selection policy does not parse', () => {
    expect(codes(validateCampaignActivation(shipping({ hasValidSelectionPolicy: false })))).toEqual([
      'INVALID_SELECTION_POLICY:selection_policy',
    ])
  })

  test('ignores an ownership row for a purpose this route never sends', () => {
    const withExtra = [
      ...ownedPurposes('APPLICATION_REQUEST', 'SELECTION_RESULT', 'GUIDELINE_DELIVERY', 'SHIPPING_ADDRESS_REQUEST'),
      { purposeStem: 'VISIT_A_INSTRUCTIONS', authoritativeSender: 'helloreview_platform', triggerAudited: false },
    ]
    expect(validateCampaignActivation(shipping({ purposeOwnerships: withExtra })).canActivate).toBe(true)
  })
})
