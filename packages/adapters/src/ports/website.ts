/**
 * Read-back boundary for the authoritative campaign website (PRD 13.1, FR-APP-001, T26/T27).
 *
 * Webhooks travel through the generic inbound-event port. This separate port is deliberately
 * read-only: reconciliation may discover website records, but it must never create or mutate one.
 */

export const WEBSITE_APPLICATION_STATUSES = ['received', 'completed', 'matched', 'ambiguous', 'cancelled'] as const

export type WebsiteApplicationStatus = (typeof WEBSITE_APPLICATION_STATUSES)[number]

export type WebsiteApplicationSnapshot = Readonly<{
  sourceSystem: string
  sourceApplicationId: string
  campaignId: string
  status: WebsiteApplicationStatus
  applicantName: string
  phoneNormalized: string
  blogUrl?: string
  /** Source-owned blogger ranking. This is distinct from the application lifecycle status. */
  bloggerLevel?: number
  /** Raw count from the source field labelled `블로그일평균방문자수`. */
  blogDailyVisitors?: number
  /** Coarse source region only; detailed address fields are deliberately excluded. */
  bloggerRegion?: string | null
  submittedAt: Date
  sourceVersion: number
  /** Stable source evidence for this version, whether read through an API or event log. */
  sourceEventId: string
  sourceOccurredAt: Date
}>

/**
 * A source snapshot that has trustworthy occurrence evidence but no upstream revision counter.
 *
 * Manual exports and browser-derived records commonly have this shape. The synchronization layer
 * allocates a local monotonic version while holding the same per-application lock used for native
 * website versions, so this weaker source cannot roll the projection backward.
 */
export type UnversionedWebsiteApplicationSnapshot = Omit<WebsiteApplicationSnapshot, 'sourceVersion'>

export type WebsiteApplicationQuery = Readonly<{
  campaignId: string
  submittedSince: Date
}>

export type WebsiteApplicationSource = Readonly<{
  sourceSystem: string
  listRecentApplications: (query: WebsiteApplicationQuery) => Promise<readonly WebsiteApplicationSnapshot[]>
}>

export const WEBSITE_SOURCE_FAILURES = {
  UNAVAILABLE: 'WEBSITE_SOURCE_UNAVAILABLE',
  RESPONSE_INVALID: 'WEBSITE_SOURCE_RESPONSE_INVALID',
} as const

export type WebsiteSourceFailure = (typeof WEBSITE_SOURCE_FAILURES)[keyof typeof WEBSITE_SOURCE_FAILURES]

export class WebsiteSourceError extends Error {
  readonly reasonCode: WebsiteSourceFailure

  constructor(reasonCode: WebsiteSourceFailure) {
    super(reasonCode)
    this.name = 'WebsiteSourceError'
    this.reasonCode = reasonCode
  }
}
