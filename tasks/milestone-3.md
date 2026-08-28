# Task List: Milestone 3 — Operations Surface

Plan: [tasks/plan.md](plan.md) · Spec: [SPEC.md](../SPEC.md) · Requirements: PRD v1.0

Status: **T88–T99 and T103–T117 complete. T100–T102 remain policy-blocked. Policy-dependent
production activation remains blocked until the named decisions are approved.**

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

Status: **Complete (2026-08-26). No production schedule is published; activation remains blocked by
company and legal approval of every data-class period and disposition.**

Store approved, versioned schedules for each PRD §21.6 data class. Missing schedules are explicit and
block deletion.

**Acceptance:** strict `privacy-retention-schedule-v1` input requires all eleven data classes,
bounded integer days, a disposition, version chain, and separate company/legal approval references;
versions and entries are immutable; replay is idempotent and semantic conflicts fail closed; no
default or production fixture is seeded.

**Verification:** contract tests, clean migration replay, RLS/restricted-role checks, complete-entry
and exact-supersession integration cases, and append-only mutation refusals. See
[docs/privacy-operations.md](../docs/privacy-operations.md).

**Production blocked by:** approved retention periods and dispositions per data class

## T99 — Legal hold and deletion eligibility

Status: **Complete (2026-08-26). This is evidence-only and performs no deletion or masking.**

Calculate eligibility from the approved schedule while legal hold always wins. Missing policy is
`not_eligible`, not a default duration.

**Acceptance:** participant, participant/data-class, and record scopes are strict and pseudonymous;
apply/release history and each eligibility evaluation are immutable; active hold wins even when the
schedule is absent or retention elapsed; missing policy returns `policy_missing`; retention produces
only `retention_active` or `eligible` evidence with the approved disposition; audit detail states
`deletion_executed = false`.

**Verification:** idempotent replay/conflict cases, hold-before-policy and release-time cases,
retention-boundary cases, append-only database triggers, RLS, and an assertion that no deletion queue
or job object exists.

**Dependencies:** T98; T100 remains separately blocked from executing an eligible result

## T100 — Audited deletion and irreversible masking jobs

Status: **Blocked.** The PRD requires company/legal approval of concrete periods before deletion jobs
can be specified. T99 intentionally provides eligibility evidence but no executor.

Use dry-run, bounded batches, idempotency, storage reconciliation, and immutable completion/failure
evidence. Business history is superseded or masked according to policy, never silently erased.

## T101 — Privacy access/correction/export evidence

Assemble scoped results, record sensitive access, constrain exports, and preserve request decisions.

**Blocked in part by:** approved sensitive-reveal/export policy

## T102 — Privacy request E2E

Status: **Blocked on T100 and the approved sensitive reveal/export policy required by T101.**

Prove intake, verification, scope, legal hold, missing-policy stop, approved execution, and audit.

**Dependencies:** T96–T101

---

# Phase 16 — Administrative API

## T103 — Auth-neutral operator principal contract

Status: **Complete (2026-08-26). Production authentication adapter remains blocked by the SSO versus
local-MFA decision.**

Define verified principal, role, campaign scope, assurance level, and session/audit context without
binding an identity vendor.

**Acceptance:** exact versioned input requires verified state, known canonical roles, explicit global
or campaign scope, assurance, pseudonymous session/authentication references, policy and current
authorization versions, environment, and finite validity; provider claims and raw contact data are
not accepted.

**Verification:** contract rejection/canonicalization tests plus build and module-boundary checks. See
[docs/admin-authorization.md](../docs/admin-authorization.md).

**Blocked for production adapter by:** SSO versus local MFA decision

## T104 — Deny-by-default RBAC enforcement

Status: **Complete (2026-08-26). Production activation remains blocked by approval of the real RBAC
matrix; the repository policy is explicitly test-only.**

Map every administrative command and sensitive read to a role and campaign scope. Unknown roles,
missing scope, and stale authorization fail closed.

**Acceptance:** the versioned policy covers every known T105–T109 action exactly once; unknown
actions fail at the contract boundary; production refuses unapproved policy; role, assurance,
campaign/global scope, environment, expiry, policy version, and current authorization version are
independent deny gates; allow/deny results carry pseudonymous audit context.

