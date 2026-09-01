import { createHash, createHmac } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import type { Pool, PoolClient } from 'pg'
import type { UnversionedWebsiteApplicationSnapshot, WebsiteApplicationStatus } from '@helloreview/adapters'
import { ApplicationSyncService, type ApplicationSynchronizationOutcome } from './application-sync.service.js'

export const APPLICATION_IMPORT_HEADERS = [
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
] as const

export const APPLICATION_IMPORT_MAX_ROWS = 10_000
export const APPLICATION_IMPORT_INTENT = {
  SOURCE: 'helloreview_manual_import',
  EVENT_TYPE: 'application.import.completed',
} as const

export const APPLICATION_IMPORT_FAILURES = {
  MALFORMED_CSV: 'APPLICATION_IMPORT_MALFORMED_CSV',
  INVALID_HEADER: 'APPLICATION_IMPORT_INVALID_HEADER',
  TOO_MANY_ROWS: 'APPLICATION_IMPORT_TOO_MANY_ROWS',
  INVALID_ROW: 'APPLICATION_IMPORT_INVALID_ROW',
  UNSUPPORTED_STATUS: 'APPLICATION_IMPORT_UNSUPPORTED_STATUS',
  DUPLICATE_APPLICATION_ID: 'APPLICATION_IMPORT_DUPLICATE_APPLICATION_ID',
  UNKNOWN_CAMPAIGN: 'APPLICATION_IMPORT_UNKNOWN_CAMPAIGN',
  INVALID_EXPORTED_AT: 'APPLICATION_IMPORT_INVALID_EXPORTED_AT',
  INVALID_SOURCE_SYSTEM: 'APPLICATION_IMPORT_INVALID_SOURCE_SYSTEM',
  FILE_TOO_LARGE: 'APPLICATION_IMPORT_FILE_TOO_LARGE',
  INVALID_UTF8: 'APPLICATION_IMPORT_INVALID_UTF8',
} as const

export type ApplicationImportFailure = (typeof APPLICATION_IMPORT_FAILURES)[keyof typeof APPLICATION_IMPORT_FAILURES]

export class ManualCsvImportError extends Error {
  override readonly name = 'ManualCsvImportError'

  constructor(
    readonly reasonCode: ApplicationImportFailure,
    readonly rowNumber?: number,
    readonly evidence: Readonly<{
      rowCount?: number
      batchId?: string
      replayed?: boolean
    }> = {},
  ) {
    super(
      `Manual CSV import rejected: ${reasonCode}${rowNumber === undefined ? '' : ` at record ${String(rowNumber)}`}`,
    )
  }
}

export type ParsedApplicationCsvRow = Readonly<{
  sourceApplicationId: string
  campaignCode: string
  status: WebsiteApplicationStatus
  applicantName: string
  phoneNormalized: string
  blogUrl?: string
  bloggerLevel: number
  blogDailyVisitors: number
  bloggerRegion: string | null
  submittedAt: Date
  updatedAt: Date
}>

export type ManualCsvImportOutcome = Readonly<{
  batchId: string
  sourceSystem: string
  exportedAt: Date
  importedAt: Date
  status: 'completed' | 'quarantined'
  quarantineReasonCode: ApplicationImportFailure | null
  quarantineRowNumber: number | null
  rowCount: number
  appliedCount: number
  duplicateCount: number
  staleCount: number
  replayed: boolean
}>

type BatchCounts = Readonly<{
  applied: number
  duplicate: number
  stale: number
}>

const WEBSITE_STATUSES: readonly WebsiteApplicationStatus[] = [
  'received',
  'completed',
  'matched',
  'ambiguous',
  'cancelled',
]

const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const E164 = /^\+[1-9]\d{7,14}$/
const SOURCE_SYSTEM = /^[a-z][a-z0-9_.-]{2,63}$/
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000
const MAX_POSTGRES_INTEGER = 2_147_483_647

const failRow = (rowNumber: number): never => {
  throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.INVALID_ROW, rowNumber)
}

