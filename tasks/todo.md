# Task List: Milestone 1 — Core Spine

Plan: [tasks/plan.md](plan.md) · Spec: [SPEC.md](../SPEC.md) · Requirements: PRD v1.0

56 tasks across 8 phases. Every task clears the project Definition of Done in PRD `§36` in addition to
its own acceptance criteria. `pnpm verify` must pass before every commit.

---

## Task Index

### Phase 0 — Foundation
- [ ] T1 — Workspace and toolchain scaffold
- [ ] T2 — Lint, format, and the `pnpm verify` gate
- [ ] T3 — Local services via Docker Compose
- [ ] T4 — NestJS `api` app boot and health endpoint
- [ ] T5 — `worker` app boot and queue connection
- [ ] T6 — Module-boundary lint rule
- [ ] T7 — Test harness: Vitest and Testcontainers
- [ ] T8 — Config and secrets validation
- [ ] T9 — Drizzle setup and initial migration

### Checkpoint A — Foundation
- [ ] `pnpm verify` passes on a clean clone
- [ ] `pnpm services:up && pnpm db:reset && pnpm dev` brings up api, worker, and admin
- [ ] The boundary lint rule rejects a deliberately invalid cross-module import
- [ ] Review with human before proceeding

### Phase 1 — Observability and audit
- [ ] T10 — Correlation ID propagation
- [ ] T11 — Structured logger with masking
- [ ] T12 — PII-leak test matcher
- [ ] T13 — Append-only audit log

### Phase 2 — Idempotency spine
- [ ] T14 — Event contracts (`§18`)
- [ ] T15 — Event inbox schema
- [ ] T16 — Webhook gateway: signature and replay
- [ ] T17 — Webhook gateway: schema, limits, rate limiting
- [ ] T18 — Idempotent accept semantics
- [ ] T19 — Inbound provider port, fake, and conformance suite
- [ ] T20 — **AC-02**: duplicate application-completion webhook

### Checkpoint B — Idempotency proven
- [ ] AC-02 passes: the same source event id twice yields one transition and one message
- [ ] The conformance suite passes against the fake, and is the question list for the Kakao dealer
- [ ] No PII appears in any log emitted during the suite
- [ ] Review with human before proceeding

### Phase 3 — Configuration and source of truth
- [ ] T21 — Campaigns and versioned rules
- [ ] T22 — Time windows and blackouts
- [ ] T23 — Business details and approved aliases
- [ ] T24 — Guideline, terms, and template versions
- [ ] T25 — Campaign activation validation
- [ ] T26 — Website adapter port, fake, and applications schema
- [ ] T27 — Application reconciliation and freshness

### Phase 4 — Identity
- [ ] T28 — Participants, channel identities, phone normalization
- [ ] T29 — Matching decision table (`§16.1`)
- [ ] T30 — Application verification token
- [ ] T31 — Ambiguity and campaign disambiguation
- [ ] T32 — Human review tasks (minimal)
- [ ] T33 — **AC-04**: ambiguous identity

### Checkpoint C — Identity proven
- [ ] AC-04 passes and no candidate applicant detail is disclosed in any participant-facing output
- [ ] Name-only matching is rejected (`FR-ID-001`) with a test proving it
- [ ] Matching decision table is at 100% branch coverage
- [ ] Review with human before proceeding

### Phase 5 — Workflow core
- [ ] T34 — Workflow instances and events schema
- [ ] T35 — `transition()` with optimistic concurrency
- [ ] T36 — Legal transition table (`§14.5`)
- [ ] T37 — Illegal transitions rejected (`§14.6`)
- [ ] T38 — Automation pauses and kill switch
- [ ] T39 — Corrections and supersession (`§14.7`)
- [ ] T40 — Out-of-order and stale events

### Checkpoint D — State machine proven
- [ ] Every `§14.6` illegal transition has a passing rejection test
- [ ] Concurrent transitions on one workflow serialize or 409, never interleave
- [ ] Emergency pause halts non-essential automation at all four scopes
- [ ] Review with human before proceeding

### Phase 6 — Outbound and deduplication
- [ ] T41 — Outbound notifications schema
- [ ] T42 — Dedupe key construction (`§17.4`)
- [ ] T43 — Transactional outbox
- [ ] T44 — Template rendering
- [ ] T45 — Outbound port, fake, and send worker
- [ ] T46 — Human-ownership lock
- [ ] T47 — **AC-06**: operator and AI concurrency

### Phase 7 — The gates
- [ ] T48 — Rules engine core
- [ ] T49 — Reservation rule set (`§16.7`)
- [ ] T50 — Business approvals schema
- [ ] T51 — Visit C hard gate
- [ ] T52 — **AC-01**: Visit C approval gate
- [ ] T53 — Guideline readiness predicate (`§16.9`)
- [ ] T54 — Guideline delivery and version dedupe
- [ ] T55 — Premature-delivery incident handling
- [ ] T56 — **AC-03** and **AC-08**

### Checkpoint E — Walking skeleton complete
- [ ] AC-01, AC-02, AC-03, AC-04, AC-06, AC-08 all pass
- [ ] End-to-end: fake webhook → inbox → transition → gate → outbox → fake provider
- [ ] Coverage thresholds in SPEC.md §7 met; gates and validators at 100% branch
- [ ] SPEC.md §3.3 boundary decisions confirmed or revised against what was built
- [ ] Break down Milestone 2 before proceeding

---

# Phase 0 — Foundation

## T1 — Workspace and toolchain scaffold

**Description:** Create the pnpm + Turborepo monorepo with the directory layout from SPEC.md §5 and a
strict shared TypeScript configuration. Apps and packages are empty placeholders at this point; this
task establishes only the structure and compiler contract.

**Acceptance criteria:**
- [ ] `pnpm install` succeeds and resolves `apps/*` and `packages/*` workspaces
- [ ] `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`
- [ ] `pnpm typecheck` runs across all workspaces and exits 0

**Verification:**
- [ ] Build succeeds: `pnpm build`
- [ ] Typecheck passes: `pnpm typecheck`
- [ ] Manual check: directory tree matches SPEC.md §5

**Dependencies:** None