**Verification:** exhaustive matrix completeness, role/scope/assurance, stale/expiry/environment,
test-versus-production, unknown action/role, and enforcement-helper tests. See
[docs/admin-authorization.md](../docs/admin-authorization.md).

**Blocked for production activation by:** approved RBAC matrix

## T105 — Participant search and complete timeline API

Status: **Complete as a transport-neutral query service (2026-08-26). No production HTTP
transport exists; T151 owns that and the console still reads fixtures.**

Return masked search results and the PRD §20.3 timeline with stable pagination and no raw payloads.

**Acceptance:** campaign-scoped search masks names and phones while keeping application status and
blogger evidence separate; the stable timeline returns coded, versioned events across the complete
participant workflow without raw payloads or sensitive content.

## T106 — Human-task and approval command API

Status: **Complete as a transport-neutral command service (2026-08-26). No production HTTP
transport exists; T151 owns that. Operator selection is not exposed here — that is T140.**

Expose assign, resolve, resume, override, and business-approval commands with expected versions and
audited reasons.

**Acceptance:** authorization uses the campaign read from the target object; stale workflow
versions fail closed; resume requires both resolve and resume permissions plus current readiness;
business approval and its protected audit evidence commit atomically.

## T107 — Versioned campaign-content command API

Status: **Complete as a transport-neutral command service (2026-08-26). No production HTTP
transport exists; T151 owns that.**

Expose validated preview/publish flows for campaign rules, templates, terms, and guidelines.

**Acceptance:** campaign commands use optimistic versions; rule previews are non-mutating;
publication rechecks the locked draft; rules, payback terms, templates, and guidelines reuse their
immutable version transitions.

## T108 — Operational diagnostics and retry API

Status: **Complete as a transport-neutral diagnostics service (2026-08-26). No production HTTP
transport exists; T151 owns that. Reported integration state remains the no-real-provider safe
fallback.**

Expose health, failed jobs, notification/suppression history, idempotency-preserving retry, pauses,
cost, and AI-evaluation state.

**Acceptance:** diagnostics contain codes and metadata rather than raw payloads; retry accepts only
failed/dead-lettered inbound jobs, is atomic and idempotent through an immutable receipt, and leaves
the existing relay to enqueue; pauses reuse governed current-state validation; the AI/cost endpoint
truthfully reports the no-real-provider safe-fallback state.

**Verification for T105–T108:** API unit tests, workspace build/typecheck/lint, Drizzle schema check,
and [admin operations API notes](../docs/admin-operations-api.md). Container-backed migration and
privilege tests require an available Docker-compatible runtime.

## T109 — Sensitive reveal and export controls

Status: **Complete with production activation blocked (2026-08-26).**

Keep masked reads as default; require explicit authorization and audit for reveal/export.

**Blocked for production activation by:** approved reveal/export and RBAC policy

Implemented a second strict `sensitive-access-policy-v1` gate in addition to admin RBAC. Test-only
reveals require a globally scoped privacy reviewer, phishing-resistant assurance, an allowed reason,
and a one-record limit. Rejected attempts are protected audit events; successful address reveal
evidence and its protected audit row commit atomically. Bulk export remains an audited unavailable
safe fallback, so no real PII file can be produced before policy, destination, and durable job
decisions are approved. See [sensitive access controls](../docs/sensitive-access-controls.md).

## T110 — Admin API authorization E2E

Status: **Complete (2026-08-26).**

Prove role/scope allow and deny cases, stale commands, masked defaults, audited reveals, and retries
that preserve idempotency.

**Dependencies:** T103–T109

The isolated PostgreSQL E2E applies all migrations and proves campaign scope allow/deny, stale
authorization, masked search defaults, rejected/successful reveal evidence, stale retry state, and
one immutable receipt across an identical retry replay. The real-database proof also corrected the
participant search projection to return the application lifecycle status selected by its contract.

---

# Phase 17 — Operator console

## T111 — Console shell and accessibility baseline

Status: **Complete (2026-08-26).**

Create the Next.js operator application shell, Korean-first navigation, session boundary, error
states, keyboard navigation, and accessible status semantics.

