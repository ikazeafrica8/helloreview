// Unit tier: business name normalization (T23, FR-CAM-004, PRD §16.7).
//
// This is the function that decides whether a participant booked at the right place. A false
// NEGATIVE sends a "wrong business" correction to somebody who booked correctly; a false POSITIVE
// validates a booking at a business the campaign has nothing to do with. Both are participant-
// facing, so both directions are tested.
//
// The Hangul composition cases below are the ones worth reading. Korean text arriving from
// different sources — an OCR engine, a paste from a browser, a phone keyboard — is genuinely not
// byte-identical even when it renders identically, and a normalizer that skipped Unicode
// normalization would look correct in every hand-written test and fail against real input.

import { test, describe, expect } from 'vitest'
import {
  normalizeBusinessName,
  matchesApprovedName,
  matchesBranch,
} from '../../apps/api/dist/modules/campaign-config/index.js'

describe('Unicode composition — the case a hand-written test usually misses', () => {
  test('decomposed and composed Hangul normalize to the same string', () => {
    // '강남' as precomposed syllables vs the same text as conjoining jamo. These render
    // identically and are different byte sequences; macOS filesystems and some OCR pipelines emit
    // the decomposed form.
    const composed = '강남'
    const decomposed = '강남'.normalize('NFD')

    expect(composed === decomposed, 'the fixture is not actually testing two forms').toBe(false)
    expect(normalizeBusinessName(composed)).toBe(normalizeBusinessName(decomposed))
  })

  test('a decomposed name matches an approved composed one', () => {
    expect(matchesApprovedName('스타벅스'.normalize('NFD'), '스타벅스')).toBe(true)
  })

  test('full-width Latin folds to half-width', () => {
    // Korean input methods produce full-width Latin readily, and it renders almost identically.
    expect(normalizeBusinessName('ＳＴＡＲ')).toBe(normalizeBusinessName('STAR'))
  })

  test('the Korean company-abbreviation character folds to its expansion', () => {
    // ㈜ is a single compatibility character meaning (주) — "Inc." It appears on signage and in
    // business registrations interchangeably with the spelled form.
    expect(normalizeBusinessName('㈜헬로리뷰')).toBe(normalizeBusinessName('(주)헬로리뷰'))
  })
})

describe('spacing and case', () => {
  test.each([
    ['Korean spacing', '스타벅스 강남점', '스타벅스강남점'],
    ['leading and trailing space', '  카페  ', '카페'],
    ['an ideographic space', '카페　강남', '카페강남'],
    ['a non-breaking space', '카페 강남', '카페 강남'],
    ['Latin case', 'Starbucks Gangnam', 'STARBUCKS GANGNAM'],
    ['mixed script case', '스타벅스 Gangnam', '스타벅스 GANGNAM'],
  ])('%s does not change identity', (_label, a, b) => {
    expect(normalizeBusinessName(a)).toBe(normalizeBusinessName(b))
  })

  test.each([
    ['parentheses', '스타벅스(강남점)', '스타벅스 강남점'],
    ['square brackets', '스타벅스[강남점]', '스타벅스 강남점'],
    ['a middle dot', '스타벅스·강남점', '스타벅스 강남점'],
    ['a hyphen', '스타벅스-강남점', '스타벅스 강남점'],
    ['a full stop', '스타벅스.강남점', '스타벅스 강남점'],
  ])('%s is insignificant', (_label, a, b) => {
    expect(normalizeBusinessName(a)).toBe(normalizeBusinessName(b))
  })
})

describe('it still tells DIFFERENT businesses apart', () => {
  // The other direction. A normalizer aggressive enough to pass everything above could easily
  // collapse genuinely different names, and the consequence is validating a booking somewhere else
  // entirely.
  test.each([
    ['different names', '스타벅스', '투썸플레이스'],
    ['different branches in the name', '스타벅스강남점', '스타벅스홍대점'],
    ['a substring is not a match', '스타벅스', '스타벅스코리아'],
    ['different Latin names', 'Starbucks', 'Starbuck'],
    ['digits matter', '카페404', '카페405'],
  ])('%s do not match', (_label, a, b) => {
    expect(normalizeBusinessName(a)).not.toBe(normalizeBusinessName(b))
    expect(matchesApprovedName(a, b)).toBe(false)
  })
})

describe('matchesApprovedName', () => {
  test('matches the approved name itself', () => {
    expect(matchesApprovedName('스타벅스 강남점', '스타벅스강남점')).toBe(true)
  })

  test('matches any approved alias', () => {
    // A business is genuinely known by several names — its legal name, its sign, its Naver listing.
    expect(matchesApprovedName('스벅 강남', '스타벅스강남점', ['스벅강남', '스타벅스 강남'])).toBe(true)
  })

  test('an UNAPPROVED alias does not match', () => {
    // The whole point of an approved list. A plausible-looking nickname is not authorization.
    expect(matchesApprovedName('스타벅스 신촌점', '스타벅스강남점', ['스벅강남'])).toBe(false)
  })

  test('an empty candidate never matches, even an empty approved name', () => {
    // Otherwise an OCR pass that read nothing would validate as the right business — a failure that
    // produces a confident wrong answer rather than an error.
    expect(matchesApprovedName('', '스타벅스')).toBe(false)
    expect(matchesApprovedName('', '')).toBe(false)
    expect(matchesApprovedName('   ', '스타벅스')).toBe(false)
    // A candidate made only of insignificant characters is equally empty after normalization.
    expect(matchesApprovedName('()-·', '스타벅스')).toBe(false)
  })

  test('an empty alias in the list does not become a wildcard', () => {
    expect(matchesApprovedName('아무거나', '스타벅스', ['', '  '])).toBe(false)
  })
})

describe('matchesBranch', () => {
  test('branch is checked SEPARATELY from the name', () => {
    // T23's third criterion. A booking at the right business but the wrong branch is a different
    // failure from a booking at the wrong business, and §16.7 has to be able to say which.
    expect(matchesBranch('강남점', '강남점')).toBe(true)
    expect(matchesBranch('홍대점', '강남점')).toBe(false)
  })

  test('normalization applies to the branch too', () => {
    expect(matchesBranch('강남 점'.normalize('NFD'), '강남점')).toBe(true)
  })

  test('a campaign with no configured branch accepts any branch', () => {
    // A single-location business should not have to invent one.
    expect(matchesBranch('강남점', null)).toBe(true)
    expect(matchesBranch(undefined, null)).toBe(true)
    expect(matchesBranch('강남점', '')).toBe(true)
  })

  test('a configured branch requires a candidate', () => {
    // If the campaign names a branch, "no branch given" is a failure — not a pass by omission.
    expect(matchesBranch(undefined, '강남점')).toBe(false)
  })
})

describe('purity', () => {
  test('the same input always gives the same output', () => {
    // A stored normalized form is only trustworthy if this cannot vary. It is why the file is named
    // *-normalizer.ts, which puts it in eslint.config.js's PURE set.
    const name = '㈜스타벅스 (강남점)'
    const first = normalizeBusinessName(name)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(normalizeBusinessName(name)).toBe(first)
    }
  })

  test('normalizing an already-normalized value changes nothing', () => {
    // Idempotence. Without it, a value normalized on write and again on read would stop matching
    // itself.
    const once = normalizeBusinessName('㈜ 스타벅스 (강남점)')
    expect(normalizeBusinessName(once)).toBe(once)
  })
})
