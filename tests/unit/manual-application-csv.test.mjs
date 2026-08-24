import { describe, expect, test } from 'vitest'
import {
  APPLICATION_IMPORT_FAILURES,
  APPLICATION_IMPORT_HEADERS,
  APPLICATION_IMPORT_MAX_ROWS,
  applicationImportEventId,
  ManualCsvImportError,
  parseApplicationCsv,
} from '../../apps/api/dist/modules/application-sync/manual-csv-import.js'

const header = APPLICATION_IMPORT_HEADERS.join(',')
const validRow = [
  'website-app-1',
  'pilot-2026',
  'received',
  'Pilot Applicant',
  '+821012345678',
  'https://blog.example/pilot',
  '1',
  '1250',
  '서울',
  '2026-08-24T01:00:00Z',
  '2026-08-24T01:05:00Z',
].join(',')

const reasonOf = (body) => {
  try {
    body()
  } catch (error) {
    if (error instanceof ManualCsvImportError) return error.reasonCode
    throw error
  }
  throw new Error('expected ManualCsvImportError')
}

describe('manual application CSV contract', () => {
  test('parses UTF-8 BOM, quoted commas and embedded newlines without changing values', () => {
    const content = `\uFEFF${header}\nwebsite-app-1,pilot-2026,received,"Pilot,\nApplicant",+821012345678,,1,1250,,2026-08-24T01:00:00Z,2026-08-24T01:05:00Z\n`
    expect(parseApplicationCsv(content)).toEqual([
      {
        sourceApplicationId: 'website-app-1',
        campaignCode: 'pilot-2026',
        status: 'received',
        applicantName: 'Pilot,\nApplicant',
        phoneNormalized: '+821012345678',
        bloggerLevel: 1,
        blogDailyVisitors: 1250,
        bloggerRegion: null,
        submittedAt: new Date('2026-08-24T01:00:00Z'),
        updatedAt: new Date('2026-08-24T01:05:00Z'),
      },
    ])
  })

  test('allows a header-only full snapshot', () => {
    expect(parseApplicationCsv(`${header}\n`)).toEqual([])
  })

  test('requires the exact canonical header order', () => {
    const swapped = [...APPLICATION_IMPORT_HEADERS]
    const first = swapped[0]
    swapped[0] = swapped[1]
    swapped[1] = first
    expect(reasonOf(() => parseApplicationCsv(`${swapped.join(',')}\n${validRow}`))).toBe(
      APPLICATION_IMPORT_FAILURES.INVALID_HEADER,
    )
  })

  test.each([
    ['unsupported status', validRow.replace(',received,', ',approved,')],
    ['non-E.164 phone', validRow.replace('+821012345678', '010-1234-5678')],
    ['timestamp without timezone', validRow.replace('2026-08-24T01:05:00Z', '2026-08-24T01:05:00')],
    ['update before submission', validRow.replace('2026-08-24T01:05:00Z', '2026-08-23T01:05:00Z')],
    ['unsafe URL scheme', validRow.replace('https://blog.example/pilot', 'javascript:alert(1)')],
    ['zero blogger level', validRow.replace(',1,1250,서울,', ',0,1250,서울,')],
    ['negative daily visitors', validRow.replace(',1,1250,서울,', ',1,-1,서울,')],
    ['fractional daily visitors', validRow.replace(',1,1250,서울,', ',1,10.5,서울,')],
  ])('rejects an invalid row: %s', (_label, row) => {
    expect(reasonOf(() => parseApplicationCsv(`${header}\n${row}`))).toBe(APPLICATION_IMPORT_FAILURES.INVALID_ROW)
  })

  test('rejects duplicate source application ids within one snapshot', () => {
    expect(reasonOf(() => parseApplicationCsv(`${header}\n${validRow}\n${validRow}`))).toBe(
      APPLICATION_IMPORT_FAILURES.DUPLICATE_APPLICATION_ID,
    )
  })

  test('rejects oversized row sets before normalization', () => {
    const rows = Array.from({ length: APPLICATION_IMPORT_MAX_ROWS + 1 }, () => validRow).join('\n')
    expect(reasonOf(() => parseApplicationCsv(`${header}\n${rows}`))).toBe(APPLICATION_IMPORT_FAILURES.TOO_MANY_ROWS)
  })

  test('safe errors never echo PII-bearing values', () => {
    const pii = 'sensitive-person-name'
    try {
      parseApplicationCsv(`${header}\n${validRow.replace('Pilot Applicant', pii).replace(',received,', ',wrong,')}`)
    } catch (error) {
      expect(error).toBeInstanceOf(ManualCsvImportError)
      if (error instanceof Error) expect(error.message).not.toContain(pii)
      return
    }
    throw new Error('expected ManualCsvImportError')
  })

  test('unchanged content keeps one event identity across later export timestamps', () => {
    const first = parseApplicationCsv(`${header}\n${validRow}`)[0]
    const later = parseApplicationCsv(
      `${header}\n${validRow.replace('2026-08-24T01:05:00Z', '2026-08-24T02:05:00Z')}`,
    )[0]
    const changed = parseApplicationCsv(`${header}\n${validRow.replace(',received,', ',completed,')}`)[0]
    const rankingChanged = parseApplicationCsv(`${header}\n${validRow.replace(',1,1250,서울,', ',2,1250,서울,')}`)[0]
    expect(applicationImportEventId('test-key', 'helloreview_website', first)).toBe(
      applicationImportEventId('test-key', 'helloreview_website', later),
    )
    expect(applicationImportEventId('test-key', 'helloreview_website', changed)).not.toBe(
      applicationImportEventId('test-key', 'helloreview_website', first),
    )
    expect(applicationImportEventId('test-key', 'helloreview_website', rankingChanged)).not.toBe(
      applicationImportEventId('test-key', 'helloreview_website', first),
    )
  })
})
