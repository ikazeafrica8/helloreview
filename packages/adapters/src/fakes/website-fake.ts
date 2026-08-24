import { EVENT_TYPES, platformEventSchema, type PlatformEvent } from '@helloreview/contracts'
import {
  WebsiteSourceError,
  type WebsiteApplicationQuery,
  type WebsiteApplicationSnapshot,
  type WebsiteApplicationSource,
  type WebsiteSourceFailure,
} from '../ports/website.js'

export type FakeWebsiteApplicationSource = WebsiteApplicationSource &
  Readonly<{
    put: (snapshot: WebsiteApplicationSnapshot) => void
    remove: (sourceApplicationId: string) => void
    failNextRead: (reasonCode: WebsiteSourceFailure) => void
    emitCreated: (snapshot: WebsiteApplicationSnapshot) => PlatformEvent
    emitUpdated: (snapshot: WebsiteApplicationSnapshot, changedFields?: readonly string[]) => PlatformEvent
  }>

const clone = (snapshot: WebsiteApplicationSnapshot): WebsiteApplicationSnapshot => ({
  ...snapshot,
  submittedAt: new Date(snapshot.submittedAt),
  sourceOccurredAt: new Date(snapshot.sourceOccurredAt),
})

const envelope = (
  snapshot: WebsiteApplicationSnapshot,
  eventType: 'application.created' | 'application.updated',
  payload: Readonly<Record<string, unknown>>,
): PlatformEvent =>
  platformEventSchema.parse({
    event_id: snapshot.sourceEventId,
    event_type: eventType,
    event_version: 1,
    source: snapshot.sourceSystem,
    occurred_at: snapshot.sourceOccurredAt.toISOString(),
    idempotency_key: `${snapshot.sourceSystem}:${snapshot.sourceEventId}`,
    payload,
  })

/** Stateful, deterministic substitute for the website API while its provider contract is open. */
export const createFakeWebsiteApplicationSource = (
  sourceSystem = 'helloreview_website',
  initial: readonly WebsiteApplicationSnapshot[] = [],
): FakeWebsiteApplicationSource => {
  const records = new Map(initial.map((snapshot) => [snapshot.sourceApplicationId, clone(snapshot)]))
  const failures: WebsiteSourceFailure[] = []

  return {
    sourceSystem,
    put: (snapshot) => {
      if (snapshot.sourceSystem !== sourceSystem) {
        throw new Error('FAKE_WEBSITE_SOURCE_MISMATCH')
      }
      records.set(snapshot.sourceApplicationId, clone(snapshot))
    },
    remove: (sourceApplicationId) => {
      records.delete(sourceApplicationId)
    },
    failNextRead: (reasonCode) => {
      failures.push(reasonCode)
    },
    listRecentApplications: (query: WebsiteApplicationQuery) => {
      const reasonCode = failures.shift()
      if (reasonCode !== undefined) {
        return Promise.reject(new WebsiteSourceError(reasonCode))
      }

      return Promise.resolve(
        [...records.values()]
          .filter(
            (snapshot) =>
              snapshot.campaignId === query.campaignId &&
              snapshot.submittedAt.getTime() >= query.submittedSince.getTime(),
          )
          .sort((left, right) => left.submittedAt.getTime() - right.submittedAt.getTime())
          .map(clone),
      )
    },
    emitCreated: (snapshot) =>
      envelope(snapshot, EVENT_TYPES.APPLICATION_CREATED, {
        application_id: snapshot.sourceApplicationId,
        campaign_id: snapshot.campaignId,
        application_status: snapshot.status,
        application_source: snapshot.sourceSystem,
        applicant: {
          name: snapshot.applicantName,
          phone_normalized: snapshot.phoneNormalized,
          ...(snapshot.blogUrl === undefined ? {} : { blog_url: snapshot.blogUrl }),
        },
        submitted_at: snapshot.submittedAt.toISOString(),
      }),
    emitUpdated: (snapshot, changedFields = ['application_status']) =>
      envelope(snapshot, EVENT_TYPES.APPLICATION_UPDATED, {
        application_id: snapshot.sourceApplicationId,
        changed_fields: changedFields,
        application_status: snapshot.status,
        source_version: snapshot.sourceVersion,
      }),
  }
}