const stringRecord = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const fields: readonly unknown[] = value
  const strings: string[] = []
  for (const field of fields) {
    if (typeof field !== 'string') return undefined
    strings.push(field)
  }
  return strings
}

const fieldAt = (record: readonly string[], index: number, rowNumber: number): string => {
  const value = record[index]
  return value === undefined ? failRow(rowNumber) : value.trim()
}

const boundedText = (value: string, maximum: number, rowNumber: number): string => {
  if (value.length === 0 || value.length > maximum) return failRow(rowNumber)
  return value
}

const optionalBoundedText = (value: string, maximum: number, rowNumber: number): string | null => {
  if (value.length > maximum) return failRow(rowNumber)
  return value === '' ? null : value
}

const integer = (value: string, minimum: number, rowNumber: number): number => {
  if (!/^\d+$/.test(value)) return failRow(rowNumber)
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > MAX_POSTGRES_INTEGER) return failRow(rowNumber)
  return parsed
}

const timestamp = (value: string, rowNumber: number): Date => {
  if (!ISO_WITH_TIMEZONE.test(value)) return failRow(rowNumber)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return failRow(rowNumber)
  return parsed
}

const status = (value: string, rowNumber: number): WebsiteApplicationStatus => {
  const known = WEBSITE_STATUSES.find((candidate) => candidate === value)
  if (known !== undefined) return known
  throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.UNSUPPORTED_STATUS, rowNumber)
}

const optionalBlogUrl = (value: string, rowNumber: number): string | undefined => {
  if (value === '') return undefined
  if (value.length > 2_048) return failRow(rowNumber)
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return failRow(rowNumber)
    return value
  } catch {
    return failRow(rowNumber)
  }
}

const normalizeRow = (record: readonly string[], rowNumber: number): ParsedApplicationCsvRow => {
  if (record.length !== APPLICATION_IMPORT_HEADERS.length) return failRow(rowNumber)
  const sourceApplicationId = boundedText(fieldAt(record, 0, rowNumber), 200, rowNumber)
  const campaignCode = boundedText(fieldAt(record, 1, rowNumber), 100, rowNumber)
  const sourceStatus = status(fieldAt(record, 2, rowNumber), rowNumber)
  const applicantName = boundedText(fieldAt(record, 3, rowNumber), 200, rowNumber)
  const phoneNormalized = fieldAt(record, 4, rowNumber)
  if (!E164.test(phoneNormalized)) return failRow(rowNumber)
  const blogUrl = optionalBlogUrl(fieldAt(record, 5, rowNumber), rowNumber)
  const bloggerLevel = integer(fieldAt(record, 6, rowNumber), 1, rowNumber)
  const blogDailyVisitors = integer(fieldAt(record, 7, rowNumber), 0, rowNumber)
  const bloggerRegion = optionalBoundedText(fieldAt(record, 8, rowNumber), 100, rowNumber)
  const submittedAt = timestamp(fieldAt(record, 9, rowNumber), rowNumber)
  const updatedAt = timestamp(fieldAt(record, 10, rowNumber), rowNumber)
  if (updatedAt.getTime() < submittedAt.getTime()) return failRow(rowNumber)

  return {
    sourceApplicationId,
    campaignCode,
    status: sourceStatus,
    applicantName,
    phoneNormalized,
    ...(blogUrl === undefined ? {} : { blogUrl }),
    bloggerLevel,
    blogDailyVisitors,
    bloggerRegion,
    submittedAt,
    updatedAt,
  }
}

