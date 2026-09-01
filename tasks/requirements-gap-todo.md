# Task List: Supplied Requirements Gap Closure

| Field              | Value                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Source             | [Requirements implementation audit](../docs/requirements-implementation-audit-2026-08-27.md)      |
| Status             | Proposed; no production activation or new schema is authorized by this plan                       |
| Numbering          | Continues after Milestone 4 task T132                                                             |
| Pilot ingestion    | Operator-controlled website XLSX/CSV export remains the approved fallback                         |
| Selection boundary | Manual approval and shadow recommendations remain authoritative until T129 is separately approved |

This ledger adds only gaps not already represented by T100–T132. A checked task means its acceptance
criteria and verification evidence are complete; writing the plan does not approve a migration,
provider, production data, automatic selection, readiness change, or production activation.

## Existing unfinished tasks that remain required

| Existing tasks | Required outcome                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| T100–T102      | Approved retention policy, deletion/masking jobs, and privacy-request E2E                                       |
| T124–T126      | Visit B/C shadow extraction, deterministic readiness integration, and AC-07 E2E                                 |
| T127–T129      | Approved blog-score provenance, measured shadow comparison, and separately authorized controlled auto-selection |
| T130–T132      | Versioned metrics, read-only analytics, and Milestone 4 release evidence                                        |

## Task index

- [x] T133 — Correctness and hardening remediation
- [x] T134 — Specification baseline and requirement traceability
- [x] T135 — Durable inbound conversation and evidence history
- [x] T136 — Versioned journey configuration and legacy-notification ownership
- [ ] T137 — Manual-import workflow bootstrap and deterministic candidate lookup
- [ ] T138 — Inbound-event and workflow-side-effect dispatcher
- [ ] T139 — Direct-application and secret-comment journey coordinator
- [ ] T140 — Governed operator selection command
- [ ] T141 — Production-capable shipping journey
- [ ] T142 — Payback inbound-response journey
- [ ] T143 — Visit A instruction, correction, and guideline journey
- [ ] T144 — Visit B/C instruction and pre-approval handling
- [ ] T145 — Secret-comment screenshot extraction boundary
- [ ] T146 — Authoritative guideline-readiness composition
- [ ] T147 — Official Kakao 상담톡 adapter lane
- [ ] T148 — Aligo trigger audit, coexistence control, and outbound runtime
- [ ] T149 — Approved Korean text-AI production lane
- [ ] T150 — Approved file-scanner and OCR production-shadow lane
- [ ] T151 — Production admin authentication and console transport
- [ ] T152 — Full requirement acceptance, UAT, and controlled pilot

---

# Phase 22 — Correctness and specification integrity

## T133 — Correctness and hardening remediation

Status: **Implemented.** No provider, migration, automatic selection, readiness change, or
production activation was included, and none was needed.

Fix the verified defects found during the PR #16 post-merge and requirements audits before building
new runtime composition.

**Acceptance criteria:**

- [x] OCR evaluation uses a collision-safe category map and has regression cases for
      `constructor`, `toString`, and other inherited-property names.
- [x] OCR idempotency is bounded by an explicit size/expiry policy, removes result and fingerprint
      state coherently, and does not retain sensitive evidence indefinitely.
- [x] OCR evaluator outputs are deeply immutable and required `unknown` enum values route to an
      unresolved/human-review quality outcome rather than clean shadow evidence.
- [x] Fixture and future console commands enforce the command-specific authorization action and
      campaign scope before returning any accepted receipt.
- [x] Sensitive-command rejection paths validate pseudonymous identifiers at runtime and use the
      authorization decision's validated policy version in audit evidence.
- [x] `blog_daily_visitors` remains named and displayed as average-daily visitors until a separately
      sourced previous-day metric exists.
- [x] Shipping submission loads the current immutable campaign policy server-side; callers cannot
      weaken required fields or validation.
- [x] Reservation configuration treats a missing branch consistently for single-location
      businesses in both complete and evaluation parsers.
- [x] Correction templates receive safe submitted and expected values, and tests assert a specific
      Korean explanation rather than only a reason code.

**What each fix changed:**

