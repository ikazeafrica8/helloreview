// Security tier: nothing this test writes may contain personal data (T12).
//
// Every test in this tier is wrapped automatically — see packages/testing/src/matchers/security-setup.ts
// — so the assertion below is not what protects us. The tier-wide capture is. This file exists to
// prove that mechanism actually works, and to exercise the real logger through it.

import { test, describe, expect } from 'vitest'
import { createLogger, maskPhone, maskName, runWithCorrelation } from '../../packages/observability/src/index.js'
import { captureOutput, detectPii } from '../../packages/testing/src/index.js'

describe('the structured logger under the PII capture', () => {
  test('a line carrying masked personal data passes', async () => {
    const output = await captureOutput(() => {
      const logger = createLogger({ module: 'security-probe', environment: 'test' })
      runWithCorrelation('cor_security_probe', () => {
        logger.info('matched an applicant', {
          operation: 'identity.match',
          result: 'strong_match',
          // Masked at the CALL SITE, which is the convention the logger deliberately does not
          // paper over: a reviewer can see which field is personal data.
          actorId: maskName('홍길동'),
        })
      })
    })

    expect(output).toContainNoPii()
    expect(output).toContain('cor_security_probe')
  })

  test('the capture would catch an unmasked number — proven without leaking one into the tier', () => {
    // Deliberately NOT written to stdout: doing so would trip the tier-wide afterEach and fail this
    // very test. Running the same detector the capture uses proves the mechanism on the same input.
    const wouldLeak = JSON.stringify({ message: 'applicant', phone: '010-1234-5678' })

    expect(detectPii(wouldLeak).map((finding) => finding.kind)).toContain('korean-phone')
    expect(maskPhone('010-1234-5678')).toContainNoPii()
  })
})
