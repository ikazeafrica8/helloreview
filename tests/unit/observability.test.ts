// Unit tier: correlation context and PII masking (T10, T11).
//
// Both are pure enough to test in-process, which is what makes them cheap to cover exhaustively —
// and masking is a security control, so exhaustive is the right bar.

import { test, describe, expect } from 'vitest'
import {
  maskPhone,
  maskName,
  maskAddress,
  maskIdentifier,
  runWithCorrelation,
  currentCorrelationId,
  newCorrelationId,
  isCorrelationId,
  createLogger,
} from '../../packages/observability/src/index.js'

describe('maskPhone', () => {
  test.each([
    ['Korean local, hyphenated', '010-1234-5678'],
    ['Korean local, bare', '01012345678'],
    ['Korean local, spaced', '010 1234 5678'],
    ['international E.164', '+821012345678'],
    ['international, hyphenated', '+82-10-1234-5678'],
  ])('masks a %s number', (_label, raw) => {
    const masked = maskPhone(raw)

    // The full number must not survive in any form the eye or a grep would recognize.
    expect(masked).not.toContain('1234')
    expect(masked).not.toContain('12345678')
    expect(masked).toMatch(/\*/)
  })

  test('is stable, so two log lines about one participant can be correlated', () => {
    // Stability is the whole reason a mask is more useful than dropping the field.
    expect(maskPhone('010-1234-5678')).toBe(maskPhone('01012345678'))
    expect(maskPhone('010-1234-5678')).toBe(maskPhone('+821012345678'))
  })

  test('distinguishes different participants', () => {
    expect(maskPhone('010-1234-5678')).not.toBe(maskPhone('010-1234-9999'))
  })

  test('produces an exact, known shape rather than merely "something different"', () => {
    // Pinning the output is what makes the digits-kept count a decision rather than an accident: a
    // regression that kept four digits instead of two would pass a "not equal to the input" check.
    expect(maskPhone('010-1234-5678')).toBe('010******78')
    expect(maskPhone('not a phone at all')).toBe('[masked]')
    expect(maskPhone('')).toBe('[empty]')
  })
})

describe('maskName', () => {
  test('keeps the first character, matching the §20.4 dashboard convention', () => {
    // PRD §20.4's wireframe shows a participant as 홍** — the established convention here.
    expect(maskName('홍길동')).toBe('홍**')
    expect(maskName('김철수')).toBe('김**')
  })

  test('handles Latin names too', () => {
    expect(maskName('Alice')).toBe('A****')
  })

  test.each([
    ['a single character — the whole name, so it must be masked entirely', '홍', '[masked]'],
    ['empty', '', '[empty]'],
    ['whitespace', '   ', '[empty]'],
  ])('masks %s', (_label, raw, expected) => {
    // Asserting the OUTCOME. The previous form only checked the result did not contain the word
    // "undefined", which is true of every implementation including one that returns the input.
    expect(maskName(raw)).toBe(expected)
  })
})

describe('maskAddress', () => {
  test('keeps only the broadest administrative unit', () => {
    // Enough to know which region a fulfilment problem is in; not enough to find the door.
    const masked = maskAddress('서울특별시 강남구 테헤란로 123 4층')
    expect(masked).toContain('서울특별시')
    expect(masked).not.toContain('강남구')
    expect(masked).not.toContain('123')
  })

  test('masks entirely when there is no recognizable structure', () => {
    expect(maskAddress('somewhere')).not.toBe('somewhere')
  })
})

