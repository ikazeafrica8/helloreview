# Task List: Milestone 2 — Participant Flows

Plan: [tasks/plan.md](plan.md) · Spec: [SPEC.md](../SPEC.md) · Requirements: PRD v1.0

Status: **T57–T87 complete. Checkpoint F remains gated by external AI/privacy approval and human review.**

31 tasks across six phases. Milestone 2 turns the proven core spine into the first participant
journeys while preserving three non-negotiable boundaries:

- AI and OCR may extract or recommend, but never authorize selection, consent, reservation validity,
  business approval, or guideline delivery.
- Selection remains recommendation-only. Automatic selection stays disabled until an approved score
  source, metric period, campaign-region matching policy, shadow-mode results, and legal review exist.
- The outsourced website remains a manual CSV source for the pilot. No website API, webhook, or
  database credentials are assumed.

## Decisions required before affected tasks

| Decision                                                        | Blocks                         | Safe work that may proceed                                              |
| --------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Hosting region and overseas AI-processing policy                | T63–T66, T84                   | Attachment schemas/ports, deterministic flow schemas, shipping, payback |
| Approved AI provider and Korean evaluation dataset              | T63–T66                        | Provider fake, schema-only boundaries, deterministic rules              |
| Selection metric period and campaign-region matching rule       | Any automated selection        | Evidence storage, recommendation-only evaluator, operator comparison    |
| Approved blog-score source and automatic-selection legal review | Production auto-selection      | Manual CSV evidence and shadow recommendations only                     |
| Existing Aligo trigger inventory                                | Production outbound enablement | Fake-provider E2E and outbox verification                               |
| Retention periods per attachment class                          | Production deletion jobs       | Quarantine, legal hold, and no-delete-by-default records                |

---

# Phase 8 — Secure attachments

## T57 — Attachment evidence schema

Status: **Complete (2026-08-25).**

Store immutable attachment metadata: owning workflow, participant, source message, opaque provider
reference, declared and detected type, size, content hash, security state, storage reference, and
timestamps. Raw file bytes never enter workflow events, Redis jobs, logs, or audit detail.

**Acceptance:** ownership is mandatory; content hashes are indexed; security and lifecycle history
are append-only; ordinary queries expose no signed URL or storage credential.

**Verification:** migration/integration tests, audit-protection test, `pnpm db:check`.

**Dependencies:** T34, T13

## T58 — Attachment storage port and fake

Status: **Complete (2026-08-25).**

Define encrypted put/get/delete and short-lived signed-read operations behind a provider-neutral
port. Add an in-repo fake and a shared conformance suite; no production object-store vendor is bound.

**Acceptance:** opaque references only; repeat put by content hash is idempotent; signed reads expire;
the fake passes the same contract a future MinIO/S3 adapter must pass.

**Verification:** unit conformance suite and integration test against local MinIO.

**Dependencies:** T57

## T59 — Secure ingest pipeline

Status: **Complete (2026-08-25).**

Stream uploads through size limits, extension-independent signature detection, type allowlist,
content hashing, malware-scanner port, and quarantine before any downstream consumer can read them.

**Acceptance:** double extensions, type/signature mismatch, oversize files, scanner failures, and
malware all fail closed with specific reason codes; only `clean` evidence becomes readable.

**Verification:** security corpus covering PRD §21.5 and failure-injection integration tests.

**Dependencies:** T58

## T60 — Ownership-bound upload and download grants

Status: **Complete (2026-08-25).**

Issue one-time upload grants and short-lived read grants scoped to one workflow and expected
participant. Consumption is atomic, single-use, audited, and protected against cross-participant
access.

**Acceptance:** replay, expiry, wrong workflow, wrong participant, and reference substitution are
rejected without revealing whether another participant's object exists.

**Verification:** authorization/security tests and concurrent-consumption integration test.

**Dependencies:** T59, T30

## T61 — Attachment quarantine and lifecycle gate

Status: **Complete (2026-08-25).**

Connect clean attachments to workflow evidence, retain quarantined objects for operator review, and
record legal-hold/deletion eligibility without inventing retention periods that have not been
approved.

