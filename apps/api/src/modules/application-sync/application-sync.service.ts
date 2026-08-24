import { Inject, Injectable } from '@nestjs/common'
import { EVENT_TYPES, type EventOfType, type PlatformEvent } from '@helloreview/contracts'
import type {
  UnversionedWebsiteApplicationSnapshot,
  WebsiteApplicationSnapshot,
  WebsiteApplicationStatus,
} from '@helloreview/adapters'
import { POSTGRES_POOL } from '@helloreview/db'
import { Pool, type PoolClient } from 'pg'
import { APPLICATION_SYNC_REASON, type ApplicationSyncReasonCode } from './reason-codes.js'

export type ApplicationStatus = WebsiteApplicationStatus | 'synchronized_late'

export type ApplicationSynchronizationOutcome = Readonly<{
  outcome: 'applied' | 'duplicate' | 'stale'
  applicationId: string
  status: ApplicationStatus
  sourceVersion: number
}>

export class ApplicationSynchronizationError extends Error {
  override readonly name = 'ApplicationSynchronizationError'

  constructor(
    readonly reasonCode: ApplicationSyncReasonCode,
    readonly sourceApplicationId: string,
  ) {
    super(`Application synchronization rejected: ${reasonCode}`)
  }
}

type FullApplicationInput = Readonly<{
  sourceSystem: string
  sourceApplicationId: string
  campaignId: string
  sourceStatus: WebsiteApplicationStatus
  applicationStatus: ApplicationStatus
  applicantName: string
  phoneNormalized: string
  blogUrl?: string
  bloggerLevel?: number
  blogDailyVisitors?: number
  bloggerRegion?: string | null
  submittedAt: Date
  sourceVersion?: number
  sourceEventId: string
  sourceOccurredAt: Date
  synchronizationMethod: 'event' | 'reconciliation'
  changedFields: readonly string[]
  synchronizedAt: Date
}>

type PartialApplicationInput = Readonly<{
  sourceSystem: string
  sourceApplicationId: string
  sourceStatus?: WebsiteApplicationStatus
  applicationStatus?: ApplicationStatus
  sourceVersion: number
  sourceEventId: string
  sourceOccurredAt: Date
  synchronizationMethod: 'event'
  changedFields: readonly string[]
  synchronizedAt: Date
}>

type ApplicationInput = FullApplicationInput | PartialApplicationInput

type VersionedFullApplicationInput = Omit<FullApplicationInput, 'sourceVersion'> & Readonly<{ sourceVersion: number }>
type VersionedApplicationInput = VersionedFullApplicationInput | PartialApplicationInput

type Projection = Readonly<{
  id: string
  status: ApplicationStatus
  sourceVersion: number
  lastSourceOccurredAt: Date
}>

const WEBSITE_STATUSES: readonly WebsiteApplicationStatus[] = [
  'received',
  'completed',
  'matched',
  'ambiguous',
  'cancelled',
]

const APPLICATION_STATUSES: readonly ApplicationStatus[] = [...WEBSITE_STATUSES, 'synchronized_late']

const websiteStatus = (value: string, sourceApplicationId: string): WebsiteApplicationStatus => {
  const known = WEBSITE_STATUSES.find((candidate) => candidate === value)
  if (known !== undefined) return known
  throw new ApplicationSynchronizationError(APPLICATION_SYNC_REASON.UNSUPPORTED_STATUS, sourceApplicationId)
}

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`application query returned a non-string ${column}`)
}

const projectionFromRow = (row: Record<string, unknown>): Projection => ({
  id: stringColumn(row, 'id'),
  status: (() => {
    const value = stringColumn(row, 'status')
    const known = APPLICATION_STATUSES.find((candidate) => candidate === value)
    if (known !== undefined) return known
    throw new Error('application query returned an unknown status')
  })(),
  sourceVersion: Number(row.source_version),
  lastSourceOccurredAt: (() => {
    const value = row.last_source_occurred_at
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value
    throw new Error('application query returned an invalid last_source_occurred_at')
  })(),
})

const isFullInput = (input: ApplicationInput): input is FullApplicationInput => 'campaignId' in input

const distinctFields = (fields: readonly string[]): readonly string[] => [
  ...new Set(fields.filter((field) => field.length > 0)),
]

