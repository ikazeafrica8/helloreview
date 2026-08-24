import { describe, expect, test } from 'vitest'
import { evaluateRule, type DeterministicRule } from './rule-evaluator.js'

type Input = Readonly<{ submitted: number }>

const configuredRule = (
  configuration: unknown,
  version = 3,
): DeterministicRule<Input, number, 'MINIMUM', 'TRY_AGAIN' | 'CONFIG_REVIEW'> => ({
  ruleCode: 'MINIMUM',
  ruleVersion: version,
  configuration,
  parseConfiguration: (value) => (typeof value === 'number' ? value : undefined),
  submittedValue: (input) => input.submitted,
  expectedCondition: (value) => (value === undefined ? 'configured minimum' : `at least ${String(value)}`),
  passes: (input, value, now) => input.submitted >= value && now.getTime() > 0,
  correction: 'TRY_AGAIN',
  retryEligible: true,
  reviewRequired: false,
  configurationCorrection: 'CONFIG_REVIEW',
})

describe('deterministic rule evaluator', () => {
  const now = new Date('2026-08-24T00:00:00.000Z')

  test('returns traceable pass and fail results', () => {
    expect(evaluateRule({ submitted: 10 }, configuredRule(5), now)).toEqual({
      outcome: 'pass',
      reasonCode: 'RULE_PASSED',
      ruleCode: 'MINIMUM',
      ruleVersion: 3,
      submittedValue: 10,
      expectedCondition: 'at least 5',
    })
    expect(evaluateRule({ submitted: 4 }, configuredRule(5), now)).toEqual({
      outcome: 'fail',
      reasonCode: 'RULE_FAILED',
      ruleCode: 'MINIMUM',
      ruleVersion: 3,
      submittedValue: 4,
      expectedCondition: 'at least 5',
      correction: 'TRY_AGAIN',
      retryEligible: true,
      reviewRequired: false,
    })
  })

  test.each([
    ['missing configuration', undefined, 3],
    ['malformed configuration', 'five', 3],
    ['zero rule version', 5, 0],
    ['fractional rule version', 5, 1.5],
  ])('%s is a configuration error and never a pass', (_label, configuration, version) => {
    expect(evaluateRule({ submitted: 10 }, configuredRule(configuration, version), now)).toMatchObject({
      outcome: 'configuration_error',
      reasonCode: 'RULE_CONFIGURATION_ERROR',
      correction: 'CONFIG_REVIEW',
      retryEligible: false,
      reviewRequired: true,
    })
  })
})
