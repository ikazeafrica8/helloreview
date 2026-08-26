import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import type { Pool } from 'pg'
import { authorizeAdminInvocation, type AdminInvocation } from './admin-invocation.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ParticipantSearchRequest = Readonly<{
  campaignId: string
  query: string
  limit?: number
  cursor?: string
}>

export type MaskedParticipantSearchResult = Readonly<{
  participantId: string
  workflowId: string
  applicationId: string
  campaignId: string
  maskedName: string
  maskedPhone: string
  applicationStatus: string
  bloggerLevel: number | null
  previousDayVisitors: number | null
  bloggerRegion: string | null
  createdAt: Date
}>

export type ParticipantTimelineEvent = Readonly<{
  eventId: string
  category: string
  eventCode: string
  occurredAt: Date
  workflowId: string | null
  campaignId: string
  version: number | null
  reasonCode: string | null
  stateCode: string | null
}>

export type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>

export class AdminParticipantQueryError extends Error {
  override readonly name = 'AdminParticipantQueryError'
  constructor(readonly reasonCode: string) {
    super(`admin participant query rejected: ${reasonCode}`)
  }
}

type Cursor = Readonly<{ occurredAt: string; eventId: string }>

const encodeCursor = (value: Cursor): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const decodeCursor = (value: string | undefined): Cursor | null => {
  if (value === undefined) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('occurredAt' in parsed) ||
      !('eventId' in parsed) ||
      typeof parsed.occurredAt !== 'string' ||
      typeof parsed.eventId !== 'string' ||
      !UUID.test(parsed.eventId) ||
      Number.isNaN(Date.parse(parsed.occurredAt))
    )
      throw new Error('invalid')
    return { occurredAt: parsed.occurredAt, eventId: parsed.eventId.toLowerCase() }
  } catch {
    throw new AdminParticipantQueryError('ADMIN_CURSOR_INVALID')
  }
}

export const maskParticipantName = (name: string | null): string => {
  if (name === null || name.length === 0) return '***'
  const chars = Array.from(name)
  const first = chars[0] ?? '*'
  return chars.length === 1 ? '*' : `${first}${'*'.repeat(Math.min(3, chars.length - 1))}`
}

export const maskParticipantPhone = (phone: string | null): string => {
  if (phone === null) return '***-****-****'
  const digits = phone.replace(/\D/g, '')
  return digits.length < 4 ? '***-****-****' : `***-****-${digits.slice(-4)}`
}

const positiveLimit = (value: number | undefined): number => {
  const limit = value ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new AdminParticipantQueryError('ADMIN_PAGE_LIMIT_INVALID')
  return limit
}

const asDate = (value: unknown, field: string): Date => {
  if (value instanceof Date) return value
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value)
  throw new Error(`participant query returned invalid ${field}`)
}

const asString = (value: unknown, field: string): string => {
  if (typeof value === 'string') return value
  throw new Error(`participant query returned invalid ${field}`)
}