**Acceptance:** unsafe evidence cannot progress a workflow; deletion is disabled when policy is
missing or legal hold is active; one E2E trace proves secure ingest to workflow evidence.

**Verification:** E2E, security, retention-state transition tests, and the
[secure-attachment runbook](../docs/secure-attachments.md).

**Dependencies:** T60, T38

---

# Phase 9 — AI orchestration boundary

## T62 — AI request, extraction, and recommendation contracts

Status: **Complete (2026-08-25).**

Define versioned Korean intent, entity, date/time, confidence, refusal, and provenance schemas.
Protected business-state fields are absent from AI write contracts by construction.

**Acceptance:** unknown fields fail validation; raw model output is evidence only; every result names
model, prompt, schema, and input version.

**Verification:** contract tests and compile-time protected-state boundary test.

**Dependencies:** T14

## T63 — AI provider port, fake, timeout, and fallback

Status: **Complete (2026-08-25).**

Add a provider-neutral text extraction port, deterministic fake, bounded timeout, retry policy, and
configured model cascade. No real provider is enabled before the hosting/overseas-processing decision.

**Acceptance:** timeout/failure never advances workflow state; fallback preserves the original
request id; provider conformance records no raw PII in logs.

**Verification:** conformance, failure-injection, PII, and idempotency tests.

**Dependencies:** T62; blocked by provider/privacy decisions for a real adapter

## T64 — Korean intent pipeline

Status: **Complete (2026-08-25).**

Implement deterministic preprocessing first, then schema-constrained AI classification for the PRD
§19.2 taxonomy. Low confidence, ambiguity, unsupported intent, and opt-out route explicitly.

**Acceptance:** no free-form intent codes; ambiguous input cannot trigger a protected transition;
operator takeover and opt-out remain higher-priority than automation.

**Verification:** scored Korean evaluation set plus hard adversarial assertions.

**Dependencies:** T63, T46

## T65 — Korean date/time extraction and normalization

Status: **Complete (2026-08-25).**

Normalize explicit and relative Korean date/time expressions against an injected Seoul clock and
campaign timezone. Extraction produces structured candidates; the reservation rules remain the only
authority that can declare a booking valid.

**Acceptance:** ambiguity, missing timezone, impossible dates, and conflicting expressions require
clarification or review; daylight/period boundaries have named fixtures.

**Verification:** deterministic unit table and scored extraction dataset.

**Dependencies:** T63, T49

## T66 — Injection defenses, budgets, and evaluation gate

Status: **Complete (2026-08-25). Production release remains gated on the provider, overseas-processing decision, and representative corpus.**

Add prompt-injection fixtures, untrusted-content delimiting, output-schema enforcement, model/prompt
version tracking, token/cost budgets, and an evaluation report gate.

**Acceptance:** participant text cannot alter system policy or emit a protected-state command; budget
exhaustion falls back safely; release thresholds and stop criteria are explicit.

**Verification:** security tests, scored evaluation report, and budget/fallback integration tests.

**Dependencies:** T64, T65

---

# Phase 10 — Selection recommendations only

## T67 — Immutable selection decision evidence

Status: **Complete (2026-08-25).**

Store recommendation versions with application, campaign, input facts, threshold/rule version,
result, reason, component outcomes, freshness, actor, and time. Manual decisions remain separately
identifiable and auditable.

**Acceptance:** history cannot be rewritten; no recommendation becomes a workflow selection without
an authorized human command; participant output excludes internal ranking details.

**Verification:** migration, append-only, authorization, and non-disclosure tests.

**Dependencies:** T29, T34

## T68 — Manual-pilot ranking evidence adapter

Status: **Complete (2026-08-25).**

Read `blogger_level`, `blog_daily_visitors`, and coarse `blogger_region` from the verified website CSV
import. `blogger_level` is source-owned ranking evidence and remains separate from application
lifecycle `status`.