| Defect                        | Authoritative boundary                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Prototype-colliding counts    | `ocr-extraction/evaluation-report.ts` counts in a `Map` and returns a frozen null-prototype record                    |
| Unbounded OCR retention       | `ocr-extraction.service.ts` holds one bounded entry per request identity (`DEFAULT_OCR_IDEMPOTENCY_POLICY`)           |
| Mutable decisions             | `evidence-quality-evaluator.ts` returns every decision deeply frozen                                                  |
| `unknown` as clean evidence   | A required `reservationStatus`/`visibleBookingMethod` of `unknown` is `OCR_EVIDENCE_REQUIRED_FIELD_UNRESOLVED`        |
| Unenforced console commands   | `evaluateGovernedAction` rechecks the command action and campaign scope against the server-derived session            |
| Unvalidated rejection audit   | `sensitive-access-admin.service.ts` revalidates actor/target references and keeps the decision's policy version       |
| Mislabelled visitor metric    | `averageDailyVisitors` / `블로그 일평균 방문자 수` across the admin contract, console, UI, and docs                   |
| Caller-supplied shipping rule | `submit` has no `policy` field; `parseShippingRulePolicy` reads the published `campaign_rules` row inside the same tx |
| Disagreeing branch parsers    | `rules-engine/reservation-rules.ts` shares one `businessEntrySchema` between both parsers                             |
| Reason-code-only corrections  | `reservation/correction-values.ts` builds safe Korean `submitted_value` / `expected_condition` for every correction   |

**Two defects of the same class were found outside the audit list and fixed or recorded here:**

- `ai-orchestration/evaluation-report.ts` had the identical `Object.prototype` collision, and
  `evaluation-gate.ts` consumes those counts for `AI_CRITICAL_CATEGORY_TOO_SMALL`. A category named
  `constructor` corrupted the AI release gate. Fixed with the same `Map` + frozen null-prototype
  record.
- `guideline-delivery` sent the same `RESERVATION_CORRECTION:*` templates with empty variables. It
  holds the failed rule but not the evidence it was judged from, so it now renders the one
  strictly-shaped value it can read and defers the expected condition to an operator. The
  caller-authoritative composition itself is T146's to remove.

**Verification (all run on this tree):** `pnpm verify` (typecheck, lint, 874 unit, 106 transition),
84 security, 182 integration, 14 e2e, 7 operator browser tests, `pnpm db:check`, `pnpm format:check`,
`pnpm eval:ai` and `pnpm eval:ocr` (both `engineeringPassed`, production release still blocked), and
the full coverage suite at 125 files / 1,260 tests with 84.88% statements and 86.65% lines.

**Not changed, deliberately:** no migration, no provider, no readiness predicate, no automatic
selection, no RBAC/retention/messaging policy, and no production configuration.

## T134 — Specification baseline and requirement traceability

Status: **Complete (2026-08-27).** The product owner approved the §3 capability map and chose to
revise SPEC.md §9's per-module-spec criterion rather than write module specs after the fact.

Reconcile the engineering contract with the code that has already landed.

**Acceptance criteria:**

- [x] `SPEC.md` no longer says “Draft — awaiting capability-map approval” unless that is still the
      product owner's explicit decision. Approved by the product owner on 2026-08-27; the status line,
      §10's blocking open question, and §9 criterion 21 now say so.
- [x] The documented Next.js version and other stack facts match the lockfile/runtime.
- [x] Status lines for T105–T108 are explicit and consistent with `tasks/plan.md` and their verified code.
- [x] Every implemented module has a focused module spec and requirement/test traceability, or
      SPEC.md §9's per-module-spec success criterion is deliberately revised and approved. The product
      owner chose revision: criterion 22 now requires a module spec only where a module carries its
      own approval boundary, with the reasoning recorded in §9 itself. `SPEC-ocr-extraction.md` is
      the one module that qualifies today. Per-module requirement/test traceability continues to live
      in the task ledgers, where each task names its acceptance criteria and verification.
- [x] OCR traceability stops claiming the reservation-only schema implements secret-comment
      campaign/blog/comment extraction.
- [x] `SPEC.md` §3.3 stops stating that `guideline-delivery` does not depend on `reservation`. The
      enforced `module-graph.json` has listed that dependency since T87, so the contract and the
      lint-enforced graph disagreed. The bullet now states what is actually true and load-bearing:
      the readiness PREDICATE still reads only a snapshot and imports no flow module, while the
      module gained the `reservation` edge in T87 to compose participant corrections.
- [x] The supplied Korean process has a stable requirement identifier/crosswalk so later audits do
      not rely on a chat transcript. [docs/supplied-process-crosswalk.md](../docs/supplied-process-crosswalk.md)
      assigns `HRP-01`…`HRP-25` and `HRQ-01`…`HRQ-12`, and maps each to its PRD requirement family,
      current status, and closing task.

**Verification:** link check, task-index consistency, Markdown formatting, and a manual traceability
review with no implementation claim unsupported by code/tests. All run: `pnpm format:check`,
`git diff --check`, local-link validation across every edited document, and the four task-index
consistency tests. The one status upgrade in the crosswalk (`HRP-06`, `HRP-15`) is backed by T133's
regression tests rather than by assertion.

---

# Phase 23 — Durable communication and orchestration spine

