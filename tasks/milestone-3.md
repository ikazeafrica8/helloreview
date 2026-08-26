# Task List: Milestone 3 — Operations Surface

Plan: [tasks/plan.md](plan.md) · Spec: [SPEC.md](../SPEC.md) · Requirements: PRD v1.0

Status: **T88–T97 complete. T98–T117 planned. Policy-dependent tasks remain blocked until their
named decisions are approved.**

Milestone 3 makes the tested automation spine operable without weakening its safety boundaries.
Human ownership remains explicit, selection remains manual, sensitive reads are audited, and every
resume operation revalidates current state.

## Decisions required before affected tasks

| Decision                                    | Blocks                                   | Safe work that may proceed                                                            |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Operator service hours and response targets | Production SLA activation and escalation | Versioned SLA contract that fails closed when policy is absent                        |
| Retention periods per data class            | Retention/deletion schedules             | Privacy request intake, legal-hold model, deletion eligibility with no-delete default |
| Operator authentication: SSO or local MFA   | Login integration                        | Auth-neutral principal contract and authorization tests                               |
| Approved RBAC matrix and campaign scopes    | Production admin authorization           | Deny-by-default policy engine and PRD-role fixtures                                   |
| Approved sensitive-reveal/export policy     | Full PII reveal and export               | Masked reads and immutable access-attempt audit                                       |

---

# Phase 14 — Human operations

## T88 — Versioned full case-packet contract

Status: **Complete (2026-08-25).**

Define the FR-HUM-003 operator packet with workflow state, masked identity, application, campaign,
summary, evidence, deterministic rule results, allowed actions, priority, and recommendation.
Participant PII and raw provider/model payloads are not representable in the default packet.

**Acceptance:** schema/version is explicit; unsafe codes, references, raw Korean mobile numbers,
unmasked display names, duplicate actions, and invalid timestamps fail closed; inputs are copied so
caller mutation cannot rewrite returned evidence.

**Verification:** unit contract and PII tests, typecheck, lint.

**Dependencies:** T32, T66

## T89 — Handoff episode and one holding message

Status: **Complete (2026-08-26).**

Create one durable handoff episode and at most one approved holding-message intent per episode and
template version. Duplicate triggers reuse the original task and dedupe context.

**Verification:** migration/integration proof of one task, one outbox intent, one immutable holding
link, and replay idempotency. See
[docs/human-review-operations.md](../docs/human-review-operations.md).

**Dependencies:** T88, T43; participant-facing template approval required before production content

## T90 — Assignment, ownership, and queue filters

Status: **Complete (2026-08-26).**

Add explicit assignment/claim/release history and queue reads by priority, age, campaign, reason,
assignee, and overdue status. Human and automated conversation ownership remain mutually exclusive.

**Verification:** exclusive claim, release/reassignment history, priority/due ordering, and queue
filter integration cases.

**Dependencies:** T89, T42

## T91 — Policy-required SLA and escalation

Status: **Complete (2026-08-26). Production activation remains blocked by service-hours/SLA approval.**

Calculate due/overdue/escalation timestamps from a versioned service-hours policy. No policy means
`SLA_POLICY_MISSING`, never an invented deadline.

**Verification:** Seoul service-window/holiday unit table, persisted timestamps, overdue query, and
missing-policy no-deadline integration proof.

**Dependencies:** T90; production activation blocked by service-hours/SLA approval

## T92 — Validated return to automation

Status: **Complete (2026-08-26).**

Resolve a task and release ownership only after reloading current workflow state, checking version,
required evidence, active pauses, opt-out, and deterministic readiness. Stale or incomplete state
remains paused.

**Verification:** current-version, authorized-owner, opt-out, evidence/readiness, campaign, active
pause, other-task, immutable rejection, and successful atomic-return integration cases.

**Dependencies:** T90, T39, T53

## T93 — Sensitive override evidence

Status: **Complete (2026-08-26).**

Require an authorized actor, non-empty reason, prior/new values, scope, correlation ID, and immutable
audit record for every permitted override. Protected invariants remain non-overridable.

**Verification:** versioned evidence contract; unauthorized, empty, unsafe, and no-op inputs fail
closed; selection decisions and workflow corrections persist the evidence inside their atomic audit
record; generic corrections cannot manufacture protected positive states.

**Dependencies:** T92, T13

## T94 — Emergency kill-switch operation

Status: **Complete (2026-08-26).**

Expose authorized global activation, visible status, incident reason, and separately authorized
resume validation. Essential holding/security notices are explicitly classified.

**Verification:** inactive/active status, unauthorized activation, duplicate activation,
unauthorized resume, incomplete reconciliation/state validation, immutable rejection evidence, and
successful separately authorized resume integration cases.

**Dependencies:** T92, T38

## T95 — Human-handoff journey E2E

Status: **Complete (2026-08-26).**

Trigger → pause → complete masked packet → one holding intent → assignment → resolution → current
state validation → audited resume, with duplicate, stale, unauthorized, and incomplete cases.

**Verification:** full temporary-PostgreSQL journey proves each step and one final atomic return to
automation.

**Dependencies:** T89–T94

---

# Phase 15 — Privacy operations

## T96 — Privacy-request aggregate and intake

Status: **Complete (2026-08-26).**

Persist request type, identity-verification state, scope, status, deadlines-policy reference,
assignee, evidence, and immutable history without assuming a retention duration.

