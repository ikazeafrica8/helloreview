// The PRD §18.5–§18.15 event payloads.
//
// Each schema validates the WIRE shape exactly as the PRD documents it — snake_case, because that
// is what providers send — and transforms it into the camelCase shape the rest of the platform
// uses. Same boundary decision as packages/config, which turns DATABASE_URL into
// config.databaseUrl: the external format belongs to whoever produces it, the internal one is
// ours, and the schema is the only place both are named.
//
// STRICT, not passthrough. An unmodelled field is rejected rather than dropped. A provider that
// starts sending something new is a contract change worth failing loudly at the edge; silently
// discarding it means the first symptom is a business rule acting on data it never saw.
//
// The transforms are written out longhand rather than generated from a key-mapping helper. It is
// more lines, but each field is greppable in both spellings, and a generated mapping would type as
// `Record<string, unknown>` — which is how a renamed field becomes `undefined` at runtime instead
// of a compile error.

import { z } from 'zod'
import { identifier, isoTimestamp, e164Phone, webUrl, version, reasonCode } from './primitives.js'

/** §18.5 — a new application, the entry point for workflow 1. */
export const applicationCreatedPayload = z
  .strictObject({
    application_id: identifier,
    campaign_id: identifier,
    application_status: identifier,
    application_source: identifier,
    applicant: z.strictObject({
      name: z.string().min(1),
      phone_normalized: e164Phone,
      // Optional: a campaign may not require a blog, and workflow 2 resolves it separately.
      blog_url: webUrl.optional(),
    }),
    submitted_at: isoTimestamp,
  })
  .transform((raw) => ({
    applicationId: raw.application_id,
    campaignId: raw.campaign_id,
    applicationStatus: raw.application_status,
    applicationSource: raw.application_source,
    applicant: {
      name: raw.applicant.name,
      phoneNormalized: raw.applicant.phone_normalized,
      ...(raw.applicant.blog_url === undefined ? {} : { blogUrl: raw.applicant.blog_url }),
    },
    submittedAt: raw.submitted_at,
  }))

/**
 * §18.6 — an application changed upstream.
 *
 * `source_version` is what makes FR-MSG-007 enforceable: a delayed update carrying an older
 * version must not reverse a newer state, and the comparison is impossible without it.
 */
export const applicationUpdatedPayload = z
  .strictObject({
    application_id: identifier,
    changed_fields: z.array(z.string().min(1)).min(1),
    application_status: identifier.optional(),
    source_version: version,
  })
  .transform((raw) => ({
    applicationId: raw.application_id,
    changedFields: raw.changed_fields,
    ...(raw.application_status === undefined ? {} : { applicationStatus: raw.application_status }),
    sourceVersion: raw.source_version,
  }))

/** §18.7 — a selection decision, automatic (workflow 5) or manual (workflow 6). */
export const selectionUpdatedPayload = z
  .strictObject({
    application_id: identifier,
    campaign_id: identifier,
    selection_result: identifier,
    decision_id: identifier,
    decision_reason_code: reasonCode,
    // Which rule version produced the decision. §21.2 requires a decision be reconstructable, and
    // that is impossible without knowing the rules in force at the time.
    rule_version: identifier,
  })
  .transform((raw) => ({
    applicationId: raw.application_id,
    campaignId: raw.campaign_id,
    selectionResult: raw.selection_result,
    decisionId: raw.decision_id,
    decisionReasonCode: raw.decision_reason_code,
    ruleVersion: raw.rule_version,
  }))

/** §18.8 — an inbound KakaoTalk message. */
export const channelMessageReceivedPayload = z
  .strictObject({
    provider: identifier,
    external_message_id: identifier,
    external_conversation_id: identifier,
    external_user_id: identifier,
    message_type: identifier,
    // Optional: a message may carry only an attachment. Requiring it would reject valid traffic.
    text: z.string().optional(),
    sent_at: isoTimestamp,
  })
  .transform((raw) => ({
    provider: raw.provider,
    externalMessageId: raw.external_message_id,
    externalConversationId: raw.external_conversation_id,
    externalUserId: raw.external_user_id,
    messageType: raw.message_type,
    ...(raw.text === undefined ? {} : { text: raw.text }),
    sentAt: raw.sent_at,
  }))

/**
 * §18.9 — an inbound attachment.
 *
 * Both size and mime type are DECLARED by the provider, and the field names keep saying so. §19
 * requires the real values be established after download; treating a declared size as a fact is
 * how a size limit gets bypassed.
 */
export const channelAttachmentReceivedPayload = z
  .strictObject({
    provider: identifier,
    external_message_id: identifier,
    external_conversation_id: identifier,
    attachment_type: identifier,
    provider_attachment_reference: identifier,
    declared_mime_type: identifier,
    declared_size_bytes: z.number().int().nonnegative(),
  })
  .transform((raw) => ({
    provider: raw.provider,
    externalMessageId: raw.external_message_id,
    externalConversationId: raw.external_conversation_id,
    attachmentType: raw.attachment_type,
    providerAttachmentReference: raw.provider_attachment_reference,
    declaredMimeType: raw.declared_mime_type,
    declaredSizeBytes: raw.declared_size_bytes,
  }))