## T135 — Durable inbound conversation and evidence history

Status: **Implemented (2026-08-27).** Schema and retention design approved by the product owner,
including storing `inbound_messages.body_text` under the `conversation_content` retention class with
no read path returning it. No provider is connected and no journey consumes these records yet.

Add the missing operational records for conversations, inbound messages, attachment linkage, and
secret-comment evidence without storing unnecessary raw provider payloads.

**Acceptance criteria:**

- [x] Provider conversation and message IDs are unique and idempotent, with a verified channel
      identity and workflow/application scope where known.
- [x] Inbound/outbound metadata, purpose, ownership, delivery, and supersession history are durable.
- [x] Secret-comment evidence has immutable versions and remains supporting evidence, never identity
      proof or selection authority.
- [x] Attachment ownership, quarantine state, content reference, and evidence version are linked
      without exposing object paths.
- [x] Retention classes, masking, legal hold, and timeline projection are defined before production.
- [x] Duplicate, delayed, reassigned, deleted-by-provider, and ambiguous-conversation cases preserve
      a reconstructable coded history.

**What landed:** migration `0033_add_conversation_and_evidence_history`, four tables
(`conversations`, `conversation_events`, `inbound_messages`, `secret_comment_evidence_versions`),
two additive nullable columns (`attachments.inbound_message_id`,
`outbound_notifications.conversation_id`), a `conversations` module with three narrow services, and
two new operator-timeline categories (`messages`, `secret_comment_evidence`). See
[docs/conversation-history.md](../docs/conversation-history.md).

**Boundaries held:** no raw provider payload is copied — the minimized envelope stays in
`event_inbox`. `secret_comment_evidence_versions` has no column that could bind an application,
decide a selection, or approve anything, and `supporting_only` carries a CHECK pinning it true.
`body_text` is stored and never disclosed: no module read path selects it, the timeline projects
codes only, and reading it back would need a governed sensitive-access operation that deliberately
does not exist.

**Verification:** `pnpm verify` (typecheck, lint, 874 unit, 106 transition), 88 security (4 new),
188 integration (6 new), 14 e2e, 7 operator browser, `pnpm db:check`, `pnpm format:check`, and the
full coverage suite at 127 files / 1,270 tests with 84.73% statements and 86.5% lines. The
container-backed privilege test caught a real regression during implementation — a trigger function
created after migration 0009's REVOKE loop retained `PUBLIC EXECUTE` — which the migration now
revokes for itself, as migrations 0027 and 0028 do.

**Dependencies:** T59–T61, T88–T92, approved migration and retention design.

## T136 — Versioned journey configuration and legacy-notification ownership

Status: **Implemented (2026-08-28).** Schema and the two policy decisions approved by the product
owner: the visitor metric period is `website_average_daily`, and sender ownership is per campaign.
No provider is connected, no automation is enabled, and selection stays manual.

Store the configuration that the journeys currently assume but cannot resolve authoritatively.

**Acceptance criteria:**

- [x] Campaign/application URL is versioned and activation fails when a secret-comment journey
      requires it but it is missing.
- [x] Visit A activation requires a current business phone; Visit B/C activation requires the
      approved booking URL/instruction version.
- [x] Every participant-facing purpose identifies whether the website legacy trigger, HelloReview
      platform, or operator is the authoritative sender during cutover.
- [x] Aligo template/provider codes, legal classification, quiet-hours/opt-out behavior, and
      trigger-audit status are queryable without secrets.
- [x] Campaign-region mapping, visitor metric name/period, eligible levels, thresholds, review band,
      and non-selection policy remain versioned and cannot be invented by AI.
- [x] `RankingEvidenceAdapter.read` stops taking `measurementPeriod` from its caller. It reads the
      website's `blog_daily_visitors` column, which is average daily visitors, but labels the
      evidence with whatever period the caller passes — so a caller can declare
      `previous_calendar_day` on both the evidence and the policy and the evaluator's
      period-agreement check passes on a relabelled metric. Found during T133; left unfixed there
      because the correct period is a versioned policy decision this task owns, and choosing one
      inside a shadow evaluator would be inventing selection policy. Selection remains manual, so
      nothing acts on it today.
- [x] Missing or unapproved ownership/configuration prevents activation rather than guessing.

**What landed:** migration `0034_add_journey_configuration_and_sender_ownership` with two versioned
tables (`campaign_journey_configurations`, `message_purpose_ownership`) and two enums, both frozen
once published by the same trigger pattern as `campaign_businesses`; a `parseSelectionRuleConfiguration`
over the existing `campaign_rules` selection type; the `RankingEvidenceAdapter` metric-period fix; and
six new activation checks. See [docs/journey-configuration.md](../docs/journey-configuration.md).