**Acceptance:** a new export schema must be revalidated; source fields are never reinterpreted as a
selection decision; regional eligibility stays `unknown/review` until a campaign-region mapping is
configured; visitor evidence carries a defined measurement period or is treated as incomplete.

**Verification:** CSV/import integration fixtures, freshness tests, and policy-missing review cases.

**Dependencies:** T27, T67

## T69 — Pure recommendation evaluator and manual-review band

Status: **Complete (2026-08-25).**

Evaluate versioned selection facts into recommend-select, recommend-not-select, or human-review.
Missing/stale evidence, absent threshold, borderline values, or unresolved region mapping always
return review.

**Acceptance:** the evaluator is pure with 100% branch coverage; AI cannot create thresholds; no
default rejection message is invented when campaign policy is missing.

**Verification:** exhaustive decision table and mutation tests.

**Dependencies:** T68, T48

## T70 — Shadow-mode and automatic-selection hard gate

Status: **Complete (2026-08-25).**

Persist recommendations beside operator outcomes for comparison while keeping automatic selection
disabled globally and per campaign.

**Acceptance:** no recommendation can invoke the selected transition; enabling automation requires a
future reviewed config change, approved score source, legal approval, and measured exit criteria.

**Verification:** security bypass test and E2E proof that recommendation-only mode creates zero
automatic selection transitions.

**Dependencies:** T69

## T71 — Manual overrides and selection revocation

Status: **Complete (2026-08-25).**

Authorized operators may accept/override recommendations with actor, reason, prior/new result, and
immutable audit evidence. Revocation pauses downstream reservation and guideline work.

**Acceptance:** unauthorized overrides fail; every override is reconstructable; revocation creates
the required review task and stops ordinary automation.

**Verification:** integration, transition, and audit tests.

**Dependencies:** T70, T38

## T72 — Selection shadow-mode E2E

Status: **Complete (2026-08-25).**

Import a manual website CSV row, generate one recommendation, record one operator decision, and prove
the comparison record contains no participant-facing score disclosure and no automatic selection.

**Verification:** E2E release gate with duplicate-input idempotency.

**Dependencies:** T71

---

# Phase 11 — Shipping flow

## T73 — Versioned and protected shipping addresses

Status: **Complete (2026-08-25).**

Store encrypted, versioned addresses owned by one workflow, with masked ordinary reads and immutable
change history.

**Acceptance:** full values require explicit authorization and audited reveal; cross-participant
reads are indistinguishable from missing records.

**Verification:** database, masking, and authorization tests.

**Dependencies:** T57, T34

## T74 — One-time secure address form

Status: **Complete (2026-08-25).**

Issue a single-use, expiring workflow-bound form token after selection. Kakao messages carry only the
form link, never the address.

**Acceptance:** unselected, expired, replayed, or wrong-workflow submissions fail closed; duplicate
address requests are suppressed.

**Verification:** security and E2E token tests.

**Dependencies:** T60, T70, T73

## T75 — Campaign-configurable address validation

Status: **Complete (2026-08-25).**

Validate required fields, Korean phone, postal code, and campaign-specific constraints with specific
approved corrections.

**Acceptance:** validation is deterministic and 100% branch-covered; missing configuration returns a
configuration error, never a pass.

**Verification:** unit table and integration persistence tests.

**Dependencies:** T74, T48

## T76 — Address change, cutoff, lock, and dedupe

Status: **Complete (2026-08-25).**

Allow versioned changes before cutoff, lock after fulfillment cutoff, and route later changes to
human review. A valid current address is not requested twice.

**Verification:** transition, concurrency, outbox-dedupe, and history tests.

**Dependencies:** T75, T43

## T77 — Shipping journey E2E

Status: **Complete (2026-08-25).**

Selected participant → one-time form → valid versioned address → guideline readiness → one provider
message, with duplicate submission and cross-owner attack cases.

**Dependencies:** T76, T54

---

# Phase 12 — Payback consent

## T78 — Versioned consent aggregate

Status: **Complete (2026-08-25).**

Persist Not Requested, Awaiting Response, Agreed, Declined, Withdrawn, and Human Review Required with
terms version, evidence message, channel, classification, actor, and timestamp.