/** §18.10 — an Aligo delivery result, closing the loop on an outbound send. */
export const messageDeliveryUpdatedPayload = z
  .strictObject({
    provider: identifier,
    provider_message_id: identifier,
    internal_notification_id: identifier,
    delivery_status: identifier,
    // Absent while a delivery is still pending or has failed.
    delivered_at: isoTimestamp.optional(),
    provider_status_code: identifier.optional(),
  })
  .transform((raw) => ({
    provider: raw.provider,
    providerMessageId: raw.provider_message_id,
    internalNotificationId: raw.internal_notification_id,
    deliveryStatus: raw.delivery_status,
    ...(raw.delivered_at === undefined ? {} : { deliveredAt: raw.delivered_at }),
    ...(raw.provider_status_code === undefined ? {} : { providerStatusCode: raw.provider_status_code }),
  }))

/**
 * §18.11 — business approval state, which gates Visit C.
 *
 * `expires_at` is load-bearing rather than informational: §16.9 makes readiness depend on approval
 * being CURRENT, so an approval without an expiry cannot be evaluated for freshness.
 */
export const businessApprovalUpdatedPayload = z
  .strictObject({
    workflow_id: identifier,
    campaign_id: identifier,
    approval_state: identifier,
    approval_version: version,
    approved_by: identifier.optional(),
    approved_at: isoTimestamp.optional(),
    expires_at: isoTimestamp.optional(),
  })
  .transform((raw) => ({
    workflowId: raw.workflow_id,
    campaignId: raw.campaign_id,
    approvalState: raw.approval_state,
    approvalVersion: raw.approval_version,
    ...(raw.approved_by === undefined ? {} : { approvedBy: raw.approved_by }),
    ...(raw.approved_at === undefined ? {} : { approvedAt: raw.approved_at }),
    ...(raw.expires_at === undefined ? {} : { expiresAt: raw.expires_at }),
  }))

/** §18.12 — a reservation submission, by screenshot or by structured entry. */
export const reservationSubmittedPayload = z
  .strictObject({
    workflow_id: identifier,
    submission_type: identifier,
    // Present for a screenshot submission, absent for a structured one.
    attachment_id: identifier.optional(),
    participant_message_id: identifier.optional(),
    // Workflow 15 supersedes a prior active version rather than mutating it, so every submission
    // is numbered.
    reservation_version: version,
  })
  .transform((raw) => ({
    workflowId: raw.workflow_id,
    submissionType: raw.submission_type,
    ...(raw.attachment_id === undefined ? {} : { attachmentId: raw.attachment_id }),
    ...(raw.participant_message_id === undefined ? {} : { participantMessageId: raw.participant_message_id }),
    reservationVersion: raw.reservation_version,
  }))

/**
 * §18.13 — a request to deliver a guideline.
 *
 * A REQUEST, never an instruction. The PRD says immediately after this example that "the
 * notification service must independently re-evaluate readiness before sending" — so nothing
 * downstream may treat this payload as evidence that sending is permitted (SPEC.md §8).
 */
export const guidelineDeliveryRequestedPayload = z
  .strictObject({
    workflow_id: identifier,
    guideline_version: identifier,
    triggering_event_id: identifier,
    requested_reason: reasonCode,
  })
  .transform((raw) => ({
    workflowId: raw.workflow_id,
    guidelineVersion: raw.guideline_version,
    triggeringEventId: raw.triggering_event_id,
    requestedReason: raw.requested_reason,
  }))

/** §18.14 — a human handoff, which pauses automation for the workflow. */
export const humanReviewCreatedPayload = z
  .strictObject({
    workflow_id: identifier,
    reason_code: reasonCode,
    priority: identifier,
    automation_paused: z.boolean(),
    source_event_id: identifier.optional(),
  })
  .transform((raw) => ({
    workflowId: raw.workflow_id,
    reasonCode: raw.reason_code,
    priority: raw.priority,
    automationPaused: raw.automation_paused,
    ...(raw.source_event_id === undefined ? {} : { sourceEventId: raw.source_event_id }),
  }))

/** §18.15 — a resolved human review, which may hand the workflow back to automation. */
export const humanReviewCompletedPayload = z
  .strictObject({
    task_id: identifier,
    workflow_id: identifier,
    resolution_code: reasonCode,
    operator_id: identifier,
    return_to_automation: z.boolean(),
    // Free text written by an operator. Never a substitute for resolution_code, which is what
    // rules and reports read.
    resolution_reason: z.string().optional(),
  })
  .transform((raw) => ({
    taskId: raw.task_id,
    workflowId: raw.workflow_id,
    resolutionCode: raw.resolution_code,
    operatorId: raw.operator_id,
    returnToAutomation: raw.return_to_automation,
    ...(raw.resolution_reason === undefined ? {} : { resolutionReason: raw.resolution_reason }),
  }))
