// Unit tier: the PII detector's own fixtures (T12).
//
// Both directions matter equally. Detection is the point; NON-detection is what keeps the matcher
// alive — one that trips on a UUID or a correlation id gets disabled within a week, and then it
// protects nothing at all.

import { test, describe, expect } from 'vitest'
import { detectPii } from '../../packages/testing/src/matchers/no-pii.js'
import { maskPhone, maskName, maskAddress, maskIdentifier } from '../../packages/observability/src/index.js'

describe('detects what SPEC.md §21.4 forbids', () => {
  test.each([
    ['Korean mobile, hyphenated', 'participant 010-1234-5678 called', 'korean-phone'],
    ['Korean mobile, bare', 'phone=01012345678', 'korean-phone'],
    ['Korean mobile, spaced', 'tel 010 1234 5678', 'korean-phone'],
    ['E.164 Korean', 'normalized +821012345678', 'international-phone'],
    ['resident registration number', 'rrn 900101-1234567', 'resident-registration-number'],
    ['Korean street address', '배송지 서울특별시 강남구 테헤란로 123', 'korean-address'],
    ['bearer token', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'authorization'],
    ['basic credentials', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'authorization'],
  ])('flags %s', (_label, text, expectedKind) => {
    const findings = detectPii(text)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.map((finding) => finding.kind)).toContain(expectedKind)
  })

  test('the failure message does not itself repeat the leak', () => {
    // A matcher whose error message prints the phone number has moved the leak, not closed it.
    const [finding] = detectPii('010-1234-5678')
    expect(finding?.excerpt).not.toContain('1234')
    expect(finding?.excerpt).toMatch(/\*/)
  })

  test('finds several distinct leaks in one line', () => {
    const findings = detectPii('name 홍길동 phone 010-1234-5678 rrn 900101-1234567')
    expect(findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['korean-phone', 'resident-registration-number']),
    )
  })
})

describe('leaves ordinary log content alone', () => {
  test.each([
    ['a UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['a correlation id', 'cor_9f8e7d6c5b4a39281706f5e4d3c2b1a0'],
    ['a millisecond timestamp', '1756000000000'],
    ['an ISO timestamp', '2026-08-23T02:51:40.123Z'],
    ['a workflow id', 'wf_123 app_456 camp_789'],
    ['a masked identifier', 'actorId=id_a1b2c3d4e5'],
    ['a port and latency', 'listening on 127.0.0.1:13000 latencyMs=29'],
    ['a business name ending in 로', '테헤란로 매장'],
    ['a version string', 'postgres 16.15-bookworm'],
    ['a hash', 'sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537'],
  ])('does not flag %s', (_label, text) => {
    expect(detectPii(text)).toEqual([])
  })
})

describe('the masks from T11 survive the detector', () => {
  // The two halves must agree: if masking produced something the detector still flags, one of them
  // is wrong, and this is the test that says which.
  test.each([
    ['phone', maskPhone('010-1234-5678')],
    ['name', maskName('홍길동')],
    ['address', maskAddress('서울특별시 강남구 테헤란로 123 4층')],
    ['identifier', maskIdentifier('provider-user-789', 'a-test-pepper-at-least-16-chars')],
  ])('a masked %s is clean', (_label, masked) => {
    expect(detectPii(masked)).toEqual([])
    expect(masked).toContainNoPii()
  })
})