export const parseApplicationCsv = (content: string): readonly ParsedApplicationCsvRow[] => {
  let parsed: unknown
  try {
    parsed = parse(content, {
      bom: true,
      max_record_size: 1_000_000,
      relax_column_count: false,
      skip_empty_lines: true,
    })
  } catch {
    throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.MALFORMED_CSV)
  }

  if (!Array.isArray(parsed)) throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.MALFORMED_CSV)
  const records: readonly unknown[] = parsed
  const header = stringRecord(records[0])
  if (
    header?.length !== APPLICATION_IMPORT_HEADERS.length ||
    !APPLICATION_IMPORT_HEADERS.every((expected, index) => header[index] === expected)
  ) {
    throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.INVALID_HEADER)
  }

  if (records.length - 1 > APPLICATION_IMPORT_MAX_ROWS) {
    throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.TOO_MANY_ROWS)
  }

  const normalized: ParsedApplicationCsvRow[] = []
  const applicationIds = new Set<string>()
  for (let index = 1; index < records.length; index += 1) {
    const rowNumber = index + 1
    const record = stringRecord(records[index])
    if (record === undefined) return failRow(rowNumber)
    let row: ParsedApplicationCsvRow
    try {
      row = normalizeRow(record, rowNumber)
    } catch (error) {
      if (error instanceof ManualCsvImportError) {
        throw new ManualCsvImportError(error.reasonCode, error.rowNumber, { rowCount: records.length - 1 })
      }
      throw error
    }
    if (applicationIds.has(row.sourceApplicationId)) {
      throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.DUPLICATE_APPLICATION_ID, rowNumber)
    }
    applicationIds.add(row.sourceApplicationId)
    normalized.push(row)
  }
  return normalized
}

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`application import query returned an invalid ${column}`)
}

const integerColumn = (row: Record<string, unknown>, column: string): number => {
  const value = Number(row[column])
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw new Error(`application import query returned an invalid ${column}`)
}

const nullableIntegerColumn = (row: Record<string, unknown>, column: string): number | null => {
  const value = row[column]
  if (value === null) return null
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  throw new Error(`application import query returned an invalid ${column}`)
}

const isApplicationImportFailure = (value: unknown): value is ApplicationImportFailure =>
  typeof value === 'string' && Object.values(APPLICATION_IMPORT_FAILURES).some((candidate) => candidate === value)

const nullableFailureColumn = (row: Record<string, unknown>, column: string): ApplicationImportFailure | null => {
  const value = row[column]
  if (value === null) return null
  if (isApplicationImportFailure(value)) return value
  throw new Error(`application import query returned an invalid ${column}`)
}

const batchStatusColumn = (row: Record<string, unknown>): ManualCsvImportOutcome['status'] => {
  const value = row.status
  if (value === 'completed' || value === 'quarantined') return value
  throw new Error('application import query returned an invalid status')
}

const dateColumn = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`application import query returned an invalid ${column}`)
}

const batchFromRow = (row: Record<string, unknown>, replayed: boolean): ManualCsvImportOutcome => ({
  batchId: stringColumn(row, 'id'),
  sourceSystem: stringColumn(row, 'source_system'),
  exportedAt: dateColumn(row, 'exported_at'),
  importedAt: dateColumn(row, 'imported_at'),
  status: batchStatusColumn(row),
  quarantineReasonCode: nullableFailureColumn(row, 'quarantine_reason_code'),
  quarantineRowNumber: nullableIntegerColumn(row, 'quarantine_row_number'),
  rowCount: integerColumn(row, 'row_count'),
  appliedCount: integerColumn(row, 'applied_count'),
  duplicateCount: integerColumn(row, 'duplicate_count'),
  staleCount: integerColumn(row, 'stale_count'),
  replayed,
})

const selectBatch = `SELECT id, source_system, exported_at, imported_at, status,
                            quarantine_reason_code, quarantine_row_number, row_count,
                            applied_count, duplicate_count, stale_count
                       FROM application_import_batches
                      WHERE source_system = $1 AND file_digest = $2`

const increment = (counts: BatchCounts, outcome: ApplicationSynchronizationOutcome['outcome']): BatchCounts => ({
  ...counts,
  [outcome]: counts[outcome] + 1,
})

/** Content identity deliberately excludes occurrence time so unchanged rows in a later export replay safely. */
export const applicationImportEventId = (
  eventKey: string,
  sourceSystem: string,
  row: ParsedApplicationCsvRow,
): string => {
  const canonical = JSON.stringify([
    sourceSystem,
    row.sourceApplicationId,
    row.campaignCode,
    row.status,
    row.applicantName,
    row.phoneNormalized,
    row.blogUrl ?? null,
    row.bloggerLevel,
    row.blogDailyVisitors,
    row.bloggerRegion,
    row.submittedAt.toISOString(),
  ])
  const digest = createHmac('sha256', eventKey).update('application-csv-event-v2\0').update(canonical).digest('hex')
  return `manual_csv_${digest}`
}