@Injectable()
export class ParticipantAdminQueryService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async search(
    invocation: AdminInvocation,
    request: ParticipantSearchRequest,
  ): Promise<Page<MaskedParticipantSearchResult>> {
    if (!UUID.test(request.campaignId)) throw new AdminParticipantQueryError('ADMIN_CAMPAIGN_ID_INVALID')
    const query = request.query.trim()
    if (query.length < 2 || query.length > 200) throw new AdminParticipantQueryError('ADMIN_SEARCH_QUERY_INVALID')
    authorizeAdminInvocation(invocation, 'participants.search', request.campaignId.toLowerCase())
    const limit = positiveLimit(request.limit)
    const cursor = decodeCursor(request.cursor)
    const digits = query.replace(/\D/g, '')
    const exactParticipantId = UUID.test(query) ? query.toLowerCase() : null
    const phone =
      digits.length >= 10 ? `+82${digits.startsWith('0') ? digits.slice(1) : digits.replace(/^82/, '')}` : null
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT p.id AS participant_id, w.id AS workflow_id, a.id AS application_id,
              w.campaign_id, coalesce(p.name, a.applicant_name) AS name,
              coalesce(p.phone_normalized, a.phone_normalized) AS phone_normalized,
              a.status::text AS application_status,
              a.blogger_level, a.blog_daily_visitors, a.blogger_region, w.created_at
         FROM workflow_instances w
         JOIN participants p ON p.id = w.participant_id
         JOIN applications a ON a.id = w.application_id
        WHERE w.campaign_id = $1
          AND ($2::uuid IS NOT NULL AND p.id = $2::uuid
               OR $3::text IS NOT NULL AND p.phone_normalized = $3
               OR coalesce(p.name, a.applicant_name) ILIKE '%' || $4 || '%'
               OR a.source_application_id = $4)
          AND ($5::timestamptz IS NULL OR (w.created_at, w.id) < ($5::timestamptz, $6::uuid))
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT $7`,
      [
        request.campaignId,
        exactParticipantId,
        phone,
        query,
        cursor?.occurredAt ?? null,
        cursor?.eventId ?? null,
        limit + 1,
      ],
    )
    const rows = result.rows.slice(0, limit)
    const items = rows.map((row): MaskedParticipantSearchResult => ({
      participantId: asString(row.participant_id, 'participant_id'),
      workflowId: asString(row.workflow_id, 'workflow_id'),
      applicationId: asString(row.application_id, 'application_id'),
      campaignId: asString(row.campaign_id, 'campaign_id'),
      maskedName: maskParticipantName(typeof row.name === 'string' ? row.name : null),
      maskedPhone: maskParticipantPhone(typeof row.phone_normalized === 'string' ? row.phone_normalized : null),
      applicationStatus: asString(row.application_status, 'application_status'),
      bloggerLevel: row.blogger_level === null ? null : Number(row.blogger_level),
      previousDayVisitors: row.blog_daily_visitors === null ? null : Number(row.blog_daily_visitors),
      bloggerRegion: typeof row.blogger_region === 'string' ? row.blogger_region : null,
      createdAt: asDate(row.created_at, 'created_at'),
    }))
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        result.rows.length > limit && last !== undefined
          ? encodeCursor({ occurredAt: last.createdAt.toISOString(), eventId: last.workflowId })
          : null,
    }
  }

  async timeline(
    invocation: AdminInvocation,
    request: Readonly<{ participantId: string; campaignId: string; limit?: number; cursor?: string }>,
  ): Promise<Page<ParticipantTimelineEvent>> {
    if (!UUID.test(request.participantId) || !UUID.test(request.campaignId))
      throw new AdminParticipantQueryError('ADMIN_PARTICIPANT_SCOPE_INVALID')
    authorizeAdminInvocation(invocation, 'participants.timeline.read', request.campaignId.toLowerCase())
    const scope = await this.pool.query(
      `SELECT 1 FROM workflow_instances WHERE participant_id = $1 AND campaign_id = $2 LIMIT 1`,
      [request.participantId, request.campaignId],
    )
    if (scope.rows.length === 0) throw new AdminParticipantQueryError('ADMIN_PARTICIPANT_NOT_FOUND_IN_CAMPAIGN')
    const limit = positiveLimit(request.limit)
    const cursor = decodeCursor(request.cursor)
    const result = await this.pool.query<Record<string, unknown>>(
      `WITH participant_workflows AS (
         SELECT id, application_id, campaign_id FROM workflow_instances
          WHERE participant_id = $1 AND campaign_id = $2
       ), timeline AS (
         SELECT e.id AS event_id, 'workflow'::text AS category, e.event_kind::text AS event_code,
                e.occurred_at, e.workflow_id, w.campaign_id, e.workflow_version AS version,
                e.decision_reason AS reason_code, e.requested_target_state AS state_code
           FROM workflow_events e JOIN participant_workflows w ON w.id = e.workflow_id
         UNION ALL
         SELECT c.id, 'application', 'APPLICATION_SYNCHRONIZED', c.source_occurred_at, w.id, w.campaign_id,
                c.source_version, NULL, c.application_status::text
           FROM application_changes c JOIN participant_workflows w ON w.application_id = c.application_id
         UNION ALL
         SELECT r.id, 'selection_recommendation', 'SELECTION_RECOMMENDED', r.created_at, r.workflow_id,
                r.campaign_id, r.version, r.reason_code, r.result::text
           FROM selection_recommendations r JOIN participant_workflows w ON w.id = r.workflow_id
         UNION ALL
         SELECT d.id, 'selection_decision', 'SELECTION_MANUALLY_DECIDED', d.occurred_at, d.workflow_id,
                w.campaign_id, d.version, d.reason_code, d.decision::text
           FROM selection_manual_decisions d JOIN participant_workflows w ON w.id = d.workflow_id
         UNION ALL
         SELECT v.id, 'payback_consent', 'PAYBACK_CONSENT_CHANGED', v.occurred_at, v.workflow_id,
                w.campaign_id, v.version, v.reason_code, v.state::text
           FROM payback_consent_versions v JOIN participant_workflows w ON w.id = v.workflow_id
         UNION ALL
         SELECT a.id, 'shipping', 'SHIPPING_ADDRESS_VERSIONED', a.created_at, a.workflow_id,
                a.campaign_id, a.version, NULL, a.validation_state::text
           FROM shipping_addresses a JOIN participant_workflows w ON w.id = a.workflow_id
         UNION ALL
         SELECT v.id, 'reservation', 'RESERVATION_VERSIONED', v.occurred_at, v.workflow_id,
                w.campaign_id, v.version, v.cancellation_reason, v.status::text
           FROM reservation_versions v JOIN participant_workflows w ON w.id = v.workflow_id
         UNION ALL
         SELECT b.id, 'business_approval', 'BUSINESS_APPROVAL_CHANGED', b.recorded_at, b.workflow_id,
                b.campaign_id, b.version, b.reason_code, b.state::text
           FROM business_approvals b JOIN participant_workflows w ON w.id = b.workflow_id
         UNION ALL
         SELECT g.id, 'guideline', 'GUIDELINE_DELIVERY_' || upper(g.status::text), g.updated_at, g.workflow_id,
                g.campaign_id, g.guideline_version, NULL, g.status::text
           FROM guideline_deliveries g JOIN participant_workflows w ON w.id = g.workflow_id
         UNION ALL
         SELECT a.id, 'guideline_attempt', 'GUIDELINE_' || upper(a.outcome::text), a.occurred_at, a.workflow_id,
                w.campaign_id, a.guideline_version, a.reason_code, a.outcome::text
           FROM guideline_delivery_attempts a JOIN participant_workflows w ON w.id = a.workflow_id
         UNION ALL
         SELECT e.id, 'notification', upper(e.event_type::text), e.occurred_at, n.workflow_id,
                w.campaign_id, n.template_version, e.reason_code, e.status::text
           FROM outbound_notification_events e JOIN outbound_notifications n ON n.id = e.notification_id
           JOIN participant_workflows w ON w.id = n.workflow_id
         UNION ALL
         SELECT e.id, 'human_review', upper(e.event_type::text), e.occurred_at, t.workflow_id,
                t.campaign_id, t.episode_number, e.reason_code, e.to_status::text
           FROM human_review_task_events e JOIN human_review_tasks t ON t.id = e.task_id
           JOIN participant_workflows w ON w.id = t.workflow_id
         UNION ALL
         SELECT i.id, 'identity_resolution', 'IDENTITY_' || upper(i.status::text), i.decided_at, NULL,
                i.campaign_id, NULL, i.reason_code, i.match_category::text
           FROM identity_resolution_cases i
          WHERE i.participant_id = $1 AND i.campaign_id = $2
       )
       SELECT event_id, category, event_code, occurred_at, workflow_id, campaign_id, version, reason_code, state_code
         FROM timeline
        WHERE ($3::timestamptz IS NULL OR (occurred_at, event_id) < ($3::timestamptz, $4::uuid))
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT $5`,
      [request.participantId, request.campaignId, cursor?.occurredAt ?? null, cursor?.eventId ?? null, limit + 1],
    )
    const items = result.rows.slice(0, limit).map((row): ParticipantTimelineEvent => ({
      eventId: asString(row.event_id, 'event_id'),
      category: asString(row.category, 'category'),
      eventCode: asString(row.event_code, 'event_code'),
      occurredAt: asDate(row.occurred_at, 'occurred_at'),
      workflowId: typeof row.workflow_id === 'string' ? row.workflow_id : null,
      campaignId: asString(row.campaign_id, 'campaign_id'),
      version: row.version === null ? null : Number(row.version),
      reasonCode: typeof row.reason_code === 'string' ? row.reason_code : null,
      stateCode: typeof row.state_code === 'string' ? row.state_code : null,
    }))
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        result.rows.length > limit && last !== undefined
          ? encodeCursor({ occurredAt: last.occurredAt.toISOString(), eventId: last.eventId })
          : null,
    }
  }
}