**Most of this needed no schema change.** `campaign_businesses.phone`/`.booking_url` and the whole
`message_templates` legal-classification, quiet-hours, opt-out, sender-identification, and Alimtalk
provider-code surface already existed. T136 makes activation REQUIRE them rather than adding a second
home for them.

**Gap found during implementation:** there was no `APPLICATION_REQUEST` message purpose. PRD §14.5
made the application URL a mandatory transition guard, §32.1 defined the Korean template, and
FR-SC-002 required a secret-comment claimant to receive it — but the purpose registry had all twenty
codes and none was that message, so the one message that starts the secret-comment route could not
pass through the outbox. Added here, and activation now requires an active template for it.

**Boundaries held:** `CHECK (authoritative_sender <> 'helloreview_platform' OR trigger_audit_status
<> 'not_audited')` means this platform cannot claim a purpose whose legacy trigger nobody has
audited — T148's inventory has to happen first. `automaticSelectionEnabled` is pinned false by the
schema. No threshold, region, or period is defaulted anywhere; an unparseable policy refuses
activation rather than falling back. The stored preferences are versioned policy, not enabled
automation.

**Behaviour change to be aware of:** a selection policy claiming `previous_calendar_day` now
mismatches the evidence and routes to `human_review` with `VISITOR_MEASUREMENT_PERIOD_MISMATCH`,
because the adapter reports the period of the column it actually reads. That is the intended
fail-closed result of no longer letting a caller relabel the metric.

**Verification:** `pnpm verify` (typecheck, lint, 894 unit, 106 transition), 88 security,
192 integration (4 new), 14 e2e, 7 operator browser, `pnpm db:check`, `pnpm format:check`,
`pnpm eval:ai` and `pnpm eval:ocr`, and the full coverage suite at 129 files / 1,294 tests with
84.78% statements and 86.54% lines. `validateCampaignActivation` keeps its 100% branch threshold.

**Dependencies:** T21–T25, T107, Aligo audit and selection-policy decisions.

## T137 — Manual-import workflow bootstrap and deterministic candidate lookup

Implementation progress (2026-09-01): the local/fake foundation now records a replay-safe
`application.import.completed` processing intent using the website export time, supports atomic
one-workflow-per-application bootstrap (including reuse of a verified participant across campaigns),
and provides deterministic candidate lookup with a participant-safe redacted result. The bootstrap
operation and state model now live in `@helloreview/workflow-runtime`, so API and worker use one
transactional implementation rather than an app-to-app dependency or duplicate SQL. Approved
migration 0035 now records unapproved website lifecycle codes as replay-safe quarantined batches
without retaining the raw value or CSV contents; it has been applied to the healthy local Docker
database and its migration/import/bootstrap integration cases pass. The task remains open for the
authenticated upload transport and the non-import reconciliation actions listed below.
An authoritative imported application now initializes its workflow at `application_completed` and
creates one replay-safe `BEGIN_IDENTITY_MATCHING` side effect; generic/non-import workflow creation
still starts at `not_applied`. T138 now binds the completed internal import intent at worker startup,
while the independent workflow-side-effect scheduler remains disabled until its complete supported
effect set and retry path are safe.

Status: **Proposed; preserves the approved manual CSV pilot.**

Connect a successful application import/reconciliation to idempotent participant/workflow bootstrap
and provide the deterministic candidate search needed by Kakao identity resolution.

**Acceptance criteria:**

- [ ] A completed import batch emits a durable, replay-safe processing intent without treating CSV
      upload time as website freshness.
- [ ] Website lifecycle-status codes have an owner-approved mapping; unknown codes quarantine the
      batch rather than being guessed or silently discarded.
- [ ] Direct applicants receive at most one participant/application/campaign workflow, while one
      participant may retain several campaign workflows.
- [ ] Candidate lookup uses verification token, normalized phone, campaign, blog URL, and approved
      evidence; name alone never binds.
- [ ] Ambiguous/multiple/no-match outcomes reveal no candidate details and create the correct
      reconciliation or human-review action.
- [ ] Website application state remains authoritative and an inbound participant claim cannot mark
      an application complete.
- [ ] CLI import remains supported; a future authenticated upload transport invokes the same parser
      and records an audit receipt rather than duplicating import logic.

**Dependencies:** T27–T33, manual import, T135.

## T138 — Inbound-event and workflow-side-effect dispatcher