describe('maskIdentifier', () => {
  const PEPPER = 'a-test-pepper-at-least-16-chars'

  test('is stable and short, and never returns the original', () => {
    const kakaoUserId = 'provider-user-789'
    const masked = maskIdentifier(kakaoUserId, PEPPER)

    expect(masked).not.toContain(kakaoUserId)
    expect(masked).toBe(maskIdentifier(kakaoUserId, PEPPER))
    expect(maskIdentifier('provider-user-790', PEPPER)).not.toBe(masked)
  })

  test('is KEYED — a different pepper gives a different tag for the same input', () => {
    // This is the property that makes it unlinkable. An unsalted digest of a low-entropy id is
    // brute-forceable, so a mask that ignored the pepper would be reversible.
    const a = maskIdentifier('provider-user-789', PEPPER)
    const b = maskIdentifier('provider-user-789', 'a-different-pepper-16-chars')
    expect(a).not.toBe(b)
  })

  test('refuses to run without a pepper rather than degrading to an unkeyed digest', () => {
    expect(() => maskIdentifier('provider-user-789', '')).toThrow(/pepper/)
    expect(() => maskIdentifier('provider-user-789', '   ')).toThrow(/pepper/)
  })

  test('is wide enough that collisions are not a practical concern', () => {
    // 64 bits. A 40-bit tag (the original 10 hex chars) is small enough to be worth attacking.
    expect(maskIdentifier('x', PEPPER)).toMatch(/^id_[0-9a-f]{16}$/)
  })
})

describe('correlation context', () => {
  test('a generated id is recognized as one', () => {
    expect(isCorrelationId(newCorrelationId())).toBe(true)
  })

  test.each([
    ['empty', ''],
    ['whitespace', '  '],
    ['far too long', 'x'.repeat(500)],
    ['containing a newline, which would forge a log line', 'abc\ndef'],
  ])('rejects an id that is %s', (_label, value) => {
    expect(isCorrelationId(value)).toBe(false)
  })

  test('is retrievable inside the scope without being threaded through signatures', () => {
    // T10's third criterion. Deep call stacks must not have to pass it along.
    const id = newCorrelationId()
    const deep = () => currentCorrelationId()

    const observed = runWithCorrelation(id, () => ((): string | undefined => deep())())
    expect(observed).toBe(id)
  })

  test('does not leak out of its scope', () => {
    runWithCorrelation(newCorrelationId(), () => undefined)
    expect(currentCorrelationId()).toBeUndefined()
  })

  test('survives an await boundary', async () => {
    const id = newCorrelationId()
    const observed = await runWithCorrelation(id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return currentCorrelationId()
    })
    expect(observed).toBe(id)
  })

  test('nested scopes restore the outer id', () => {
    const outer = newCorrelationId()
    const inner = newCorrelationId()

    runWithCorrelation(outer, () => {
      runWithCorrelation(inner, () => {
        expect(currentCorrelationId()).toBe(inner)
      })
      expect(currentCorrelationId()).toBe(outer)
    })
  })
})

describe('structured logger', () => {
  /**
   * JSON.parse returns `any`, and casting it would be the lie no-unsafe-type-assertion exists to
   * catch — here it would also hide the very failure this suite is checking for, since a logger that
   * emitted a bare string would sail through a cast and fail some later assertion confusingly.
   */
  const parseLine = (line: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) throw new Error(`log line is not a JSON object: ${line}`)
    return { ...value }
  }

  const capture = () => {
    const lines: string[] = []
    const logger = createLogger({ module: 'test-module', environment: 'test', write: (line) => lines.push(line) })
    return { logger, lines, parsed: () => lines.map(parseLine) }
  }

  test('every line carries the §23.1 fields', () => {
    const { logger, parsed } = capture()
    runWithCorrelation('cor_test', () => {
      logger.info('probe', { operation: 'health.check', result: 'ok' })
    })

    const [line] = parsed()
    for (const field of ['timestamp', 'environment', 'module', 'correlationId', 'operation', 'result', 'level']) {
      expect(line, `missing §23.1 field "${field}"`).toHaveProperty(field)
    }
    expect(line?.correlationId).toBe('cor_test')
    expect(line?.module).toBe('test-module')
  })

  test('emits valid JSON on one line, so a log shipper can parse it', () => {
    const { logger, lines } = capture()
    logger.warn('multi\nline\tmessage', { operation: 'probe' })

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('\n')
    expect(() => parseLine(lines[0] ?? '')).not.toThrow()
  })

  test('records no correlation id rather than inventing one outside a scope', () => {
    // A fabricated id would silently join unrelated interactions together in a trace.
    const { logger, parsed } = capture()
    logger.info('outside any scope', { operation: 'probe' })
    expect(parsed()[0]?.correlationId).toBeNull()
  })
})