Added `apps/admin` on pinned Next.js 16.3.3 with Korean top-level navigation, a separate exact
twenty-page PRD registry, a production-locked provider-neutral session boundary, request-time
session evaluation, semantic status and error states, keyboard skip navigation, a responsive mobile
menu, reduced-motion support, and reproducible local font loading. Production build, desktop/mobile
browser checks, keyboard focus, runtime error inspection, and axe WCAG 2 A/AA all pass. See the
[operator console foundation](../docs/operator-console.md).

## T112 — Overview, participant search, and timeline

Status: **Complete (2026-08-26) against the deterministic console adapter. Production data access
remains locked until the authenticated HTTP adapter and missing timeline projections exist.**

Implement PRD §20.1 pages 1–3 with masked defaults and visible automation/ownership state.

Added overview metrics, POST-based masked participant search with stable pagination,
campaign-scoped detail, separate application-status and blogger-evidence fields, and the complete
PRD §20.3 timeline UI contract. Search terms stay out of URLs. The typed response reports support
for every category without raw payloads or PII. A production adapter must mark unsupported
persisted categories unavailable rather than fabricate history. The participant-search Server
Action independently re-checks the session, canonical action authorization, and campaign scope.

## T113 — Work queues

Status: **Complete (2026-08-26) against the deterministic console adapter.**

Implement human review, business approval, failed jobs, notification history, and duplicate
suppression pages (pages 4, 9, and 12–14).

Added pseudonymous queues with ownership, SLA, attempt, state, version, and safe command evidence.
Production rows and mutations remain locked until authorized query and command transports exist.

## T114 — Campaign and content editors

Status: **Complete (2026-08-26) against the deterministic console adapter.**

Implement pages 5–8 and 10–11 with version preview, validation, maker-checker state, and no direct
database writes.

Added campaign detail, selection and reservation rule, message template, and guideline editors with
editable deterministic fixture payloads, coded schema preview outcomes, expected versions,
maker-checker evidence, and the draft/approved/scheduled/active/retired lifecycle. Editor content is
not persisted or transmitted, and the console performs no direct database writes. Campaign state
options match the command contract (`draft`, `active`, `paused`, `closed`), and its deterministic
preview rejects impossible calendar dates and non-increasing campaign periods.

## T115 — Governance and system pages

Status: **Complete (2026-08-26) against the deterministic console adapter.**

Implement integration health, audit, privacy, user/role, pause, and AI/cost pages (15–20).

Added integration health, audit, privacy, users/roles, automation pause, and AI/cost surfaces. The
AI page preserves T63's no-provider safe fallback and zero estimated provider cost. The production
adapter returns no records until authorized read services exist.

## T116 — Destructive-action safeguards

Status: **Complete (2026-08-26).**

Add explicit confirmations, reason capture, stale-version handling, masked/reveal affordances, and
clear pause/production-block banners.

Added typed reason, exact-confirmation, expected-version, stale-state, preview, and policy-denial
outcomes. Canonical authorization actions are shared by API and console while fixture scenarios stay
separate. The discriminated contract makes versions impossible on blocked actions, and policy is
evaluated before input or stale-state checks. Sensitive values stay masked, reveal remains denied,
bulk export is unavailable, and every page shows the emergency pause and production-change
boundaries.

## T117 — Operator-console release E2E

Status: **Complete (2026-08-26).**

Cover every §20.1 route plus representative permitted/denied commands, keyboard navigation, stale
updates, human ownership, and emergency pause visibility.

Added a Playwright release suite and a Windows-safe server runner. The fixture lane covers all
twenty canonical routes from the shared registry, masked participant and campaign-scope behavior,
timeline pagination, deterministic editors, permitted, preview, stale, and denied outcomes,
keyboard/mobile navigation, emergency banners, and representative desktop/mobile axe WCAG A/AA
checks. A second lane runs the built standalone production artifact in its default locked state.
Browser and server runtime errors fail either lane.

**Dependencies:** T111–T116

---

# Checkpoint G — Operations surface proven

- [x] Human handoff is complete, deduplicated, assignable, SLA-aware, and only resumes after current-state validation.
- [ ] Privacy requests and approved retention/legal-hold operations pass end to end.
- [x] Administrative commands are deny-by-default, scoped, versioned, and audited.
- [x] All twenty PRD §20.1 console pages exist with masked defaults and accessibility checks.
- [x] Security, coverage, integration, and operator E2E gates pass.
- [ ] Review with human before Milestone 4.