Implementation progress (2026-09-01): a strict `PROCESS_INBOUND_EVENT` dispatcher core now locks
the inbox row transactionally, suppresses completed/dead-letter replays, records bounded retry and
dead-letter evidence using safe reason codes, validates the job/event identity, and refuses AI/OCR
event registration. The minimized `application.import.completed` handler validates application ids
and invokes the shared `@helloreview/workflow-runtime` operation through a worker-owned adapter.
Replay tests prove that initialization evidence and its protected audit are written once. T138
remains open: `PROCESS_INBOUND_EVENT` also carries external events whose participant journeys are not
implemented yet. The worker now binds the approved import handler while leaving unsupported external
events authoritatively `received`; the relay queries only enabled event types, so those events are
available when their complete journey is approved instead of being guessed, failed, or dead-lettered.
The independent
`workflow_side_effects` dispatcher now has a transaction-bound core that claims pending rows with
`FOR UPDATE SKIP LOCKED`, uses the canonical shared effect-code registry, suppresses stale or
human-owned effects, cancels closed-campaign effects, leaves paused work pending, and rolls handler
failures back for retry. It remains unbound until every effect has a concrete deterministic handler
and a safe scheduling path; full startup coverage is enforced by an explicit registry assertion. The
workflow state mutation boundary is now shared and transaction-bound: it locks the workflow, checks
the expected version, classifies planner rejection before pauses, records protected rejection evidence,
and commits approved state, event, audit, and side-effect rows atomically. The API delegates to this
boundary without changing its public errors. The complete legal/illegal transition table, guard and
trigger registry, reason codes, and pure planner now live in the shared runtime; the API re-exports
that canonical policy instead of owning a second copy. The first deterministic side-effect handler
advances only an authoritative import-created application through verified application matching and
into `review_pending`. A second transaction-bound handler records the imported ranking facts as one
deduplicated `human_review` recommendation, without changing selection state or evaluating the
unapproved freshness/region thresholds. A real PostgreSQL/Redis worker test proves one queued import
intent creates exactly one `application_completed` workflow and one pending
`BEGIN_IDENTITY_MATCHING` effect without a selection decision. Non-import matching work remains
pending, and the workflow-side-effect scheduler remains disabled while the rest of the effect
registry has no concrete handlers. No provider, AI/OCR, outbound sender, or automatic selection path
is activated.

Status: **Proposed; production provider binding remains disabled until T147–T150.**

Implement the missing durable runtime that consumes inbox events and pending workflow side effects,
then invokes narrow domain services under idempotency, version, pause, and ownership controls.

**Acceptance criteria:**

- [x] `PROCESS_INBOUND_EVENT` has a real dispatcher for every approved internal event type and marks
      inbox outcomes without swallowing failures.
- [ ] Pending `workflow_side_effects` are claimed atomically, retried with the same logical key, and
      completed/suppressed/cancelled exactly once.
- [ ] Human ownership, participant/campaign/global pauses, stale versions, opt-out, and provider
      outages stop the applicable side effect.
- [ ] The dispatcher never lets AI/OCR output execute a protected command directly.
- [ ] Restart, replay, duplicate delivery, out-of-order events, partial failure, and dead-letter
      handling preserve one business effect.
- [ ] Worker startup fails closed when an enabled queue lacks its required handler/dependency.

**Dependencies:** T18, T27, T35–T47, T135–T137.

## T139 — Direct-application and secret-comment journey coordinator

Implementation progress (2026-09-01): the direct-application entry point now distinguishes an
authoritative imported website application from a generic/contact-created workflow. It initializes
the former as completed and schedules deterministic identity matching once, without creating or
assuming a Kakao channel identity. The direct-import identity handler now uses the shared governed
transition boundary to reach `application_matched` and `review_pending`, scheduling
`LOAD_SELECTION_RULE` without asserting a Kakao identity. Its intermediate `PERSIST_CHANNEL_LINK`
work becomes stale after the immediate direct-route progression and is suppressed by the dispatcher.
`LOAD_SELECTION_RULE` now persists a replay-safe manual-review recommendation using the website
ranking facts while explicitly declining to invent a freshness window or campaign-region mapping.
Candidate matching for conversational entrants, the operator decision command, secret-comment
claimant route, approved message ownership, and final campaign route composition remain open;
automatic selection remains disabled.

Status: **Proposed; automatic selection remains disabled.**

Compose the two supplied intake routes through the same authoritative application, identity,
selection, campaign-route, and human-review services.

**Acceptance criteria:**

- [ ] Direct applicants progress from imported application to deterministic matching and selection
      recommendation/manual review without requiring a secret-comment claim.
- [ ] A secret-comment claimant without a completed website application receives the configured
      application link exactly once and cannot enter selection review.
- [ ] After authoritative completion, applicable secret-comment workflows request a screenshot once
      and retain its safe evidence/history.
- [ ] Match/reconciliation, selection pending/result, and non-selection messages use approved
      purposes/templates and configured policies.
