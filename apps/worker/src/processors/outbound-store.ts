import type { DbClient, DbTransaction } from '@helloreview/db'
import type { OutboundChannel } from '@helloreview/contracts'

export type ClaimedOutboundNotification = Readonly<{
  id: string
  channel: OutboundChannel
  recipientReference: string
  purpose: string
  renderedContent: string
  templateVersion: number
  providerTemplateCode?: string
  idempotencyKey: string
  providerMessageId?: string
  retryCount: number
}>

export type OutboundNotificationStore = Readonly<{
  claimForSend: (workerId: string, now: Date, limit: number) => Promise<readonly ClaimedOutboundNotification[]>
  claimForReconciliation: (
    workerId: string,
    now: Date,
    limit: number,
  ) => Promise<readonly ClaimedOutboundNotification[]>
  markSending: (notification: ClaimedOutboundNotification, workerId: string, now: Date) => Promise<void>
  markAccepted: (
    notification: ClaimedOutboundNotification,
    workerId: string,
    provider: string,
    providerMessageId: string,
    reconcileAt: Date,
    now: Date,
  ) => Promise<void>
  markUnknown: (
    notification: ClaimedOutboundNotification,
    workerId: string,
    provider: string,
    providerMessageId: string | undefined,
    reconcileAt: Date,
    now: Date,
  ) => Promise<void>
  markDelivered: (
    notification: ClaimedOutboundNotification,
    workerId: string,
    provider: string,
    providerMessageId: string,
    now: Date,
  ) => Promise<void>
  scheduleRetry: (
    notification: ClaimedOutboundNotification,
    workerId: string,
    failureCode: string,
    retryAt: Date,
    now: Date,
  ) => Promise<void>
  markFailed: (
    notification: ClaimedOutboundNotification,
    workerId: string,
    failureCode: string,
    now: Date,
  ) => Promise<void>
}>

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`outbox query returned invalid ${column}`)
}

const claimedFrom = (row: Record<string, unknown>): ClaimedOutboundNotification => {
  const templateVersion = Number(row.template_version)
  const retryCount = Number(row.retry_count)
  if (!Number.isInteger(templateVersion) || !Number.isInteger(retryCount)) {
    throw new Error('outbox query returned invalid numeric delivery fields')
  }
  const channel = stringColumn(row, 'channel')
  if (channel !== 'KAKAO') throw new Error(`outbox query returned unsupported channel ${channel}`)
  const providerTemplateCode = row.provider_template_code
  const providerMessageId = row.provider_message_id
  return {
    id: stringColumn(row, 'id'),
    channel,
    recipientReference: stringColumn(row, 'recipient_reference'),
    purpose: stringColumn(row, 'purpose_code'),
    renderedContent: stringColumn(row, 'rendered_content'),
    templateVersion,
    ...(typeof providerTemplateCode === 'string' ? { providerTemplateCode } : {}),
    idempotencyKey: stringColumn(row, 'deduplication_key'),
    ...(typeof providerMessageId === 'string' ? { providerMessageId } : {}),
    retryCount,
  }
}