export class ManualCsvImportService {
  constructor(
    private readonly pool: Pool,
    private readonly synchronization: ApplicationSyncService,
    private readonly eventKey: string,
  ) {}

  async importCsv(
    input: Readonly<{
      content: string
      sourceSystem: string
      exportedAt: Date
      importedAt?: Date
    }>,
  ): Promise<ManualCsvImportOutcome> {
    const importedAt = input.importedAt ?? new Date()
    this.validateImportEvidence(input.sourceSystem, input.exportedAt, importedAt)
    const fileDigest = this.fileDigest(input.sourceSystem, input.exportedAt, input.content)
    let rows: readonly ParsedApplicationCsvRow[]
    try {
      rows = parseApplicationCsv(input.content)
    } catch (error) {
      if (
        error instanceof ManualCsvImportError &&
        error.reasonCode === APPLICATION_IMPORT_FAILURES.UNSUPPORTED_STATUS
      ) {
        const batch = await this.recordQuarantineBatch(
          input.sourceSystem,
          fileDigest,
          input.exportedAt,
          importedAt,
          error.evidence.rowCount ?? 0,
          error.reasonCode,
          error.rowNumber,
        )
        throw new ManualCsvImportError(error.reasonCode, error.rowNumber, {
          rowCount: batch.rowCount,
          batchId: batch.batchId,
          replayed: batch.replayed,
        })
      }
      throw error
    }
    for (const [index, row] of rows.entries()) {
      if (row.updatedAt.getTime() > importedAt.getTime() + MAX_CLOCK_SKEW_MS) return failRow(index + 2)
    }
    const replay = await this.pool.query<Record<string, unknown>>(selectBatch, [input.sourceSystem, fileDigest])
    const replayRow = replay.rows[0]
    if (replayRow !== undefined) {
      const batch = batchFromRow(replayRow, true)
      if (batch.status === 'quarantined') this.throwQuarantinedBatch(batch)
      const applicationIds = await this.applicationIdsForRows(input.sourceSystem, rows)
      await this.ensureReplayIntent(batch, applicationIds)
      return batch
    }
    const campaigns = await this.campaignIds(rows)

    let counts: BatchCounts = { applied: 0, duplicate: 0, stale: 0 }
    const applicationIds = new Set<string>()
    for (const row of rows) {
      const campaignId = campaigns.get(row.campaignCode)
      if (campaignId === undefined) {
        throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.UNKNOWN_CAMPAIGN)
      }
      const snapshot: UnversionedWebsiteApplicationSnapshot = {
        sourceSystem: input.sourceSystem,
        sourceApplicationId: row.sourceApplicationId,
        campaignId,
        status: row.status,
        applicantName: row.applicantName,
        phoneNormalized: row.phoneNormalized,
        ...(row.blogUrl === undefined ? {} : { blogUrl: row.blogUrl }),
        bloggerLevel: row.bloggerLevel,
        blogDailyVisitors: row.blogDailyVisitors,
        bloggerRegion: row.bloggerRegion,
        submittedAt: row.submittedAt,
        sourceEventId: applicationImportEventId(this.eventKey, input.sourceSystem, row),
        sourceOccurredAt: row.updatedAt,
      }
      const outcome = await this.synchronization.synchronizeUnversionedSnapshot(snapshot, importedAt)
      counts = increment(counts, outcome.outcome)
      applicationIds.add(outcome.applicationId)
    }