- [ ] A selected workflow routes exactly once to Shipping, Payback, Visit A, Visit B, or Visit C.
- [ ] The next outbound channel is resolved from approved purpose ownership and verified contact
      evidence; a direct website applicant is not assumed to have a Kakao identity.
- [ ] Unknown data, conflict, complaint, human request, and unsupported policy create a complete
      human-review packet and pause ordinary automation.

**Dependencies:** T64–T72, T135–T138, T145 for automated comment-image evidence.

## T140 — Governed operator selection command

Implementation progress (2026-09-01): the transport-neutral admin command boundary now loads the
target workflow's campaign before authorization and uses the existing protected `overrides.approve`
permission, so submitted commands cannot provide their own role, operator identity, authorization
flag, campaign scope, or correlation ID. New decisions recheck the expected workflow version and the
latest recommendation ID/version while holding the workflow lock. The existing immutable manual
decision, shadow-comparison, protected audit, replay, and revocation behavior is now reachable only
through those derived values in the admin boundary. Real-PostgreSQL tests cover stale workflow and
recommendation rejection, successful selection, idempotent replay, and revocation. An authenticated
console/HTTP transport remains intentionally absent until T151 supplies production identity and RBAC.

Status: **Proposed; production use depends on T151 authentication/RBAC.**

Expose the existing manual decision, override, and revocation service through the same governed
admin command boundary as human tasks and business approval.

**Acceptance criteria:**

- [ ] Campaign scope is loaded from the target workflow before authorization.
- [ ] Expected workflow/recommendation versions, operator role, reason, and current evidence are
      rechecked server-side.
- [ ] Select, not-select, override, and revoke create immutable decision/audit evidence and preserve
      the shadow comparison.
- [ ] Revocation pauses downstream reservation/guideline work and opens review exactly once.
- [ ] The console cannot submit a selection decision using fixture permission or request-authored
      roles/policy.

**Dependencies:** T67–T72, T103–T110, T133.

---

# Phase 24 — Participant journeys

## T141 — Production-capable shipping journey

Status: **Proposed; shipping-state migration, public endpoint/security design, and deployment approval required.**

Complete the one-time shipping form as a participant-facing flow.

**Acceptance criteria:**

- [ ] One-time GET/POST routes and a Korean participant UI validate the grant, fragment token,
      workflow ownership, expiry, replay, CSRF/origin, rate limit, and safe error behavior.
- [ ] A shipping workflow begins in an explicit pre-request state and enters `address_requested`
      only in the transaction that durably creates the request intent.
- [ ] Required fields and validation rules come from the current immutable campaign policy.
- [ ] Missing/invalid fields receive specific corrections without exposing stored address data.
- [ ] Valid submission records a version, consumes the grant, sends one completion/next-step notice,
      and triggers authoritative guideline re-evaluation.
- [ ] Changes before cutoff and post-lock review preserve history and authorization evidence.
- [ ] Browser E2E covers expiry, replay, cross-participant access, duplicate submit, correction, and
      mobile accessibility.

**Dependencies:** T73–T77, T133, T136, T138.

## T142 — Payback inbound-response journey

Status: **Proposed; Korean terms/templates and messaging policy require approval.**

Route real inbound responses to the current consent request and continue only from deterministic
consent state.

**Acceptance criteria:**

- [ ] Only an explicit response correlated with the active request/current terms can agree or
      decline.
- [ ] One ambiguous response creates one clarification; a repeated ambiguity hands off.
- [ ] Decline/withdrawal stops progression and follows the campaign's approved policy.
- [ ] Agreement triggers authoritative readiness evaluation without allowing AI classification to
      write consent directly.
- [ ] Duplicate, old-terms, unrelated “yes,” provider retry, cancellation, and human ownership are
      covered end to end.

**Dependencies:** T78–T82, T135, T138–T139, T146.

## T143 — Visit A instruction, correction, and guideline journey

Status: **Proposed.**

Complete Visit A from selection through business-phone instructions, reported reservation,
deterministic validation, specific correction, and conditional guideline delivery.

**Acceptance criteria:**

- [ ] The effective business version and phone are loaded server-side and recorded with the
      instruction/template version.
- [ ] The participant is clearly asked to send the confirmed date and time; duplicate instructions
      are suppressed.
- [ ] Inbound date/time text is correlated to the correct workflow and current instruction.
- [ ] Correction templates receive the failed rule, safe submitted value, configured expected
      condition, correction action, and retry/review behavior.
- [ ] A valid current reservation automatically re-evaluates and queues the guideline exactly once.
- [ ] Wrong campaign/method/business, ambiguous time, cancellation, rescheduling, stale evidence,
      handoff, replay, and restart are tested through the dispatcher.

**Dependencies:** T83–T87, T133, T136, T138–T139, T146.