const event = async (
  tx: DbTransaction,
  notification: ClaimedOutboundNotification,
  eventType: string,
  status: string,
  reasonCode: string,
  actorId: string,
  occurredAt: Date,
  retryCount = notification.retryCount,
  providerMessageId?: string,
): Promise<void> => {
  await tx.query(
    `INSERT INTO outbound_notification_events (
       notification_id, event_type, status, reason_code, provider_message_id,
       retry_count, actor_id, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [notification.id, eventType, status, reasonCode, providerMessageId ?? null, retryCount, actorId, occurredAt],
  )
}

const claim = async (
  db: DbClient,
  workerId: string,
  now: Date,
  limit: number,
  statuses: readonly string[],
): Promise<readonly ClaimedOutboundNotification[]> =>
  db.transaction(async (tx) => {
    const claimed = await tx.query(
      `WITH candidates AS (
         SELECT id
           FROM outbound_notifications
          WHERE status = ANY($1::outbound_notification_status[])
            AND next_attempt_at <= $2
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE outbound_notifications AS notification
          SET status = 'claimed', claimed_at = $2, claimed_by = $4, updated_at = $2
         FROM candidates
        WHERE notification.id = candidates.id
       RETURNING notification.id, notification.channel, notification.recipient_reference,
                 notification.purpose_code, notification.rendered_content,
                 notification.template_version, notification.provider_template_code,
                 notification.deduplication_key, notification.provider_message_id,
                 notification.retry_count`,
      [statuses, now, limit, workerId],
    )
    const notifications = claimed.rows.map(claimedFrom)
    for (const notification of notifications) {
      await event(tx, notification, 'claimed', 'claimed', 'OUTBOUND_INTENT_CLAIMED', workerId, now)
    }
    return notifications
  })

/** PostgreSQL implementation of the worker delivery ledger. */
export const createOutboundNotificationStore = (db: DbClient): OutboundNotificationStore => ({
  claimForSend: async (workerId, now, limit) => claim(db, workerId, now, limit, ['pending']),
  claimForReconciliation: async (workerId, now, limit) => claim(db, workerId, now, limit, ['accepted', 'unknown']),

  markSending: async (notification, workerId, now) => {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE outbound_notifications
            SET status = 'sending', last_attempt_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'claimed' AND claimed_by = $2`,
        [notification.id, workerId, now],
      )
      await event(tx, notification, 'send_started', 'sending', 'OUTBOUND_SEND_STARTED', workerId, now)
    })
  },

  markAccepted: async (notification, workerId, provider, providerMessageId, reconcileAt, now) => {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE outbound_notifications
            SET status = 'accepted', provider_name = $3, provider_message_id = $4,
                next_attempt_at = $5, claimed_at = NULL, claimed_by = NULL, updated_at = $6
          WHERE id = $1 AND claimed_by = $2`,
        [notification.id, workerId, provider, providerMessageId, reconcileAt, now],
      )
      await event(
        tx,
        notification,
        'send_accepted',
        'accepted',
        'OUTBOUND_SEND_ACCEPTED',
        workerId,
        now,
        notification.retryCount,
        providerMessageId,
      )
    })
  },

  markUnknown: async (notification, workerId, provider, providerMessageId, reconcileAt, now) => {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE outbound_notifications
            SET status = 'unknown', provider_name = $3,
                provider_message_id = COALESCE($4, provider_message_id), next_attempt_at = $5,
                claimed_at = NULL, claimed_by = NULL, updated_at = $6
          WHERE id = $1 AND claimed_by = $2`,
        [notification.id, workerId, provider, providerMessageId ?? null, reconcileAt, now],
      )
      await event(
        tx,
        notification,
        'delivery_unknown',
        'unknown',
        'OUTBOUND_DELIVERY_UNKNOWN',
        workerId,
        now,
        notification.retryCount,
        providerMessageId,
      )
    })
  },

  markDelivered: async (notification, workerId, provider, providerMessageId, now) => {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE outbound_notifications
            SET status = 'delivered', provider_name = $3, provider_message_id = $4,
                delivered_at = $5, claimed_at = NULL, claimed_by = NULL, updated_at = $5
          WHERE id = $1 AND claimed_by = $2`,
        [notification.id, workerId, provider, providerMessageId, now],
      )
      await event(
        tx,
        notification,
        'delivered',
        'delivered',
        'OUTBOUND_DELIVERED',
        workerId,
        now,
        notification.retryCount,
        providerMessageId,
      )
    })
  },

  scheduleRetry: async (notification, workerId, failureCode, retryAt, now) => {
    const retryCount = notification.retryCount + 1
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE outbound_notifications
            SET status = 'pending', retry_count = $3, last_failure_code = $4,
                next_attempt_at = $5, claimed_at = NULL, claimed_by = NULL, updated_at = $6
          WHERE id = $1 AND claimed_by = $2`,
        [notification.id, workerId, retryCount, failureCode, retryAt, now],
      )
      await event(tx, notification, 'retry_scheduled', 'pending', failureCode, workerId, now, retryCount)
    })
  },

  markFailed: async (notification, workerId, failureCode, now) => {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE outbound_notifications
            SET status = 'failed', last_failure_code = $3,
                claimed_at = NULL, claimed_by = NULL, updated_at = $4
          WHERE id = $1 AND claimed_by = $2`,
        [notification.id, workerId, failureCode, now],
      )
      await event(tx, notification, 'failed', 'failed', failureCode, workerId, now)
    })
  },
})
