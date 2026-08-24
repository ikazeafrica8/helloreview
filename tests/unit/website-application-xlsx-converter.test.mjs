import { describe, expect, test } from 'vitest'
import {
  convertWebsiteRows,
  normalizeWebsiteKoreanPhone,
  WEBSITE_EXPORT_FAILURES,
  WEBSITE_EXPORT_HEADERS,
  WebsiteExportError,
  websiteSeoulTimestamp,
} from '../../tools/lib/helloreview-website-export.mjs'
import { parseApplicationCsv } from '../../apps/api/dist/modules/application-sync/manual-csv-import.js'

const websiteRow = (overrides = {}) => {
  const values = {
    고유번호: '101',
    캠페인번호: '2026000001',
    채널: 'https://blog.example/pilot',
    '진행상태(1신청/2선정/3검수요청/4등록완료/5미선정/6선정후 취소/7수정요청)': '1',
    리뷰신청일시: '2026-08-24 13:07:46',
    이름: 'Example Applicant',
    휴대폰: '010-1234-5678',
    지역: '서울',
    회원레벨: '1',
    블로그일평균방문자수: '1250',
    ...overrides,
  }
  return WEBSITE_EXPORT_HEADERS.map((header) => values[header] ?? '')
}

const options = (overrides = {}) => ({
  exportedAt: new Date('2026-08-24T05:02:48Z'),
  allowMissingPhone: false,
  ...overrides,
})

const rejection = (body) => {
  try {
    body()
  } catch (error) {
    if (error instanceof WebsiteExportError) return error
    throw error
  }
  throw new Error('expected WebsiteExportError')
}

describe('HelloReview website XLSX mapping', () => {
  test('maps the verified Korean columns into the canonical import contract', () => {
    const converted = convertWebsiteRows(
      [WEBSITE_EXPORT_HEADERS, websiteRow()],
      options({ campaignMap: new Map([['2026000001', 'pilot-code']]) }),
    )
    expect(converted.report).toEqual({
      sourceRowCount: 1,
      convertedRowCount: 1,
      skippedMissingPhoneRows: [],
      droppedNonUrlChannels: 0,
    })
    expect(parseApplicationCsv(converted.csv)).toEqual([
      {
        sourceApplicationId: '101',
        campaignCode: 'pilot-code',
        status: 'received',
        applicantName: 'Example Applicant',
        phoneNormalized: '+821012345678',
        blogUrl: 'https://blog.example/pilot',
        bloggerLevel: 1,
        blogDailyVisitors: 1250,
        bloggerRegion: '서울',
        submittedAt: new Date('2026-08-24T04:07:46Z'),
        updatedAt: new Date('2026-08-24T05:02:48Z'),
      },
    ])
  })

  test('requires the exact 33-column export schema', () => {
    const changedHeaders = [...WEBSITE_EXPORT_HEADERS]
    changedHeaders[0] = 'changed'
    expect(rejection(() => convertWebsiteRows([changedHeaders, websiteRow()], options()))).toMatchObject({
      reasonCode: WEBSITE_EXPORT_FAILURES.INVALID_HEADER,
    })
  })

  test('maps only observed and approved status 1, rejecting unverified lifecycle semantics', () => {
    const statusHeader = '진행상태(1신청/2선정/3검수요청/4등록완료/5미선정/6선정후 취소/7수정요청)'
    expect(
      rejection(() => convertWebsiteRows([WEBSITE_EXPORT_HEADERS, websiteRow({ [statusHeader]: '2' })], options())),
    ).toMatchObject({ reasonCode: WEBSITE_EXPORT_FAILURES.UNSUPPORTED_STATUS, rowNumber: 2 })
  })

  test('fails closed on a blank phone unless the operator explicitly allows an incomplete conversion', () => {
    expect(
      rejection(() => convertWebsiteRows([WEBSITE_EXPORT_HEADERS, websiteRow({ 휴대폰: '' })], options())),
    ).toMatchObject({ reasonCode: WEBSITE_EXPORT_FAILURES.MISSING_PHONE, rowNumber: 2 })
    const allowed = convertWebsiteRows(
      [WEBSITE_EXPORT_HEADERS, websiteRow({ 휴대폰: '' })],
      options({ allowMissingPhone: true }),
    )
    expect(allowed.report).toMatchObject({ convertedRowCount: 0, skippedMissingPhoneRows: [2] })
  })

  test('drops a non-URL channel because blog URL is optional and phone remains binding evidence', () => {
    const converted = convertWebsiteRows([WEBSITE_EXPORT_HEADERS, websiteRow({ 채널: 'not-a-url' })], options())
    expect(converted.report.droppedNonUrlChannels).toBe(1)
    expect(parseApplicationCsv(converted.csv)[0]).not.toHaveProperty('blogUrl')
  })

  test.each([
    ['blank level', { 회원레벨: '' }, WEBSITE_EXPORT_FAILURES.INVALID_BLOGGER_LEVEL],
    ['zero level', { 회원레벨: '0' }, WEBSITE_EXPORT_FAILURES.INVALID_BLOGGER_LEVEL],
    ['negative visitor count', { 블로그일평균방문자수: '-1' }, WEBSITE_EXPORT_FAILURES.INVALID_VISITOR_COUNT],
    ['fractional visitor count', { 블로그일평균방문자수: '10.5' }, WEBSITE_EXPORT_FAILURES.INVALID_VISITOR_COUNT],
  ])('rejects invalid ranking evidence: %s', (_label, override, reasonCode) => {
    expect(
      rejection(() => convertWebsiteRows([WEBSITE_EXPORT_HEADERS, websiteRow(override)], options())),
    ).toMatchObject({ reasonCode, rowNumber: 2 })
  })

  test('allows a blank coarse region without retaining detailed address fields', () => {
    const converted = convertWebsiteRows([WEBSITE_EXPORT_HEADERS, websiteRow({ 지역: '' })], options())
    expect(parseApplicationCsv(converted.csv)[0]).toMatchObject({ bloggerRegion: null })
  })

  test.each([
    ['010-1234-5678', '+821012345678'],
    ['01012345678', '+821012345678'],
    ['+82 10-1234-5678', '+821012345678'],
    ['821012345678', '+821012345678'],
  ])('normalizes Korean phone form %s', (raw, expected) => {
    expect(normalizeWebsiteKoreanPhone(raw, 2)).toBe(expected)
  })

  test('validates impossible local dates rather than letting Date normalize them silently', () => {
    expect(websiteSeoulTimestamp('2026-08-24 13:07:46', 2)).toEqual(new Date('2026-08-24T04:07:46Z'))
    expect(rejection(() => websiteSeoulTimestamp('2026-02-30 13:07:46', 2))).toMatchObject({
      reasonCode: WEBSITE_EXPORT_FAILURES.INVALID_TIMESTAMP,
    })
  })

  test('does not echo PII-bearing cell values in conversion errors', () => {
    const privateValue = 'private-value-that-must-not-leak'
    const error = rejection(() =>
      convertWebsiteRows([WEBSITE_EXPORT_HEADERS, websiteRow({ 휴대폰: privateValue })], options()),
    )
    expect(error.message).not.toContain(privateValue)
  })
})