## T144 — Visit B/C instruction and pre-approval handling

Status: **Proposed; does not replace T124–T126.**

Add participant-facing B/C instruction composition around the existing approval gate and the planned
OCR/evidence journey.

**Acceptance criteria:**

- [ ] Visit B sends the effective Naver booking URL/instructions once and requests a screenshot.
- [ ] Visit C sends only an approval-pending explanation before approval; authorized approval
      automatically schedules the approved booking instructions exactly once.
- [ ] Booking URL, business, branch, approval version, and template version are resolved
      server-side and included in coded evidence.
- [ ] A participant screenshot/booking received before Visit C approval creates a review task and
      never receives retroactive automatic validation.
- [ ] Rejection, expiry, revocation, duplicate approval, replacement screenshot, and human ownership
      suppress inappropriate instructions.

**Dependencies:** T50–T52, T124–T126, T136, T138–T139, T146.

## T145 — Secret-comment screenshot extraction boundary

Status: **Proposed; this widens the AI/OCR schema and requires explicit approval before implementation.**

Define a separate, minimal, allowlisted contract for secret-comment evidence rather than forcing it
through `reservation-image-v1`.

**Acceptance criteria:**

- [ ] The schema contains only approved visible comment/campaign/blog evidence, confidence,
      missing/conflicting fields, image quality, and review recommendation.
- [ ] It contains no identity binding, blog-score retrieval, selection, approval, reservation, or
      guideline authority.
- [ ] Cropped, suspicious, conflicting, prompt-like, and low-quality screenshots fail to retry or
      human review without accusing the participant.
- [ ] Evidence is ownership-bound, versioned, and supporting-only; it cannot bind an application.
- [ ] Synthetic injection/evaluation cases and provider-neutral fake conformance are complete before
      any real image or provider is used.

**Dependencies:** T57–T66, T119–T123, T135; explicit schema/responsibility approval.

## T146 — Authoritative guideline-readiness composition

Status: **Proposed; readiness-predicate and persistence changes require explicit approval.**

Replace caller-authoritative readiness flags with a repository-built snapshot of current durable
facts and trigger evaluation after every relevant state change.

**Acceptance criteria:**

- [ ] Current selection, campaign/guideline version, consent/terms, shipping head/policy,
      reservation head/validation, safe attachment, OCR evidence, Visit C approval, pauses, human
      ownership, and prior delivery are loaded under one consistent transaction/version boundary.
- [ ] Callers can identify the workflow/event but cannot assert that prerequisites passed.
- [ ] Stale, superseded, missing, conflicting, or unavailable evidence fails closed with one specific
      correction/review action.
- [ ] Shipping, Payback, A, B, and C each trigger readiness after their prerequisite changes and
      still dedupe the same guideline version.
- [ ] Premature-delivery audit independently reconstructs the same authoritative snapshot.

**Dependencies:** T53–T56, T124–T126, T133, T141–T145; explicit readiness approval.

---

# Phase 25 — Official integrations and production operation

## T147 — Official Kakao 상담톡 adapter lane

Status: **External blocked pending dealer/product proof and credentials.**

Verify and implement only an official supported integration for inbound text, attachments, stable
identifiers, replies, callbacks, and human takeover.

**Acceptance criteria:**

- [ ] Dealer evidence confirms event shapes, stable user/conversation/message IDs, attachment access,
      webhook authentication, replay behavior, rate limits, retries, delivery callbacks, and agent
      takeover/release semantics.
- [ ] A provider-specific adapter translates raw payloads into strict internal contracts and passes
      the shared conformance suite used by the fake.
- [ ] Signatures, timestamps, replay, attachment ownership, opt-out, human ownership, outage, and
      reconciliation fail closed without raw payload/PII logs.
- [ ] A sandbox journey reaches T138 without provider vocabulary leaking into core modules.

**Dependencies:** vendor contract/access, T135, T138, security/privacy approval.

## T148 — Aligo trigger audit, coexistence control, and outbound runtime

Status: **External blocked pending account/source/template access and an approved cutover decision.**

Inventory every existing website/Aligo send, decide authoritative ownership by purpose, implement
cross-system coordination, then bind the real outbound/reconciliation workers.

**Acceptance criteria:**

- [ ] Existing trigger, event, template/version, provider code, retry, callback, SMS fallback, and
      credit behavior is documented with an owner for every purpose.
- [ ] Each purpose has one authoritative sender, or an observable coexistence ledger that suppresses
      the other sender before a duplicate can occur.
- [ ] Real Aligo/Kakao outbound adapters pass fake conformance and reuse canonical idempotency keys.
- [ ] Send, unknown-status reconciliation, confirmed failure retry, notification history, and
      suppression processors are registered in the worker.