**Acceptance:** authorized intake starts unverified and received; strict versioned scope/evidence
contracts reject raw contact data and unknown fields; request-reference replay is idempotent while a
semantic conflict fails closed; missing deadline policy stores no deadline; history and protected
audit evidence are atomic and append-only; direct Data API roles receive no access.

**Verification:** clean migration replay, app-role privilege repair, RLS inspection, unit contract,
integration replay/conflict/history, and security PII rejection. See
[docs/privacy-operations.md](../docs/privacy-operations.md).

**Dependencies:** T13, T28

## T97 — Privacy identity verification and affected-processing pause

Status: **Complete (2026-08-26). Production activation remains blocked by approval of a real
minimal verification policy and verified channel.**

Verify requester identity through an approved minimal process and pause only affected processing.
Candidate or cross-participant data is never disclosed during verification.

**Acceptance:** only an explicitly approved versioned verified-channel policy is accepted; supplied
pause targets must exactly match the claimed participant and declared campaign/workflow references;
cross-participant workflow and identity evidence fail with generic results; pause/event/audit
history is atomic and immutable; ordinary resume cannot release privacy pauses; success advances to
`in_review` but retains every affected pause.

**Verification:** clean two-step migration replay, RLS and restricted-role privilege repair, strict
contract unit tests, and database cases for exact pause isolation, generic failure, verified success,
idempotent replay, immutable history, and protected resume. See
[docs/privacy-operations.md](../docs/privacy-operations.md).

**Dependencies:** T96, T28; production activation blocked by verification-policy/channel approval

## T98 — Retention schedule registry

Store approved, versioned schedules for each PRD §21.6 data class. Missing schedules are explicit and
block deletion.

**Blocked by:** approved retention periods per data class

## T99 — Legal hold and deletion eligibility

Calculate eligibility from the approved schedule while legal hold always wins. Missing policy is
`not_eligible`, not a default duration.

## T100 — Audited deletion and irreversible masking jobs

Use dry-run, bounded batches, idempotency, storage reconciliation, and immutable completion/failure
evidence. Business history is superseded or masked according to policy, never silently erased.

## T101 — Privacy access/correction/export evidence

Assemble scoped results, record sensitive access, constrain exports, and preserve request decisions.

**Blocked in part by:** approved sensitive-reveal/export policy

## T102 — Privacy request E2E

Prove intake, verification, scope, legal hold, missing-policy stop, approved execution, and audit.

**Dependencies:** T96–T101

---

# Phase 16 — Administrative API

## T103 — Auth-neutral operator principal contract

Define verified principal, role, campaign scope, assurance level, and session/audit context without
binding an identity vendor.

**Blocked for production adapter by:** SSO versus local MFA decision

## T104 — Deny-by-default RBAC enforcement

Map every administrative command and sensitive read to a role and campaign scope. Unknown roles,
missing scope, and stale authorization fail closed.

**Blocked for production activation by:** approved RBAC matrix

## T105 — Participant search and complete timeline API

Return masked search results and the PRD §20.3 timeline with stable pagination and no raw payloads.

## T106 — Human-task and approval command API

Expose assign, resolve, resume, override, and business-approval commands with expected versions and
audited reasons.

## T107 — Versioned campaign-content command API

Expose validated preview/publish flows for campaign rules, templates, terms, and guidelines.

## T108 — Operational diagnostics and retry API

Expose health, failed jobs, notification/suppression history, idempotency-preserving retry, pauses,
cost, and AI-evaluation state.

## T109 — Sensitive reveal and export controls

Keep masked reads as default; require explicit authorization and audit for reveal/export.

**Blocked for production activation by:** approved reveal/export and RBAC policy

## T110 — Admin API authorization E2E

Prove role/scope allow and deny cases, stale commands, masked defaults, audited reveals, and retries
that preserve idempotency.

**Dependencies:** T103–T109

---

# Phase 17 — Operator console

## T111 — Console shell and accessibility baseline

Create the Next.js operator application shell, Korean-first navigation, session boundary, error
states, keyboard navigation, and accessible status semantics.

## T112 — Overview, participant search, and timeline

Implement PRD §20.1 pages 1–3 with masked defaults and visible automation/ownership state.

## T113 — Work queues

Implement human review, business approval, failed jobs, notification history, and duplicate
suppression pages (pages 4, 9, and 12–14).

## T114 — Campaign and content editors

Implement pages 5–8 and 10–11 with version preview, validation, maker-checker state, and no direct
database writes.

## T115 — Governance and system pages

Implement integration health, audit, privacy, user/role, pause, and AI/cost pages (15–20).

## T116 — Destructive-action safeguards

Add explicit confirmations, reason capture, stale-version handling, masked/reveal affordances, and
clear pause/production-block banners.

## T117 — Operator-console release E2E

Cover every §20.1 route plus representative permitted/denied commands, keyboard navigation, stale
updates, human ownership, and emergency pause visibility.

**Dependencies:** T111–T116

---

# Checkpoint G — Operations surface proven

- [x] Human handoff is complete, deduplicated, assignable, SLA-aware, and only resumes after current-state validation.
- [ ] Privacy requests and approved retention/legal-hold operations pass end to end.
- [ ] Administrative commands are deny-by-default, scoped, versioned, and audited.
- [ ] All twenty PRD §20.1 console pages exist with masked defaults and accessibility checks.
- [ ] Security, coverage, integration, and operator E2E gates pass.
- [ ] Review with human before Milestone 4.