**Acceptance:** exactly one current state with immutable history; consent state is independently
queryable and cannot be inferred from free text alone.

**Verification:** migration and state-history integration tests.

**Dependencies:** T24, T34

## T79 — Current-terms consent request

Status: **Complete (2026-08-25).**

Send one request tied to the active terms and request id. Old, unrelated, duplicate, or superseded
responses cannot satisfy it.

**Verification:** outbox dedupe and correlation tests.

**Dependencies:** T78, T43

## T80 — Explicit response and one clarification

Status: **Complete (2026-08-25).**

Classify explicit agree/decline responses deterministically where possible; ambiguity creates exactly
one approved clarification and no agreed state.

**Verification:** Korean unit cases, ambiguity idempotency, and human-review integration test.

**Dependencies:** T64, T79

## T81 — Terms supersession, decline, and withdrawal

Status: **Complete (2026-08-25).**

New terms invalidate incomplete requests; decline stops progression; withdrawal preserves evidence
and creates review when fulfillment has begun.

**Verification:** transition, guideline-gate, and audit tests.

**Dependencies:** T80

## T82 — AC-05: consent versioning

Status: **Complete (2026-08-25). T81's broader decline/withdrawal policy remains a separate release dependency.**

Implement PRD §26.3 AC-05 verbatim: consent to an old terms version cannot authorize the current
payback flow, while one explicit response to the current request can.

**Verification:** E2E release gate and mutation proof.

**Dependencies:** T81

---

# Phase 13 — Visit A reservation

## T83 — Reservation aggregate and immutable versions

Status: **Complete (2026-08-25).**

Store structured reservation versions, source/evidence, extraction provenance, validation result,
rule version, status, cancellation, and supersession history.

**Acceptance:** current head is unique; prior versions are immutable; no extraction result alone can
mark a reservation valid.

**Verification:** migration, authorization, and history tests.

**Dependencies:** T34, T49

## T84 — Visit A text intake and date/time candidates

Status: **Complete (2026-08-25).**

Convert participant text into structured reservation candidates through deterministic parsing and the
bounded AI extraction fallback. Ambiguous candidates request clarification instead of guessing.

**Verification:** Korean intent/date evaluation plus prompt-injection security cases.

**Dependencies:** T65, T66, T83

## T85 — Reservation validation and specific corrections

Status: **Complete (2026-08-25).**

Run every structured candidate through the existing fourteen-rule set and persist the full rule
evidence. Participant corrections name the failed rule and approved corrective action.

**Verification:** boundary, blackout, lead-time, business, status, and timezone integration tests.

**Dependencies:** T84, T49

## T86 — Cancellation, rescheduling, and stale evidence

Status: **Complete (2026-08-25).**

Cancellation and rescheduling create new history, revoke prior readiness, reject stale source events,
and deduplicate corrections.

**Verification:** transition, out-of-order, audit, and outbox tests.

**Dependencies:** T85, T39

## T87 — Visit A journey E2E

Status: **Complete (2026-08-25).**

Selected participant → text reservation → structured extraction → deterministic validation → specific
correction or readiness → one guideline delivery. Repeat and stale events produce no duplicate side
effect.

**Dependencies:** T86, T54

---

# Checkpoint F — Participant flows proven

- [x] Attachment attack corpus and cross-owner authorization tests pass.
- [ ] AI evaluation thresholds and protected-state boundary pass; approved provider/privacy decisions are recorded.
- [x] Selection remains recommendation-only and shadow comparisons are auditable.
- [x] Shipping and Visit A journeys pass with duplicate/stale-event proofs.
- [x] AC-05 passes and all prior Milestone 1 acceptance tests remain green.
- [ ] Coverage thresholds, security tier, rollback notes, and operator runbooks pass review. The
      decision-independent runbook is recorded in
      [docs/operations-readiness.md](../docs/operations-readiness.md); current review evidence is being
      collected on the Milestone 3 branch.
- [ ] Review with human before Milestone 3.