- [ ] Application-completion, selection, AI reply, correction, and guideline messages are tested
      against legacy-trigger overlap and credit accounting.
- [ ] Rollback returns the purpose to the documented legacy/manual sender without losing history.

**Dependencies:** T41–T47, T136, T138, official provider/account access, messaging/legal approval.

## T149 — Approved Korean text-AI production lane

Status: **External blocked pending provider, region, privacy, retention, cost, and corpus approval.**

Connect a real provider behind the existing safe port only after the production release criteria are
approved and measured.

**Acceptance criteria:**

- [ ] Vendor data use, retention, region/overseas processing, subprocessors, credentials, cost, and
      outage policy are approved.
- [ ] The adapter passes conformance, timeout, fallback, redaction, injection, budget, and no-
      protected-state tests.
- [ ] At least the approved representative Korean corpus and critical-category minimums are scored
      with versioned provenance and accepted thresholds.
- [ ] Deterministic fallback/human review remains available and production can disable AI without
      corrupting workflow state.

**Dependencies:** T62–T66, approved provider/privacy policy and representative corpus.

## T150 — Approved file-scanner and OCR production-shadow lane

Status: **External blocked pending provider, storage, privacy, retention, image, and threshold approvals.**

Make safe production screenshots evaluable in shadow/manual mode before any OCR-dependent
progression is considered.

**Acceptance criteria:**

- [ ] A real malware/file scanner, private storage, lifecycle, signed read, and deletion/hold policy
      pass security review.
- [ ] The approved OCR adapter passes conformance and does not receive raw database/storage secrets
      or protected-state context.
- [ ] Authorized representative reservation and secret-comment screenshot corpora calibrate each
      required field/provider/layout; wrong branch and status mappings are explicitly defined.
- [ ] Results persist only through the approved T124/T125/T145 evidence models and remain
      human-reviewed until release criteria pass.
- [ ] Timeout, outage, disagreement, corrupted/unsafe file, prompt injection, replacement image,
      stale evidence, and rollback are proven.

**Dependencies:** T57–T61, T124–T126, T145, provider/privacy/retention approvals.

## T151 — Production admin authentication and console transport

Status: **External blocked pending authentication choice and approved RBAC/sensitive-access policies.**

Replace fixture/locked adapters with authenticated, campaign-scoped HTTP and console transports for
the already-built query and command services.

**Acceptance criteria:**

- [ ] SSO or local-MFA adapter creates a server-owned verified principal; request JSON cannot author
      roles, policy, scope, assurance, or authorization versions.
- [ ] Production RBAC, campaign scopes, CSRF/origin/session expiry, reauthentication, and sensitive
      reveal/export policies fail closed and are audited.
- [ ] Participant search/timeline, work queues, selection, campaign/rule/template/guideline editors,
      business approval, pauses, failed jobs, retry, integrations, and audit pages use real services.
- [ ] Every command reauthorizes its exact action and target scope server-side with optimistic
      versions; fixture receipts cannot reach production.
- [ ] Accessibility, mobile/desktop, partial outage, read-only fallback, and browser security E2E pass.

**Dependencies:** T103–T117, T133–T140, approved authentication/RBAC/sensitive policies.

## T152 — Full requirement acceptance, UAT, and controlled pilot

Status: **Proposed; this is evidence and rollout, not an activation shortcut.**

Prove the supplied process as a complete system at the approved manual-CSV pilot boundary, then
activate only allowlisted campaigns and capabilities.

**Acceptance criteria:**

- [ ] Direct and secret-comment routes run through HTTP/webhook, queue, dispatcher, database,
      operator approval, campaign journey, outbound sandbox, callback, restart, and replay.
- [ ] Shipping, Payback, Visit A, Visit B, and Visit C pass their happy paths and failure matrices,
      including wrong weekday/time/method/business and pre-approval Visit C.
- [ ] Legacy/new duplicate-message, provider timeout/unknown delivery, human takeover, complaint,
      pause, cancellation/rescheduling, replacement evidence, and premature-guideline tests pass.
- [ ] The complete timeline reconstructs application, identity, inbound/outbound messages,
      selection, evidence, consent/address/reservation/approval, handoff, guideline, and audit history.
- [ ] All PRD §34 acceptance criteria and §36 Definition of Done have current evidence; open external
      decisions remain visible and no blocked capability is labeled ready.
- [ ] Korean templates, operator training, support ownership, monitoring/alerts, backup restore,
      incident response, rollback, and UAT are signed off.
- [ ] Automatic selection remains disabled unless T129 has its own explicit activation approval and
      measured release evidence.

**Dependencies:** T100–T151 as applicable to the approved pilot scope, all named external approvals,
and product-owner UAT sign-off.