    return this.recordBatch(input.sourceSystem, fileDigest, input.exportedAt, importedAt, rows.length, counts, [
      ...applicationIds,
    ])
  }

  private validateImportEvidence(sourceSystem: string, exportedAt: Date, importedAt: Date): void {
    if (!SOURCE_SYSTEM.test(sourceSystem)) {
      throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.INVALID_SOURCE_SYSTEM)
    }
    if (
      Number.isNaN(exportedAt.getTime()) ||
      Number.isNaN(importedAt.getTime()) ||
      exportedAt.getTime() > importedAt.getTime() + MAX_CLOCK_SKEW_MS
    ) {
      throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.INVALID_EXPORTED_AT)
    }
  }

  private fileDigest(sourceSystem: string, exportedAt: Date, content: string): string {
    return createHmac('sha256', this.eventKey)
      .update('application-csv-batch-v1\0')
      .update(sourceSystem)
      .update('\0')
      .update(exportedAt.toISOString())
      .update('\0')
      .update(content)
      .digest('hex')
  }

  private async campaignIds(rows: readonly ParsedApplicationCsvRow[]): Promise<ReadonlyMap<string, string>> {
    const codes = [...new Set(rows.map((row) => row.campaignCode))]
    if (codes.length === 0) return new Map()
    const result = await this.pool.query<Record<string, unknown>>(
      'SELECT id, code FROM campaigns WHERE code = ANY($1::text[])',
      [codes],
    )
    const campaigns = new Map<string, string>()
    for (const row of result.rows) campaigns.set(stringColumn(row, 'code'), stringColumn(row, 'id'))
    if (campaigns.size !== codes.length) {
      throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.UNKNOWN_CAMPAIGN)
    }
    return campaigns
  }

  private async applicationIdsForRows(
    sourceSystem: string,
    rows: readonly ParsedApplicationCsvRow[],
  ): Promise<readonly string[]> {
    const sourceApplicationIds = rows.map((row) => row.sourceApplicationId)
    if (sourceApplicationIds.length === 0) return []
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id
         FROM applications
        WHERE source_system = $1 AND source_application_id = ANY($2::text[])
        ORDER BY id`,
      [sourceSystem, sourceApplicationIds],
    )
    if (result.rows.length !== sourceApplicationIds.length) {
      throw new Error('application import replay is missing an application projection')
    }
    return result.rows.map((row) => stringColumn(row, 'id'))
  }

  private async recordBatch(
    sourceSystem: string,
    fileDigest: string,
    exportedAt: Date,
    importedAt: Date,
    rowCount: number,
    counts: BatchCounts,
    applicationIds: readonly string[],
  ): Promise<ManualCsvImportOutcome> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query<Record<string, unknown>>(
        `INSERT INTO application_import_batches (
           source_system, file_digest, exported_at, imported_at, status, row_count,
           applied_count, duplicate_count, stale_count
         ) VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$8)
         ON CONFLICT (source_system, file_digest) DO NOTHING
         RETURNING id, source_system, exported_at, imported_at, status,
                   quarantine_reason_code, quarantine_row_number, row_count,
                   applied_count, duplicate_count, stale_count`,
        [sourceSystem, fileDigest, exportedAt, importedAt, rowCount, counts.applied, counts.duplicate, counts.stale],
      )
      const insertedRow = inserted.rows[0]
      if (insertedRow === undefined) {
        const concurrent = await client.query<Record<string, unknown>>(selectBatch, [sourceSystem, fileDigest])
        const concurrentRow = concurrent.rows[0]
        if (concurrentRow === undefined) throw new Error('application import replay batch was not visible')
        const concurrentBatch = batchFromRow(concurrentRow, true)
        if (concurrentBatch.status === 'quarantined') this.throwQuarantinedBatch(concurrentBatch)
        await this.ensureProcessingIntent(client, concurrentBatch, applicationIds)
        await client.query('COMMIT')
        return concurrentBatch
      }

      const batch = batchFromRow(insertedRow, false)
      await this.recordFreshness(client, sourceSystem, exportedAt, importedAt)
      await this.ensureProcessingIntent(client, batch, applicationIds)
      await client.query('COMMIT')
      return batch
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async recordQuarantineBatch(
    sourceSystem: string,
    fileDigest: string,
    exportedAt: Date,
    importedAt: Date,
    rowCount: number,
    reasonCode: ApplicationImportFailure,
    rowNumber?: number,
  ): Promise<ManualCsvImportOutcome> {
    const inserted = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO application_import_batches (
         source_system, file_digest, exported_at, imported_at, status,
         quarantine_reason_code, quarantine_row_number, row_count,
         applied_count, duplicate_count, stale_count
       ) VALUES ($1,$2,$3,$4,'quarantined',$5,$6,$7,0,0,0)
       ON CONFLICT (source_system, file_digest) DO NOTHING
       RETURNING id, source_system, exported_at, imported_at, status,
                 quarantine_reason_code, quarantine_row_number, row_count,
                 applied_count, duplicate_count, stale_count`,
      [sourceSystem, fileDigest, exportedAt, importedAt, reasonCode, rowNumber ?? null, rowCount],
    )
    const insertedRow = inserted.rows[0]
    if (insertedRow !== undefined) return batchFromRow(insertedRow, false)

    const replay = await this.pool.query<Record<string, unknown>>(selectBatch, [sourceSystem, fileDigest])
    const replayRow = replay.rows[0]
    if (replayRow === undefined) throw new Error('application import quarantine replay batch was not visible')
    const batch = batchFromRow(replayRow, true)
    if (
      batch.status !== 'quarantined' ||
      batch.quarantineReasonCode !== reasonCode ||
      batch.quarantineRowNumber !== (rowNumber ?? null)
    ) {
      throw new Error('application import quarantine evidence diverged on replay')
    }
    return batch
  }

  private throwQuarantinedBatch(batch: ManualCsvImportOutcome): never {
    if (batch.quarantineReasonCode === null) {
      throw new Error('application import quarantined batch is missing a reason code')
    }
    throw new ManualCsvImportError(batch.quarantineReasonCode, batch.quarantineRowNumber ?? undefined, {
      rowCount: batch.rowCount,
      batchId: batch.batchId,
      replayed: true,
    })
  }

  private async ensureReplayIntent(batch: ManualCsvImportOutcome, applicationIds: readonly string[]): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.ensureProcessingIntent(client, batch, applicationIds)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async ensureProcessingIntent(
    client: PoolClient,
    batch: ManualCsvImportOutcome,
    applicationIds: readonly string[],
  ): Promise<void> {
    const payload = {
      batchId: batch.batchId,
      sourceSystem: batch.sourceSystem,
      applicationIds: [...new Set(applicationIds)].sort(),
    }
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO event_inbox (
         source, external_event_id, event_type, payload_hash, payload,
         occurred_at, received_at, status, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'received',$8)
       ON CONFLICT (source, external_event_id) DO NOTHING
       RETURNING id`,
      [
        APPLICATION_IMPORT_INTENT.SOURCE,
        batch.batchId,
        APPLICATION_IMPORT_INTENT.EVENT_TYPE,
        payloadHash,
        payload,
        batch.exportedAt,
        batch.importedAt,
        `application-import:${batch.batchId}`,
      ],
    )
    if (inserted.rowCount === 1) return

    const existing = await client.query<Record<string, unknown>>(
      `SELECT payload_hash
         FROM event_inbox
        WHERE source = $1 AND external_event_id = $2`,
      [APPLICATION_IMPORT_INTENT.SOURCE, batch.batchId],
    )
    if (existing.rows[0]?.payload_hash !== payloadHash) {
      throw new Error('application import processing intent payload diverged on replay')
    }
  }

  private async recordFreshness(
    client: PoolClient,
    sourceSystem: string,
    exportedAt: Date,
    importedAt: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO application_source_freshness (
         source_system, last_attempted_at, last_successful_reconciliation_at,
         consecutive_failure_count, last_failure_reason, updated_at
       ) VALUES ($1,$2,$3,0,NULL,$2)
       ON CONFLICT (source_system) DO UPDATE SET
         last_attempted_at = EXCLUDED.last_attempted_at,
         last_successful_reconciliation_at = GREATEST(
           application_source_freshness.last_successful_reconciliation_at,
           EXCLUDED.last_successful_reconciliation_at
         ),
         consecutive_failure_count = 0,
         last_failure_reason = NULL,
         updated_at = EXCLUDED.updated_at`,
      [sourceSystem, importedAt, exportedAt],
    )
  }
}
