import { describe, expect, test } from 'vitest'
import {
  MESSAGE_PURPOSES,
  composePurpose,
  isWellFormedPurposeCode,
  isWellFormedTemplatePurposeCode,
  purposeStem,
} from '../../packages/contracts/dist/index.js'

describe('composed outbound purpose codes', () => {
  test('round-trips a parameterised purpose to its registered stem', () => {
    const purpose = composePurpose(MESSAGE_PURPOSES.GUIDELINE_REDELIVERY, '4', 'auth_123')
    expect(purpose).toBe('GUIDELINE_REDELIVERY:4:auth_123')
    expect(purposeStem(purpose)).toBe(MESSAGE_PURPOSES.GUIDELINE_REDELIVERY)
    expect(isWellFormedPurposeCode(purpose)).toBe(true)
  })

  test.each(['', 'contains:separator'])('rejects the invalid parameter %j', (parameter) => {
    expect(() => composePurpose(MESSAGE_PURPOSES.GUIDELINE_DELIVERY, parameter)).toThrow(/invalid purpose parameter/)
  })

  test.each(['GUIDELINE_DELIVERY', 'SELECTION_RESULT:unexpected', 'GUIDELINE_DELIVERY:', 'UNKNOWN_PURPOSE'])(
    'rejects malformed outbound purpose %s',
    (purpose) => {
      expect(isWellFormedPurposeCode(purpose)).toBe(false)
    },
  )
})

describe('message-template purpose namespaces', () => {
  test.each(['SELECTION_RESULT', 'GUIDELINE_DELIVERY', 'GUIDELINE_REDELIVERY', 'RESERVATION_CORRECTION:INVALID_TIME'])(
    'accepts %s',
    (purpose) => {
      expect(isWellFormedTemplatePurposeCode(purpose)).toBe(true)
    },
  )

  test.each(['RESERVATION_CORRECTION', 'RESERVATION_CORRECTION:', 'SELECTION_RESULT:unexpected', 'UNKNOWN_PURPOSE'])(
    'rejects %s',
    (purpose) => {
      expect(isWellFormedTemplatePurposeCode(purpose)).toBe(false)
    },
  )

  test('an unknown stem is recoverable data rather than an exception', () => {
    expect(purposeStem('FUTURE_PURPOSE:v2')).toBeUndefined()
  })
})
