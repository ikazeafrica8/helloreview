import { describe, expect, test } from 'vitest'
import {
  APPLICATION_IMPORT_FAILURES,
  ManualCsvImportError,
  ManualCsvImportService,
} from '../../apps/api/dist/modules/application-sync/index.js'

const header = [
  'application_id',
  'campaign_code',
  'application_status',
  'applicant_name',
  'phone_normalized',
  'blog_url',
  'blogger_level',
  'blog_daily_visitors',
  'blogger_region',
  'submitted_at',
  'updated_at',
].join(',')

const content = `${header}\nmanual-app-1,manual-pilot,website-code-2,Pilot Applicant,+821012345678,https://blog.example/pilot,1,1250,서울,2026-08-24T01:00:00Z,2026-08-24T01:05:00Z\n`

describe('manual application import quarantine', () => {
  test('persists one privacy-minimized quarantine record and replays it safely', async () => {
    const batch = {
      id: '11111111-1111-4111-8111-111111111111',
      source_system: 'helloreview_website',
      exported_at: new Date('2026-08-24T01:10:00Z'),
      imported_at: new Date('2026-08-24T01:11:00Z'),
      status: 'quarantined',
      quarantine_reason_code: APPLICATION_IMPORT_FAILURES.UNSUPPORTED_STATUS,
      quarantine_row_number: 2,
      row_count: 1,
      applied_count: 0,
      duplicate_count: 0,
      stale_count: 0,
    }
    const calls = []
    let inserted = false
    const pool = {
      query: async (sql, values) => {
        calls.push({ sql, values })
        if (sql.startsWith('INSERT INTO application_import_batches')) {
          if (inserted) return { rows: [], rowCount: 0 }
          inserted = true
          return { rows: [batch], rowCount: 1 }
        }
        if (sql.includes('FROM application_import_batches')) return { rows: [batch], rowCount: 1 }
        throw new Error(`unexpected query: ${sql}`)
      },
    }
    const importer = new ManualCsvImportService(
      pool,
      { synchronizeUnversionedSnapshot: async () => Promise.reject(new Error('must not synchronize')) },
      'unit-test-import-key-at-least-16-characters',
    )

    const run = async (importedAt) => {
      try {
        await importer.importCsv({
          content,
          sourceSystem: 'helloreview_website',
          exportedAt: batch.exported_at,
          importedAt,
        })
      } catch (error) {
        expect(error).toBeInstanceOf(ManualCsvImportError)
        return error
      }
      throw new Error('expected ManualCsvImportError')
    }

    const first = await run(batch.imported_at)
    const replay = await run(new Date('2026-08-24T01:12:00Z'))
    expect(first).toMatchObject({
      reasonCode: APPLICATION_IMPORT_FAILURES.UNSUPPORTED_STATUS,
      rowNumber: 2,
      evidence: { batchId: batch.id, rowCount: 1, replayed: false },
    })
    expect(replay).toMatchObject({
      reasonCode: APPLICATION_IMPORT_FAILURES.UNSUPPORTED_STATUS,
      rowNumber: 2,
      evidence: { batchId: batch.id, rowCount: 1, replayed: true },
    })
    expect(calls.filter(({ sql }) => sql.startsWith('INSERT INTO application_import_batches'))).toHaveLength(2)
    expect(JSON.stringify(calls)).not.toContain('website-code-2')
    expect(JSON.stringify(calls)).not.toContain('Pilot Applicant')
    expect(JSON.stringify(calls)).not.toContain('+821012345678')
  })
})