const hasOwn = (value: object, property: string): boolean => Object.prototype.hasOwnProperty.call(value, property)

const rankingChangedFields = (
  snapshot: WebsiteApplicationSnapshot | UnversionedWebsiteApplicationSnapshot,
): readonly string[] => [
  ...(hasOwn(snapshot, 'bloggerLevel') ? ['blogger_level'] : []),
  ...(hasOwn(snapshot, 'blogDailyVisitors') ? ['blog_daily_visitors'] : []),
  ...(hasOwn(snapshot, 'bloggerRegion') ? ['blogger_region'] : []),
]

/** Current website application projection plus immutable, source-versioned change history. */
@Injectable()
export class ApplicationSyncService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async synchronizeEvent(
    event: PlatformEvent,
    synchronizedAt = new Date(),
  ): Promise<ApplicationSynchronizationOutcome> {
    if (event.eventType === EVENT_TYPES.APPLICATION_CREATED) {
      return this.synchronizeCreatedEvent(event, synchronizedAt)
    }
    if (event.eventType === EVENT_TYPES.APPLICATION_UPDATED) {
      return this.synchronizeUpdatedEvent(event, synchronizedAt)
    }
    throw new ApplicationSynchronizationError(APPLICATION_SYNC_REASON.UNSUPPORTED_EVENT, event.eventId)
  }

  async synchronizeSnapshot(
    snapshot: WebsiteApplicationSnapshot,
    synchronizedAt = new Date(),
  ): Promise<ApplicationSynchronizationOutcome> {
    const sourceStatus = websiteStatus(snapshot.status, snapshot.sourceApplicationId)
    return this.apply({
      ...snapshot,
      sourceStatus,
      applicationStatus: sourceStatus === 'cancelled' ? 'cancelled' : 'synchronized_late',
      synchronizationMethod: 'reconciliation',
      changedFields: [
        'campaign_id',
        'application_status',
        'applicant',
        'submitted_at',
        ...rankingChangedFields(snapshot),
      ],
      synchronizedAt,
    })
  }

  async synchronizeUnversionedSnapshot(
    snapshot: UnversionedWebsiteApplicationSnapshot,
    synchronizedAt = new Date(),
  ): Promise<ApplicationSynchronizationOutcome> {
    const sourceStatus = websiteStatus(snapshot.status, snapshot.sourceApplicationId)
    return this.apply({
      ...snapshot,
      sourceStatus,
      applicationStatus: sourceStatus === 'cancelled' ? 'cancelled' : 'synchronized_late',
      synchronizationMethod: 'reconciliation',
      changedFields: [
        'campaign_id',
        'application_status',
        'applicant',
        'submitted_at',
        ...rankingChangedFields(snapshot),
      ],
      synchronizedAt,
    })
  }

  private synchronizeCreatedEvent(
    event: EventOfType<'application.created'>,
    synchronizedAt: Date,
  ): Promise<ApplicationSynchronizationOutcome> {
    const sourceStatus = websiteStatus(event.payload.applicationStatus, event.payload.applicationId)
    return this.apply({
      sourceSystem: event.source,
      sourceApplicationId: event.payload.applicationId,
      campaignId: event.payload.campaignId,
      sourceStatus,
      applicationStatus: sourceStatus,
      applicantName: event.payload.applicant.name,
      phoneNormalized: event.payload.applicant.phoneNormalized,
      ...(event.payload.applicant.blogUrl === undefined ? {} : { blogUrl: event.payload.applicant.blogUrl }),
      submittedAt: new Date(event.payload.submittedAt),
      sourceVersion: 1,
      sourceEventId: event.eventId,
      sourceOccurredAt: new Date(event.occurredAt),
      synchronizationMethod: 'event',
      changedFields: ['campaign_id', 'application_status', 'applicant', 'submitted_at'],
      synchronizedAt,
    })
  }

  private synchronizeUpdatedEvent(
    event: EventOfType<'application.updated'>,
    synchronizedAt: Date,
  ): Promise<ApplicationSynchronizationOutcome> {
    const sourceStatus =
      event.payload.applicationStatus === undefined
        ? undefined
        : websiteStatus(event.payload.applicationStatus, event.payload.applicationId)
    return this.apply({
      sourceSystem: event.source,
      sourceApplicationId: event.payload.applicationId,
      ...(sourceStatus === undefined ? {} : { sourceStatus, applicationStatus: sourceStatus }),
      sourceVersion: event.payload.sourceVersion,
      sourceEventId: event.eventId,
      sourceOccurredAt: new Date(event.occurredAt),
      synchronizationMethod: 'event',
      changedFields: event.payload.changedFields,
      synchronizedAt,
    })
  }

  private async apply(input: ApplicationInput): Promise<ApplicationSynchronizationOutcome> {
    if (input.sourceVersion !== undefined && (!Number.isInteger(input.sourceVersion) || input.sourceVersion < 1)) {
      throw new ApplicationSynchronizationError(
        APPLICATION_SYNC_REASON.INVALID_SOURCE_VERSION,
        input.sourceApplicationId,
      )
    }
    if (
      isFullInput(input) &&
      ((hasOwn(input, 'bloggerLevel') &&
        (input.bloggerLevel === undefined ||
          !Number.isInteger(input.bloggerLevel) ||
          input.bloggerLevel < 1 ||
          input.bloggerLevel > 2_147_483_647)) ||
        (hasOwn(input, 'blogDailyVisitors') &&
          (input.blogDailyVisitors === undefined ||
            !Number.isInteger(input.blogDailyVisitors) ||
            input.blogDailyVisitors < 0 ||
            input.blogDailyVisitors > 2_147_483_647)) ||
        (hasOwn(input, 'bloggerRegion') &&
          input.bloggerRegion !== null &&
          (input.bloggerRegion === undefined || input.bloggerRegion.length === 0 || input.bloggerRegion.length > 100)))
    ) {
      throw new ApplicationSynchronizationError(
        APPLICATION_SYNC_REASON.INVALID_BLOGGER_RANKING,
        input.sourceApplicationId,
      )
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify([input.sourceSystem, input.sourceApplicationId]),
      ])

      const existingEvent = await this.findByEvent(client, input)
      if (existingEvent !== undefined) {
        await client.query('COMMIT')
        return this.outcome(existingEvent, 'duplicate')
      }

      const current = await this.findProjection(client, input)
      if (
        current !== undefined &&
        (input.sourceVersion === undefined
          ? input.sourceOccurredAt.getTime() < current.lastSourceOccurredAt.getTime()
          : input.sourceVersion <= current.sourceVersion)
      ) {
        await client.query('COMMIT')
        return this.outcome(current, 'stale')
      }

      const versionedInput: VersionedApplicationInput = {
        ...input,
        sourceVersion: input.sourceVersion ?? (current?.sourceVersion ?? 0) + 1,
      }

      const next =
        current === undefined
          ? await this.insertProjection(client, versionedInput)
          : await this.updateProjection(client, current, versionedInput)
      await this.appendChange(client, next, versionedInput)
      await client.query('COMMIT')
      return this.outcome(next, 'applied')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async findByEvent(client: PoolClient, input: ApplicationInput): Promise<Projection | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT a.id, a.status, a.source_version, a.last_source_occurred_at
         FROM application_changes c
         JOIN applications a ON a.id = c.application_id
        WHERE c.source_system = $1 AND c.source_event_id = $2`,
      [input.sourceSystem, input.sourceEventId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : projectionFromRow(row)
  }

  private async findProjection(client: PoolClient, input: ApplicationInput): Promise<Projection | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, status, source_version, last_source_occurred_at
         FROM applications
        WHERE source_system = $1 AND source_application_id = $2
        FOR UPDATE`,
      [input.sourceSystem, input.sourceApplicationId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : projectionFromRow(row)
  }

  private async insertProjection(client: PoolClient, input: VersionedApplicationInput): Promise<Projection> {
    if (!isFullInput(input)) {
      throw new ApplicationSynchronizationError(
        APPLICATION_SYNC_REASON.UPDATE_WITHOUT_CREATE,
        input.sourceApplicationId,
      )
    }
    const result = await client.query<Record<string, unknown>>(
      `INSERT INTO applications (
         source_system, source_application_id, campaign_id, status, source_status,
         applicant_name, phone_normalized, blog_url, blogger_level, blog_daily_visitors,
         blogger_region, source_version, submitted_at,
         last_source_event_id, last_source_occurred_at, last_synchronized_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, status, source_version, last_source_occurred_at`,
      [
        input.sourceSystem,
        input.sourceApplicationId,
        input.campaignId,
        input.applicationStatus,
        input.sourceStatus,
        input.applicantName,
        input.phoneNormalized,
        input.blogUrl ?? null,
        input.bloggerLevel ?? null,
        input.blogDailyVisitors ?? null,
        input.bloggerRegion ?? null,
        input.sourceVersion,
        input.submittedAt,
        input.sourceEventId,
        input.sourceOccurredAt,
        input.synchronizedAt,
      ],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('application insert returned no row')
    return projectionFromRow(row)
  }

  private async updateProjection(
    client: PoolClient,
    current: Projection,
    input: VersionedApplicationInput,
  ): Promise<Projection> {
    const result = await client.query<Record<string, unknown>>(
      `UPDATE applications
          SET status = COALESCE($2, status),
              source_status = COALESCE($3, source_status),
              campaign_id = COALESCE($4, campaign_id),
              applicant_name = COALESCE($5, applicant_name),
              phone_normalized = COALESCE($6, phone_normalized),
              blog_url = CASE WHEN $7::boolean THEN $8 ELSE blog_url END,
              blogger_level = CASE WHEN $9::boolean THEN $10 ELSE blogger_level END,
              blog_daily_visitors = CASE WHEN $11::boolean THEN $12 ELSE blog_daily_visitors END,
              blogger_region = CASE WHEN $13::boolean THEN $14 ELSE blogger_region END,
              submitted_at = COALESCE($15, submitted_at),
              source_version = $16,
              last_source_event_id = $17,
              last_source_occurred_at = $18,
              last_synchronized_at = $19,
              updated_at = $19
        WHERE id = $1
        RETURNING id, status, source_version, last_source_occurred_at`,
      [
        current.id,
        input.applicationStatus ?? null,
        input.sourceStatus ?? null,
        isFullInput(input) ? input.campaignId : null,
        isFullInput(input) ? input.applicantName : null,
        isFullInput(input) ? input.phoneNormalized : null,
        isFullInput(input),
        isFullInput(input) ? (input.blogUrl ?? null) : null,
        isFullInput(input) && hasOwn(input, 'bloggerLevel'),
        isFullInput(input) ? (input.bloggerLevel ?? null) : null,
        isFullInput(input) && hasOwn(input, 'blogDailyVisitors'),
        isFullInput(input) ? (input.blogDailyVisitors ?? null) : null,
        isFullInput(input) && hasOwn(input, 'bloggerRegion'),
        isFullInput(input) ? (input.bloggerRegion ?? null) : null,
        isFullInput(input) ? input.submittedAt : null,
        input.sourceVersion,
        input.sourceEventId,
        input.sourceOccurredAt,
        input.synchronizedAt,
      ],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('application update returned no row')
    return projectionFromRow(row)
  }

  private async appendChange(
    client: PoolClient,
    projection: Projection,
    input: VersionedApplicationInput,
  ): Promise<void> {
    const sourceStatus =
      input.sourceStatus ??
      (
        await client.query<Record<string, unknown>>('SELECT source_status FROM applications WHERE id = $1', [
          projection.id,
        ])
      ).rows[0]?.source_status
    if (typeof sourceStatus !== 'string') {
      throw new Error('application query returned a non-string source_status')
    }

    await client.query(
      `INSERT INTO application_changes (
         application_id, source_system, source_event_id, source_occurred_at, source_version,
         application_status, source_status, synchronization_method, changed_fields, synchronized_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        projection.id,
        input.sourceSystem,
        input.sourceEventId,
        input.sourceOccurredAt,
        input.sourceVersion,
        projection.status,
        sourceStatus,
        input.synchronizationMethod,
        JSON.stringify(distinctFields(input.changedFields)),
        input.synchronizedAt,
      ],
    )
  }

  private outcome(
    projection: Projection,
    outcome: ApplicationSynchronizationOutcome['outcome'],
  ): ApplicationSynchronizationOutcome {
    return {
      outcome,
      applicationId: projection.id,
      status: projection.status,
      sourceVersion: projection.sourceVersion,
    }
  }
}
