import { RULE_EVALUATION_REASON } from './reason-codes.js'

export type RuleEvaluationResult<RuleCode extends string = string, CorrectionCode extends string = string> =
  | Readonly<{
      outcome: 'pass'
      reasonCode: typeof RULE_EVALUATION_REASON.RULE_PASSED
      ruleCode: RuleCode
      ruleVersion: number
      submittedValue: unknown
      expectedCondition: string
    }>
  | Readonly<{
      outcome: 'fail'
      reasonCode: typeof RULE_EVALUATION_REASON.RULE_FAILED
      ruleCode: RuleCode
      ruleVersion: number
      submittedValue: unknown
      expectedCondition: string
      correction: CorrectionCode
      retryEligible: boolean
      reviewRequired: boolean
    }>
  | Readonly<{
      outcome: 'configuration_error'
      reasonCode: typeof RULE_EVALUATION_REASON.RULE_CONFIGURATION_ERROR
      ruleCode: RuleCode
      ruleVersion: number
      submittedValue: unknown
      expectedCondition: string
      correction: CorrectionCode
      retryEligible: false
      reviewRequired: true
    }>

export type DeterministicRule<Input, Configuration, RuleCode extends string, CorrectionCode extends string> = Readonly<{
  ruleCode: RuleCode
  ruleVersion: number
  configuration: unknown
  parseConfiguration: (configuration: unknown) => Configuration | undefined
  submittedValue: (input: Input) => unknown
  expectedCondition: (configuration: Configuration | undefined) => string
  passes: (input: Input, configuration: Configuration, now: Date) => boolean
  correction: CorrectionCode
  retryEligible: boolean
  reviewRequired: boolean
  configurationCorrection: CorrectionCode
}>

/** Pure deterministic evaluator. Configuration and clock are inputs; no I/O or ambient time. */
export const evaluateRule = <Input, Configuration, RuleCode extends string, CorrectionCode extends string>(
  input: Input,
  rule: DeterministicRule<Input, Configuration, RuleCode, CorrectionCode>,
  now: Date,
): RuleEvaluationResult<RuleCode, CorrectionCode> => {
  const submittedValue = rule.submittedValue(input)
  const configuration = rule.parseConfiguration(rule.configuration)
  const expectedCondition = rule.expectedCondition(configuration)
  if (configuration === undefined || !Number.isInteger(rule.ruleVersion) || rule.ruleVersion < 1) {
    return {
      outcome: 'configuration_error',
      reasonCode: RULE_EVALUATION_REASON.RULE_CONFIGURATION_ERROR,
      ruleCode: rule.ruleCode,
      ruleVersion: rule.ruleVersion,
      submittedValue,
      expectedCondition,
      correction: rule.configurationCorrection,
      retryEligible: false,
      reviewRequired: true,
    }
  }
  if (!rule.passes(input, configuration, now)) {
    return {
      outcome: 'fail',
      reasonCode: RULE_EVALUATION_REASON.RULE_FAILED,
      ruleCode: rule.ruleCode,
      ruleVersion: rule.ruleVersion,
      submittedValue,
      expectedCondition,
      correction: rule.correction,
      retryEligible: rule.retryEligible,
      reviewRequired: rule.reviewRequired,
    }
  }
  return {
    outcome: 'pass',
    reasonCode: RULE_EVALUATION_REASON.RULE_PASSED,
    ruleCode: rule.ruleCode,
    ruleVersion: rule.ruleVersion,
    submittedValue,
    expectedCondition,
  }
}