describe('every declared LogContext field actually reaches the line', () => {
  // THE GUARD FOR A WHOLE CLASS OF BUG, not just the one that prompted it.
  //
  // `reasonCode` was declared in LogContext by T16 and never added to the emit block. It type-
  // checked at every call site, so nine callers passed it and every one was silently discarded —
  // making RATE_LIMIT_BACKEND_UNAVAILABLE indistinguishable from RATE_LIMIT_SCRIPT_UNEXPECTED_RESULT
  // and RAW_BODY_MISSING (a route-wiring bug) identical to an ordinary SIGNATURE_MISMATCH.
  //
  // A test naming only `reasonCode` would close that one hole. This one asserts the property: a
  // field added to the type and forgotten in the emit block fails here. Each field is supplied a
  // value of the right primitive type, which is why the table is written out rather than derived —
  // TypeScript types do not survive to runtime, so there is nothing to iterate over.
  const SAMPLE_CONTEXT = {
    operation: 'probe.operation',
    result: 'ok',
    eventId: 'evt_probe',
    workflowId: 'wf_probe',
    campaignId: 'camp_probe',
    provider: 'probe_provider',
    errorCategory: 'ProbeError',
    reasonCode: 'PROBE_REASON_CODE',
    retryCount: 3,
    stateVersion: 7,
    statusCode: 503,
    count: 11,
    actorId: 'id_probe',
  } as const

  test('a line carries every field it was given', () => {
    const lines: string[] = []
    const logger = createLogger({ module: 'test-module', environment: 'test', write: (line) => lines.push(line) })

    logger.info('probe', SAMPLE_CONTEXT)

    const emitted: unknown = JSON.parse(lines[0] ?? '{}')
    const held: Record<string, unknown> = typeof emitted === 'object' && emitted !== null ? { ...emitted } : {}

    const missing = Object.entries(SAMPLE_CONTEXT)
      .filter(([key, value]) => held[key] !== value)
      .map(([key]) => key)

    expect(
      missing,
      `${String(missing.length)} LogContext field(s) were accepted by the type and dropped by the ` +
        'logger. A field declared in LogContext but missing from the emit block type-checks at every ' +
        'call site and vanishes at runtime.',
    ).toEqual([])
  })

  test('reasonCode specifically, since that is the one that was dropped', () => {
    const lines: string[] = []
    const logger = createLogger({ module: 'test-module', environment: 'test', write: (line) => lines.push(line) })

    logger.warn('rejected', {
      operation: 'provider_gateway.verify',
      result: 'rejected',
      reasonCode: 'SIGNATURE_MISMATCH',
    })

    expect(lines[0]).toContain('SIGNATURE_MISMATCH')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ reasonCode: 'SIGNATURE_MISMATCH' })
  })

  test('an absent field is omitted rather than emitted as null', () => {
    // The line stays readable. Asserted so the fix above cannot be "spread everything always".
    const lines: string[] = []
    const logger = createLogger({ module: 'test-module', environment: 'test', write: (line) => lines.push(line) })

    logger.info('minimal', { operation: 'probe', result: 'ok' })

    // Narrowed rather than cast: JSON.parse returns `any`, and passing it straight to Object.keys
    // is the unchecked assumption no-unsafe-argument exists to catch.
    const emitted: unknown = JSON.parse(lines[0] ?? '{}')
    const held: Record<string, unknown> = typeof emitted === 'object' && emitted !== null ? { ...emitted } : {}

    expect(Object.keys(held)).not.toContain('reasonCode')
  })
})