**Files likely touched:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`

**Estimated scope:** S

---

## T2 — Lint, format, and the `pnpm verify` gate

**Description:** Configure ESLint and Prettier, and wire the `pnpm verify` composite script that
SPEC.md §8 requires before every commit. `verify` runs typecheck, lint, unit tests, and transition
tests; the last two are no-ops until T7.

**Acceptance criteria:**
- [ ] `pnpm lint` and `pnpm format` run across all workspaces
- [ ] ESLint rejects `as` casts applied to values typed `unknown` from external sources
- [ ] `pnpm verify` chains typecheck → lint → test:unit → test:transitions and fails on any non-zero exit

**Verification:**
- [ ] `pnpm verify` exits 0 on the clean scaffold
- [ ] Manual check: introduce a lint error and confirm `pnpm verify` fails

**Dependencies:** T1

**Files likely touched:** `eslint.config.js`, `.prettierrc`, `package.json`

**Estimated scope:** S

---

## T3 — Local services via Docker Compose

**Description:** Compose file for PostgreSQL 16, Redis 7, and MinIO with pinned versions, named
volumes, and health checks. These back local development and Testcontainers-free local runs.

**Acceptance criteria:**
- [ ] `pnpm services:up` starts all three and reports healthy; `pnpm services:down` removes them
- [ ] MinIO starts with a private bucket and no anonymous read policy (`§21.3`)
- [ ] Credentials come from `.env.example`, with no secret committed

**Verification:**
- [ ] Manual check: `pnpm services:up`, connect to Postgres and Redis, confirm MinIO bucket is private
- [ ] Manual check: `pnpm services:down` leaves no running container

**Dependencies:** T1

**Files likely touched:** `infra/docker-compose.yml`, `.env.example`, `package.json`

**Estimated scope:** S

---

## T4 — NestJS `api` app boot and health endpoint

**Description:** Minimal NestJS application with an empty `modules/` directory and a health endpoint
reporting database and queue reachability.

**Acceptance criteria:**
- [ ] `pnpm dev:api` serves on port 3000
- [ ] `GET /health` returns 200 with per-dependency status, and 503 when a dependency is unreachable
- [ ] The health endpoint requires no authentication and exposes no version or environment detail

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Manual check: stop Postgres, confirm `/health` returns 503 naming the failed dependency

**Dependencies:** T1, T3

**Files likely touched:** `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health/*`

**Estimated scope:** S

---

## T5 — `worker` app boot and queue connection

**Description:** Standalone BullMQ worker process connecting to Redis, with graceful shutdown that
drains in-flight jobs. No processors yet.

**Acceptance criteria:**
- [ ] `pnpm dev:worker` connects to Redis and logs a ready state
- [ ] SIGTERM drains in-flight jobs before exit rather than dropping them
- [ ] Queue names are defined in one shared constant, not string literals at call sites

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Manual check: enqueue a no-op job, send SIGTERM mid-flight, confirm it completes

**Dependencies:** T1, T3

**Files likely touched:** `apps/worker/src/main.ts`, `apps/worker/src/queues.ts`

**Estimated scope:** S

---

## T6 — Module-boundary lint rule

**Description:** Encode the SPEC.md §3.1 dependency table as an ESLint rule. An import that reaches
past a module's `index.ts`, or that crosses to a module not listed in the importer's `Depends on`
column, fails lint. Built before the modules exist so the rule is never retroactive.

**Acceptance criteria:**
- [ ] Deep imports into another module's internals fail lint
- [ ] A cross-module import absent from the §3.1 dependency table fails lint with a message naming both modules
- [ ] The dependency table lives in one machine-readable file that the rule reads, not duplicated in config

**Verification:**
- [ ] Tests pass: `pnpm test:unit` (rule has its own fixture tests)
- [ ] Manual check: add a deliberate violation, confirm `pnpm lint` fails and names the modules

**Dependencies:** T2

**Files likely touched:** `eslint.config.js`, `tools/eslint-rules/module-boundaries.js`, `module-graph.json`

**Estimated scope:** M

---

## T7 — Test harness: Vitest and Testcontainers

**Description:** Vitest projects for the unit, transition, integration, security, and e2e tiers from
SPEC.md §7, with a Testcontainers helper that provisions PostgreSQL and Redis per integration run and
a `packages/testing` home for fixtures and builders.

**Acceptance criteria:**
- [ ] Each tier runs independently via its own script and together via `pnpm test`
- [ ] The integration tier provisions and tears down containers without touching local dev services
- [ ] Coverage thresholds from SPEC.md §7 are configured and enforced by `pnpm test:coverage`

**Verification:**
- [ ] Tests pass: `pnpm test` with one sample test per tier
- [ ] Manual check: run the integration tier with dev services stopped and confirm it still passes

**Dependencies:** T1, T3

**Files likely touched:** `vitest.config.ts`, `vitest.workspace.ts`, `packages/testing/src/containers.ts`, `packages/testing/src/index.ts`

**Estimated scope:** M

---

## T8 — Config and secrets validation

**Description:** A Zod-validated environment schema loaded once at boot. Missing or malformed
configuration fails fast at startup rather than surfacing as a runtime error, and no secret is ever
logged.

**Acceptance criteria:**
- [ ] Invalid or missing required config aborts startup with a message naming every offending key
- [ ] Config is injectable as a typed object; `process.env` access outside the loader fails lint
- [ ] Secret-valued keys are marked in the schema and redacted from any diagnostic output

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Manual check: unset a required variable and confirm the failure message names it and prints no value

**Dependencies:** T4

**Files likely touched:** `apps/api/src/modules/platform-core/config/*`, `.env.example`

**Estimated scope:** S

---

## T9 — Drizzle setup and initial migration

**Description:** Drizzle ORM with drizzle-kit migrations in `packages/db`, plus the `db:generate`,
`db:migrate`, `db:seed`, and `db:reset` scripts. The initial migration creates shared enums and
extensions only; entity tables arrive with their owning modules.

**Acceptance criteria:**
- [ ] `pnpm db:reset` drops, recreates, migrates, and seeds without manual steps
- [ ] Migrations are checked in as SQL and reviewable — no runtime schema push
- [ ] The integration test harness runs migrations against its container automatically

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: `pnpm db:reset` twice in a row succeeds and is idempotent

**Dependencies:** T3, T7, T8

**Files likely touched:** `packages/db/src/schema/index.ts`, `packages/db/drizzle.config.ts`, `packages/db/migrations/0000_init.sql`, `package.json`

**Estimated scope:** M

---

# Phase 1 — Observability and audit

## T10 — Correlation ID propagation

**Description:** Every inbound request and every queued job carries a correlation id, generated at the
edge if absent and propagated through HTTP handlers, service calls, and job payloads so one participant
interaction is traceable end to end (`§18.3`, `§23.1`).

**Acceptance criteria:**
- [ ] An inbound request without a correlation id gets one; one with a valid id reuses it
- [ ] Enqueued jobs inherit the enqueuing context's correlation id and restore it in the worker
- [ ] The id is retrievable from async context without threading it through every signature

**Verification:**
- [ ] Tests pass: `pnpm test:unit` and `pnpm test:integration`
- [ ] Manual check: trace one request through api and worker logs by its correlation id alone

**Dependencies:** T4, T5

**Files likely touched:** `apps/api/src/modules/platform-core/correlation/*`, `apps/worker/src/context.ts`

**Estimated scope:** S

---

## T11 — Structured logger with masking

**Description:** JSON logger emitting the required `§23.1` fields, with a `mask()` helper for personal
data. Phone numbers, names, addresses, and channel identifiers are masked at the call site; the logger
never receives raw values.

**Acceptance criteria:**
- [ ] Every log line carries timestamp, environment, module, correlation id, operation, and result
- [ ] `mask()` handles Korean and international phone formats, names, and addresses, preserving enough for debugging
- [ ] Passing an object containing a known-sensitive key name to the logger fails lint

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Manual check: inspect emitted lines and confirm no unmasked personal data

**Dependencies:** T10

**Files likely touched:** `apps/api/src/modules/platform-core/logging/*`, `packages/contracts/src/mask.ts`

**Estimated scope:** S

---

## T12 — PII-leak test matcher

**Description:** A Vitest matcher that captures log output during a test and fails if it contains
anything shaped like a phone number, address fragment, resident identifier, or authorization header.
Wired into `test:security` so `§21.4` is enforced by the build, not by review.

**Acceptance criteria:**
- [ ] The matcher detects Korean local and international phone shapes, address fragments, and `Authorization` values
- [ ] Any test tier can opt in; `test:security` applies it to every test in the tier
- [ ] The matcher has its own fixture tests covering both detection and non-detection

**Verification:**
- [ ] Tests pass: `pnpm test:security`
- [ ] Manual check: deliberately log a phone number in a test and confirm the suite fails

**Dependencies:** T7, T11

**Files likely touched:** `packages/testing/src/matchers/no-pii.ts`, `vitest.workspace.ts`

**Estimated scope:** S

---

## T13 — Append-only audit log

**Description:** The `audit_logs` table and write API from `§17.2`, with database-level append-only
enforcement. A failed audit write for a protected action raises a critical alert rather than being
swallowed (`§23.3`).

**Acceptance criteria:**
- [ ] `UPDATE` and `DELETE` on `audit_logs` are rejected at the database level, not only in application code
- [ ] Every record carries actor, action, target, result, timestamp, reason, and correlation id, with PII masked or tokenized
- [ ] A failed write for a protected action emits a critical alert and surfaces the failure to the caller

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: attempt a direct `UPDATE` in psql and confirm rejection

**Dependencies:** T9, T11

**Files likely touched:** `packages/db/src/schema/audit-logs.ts`, `packages/db/migrations/*`, `apps/api/src/modules/audit-log/*`

**Estimated scope:** M

---

# Phase 2 — Idempotency spine

## T14 — Event contracts (`§18`)

**Description:** Zod schemas in `packages/contracts` for the common event envelope (`§18.1`), the
acceptance response (`§18.2`), and the error model (`§18.4`), plus the message purpose and reason code
registries. These types are the only shape core modules ever see.

**Acceptance criteria:**
- [ ] Envelope, acceptance response, and each `§18.5`–`§18.15` payload have a schema and a derived type
- [ ] The `§18.4` status table is a typed exception hierarchy mapping to HTTP status codes
- [ ] Message purpose codes are a single `as const` registry with a derived union

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Manual check: every payload example in PRD `§18` parses against its schema as a fixture

**Dependencies:** T1

**Files likely touched:** `packages/contracts/src/events/*`, `packages/contracts/src/errors.ts`, `packages/contracts/src/purposes.ts`

**Estimated scope:** S

---

## T15 — Event inbox schema

**Description:** The `event_inbox` table with `UNIQUE(source, external_event_id)` — the constraint that
is the actual idempotency guarantee, not the application logic layered over it (`§17.3`).

**Acceptance criteria:**
- [ ] The unique constraint exists in the migration and a test proves a second insert violates it
- [ ] Records store source, external event id, payload hash, status, and received time, with payload minimized or encrypted
- [ ] Failed events are retained in a queryable state for replay (`§22.3`)

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: insert a duplicate directly in psql and confirm the constraint rejects it

**Dependencies:** T9, T14

**Files likely touched:** `packages/db/src/schema/event-inbox.ts`, `packages/db/migrations/*`

**Estimated scope:** S

---

## T16 — Webhook gateway: signature and replay

**Description:** Signature verification and replay-window validation at the webhook edge (`§18.3`).
Verification is provider-pluggable because each vendor signs differently, and the scheme is unverified
for all of them.

**Acceptance criteria:**
- [ ] An invalid or absent signature is rejected with 401 before the body is parsed or persisted
- [ ] A timestamp outside the configured replay window is rejected, and the window is configurable per provider
- [ ] Signature comparison is constant-time, and no signature or secret reaches the logs

**Verification:**
- [ ] Tests pass: `pnpm test:security`
- [ ] Manual check: replay a captured valid request after the window and confirm rejection

**Dependencies:** T14, T15

**Files likely touched:** `apps/api/src/modules/provider-gateway/signature/*`, `apps/api/src/modules/provider-gateway/webhook.controller.ts`

**Estimated scope:** M

---

## T17 — Webhook gateway: schema, limits, rate limiting

**Description:** Schema validation, payload and attachment size limits, and per-provider rate limiting,
applied after signature verification and before inbox insertion (`§18.3`).

**Acceptance criteria:**
- [ ] A body failing envelope schema validation is rejected 400 without side effects
- [ ] Payloads over the configured limit are rejected 413 without being buffered entirely into memory
- [ ] Rate limiting is per provider and returns 429 with no partial processing

**Verification:**
- [ ] Tests pass: `pnpm test:security`
- [ ] Manual check: send an oversized body and confirm 413 with bounded memory use

**Dependencies:** T16

**Files likely touched:** `apps/api/src/modules/provider-gateway/validation/*`, `apps/api/src/modules/provider-gateway/rate-limit.ts`

**Estimated scope:** M

---

## T18 — Idempotent accept semantics

**Description:** The accept path from `§10.3`: insert into the inbox keyed on source event id; on
conflict, return the prior accepted result rather than reprocessing. New events return 202 and enqueue
processing.

**Acceptance criteria:**
- [ ] A duplicate returns the original acceptance response with `duplicate: true` and enqueues nothing
- [ ] A new event returns 202 and enqueues exactly one processing job
- [ ] Concurrent delivery of the same event id yields one inbox row and one job, under a concurrency test

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: fire the same event twice concurrently and confirm one job

**Dependencies:** T15, T17

**Files likely touched:** `apps/api/src/modules/provider-gateway/inbox.service.ts`, `apps/api/src/modules/provider-gateway/inbox.repository.ts`

**Estimated scope:** S

---

## T19 — Inbound provider port, fake, and conformance suite

**Description:** The platform-neutral inbound port, a fake provider that emits `§18.5`–`§18.12` events
on demand, and a conformance suite that any adapter — fake or real — must pass. The suite doubles as
the capability question list for the Kakao dealer.

**Acceptance criteria:**
- [ ] The fake emits every inbound event type in `§18`, including duplicates and out-of-order delivery
- [ ] The conformance suite runs against any adapter via a shared factory and passes for the fake
- [ ] Provider-specific types do not appear outside `packages/adapters`, enforced by the T6 lint rule

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: the suite's assertions map one-to-one onto the PRD `§33.3` provider checklist

**Dependencies:** T18

**Files likely touched:** `packages/adapters/src/ports/inbound.ts`, `packages/adapters/fakes/src/inbound-fake.ts`, `packages/adapters/src/conformance/inbound.suite.ts`

**Estimated scope:** M

---

## T20 — AC-02: duplicate application-completion webhook

**Description:** The `§26.3` AC-02 acceptance test, verbatim. Given an application-completed event has
been processed, when the same source event id is delivered again, it is acknowledged as a duplicate
with no second transition and no second acknowledgment message.

**Acceptance criteria:**
- [ ] The Gherkin scenario is implemented as written and passes
- [ ] The test asserts on persisted state and outbound intents, not on HTTP response alone
- [ ] The test runs in the e2e tier and gates release

**Verification:**
- [ ] Tests pass: `pnpm test:e2e`
- [ ] Manual check: the test fails if the inbox unique constraint is dropped

**Dependencies:** T19

**Files likely touched:** `tests/e2e/ac-02-duplicate-webhook.spec.ts`

**Estimated scope:** S

---

# Phase 3 — Configuration and source of truth

## T21 — Campaigns and versioned rules

**Description:** The `campaigns` and `campaign_rules` tables with effective-dated immutable versions
(`§13.5`). A rule version is never mutated; changes create a new version, and every decision references
the exact version it used.

**Acceptance criteria:**
- [ ] `UNIQUE(campaign_id, rule_type, version)` holds, and published versions reject updates
- [ ] Campaign type (Shipping, Payback, Visit) and visit method (A, B, C) are stored as enums, never inferred from text (`FR-CAM-001`, `FR-CAM-002`)
- [ ] Resolving the rule version effective at a given instant is a tested query, not caller arithmetic

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: attempt to mutate a published rule version and confirm rejection

**Dependencies:** T9, T13

**Files likely touched:** `packages/db/src/schema/campaigns.ts`, `packages/db/src/schema/campaign-rules.ts`, `apps/api/src/modules/campaign-config/*`

**Estimated scope:** M

---

## T22 — Time windows and blackouts

**Description:** `campaign_time_windows` and `campaign_blackouts` bound to a rule version, supporting
multiple windows per weekday and configurable boundary inclusivity (`§16.7`, `FR-RES-004`, `FR-RES-005`).

**Acceptance criteria:**
- [ ] Multiple windows per weekday are supported, and all are evaluated
- [ ] Boundary inclusivity is stored per window, not assumed globally
- [ ] `UNIQUE(campaign_id, rule_version, date)` holds for blackouts

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: configure two Tuesday windows and confirm both persist and resolve

**Dependencies:** T21

**Files likely touched:** `packages/db/src/schema/campaign-time-windows.ts`, `packages/db/src/schema/campaign-blackouts.ts`

**Estimated scope:** S

---

## T23 — Business details and approved aliases

**Description:** Versioned business name, approved aliases, branch, phone, and booking URL
(`FR-CAM-004`). Alias matching is what stops a correct booking at the wrong branch from passing
validation later.

**Acceptance criteria:**
- [ ] Business records are effective-dated and versioned; changes create a new version
- [ ] Aliases are a first-class list, and name comparison normalizes whitespace, casing, and Korean spacing variants
- [ ] Branch is stored separately from business name so a wrong-branch booking is distinguishable from a wrong business

**Verification:**
- [ ] Tests pass: `pnpm test:unit` (normalization) and `pnpm test:integration`
- [ ] Manual check: a known alias resolves to the campaign business; an unapproved one does not

**Dependencies:** T21

**Files likely touched:** `packages/db/src/schema/campaign-businesses.ts`, `apps/api/src/modules/campaign-config/business-matching.ts`

**Estimated scope:** S

---

## T24 — Guideline, terms, and template versions

**Description:** `guideline_versions`, payback terms versions, and `message_templates` — all immutable
once published, all referenced by exact version from consent records and delivery records
(`FR-CAM-005`, `FR-PAY-001`, `§17.3`).

**Acceptance criteria:**
- [ ] `UNIQUE(campaign_id, version)` for guidelines and `UNIQUE(purpose_code, version)` for templates hold
- [ ] Publishing freezes content; editing a published version is rejected and requires a new version
- [ ] Templates carry a legal classification field (`§21.9`) and a draft / approved / active / retired state

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: publish, attempt an edit, confirm rejection, create a new version successfully

**Dependencies:** T21

**Files likely touched:** `packages/db/src/schema/guideline-versions.ts`, `packages/db/src/schema/message-templates.ts`, `apps/api/src/modules/campaign-config/publishing.ts`

**Estimated scope:** M

---

## T25 — Campaign activation validation

**Description:** A campaign cannot enter automated mode with incomplete configuration (`FR-CAM-006`).
Validation runs before activation and names every missing requirement rather than failing on the first.

**Acceptance criteria:**
- [ ] Activation is rejected when required rules, windows, templates, or guideline versions are absent
- [ ] The rejection lists every missing item, each with a reason code
- [ ] An invalid campaign type and visit method combination is rejected (`FR-ADM-002`, `§16.4`)

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Manual check: activate a partially configured campaign and read the full missing-item list

**Dependencies:** T22, T23, T24

**Files likely touched:** `apps/api/src/modules/campaign-config/activation-validator.ts`, `apps/api/src/modules/campaign-config/reason-codes.ts`

**Estimated scope:** S

---

## T26 — Website adapter port, fake, and applications schema

**Description:** The website port, a fake emitting `application.created` and `application.updated`, and
the `applications` table with `UNIQUE(source_system, source_application_id)` (`§13.1`). The website
remains the source of truth; nothing here creates an application from a participant message.

**Acceptance criteria:**
- [ ] The unique constraint holds and repeated synchronization updates one record rather than creating duplicates (`FR-APP-002`)
- [ ] Source event id and source timestamp are preserved on every change (`FR-APP-003`)
- [ ] Application states distinguish received, completed, matched, ambiguous, cancelled, and synchronized-late (`FR-APP-004`)

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: replay the same application event and confirm one record, one logical change

**Dependencies:** T19, T21

**Files likely touched:** `packages/db/src/schema/applications.ts`, `packages/adapters/src/ports/website.ts`, `packages/adapters/fakes/src/website-fake.ts`, `apps/api/src/modules/application-sync/*`

**Estimated scope:** M

---

## T27 — Application reconciliation and freshness

**Description:** When a participant claims to have applied but no event has arrived, reconcile against
recent website applications over a configurable retry window before declaring no match
(`FR-APP-005`). Track synchronization freshness so stale data can block sensitive progression
(`FR-APP-008`).

**Acceptance criteria:**
- [ ] A configurable retry window elapses, with reconciliation attempts, before a no-match conclusion
- [ ] Last successful reconciliation time is queryable per source, and staleness is a computed flag
- [ ] Reconciliation is idempotent — a late-arriving event for an already-reconciled application produces no second transition

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: simulate a delayed application and confirm pending state then resolution

**Dependencies:** T26

**Files likely touched:** `apps/api/src/modules/application-sync/reconciliation.service.ts`, `apps/worker/src/processors/reconcile-applications.ts`

**Estimated scope:** M

---

# Phase 4 — Identity

## T28 — Participants, channel identities, phone normalization

**Description:** The `participants` and `channel_identities` tables with
`UNIQUE(provider, external_user_id)`, and phone normalization handling Korean local and international
forms. A phone number is explicitly not globally unique — shared numbers exist (`FR-ID-005`).

**Acceptance criteria:**
- [ ] Korean local (`010-1234-5678`, `01012345678`) and international (`+821012345678`) forms normalize identically
- [ ] `UNIQUE(provider, external_user_id)` holds; phone has an index but no unique constraint
- [ ] Normalization is a pure function with its own exhaustive test table

**Verification:**
- [ ] Tests pass: `pnpm test:unit` and `pnpm test:integration`
- [ ] Manual check: two participants sharing one phone number both persist

**Dependencies:** T26

**Files likely touched:** `packages/db/src/schema/participants.ts`, `packages/db/src/schema/channel-identities.ts`, `apps/api/src/modules/identity-resolution/phone-normalization.ts`

**Estimated scope:** M

---

## T29 — Matching decision table (`§16.1`)

**Description:** The applicant-matching decision table as a pure function over candidates and evidence,
returning one of Verified, Strong Match, Weak Match, Ambiguous, or No Match with the method and
evidence recorded (`FR-ID-012`). Name-only matching is structurally impossible, not merely discouraged.

**Acceptance criteria:**
- [ ] Every row of `§16.1` has a test, and the function is at 100% branch coverage
- [ ] A name-only candidate can only return Weak Match, never a binding result (`FR-ID-001`)
- [ ] The result carries method, evidence category, and timestamp for the audit record (`FR-ID-002`)

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Coverage: 100% branch on the decision function
- [ ] Manual check: each `§16.1` row maps to a named test case

**Dependencies:** T28

**Files likely touched:** `apps/api/src/modules/identity-resolution/matching-table.ts`, `apps/api/src/modules/identity-resolution/matching-table.spec.ts`, `apps/api/src/modules/identity-resolution/reason-codes.ts`

**Estimated scope:** M

---

## T30 — Application verification token

**Description:** Support for a website-issued single-application verification token as the strongest
matching evidence (`FR-ID-003`), with expiry and single-use semantics.

**Acceptance criteria:**
- [ ] A valid token resolves to exactly its intended application and yields a Verified result
- [ ] Expired, reused, or unknown tokens fail closed and do not degrade to a weaker match
- [ ] Tokens are compared in constant time and never logged

**Verification:**
- [ ] Tests pass: `pnpm test:unit` and `pnpm test:security`
- [ ] Manual check: reuse a consumed token and confirm rejection

**Dependencies:** T29

**Files likely touched:** `apps/api/src/modules/identity-resolution/verification-token.ts`

**Estimated scope:** S

---

## T31 — Ambiguity and campaign disambiguation

**Description:** Ambiguous results pause matching and request minimal additional verification without
ever listing candidate applicants (`FR-ID-006`, `FR-ID-007`). A conversation spanning several active
campaigns requires disambiguation before any campaign-specific state changes (`FR-ID-010`).

**Acceptance criteria:**
- [ ] No participant-facing output derived from an ambiguous result contains any candidate's name, phone, or application detail
- [ ] Several active campaigns for one participant blocks campaign-specific transitions until context resolves
- [ ] A candidate already linked to a different participant produces a security-review path, not a silent rebind

**Verification:**
- [ ] Tests pass: `pnpm test:security`
- [ ] Manual check: two matching applications produce a disambiguation request revealing neither

**Dependencies:** T29

**Files likely touched:** `apps/api/src/modules/identity-resolution/ambiguity.service.ts`

**Estimated scope:** M

---

## T32 — Human review tasks (minimal)

**Description:** Enough of `human-tasks` for ambiguity to have somewhere to go: task creation with
reason code and priority, a case packet stub, and queue persistence. Full ownership, SLA, and
return-to-automation land in Milestone 3.

**Acceptance criteria:**
- [ ] A task records workflow, reason code, priority, and status, with case data masked by default (`FR-HUM-003`)
- [ ] Priority follows the `§16.11` handoff table for the conditions implemented so far
- [ ] Creating a task pauses ordinary automation for that workflow

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: an ambiguous match produces exactly one task at the `§16.11` priority

**Dependencies:** T31

**Files likely touched:** `packages/db/src/schema/human-review-tasks.ts`, `apps/api/src/modules/human-tasks/*`

**Estimated scope:** M

---

## T33 — AC-04: ambiguous identity

**Description:** The `§26.3` AC-04 acceptance test, verbatim. Two active applications matching the same
phone and campaign produce an Ambiguous state, a human review task, and no disclosure of either record.

**Acceptance criteria:**
- [ ] The Gherkin scenario is implemented as written and passes
- [ ] The test asserts that no participant-facing output contains either applicant's details
- [ ] The test runs in the e2e tier and gates release

**Verification:**
- [ ] Tests pass: `pnpm test:e2e`
- [ ] Manual check: the test fails if the non-disclosure guard is removed

**Dependencies:** T32

**Files likely touched:** `tests/e2e/ac-04-ambiguous-identity.spec.ts`

**Estimated scope:** S

---

# Phase 5 — Workflow core

## T34 — Workflow instances and events schema

**Description:** `workflow_instances` scoped to participant + application + campaign (`§14.1`) with the
twelve `§14.2` state dimensions and a version column, plus the immutable `workflow_events` history.
`UNIQUE(application_id, campaign_id)` enforces one workflow per pairing (`§17.3`).

**Acceptance criteria:**
- [ ] The unique constraint holds, and one participant can hold several independent workflows (`FR-APP-007`)
- [ ] All twelve `§14.2` dimensions are persisted as enums with explicit initial states
- [ ] `workflow_events` is append-only at the database level and records the `§14.4` mandatory fields

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: one participant with two campaigns yields two isolated workflows

**Dependencies:** T13, T32

**Files likely touched:** `packages/db/src/schema/workflow-instances.ts`, `packages/db/src/schema/workflow-events.ts`, `packages/db/migrations/*`

**Estimated scope:** M

---

## T35 — `transition()` with optimistic concurrency

**Description:** The single write path for state change. Takes an expected version; a mismatch throws
`StaleWorkflowVersionError` mapping to HTTP 409 (`§14.4`, `§18.4`). Every transition writes a workflow
event and an audit record in the same transaction as the state change.

**Acceptance criteria:**
- [ ] A stale expected version fails with 409 and leaves the workflow unchanged
- [ ] State change, workflow event, and audit record commit atomically or not at all
- [ ] Concurrent transitions on one workflow serialize or conflict — a concurrency test proves no interleaving

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: two concurrent transitions from the same version — exactly one succeeds

**Dependencies:** T34

**Files likely touched:** `apps/api/src/modules/workflow-core/transition.service.ts`, `apps/api/src/modules/workflow-core/errors.ts`

**Estimated scope:** M

---

## T36 — Legal transition table (`§14.5`)

**Description:** The twenty-eight `§14.5` transitions encoded as data — from state, trigger, to state,
mandatory guard, side effect — with guards evaluated before any state change. Side effects are declared,
not executed inline, so they can be suppressed when a transition is rejected.

**Acceptance criteria:**
- [ ] Each `§14.5` row is represented and has a passing test for its guard passing and failing
- [ ] A failed guard rejects with a reason code and produces no side effect
- [ ] Adding a state to a dimension without adding its transitions is a compile error, not a silent gap

**Verification:**
- [ ] Tests pass: `pnpm test:transitions`
- [ ] Manual check: every `§14.5` row maps to a named test case

**Dependencies:** T35

**Files likely touched:** `apps/api/src/modules/workflow-core/transition-table.ts`, `tests/transitions/legal-transitions.spec.ts`

**Estimated scope:** M

---

## T37 — Illegal transitions rejected (`§14.6`)

**Description:** The thirteen explicitly prohibited transitions from `§14.6`, each with a test proving
rejection leaves the workflow unchanged and records an illegal-transition-attempt metric (`§23.2`).

**Acceptance criteria:**
- [ ] Each `§14.6` entry has a test asserting rejection, unchanged state, and an audit record
- [ ] Illegal attempts increment a metric and are queryable by dimension
- [ ] Anything not in the `§14.5` table is rejected by default — the table is an allowlist, not a denylist

**Verification:**
- [ ] Tests pass: `pnpm test:transitions`
- [ ] Manual check: an unlisted transition is rejected without needing an explicit `§14.6` entry

**Dependencies:** T36

**Files likely touched:** `tests/transitions/illegal-transitions.spec.ts`, `apps/api/src/modules/workflow-core/transition-table.ts`

**Estimated scope:** M

---

## T38 — Automation pauses and kill switch

**Description:** Pause scopes at global, campaign, workflow-type, and participant level, plus the
emergency kill switch that stops all non-essential outbound automation (`FR-HUM-008`, `FR-ADM-010`).
Pause state is checked by every automated path, and the active scope is always visible.

**Acceptance criteria:**
- [ ] All four scopes independently block automated progression, and the effective scope is queryable
- [ ] Activation and deactivation are authorized, audited, and carry a reason
- [ ] `UNIQUE` active pause per scope and type holds, so a scope cannot be doubly paused

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: activate global pause and confirm no automated transition proceeds

**Dependencies:** T35

**Files likely touched:** `packages/db/src/schema/automation-pauses.ts`, `apps/api/src/modules/workflow-core/pause.service.ts`

**Estimated scope:** M

---

## T39 — Corrections and supersession (`§14.7`)

**Description:** Corrections create a correction event and mark prior records superseded; they never
delete history. Downstream readiness is re-evaluated and no-longer-valid pending side effects are
cancelled.

**Acceptance criteria:**
- [ ] A correction preserves the prior state and evidence, and records the correcting actor and reason
- [ ] Superseded records remain queryable and are excluded from current-state reads
- [ ] Pending side effects invalidated by the correction are cancelled or suppressed, with a test proving it

**Verification:**
- [ ] Tests pass: `pnpm test:transitions`
- [ ] Manual check: correct a state and confirm both versions remain in the event history

**Dependencies:** T37

**Files likely touched:** `apps/api/src/modules/workflow-core/correction.service.ts`, `tests/transitions/corrections.spec.ts`

**Estimated scope:** M

---

## T40 — Out-of-order and stale events

**Description:** Delayed and out-of-order events are tolerated: a stale event cannot reverse a newer
valid state without an explicit authorized correction (`FR-MSG-007`).

**Acceptance criteria:**
- [ ] An event whose source timestamp precedes the current state's origin is rejected or reconciled, never silently applied
- [ ] Rejection records the reason and retains the event for replay
- [ ] A test covers the `§26.2` "events arrive out of order" scenario

**Verification:**
- [ ] Tests pass: `pnpm test:transitions`
- [ ] Manual check: deliver two events in reverse order and confirm the newer state survives

**Dependencies:** T39

**Files likely touched:** `apps/api/src/modules/workflow-core/staleness.ts`, `tests/transitions/out-of-order.spec.ts`

**Estimated scope:** S

---

# Phase 6 — Outbound and deduplication

## T41 — Outbound notifications schema

**Description:** `outbound_notifications` with `UNIQUE(deduplication_key)` — the database constraint
that makes duplicate suppression a guarantee rather than a best effort (`FR-MSG-003`, `§17.3`).

**Acceptance criteria:**
- [ ] The unique constraint exists and a test proves a second insert with the same key is rejected
- [ ] Records carry workflow, channel, purpose code, dedupe key, provider message id, status, and retry count
- [ ] Suppression events are recorded with a reason so an operator can explain a non-send (`FR-ADM-008`)

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: insert a duplicate key directly in psql and confirm rejection

**Dependencies:** T34

**Files likely touched:** `packages/db/src/schema/outbound-notifications.ts`, `packages/db/migrations/*`

**Estimated scope:** S

---

## T42 — Dedupe key construction (`§17.4`)

**Description:** `buildDedupeKey()` — the single function that constructs the canonical key from
channel, workflow, purpose, content version, business event version, and authorized re-delivery id.
Hand-concatenating a key anywhere else fails lint.

**Acceptance criteria:**
- [ ] The key format matches `§17.4` and the `§17.2` example round-trips through a test
- [ ] Key construction is pure and deterministic, with a test table covering each component's presence and absence
- [ ] String concatenation producing a dedupe key outside this function fails lint

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Coverage: 100% branch on the builder
- [ ] Manual check: an authorized re-delivery produces a key distinct from the original

**Dependencies:** T41

**Files likely touched:** `packages/contracts/src/dedupe-key.ts`, `packages/contracts/src/dedupe-key.spec.ts`

**Estimated scope:** S

---

## T43 — Transactional outbox

**Description:** State change and send intent commit in one database transaction (`FR-MSG-004`). The
worker picks up committed intents; an intent can never exist for a transition that rolled back, and a
transition can never commit without its intent.

**Acceptance criteria:**
- [ ] A rolled-back transition leaves no outbound intent, proven by an integration test
- [ ] The worker claims intents without double-claiming under concurrency
- [ ] Enqueueing an intent outside a transaction context fails at the type level

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: force a rollback mid-transaction and confirm no intent persists

**Dependencies:** T42, T35

**Files likely touched:** `apps/api/src/modules/messaging/outbox.service.ts`, `apps/worker/src/processors/send-outbound.ts`

**Estimated scope:** M

---

## T44 — Template rendering

**Description:** Render participant-facing messages from versioned `message_templates` with named
variables. Internal values that policy forbids disclosing — selection scores above all — cannot be
interpolated (`FR-SEL-008`).

**Acceptance criteria:**
- [ ] Rendering resolves the template by purpose code and version, and an unknown variable fails loudly
- [ ] A denylist of internal fields cannot be interpolated into a participant-facing template
- [ ] The rendered version is recorded on the notification for audit

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Manual check: attempt to interpolate a selection score and confirm rejection

**Dependencies:** T24, T41

**Files likely touched:** `apps/api/src/modules/messaging/template-renderer.ts`

**Estimated scope:** S

---

## T45 — Outbound port, fake, and send worker

**Description:** The platform-neutral outbound port, a fake provider recording sends and simulating
timeout, failure, and unknown status, and the send worker that retries reusing the original idempotency
key (`FR-MSG-008`). Delivery status reconciliation for unknown results (`FR-MSG-009`).

**Acceptance criteria:**
- [ ] A provider timeout retries with the same idempotency key and produces one logical message
- [ ] Unknown delivery status is reconciled on a schedule rather than resent blindly (`§16.10`)
- [ ] The outbound conformance suite passes for the fake and is shared with future real adapters

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: simulate a timeout then success, confirm one provider message

**Dependencies:** T43, T44

**Files likely touched:** `packages/adapters/src/ports/outbound.ts`, `packages/adapters/fakes/src/outbound-fake.ts`, `apps/worker/src/processors/reconcile-delivery.ts`

**Estimated scope:** M

---

## T46 — Human-ownership lock

**Description:** Human and automated ownership are mutually exclusive for a conversation
(`FR-MSG-006`). While an operator owns it, automated message intents are suppressed with reason
`HUMAN_OWNERSHIP_ACTIVE` rather than queued for later.

**Acceptance criteria:**
- [ ] An automated intent created during human ownership is suppressed and recorded with the reason
- [ ] Ownership has exactly one active holder, enforced by constraint, with actor and timestamp visible
- [ ] Approved system notices are the only exception and are explicitly allowlisted

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: take ownership, trigger an automated path, confirm suppression

**Dependencies:** T43

**Files likely touched:** `packages/db/src/schema/operator-assignments.ts`, `apps/api/src/modules/messaging/ownership.guard.ts`

**Estimated scope:** M

---

## T47 — AC-06: operator and AI concurrency

**Description:** The `§26.3` AC-06 acceptance test, verbatim. When an operator owns a conversation and
an automated message intent is created, the intent is suppressed with reason `HUMAN_OWNERSHIP_ACTIVE`.

**Acceptance criteria:**
- [ ] The Gherkin scenario is implemented as written and passes
- [ ] The test asserts the suppression reason, not merely the absence of a send
- [ ] The test runs in the e2e tier and gates release

**Verification:**
- [ ] Tests pass: `pnpm test:e2e`
- [ ] Manual check: the test fails if the ownership guard is removed

**Dependencies:** T46

**Files likely touched:** `tests/e2e/ac-06-ownership-concurrency.spec.ts`

**Estimated scope:** S

---

# Phase 7 — The gates

## T48 — Rules engine core

**Description:** The pure evaluator: structured facts plus a rule version in, pass / fail / review plus
reason out. It never guesses — missing configuration returns a configuration error rather than a
default (`§11`).

**Acceptance criteria:**
- [ ] Evaluation is pure, takes the clock as an argument, and performs no I/O
- [ ] Missing or malformed rule configuration returns a distinct configuration-error result, never a pass
- [ ] Every result carries the rule version used, the submitted value, and the expected condition

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Coverage: 100% branch on the evaluator
- [ ] Manual check: evaluate against a campaign missing a required rule and read the error

**Dependencies:** T21, T25

**Files likely touched:** `apps/api/src/modules/rules-engine/evaluator.ts`, `apps/api/src/modules/rules-engine/reason-codes.ts`

**Estimated scope:** M

---

## T49 — Reservation rule set (`§16.7`)

**Description:** The fourteen `§16.7` checks as individual pure rules: campaign, business, date period,
weekday, time window, boundary, timezone, booking method, approval, status, lead time, blackout,
campaign status, capacity. Each failure names the rule, the submitted value, the expected condition,
and the correction (`FR-RES-011`).

**Acceptance criteria:**
- [ ] Each `§16.7` row is an independently testable rule with its own reason code
- [ ] Boundary rules honor per-window inclusivity, and exact start and end times are tested explicitly
- [ ] Every failure result carries submitted value, expected condition, correction, and retry eligibility

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Coverage: 100% branch on the rule set
- [ ] Manual check: the `§26.2` boundary and weekday scenarios each map to a named test

**Dependencies:** T48, T22, T23

**Files likely touched:** `apps/api/src/modules/rules-engine/reservation-rules.ts`, `apps/api/src/modules/rules-engine/reservation-rules.spec.ts`

**Estimated scope:** M

---

## T50 — Business approvals schema

**Description:** `business_approvals` with versioned history and the `§13.10` states — Not Required, Not
Requested, Pending, Approved, Rejected, Expired, Revoked, Human Review Required. Approval state is
independent from reservation state and separately auditable (`FR-VC-001`).

**Acceptance criteria:**
- [ ] One current approval version per workflow, with immutable prior versions retained
- [ ] Records carry campaign, scope, approver, issued time, and expiry (`FR-VC-004`)
- [ ] Approval is queryable independently of any reservation record

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: revoke an approval and confirm the prior version remains readable

**Dependencies:** T34

**Files likely touched:** `packages/db/src/schema/business-approvals.ts`, `apps/api/src/modules/business-approval/*`

**Estimated scope:** M

---

## T51 — Visit C hard gate

**Description:** The `§16.6` approval decision table. Booking instructions are impossible while approval
is anything other than current and approved (`FR-VC-002`) — enforced by a predicate the send path
cannot bypass. Only an authorized source or operator may record approval (`FR-VC-003`); a participant
message never can.

**Acceptance criteria:**
- [ ] Every `§16.6` row has a test, and each prohibited state produces zero `VISIT_C_BOOKING_INSTRUCTIONS` intents
- [ ] Approval recorded from a participant-message path is rejected regardless of content
- [ ] Expiry and revocation both halt progression and create a task; revocation is priority Critical (`§16.11`)

**Verification:**
- [ ] Tests pass: `pnpm test:transitions` and `pnpm test:security`
- [ ] Coverage: 100% branch on the gate predicate
- [ ] Manual check: attempt a send in each prohibited state and confirm zero intents

**Dependencies:** T50, T43

**Files likely touched:** `apps/api/src/modules/business-approval/approval-gate.ts`, `apps/api/src/modules/business-approval/approval-gate.spec.ts`

**Estimated scope:** M

---

## T52 — AC-01: Visit C approval gate

**Description:** The `§26.3` AC-01 acceptance test, verbatim. A selected Visit C participant with
Pending approval who asks for the booking link receives only the approval-pending message, and no
booking-instruction intent exists.

**Acceptance criteria:**
- [ ] The Gherkin scenario is implemented as written and passes
- [ ] The test asserts the absence of any intent with purpose `VISIT_C_BOOKING_INSTRUCTIONS`
- [ ] The test runs in the e2e tier and gates release — this is a zero-incident requirement

**Verification:**
- [ ] Tests pass: `pnpm test:e2e`
- [ ] Manual check: the test fails if the approval predicate is bypassed

**Dependencies:** T51

**Files likely touched:** `tests/e2e/ac-01-visit-c-gate.spec.ts`

**Estimated scope:** S

---

## T53 — Guideline readiness predicate (`§16.9`)

**Description:** `evaluateGuidelineReadiness()` — the pure gate from SPEC.md §6, with a separate
predicate per campaign type and the universal conditions applied first. This is the task that
empirically tests the SPEC.md §3.3 boundary decision: if a required fact is not available on the
workflow snapshot, the capability map needs revising.

**Acceptance criteria:**
- [ ] Every `§16.9` row is covered, and the campaign-type switch is exhaustive at compile time
- [ ] The function is pure, takes the clock as an argument, and reads only the workflow snapshot
- [ ] Every blocked result names the specific blocking condition, never a generic failure

**Verification:**
- [ ] Tests pass: `pnpm test:unit`
- [ ] Coverage: 100% branch on the predicate
- [ ] Manual check: confirm no fact needed by the gate is absent from the snapshot — if any is, raise it against SPEC.md §3.3

**Dependencies:** T49, T51

**Files likely touched:** `apps/api/src/modules/guideline-delivery/guideline-gate.ts`, `apps/api/src/modules/guideline-delivery/guideline-gate.spec.ts`, `apps/api/src/modules/guideline-delivery/reason-codes.ts`

**Estimated scope:** M

---

## T54 — Guideline delivery and version dedupe

**Description:** Delivery through the outbox with a version-scoped dedupe key. A delivered version is
never resent automatically (`FR-GDL-004`); re-delivery requires a new version, an authorized operator
action, or a confirmed failure (`FR-GDL-005`). The notification service re-evaluates readiness
independently before sending (`§18.13`).

**Acceptance criteria:**
- [ ] A repeated request for a delivered version creates a suppression record rather than a send
- [ ] A new active version is eligible for exactly one delivery after readiness re-evaluation
- [ ] Every delivery stores the `FR-GDL-003` fields: participant, application, campaign, version, channel, event, rule result, timestamp, provider result, dedupe key

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: request the same version three times, confirm one send and two suppressions

**Dependencies:** T53, T43

**Files likely touched:** `apps/api/src/modules/guideline-delivery/delivery.service.ts`, `apps/api/src/modules/guideline-delivery/delivery.repository.ts`

**Estimated scope:** M

---

## T55 — Premature-delivery incident handling

**Description:** A guideline delivered without readiness is a critical incident (`FR-GDL-006`): it
raises an immediate alert and triggers an automation pause. Cancellation or approval revocation after
delivery creates a review task with the full delivery and state history (`FR-GDL-007`).

**Acceptance criteria:**
- [ ] A detected premature delivery raises a critical alert and activates a campaign-scope pause
- [ ] Post-delivery cancellation or revocation creates a Critical priority task carrying the delivery history
- [ ] Detection runs as an independent check, not only as an assertion inside the send path

**Verification:**
- [ ] Tests pass: `pnpm test:integration`
- [ ] Manual check: force a delivery bypassing the gate and confirm alert plus pause

**Dependencies:** T54, T38

**Files likely touched:** `apps/api/src/modules/guideline-delivery/incident.service.ts`, `apps/worker/src/processors/audit-guideline-deliveries.ts`

**Estimated scope:** S

---

## T56 — AC-03 and AC-08

**Description:** The final two `§26.3` acceptance tests. AC-03: a Visit B participant whose reservation
time violates the campaign rule requests the guideline, receives the invalid-time correction, and
guideline state stays Not Ready. AC-08: guideline v3 delivered, v4 becomes active, one v4 delivery is
queued, v3 remains recorded, and repeat v4 requests are suppressed.

**Acceptance criteria:**
- [ ] Both Gherkin scenarios are implemented as written and pass
- [ ] AC-03 asserts the specific invalid-time correction, not a generic failure message
- [ ] Both run in the e2e tier and gate release

**Verification:**
- [ ] Tests pass: `pnpm test:e2e`
- [ ] Manual check: all six Milestone 1 acceptance tests pass in one run

**Dependencies:** T55

**Files likely touched:** `tests/e2e/ac-03-guideline-readiness.spec.ts`, `tests/e2e/ac-08-guideline-version.spec.ts`

**Estimated scope:** S
