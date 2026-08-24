/** Provider-neutral outbound channels. Wire-specific names stay inside adapters. */
export const OUTBOUND_CHANNELS = {
  KAKAO: 'KAKAO',
} as const

export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[keyof typeof OUTBOUND_CHANNELS]

export type DedupeKeyInput = Readonly<{
  channel: OutboundChannel
  workflowId: string
  participantId?: string
  applicationId?: string
  campaignId?: string
  /** Full purpose identity; parameterized purposes are composed by composePurpose(). */
  purpose: string
  contentVersion: string
  businessEventVersion?: string
  authorizedRedeliveryId?: string
}>

const SEPARATOR = '|'

const segment = (label: string, value: string): string => {
  if (value.length === 0 || value !== value.trim() || value.includes(SEPARATOR)) {
    throw new Error(`invalid ${label} dedupe-key segment`)
  }
  return value
}

/**
 * Build the one canonical PRD §17.4 logical-message identity.
 *
 * Optional scope fields are omitted, never represented by empty separators. This preserves the
 * PRD example exactly while still including every identity available to a workflow. Authorized
 * redelivery is a new identity only when its approval-bound id is supplied.
 */
export const buildDedupeKey = (input: DedupeKeyInput): string => {
  const parts = [
    segment('channel', input.channel),
    segment('workflowId', input.workflowId),
    ...(input.participantId === undefined ? [] : [segment('participantId', input.participantId)]),
    ...(input.applicationId === undefined ? [] : [segment('applicationId', input.applicationId)]),
    ...(input.campaignId === undefined ? [] : [segment('campaignId', input.campaignId)]),
    segment('purpose', input.purpose),
    segment('contentVersion', input.contentVersion),
    ...(input.businessEventVersion === undefined ? [] : [segment('businessEventVersion', input.businessEventVersion)]),
    ...(input.authorizedRedeliveryId === undefined
      ? []
      : [segment('authorizedRedeliveryId', input.authorizedRedeliveryId)]),
  ]

  return parts.join(SEPARATOR)
}
