# Spec: HelloReview Reviewer Campaign Automation Platform

| Field                  | Value                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Spec version           | 1.0 (root spec — platform level)                                                                                                   |
| Status                 | Draft — awaiting capability-map approval                                                                                           |
| Source of requirements | [PRD v1.0](HelloReview%20Reviewer%20Campaign%20Automation%20Platform%20—%20Product%20Requirements%20Document.md), dated 2026-08-22 |
| Scope of this document | Platform-wide contract + capability map. Per-module specs are separate files.                                                      |
| Timezone               | Asia/Seoul (all business rules, all participant-facing rendering)                                                                  |
| Language               | Korean for participant-facing copy; English for all code, identifiers, logs, and docs                                              |

This spec is the engineering contract derived from the PRD. It does not re-open product decisions —
where the PRD states a requirement, this spec says how it is built and how we prove it works.
PRD section references (`§14.5`, `FR-VC-002`) are load-bearing: every requirement here traces back to one.

---

## 1. Objective

**What we are building.** A state-aware campaign operations platform for HelloReview's blogger and
reviewer campaigns. Participants apply on the HelloReview website and converse over a KakaoTalk
channel. The platform matches those conversations to authoritative website applications, drives each
participant through a shipping, payback, or visit workflow under versioned campaign rules, validates
their evidence, and releases campaign guidelines only when a deterministic readiness gate passes.

**Why.** Today operators do this by hand: finding applications, matching identities, re-explaining
campaign methods, validating reservations by eye, and trying to remember who was already messaged.
That is slow, inconsistent, and it leaks — duplicate notifications, premature guideline delivery, and
mismatched applicants are all live risks (`§4.4`).

**What this is not.** Not a chatbot with memory. The product asset is the workflow record, not the
conversation (`§37`). AI reads and drafts; deterministic services decide and authorize (`§2.3`).

**Users** (`§7`): participants (bloggers/reviewers), CS operators, senior operators, campaign
managers, business-approval coordinators, system administrators, privacy reviewers, auditors.

**Success looks like** a controlled production pilot where the platform runs eligible workflows
end-to-end with zero premature guideline deliveries, zero pre-approval Visit C booking instructions,
and zero cross-participant data exposure — while every automated decision remains reconstructable
from the audit log. Full criteria in §8 below.

---

## 2. Tech Stack

| Layer            | Choice                                                  | Why                                                                                                              |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Language         | TypeScript 5.x, strict mode, `noUncheckedIndexedAccess` | One language across API, workers, and dashboard; the `§18` event envelopes are defined once and shared           |
| API framework    | NestJS 11                                               | First-class module boundaries and DI — the modular monolith of `§10.1` maps onto NestJS modules directly         |
| Database         | PostgreSQL 16                                           | Authoritative operational state store (`§17.1`); the unique constraints in `§17.3` are the idempotency mechanism |
| ORM / migrations | Drizzle ORM + drizzle-kit                               | SQL-first, so the `§17.3` constraints and partial indexes stay explicit and reviewable                           |
| Queue            | BullMQ on Redis 7                                       | Durable jobs, retries, dead-letter, delayed jobs for reconciliation (`§22.2`, `§22.4`)                           |
| Validation       | Zod                                                     | One schema serves runtime validation, TS types, and the AI structured-output allowlist (`§19.6`)                 |
| Dashboard        | Next.js 15 (App Router) + React 19                      | Consumes `admin-api`; shares contract types with the backend                                                     |
| Object storage   | S3-compatible, private buckets, short-lived signed URLs | `§21.3`, `§21.5`                                                                                                 |
| Testing          | Vitest, Testcontainers, Playwright, Supertest           | See §7                                                                                                           |
| Monorepo         | pnpm workspaces + Turborepo                             | Enforced package boundaries; incremental CI                                                                      |
| Runtime          | Node 22 LTS                                             | —                                                                                                                |

**Region and hosting are unresolved** (`§8`: "Korean hosting is mandatory — Unknown"). Nothing in this
stack presumes a region. See Open Questions.

**All external providers are unverified** (`§3`, `§8`). Per the approved approach, core modules only
ever see the platform-neutral contracts from `§18`. Every provider has an in-repo fake that is the
default in development and test. Real adapters land behind the identical interface once each vendor's
capability is confirmed, and no module's tests may depend on a real provider.

---

## 3. Capability Map (PRD Phase 0)

This requirement bundles many independently testable capabilities, so modules and dependency
direction are decided before any module spec is written. **This map is the gate — review it first.**

Module ids are kebab-case, chosen once, and never renamed. Downstream specs and commands select work
by these ids. Arrows point one way; there are no cycles.

### 3.1 Modules

| Module id             | Responsibility                                                                                                                                                                                                              | Depends on                                                               | Phase                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------- |
| `platform-core`       | Config, secrets, DB access, queue, correlation IDs, error model (`§18.4`), structured logging, metrics, health                                                                                                              | —                                                                        | MVP                       |
| `audit-log`           | Append-only decision and access evidence; alert on write failure for protected actions (`§11`, `§21.4`)                                                                                                                     | `platform-core`                                                          | MVP                       |
| `campaign-config`     | Campaigns, versioned rules, weekday/time windows, blackouts, business details and aliases, terms versions, guideline versions, message templates, activation validation, maker-checker (`§13.5`, `§17.2`)                   | `platform-core`, `audit-log`                                             | MVP                       |
| `provider-gateway`    | Webhook edge: signature, replay window, schema, rate limit; event inbox idempotency; inbound adapters + fakes (`§10.3`, `§18.3`)                                                                                            | `platform-core`                                                          | MVP                       |
| `rules-engine`        | Pure deterministic evaluation of a rule version against structured facts → pass / fail / review + reason (`§11`)                                                                                                            | `campaign-config`                                                        | MVP                       |
| `application-sync`    | Website adapter, applications, source event IDs, reconciliation window, freshness and staleness (`§13.1`)                                                                                                                   | `provider-gateway`, `campaign-config`                                    | MVP                       |
| `identity-resolution` | Participants, channel identities, the `§16.1` matching table, phone normalization, verification tokens, ambiguity (`§13.2`)                                                                                                 | `application-sync`, `campaign-config`                                    | MVP                       |
| `workflow-core`       | Workflow instances and immutable events, the `§14.2` state dimensions, `§14.5` transition guards, `§14.6` illegal transitions, optimistic locking, corrections (`§14.7`), automation pauses and kill switch                 | `identity-resolution`, `campaign-config`, `audit-log`                    | MVP                       |
| `messaging`           | Conversations, messages, template rendering, message intents, dedupe keys (`§17.4`), transactional outbox, outbound adapters + fakes, delivery reconciliation, opt-out, quiet hours, human-ownership suppression (`§13.13`) | `workflow-core`, `campaign-config`, `provider-gateway`                   | MVP                       |
| `attachments`         | Secure ingest, type allowlist and signature check, malware scan, quarantine, content hash, ownership binding, encrypted storage, signed URLs (`§21.5`)                                                                      | `workflow-core`                                                          | MVP                       |
| `ai-orchestration`    | Text intent taxonomy (`§19.2`), entity and date/time extraction (`§19.3`, `§19.5`), pipeline (`§19.6`), injection defenses (`§19.7`), fallback (`§19.8`), eval harness (`§19.9`), cost budget                               | `platform-core`, `campaign-config`                                       | MVP                       |
| `human-tasks`         | Review queue, case packet, ownership lock, one holding message per episode, priority and SLA, return-to-automation validation (`§13.14`)                                                                                    | `workflow-core`, `messaging`                                             | MVP                       |
| `selection`           | Immutable decision evidence, versioned thresholds, manual-review band, shadow mode, auto-select disabled by default, overrides with reason (`§13.4`)                                                                        | `workflow-core`, `rules-engine`, `identity-resolution`                   | MVP (recommendation-only) |
| `shipping`            | Versioned addresses, secure one-time form, deterministic field validation, masking, cutoff and lock (`§13.6`)                                                                                                               | `workflow-core`, `messaging`, `rules-engine`                             | MVP                       |
| `payback-consent`     | Consent versioned against terms version, `§13.7` states, exactly one clarification, withdrawal (`§16.5`)                                                                                                                    | `workflow-core`, `messaging`, `campaign-config`                          | MVP                       |
| `business-approval`   | Visit C approval versions, authorized-source-only recording, expiry, revocation, the hard gate predicate (`§13.10`, `§16.6`)                                                                                                | `workflow-core`, `campaign-config`                                       | MVP                       |
| `reservation`         | Reservation aggregate and immutable versions, the `§16.7` validation table, rule-specific corrections, cancellation, rescheduling. Visit A path in MVP                                                                      | `workflow-core`, `rules-engine`, `ai-orchestration`, `business-approval` | MVP (Visit A)             |
| `guideline-delivery`  | Per-campaign-type readiness predicate (`§16.9`), guideline versions, delivery dedupe, authorized re-delivery, premature-delivery incident (`§13.12`)                                                                        | `workflow-core`, `rules-engine`, `messaging`                             | MVP                       |
| `privacy-ops`         | Privacy-request intake and queue, retention schedules, deletion and masking jobs, legal hold (`§21.6`)                                                                                                                      | `workflow-core`, `attachments`, `audit-log`                              | MVP (minimal)             |
| `admin-api`           | RBAC (`§20.2`), authorized commands, masked reads with logged reveal, participant-timeline assembly, replay and retry controls, export controls (`§13.15`)                                                                  | all business-flow modules, `audit-log`                                   | MVP                       |
| `operator-console`    | Next.js dashboard, the `§20.1` pages, safeguards from `§20.5`                                                                                                                                                               | `admin-api`                                                              | MVP                       |
| `ocr-extraction`      | Screenshot extraction schema (`§19.4`), confidence bands (`§16.8`), OCR plus multimodal fallback, disagreement → human review. Unlocks Visit B and full Visit C                                                             | `attachments`, `ai-orchestration`                                        | Phase 5                   |
| `blog-score`          | Approved score-source adapter and freshness. Unlocks auto-selection                                                                                                                                                         | `platform-core`                                                          | Phase 7                   |
| `analytics`           | `§25` metric dashboards, cost and AI-usage reporting                                                                                                                                                                        | `audit-log`, `admin-api`                                                 | Phase 8                   |

### 3.2 Build order

```
Wave 0   platform-core · audit-log
Wave 1   campaign-config · provider-gateway
Wave 2   rules-engine · application-sync
Wave 3   identity-resolution
Wave 4   workflow-core
Wave 5   messaging · attachments · ai-orchestration
Wave 6   human-tasks · selection · business-approval · shipping · payback-consent
Wave 7   reservation · guideline-delivery
Wave 8   privacy-ops · admin-api
Wave 9   operator-console
─────────  MVP boundary  ─────────
Later    ocr-extraction (Phase 5) · blog-score (Phase 7) · analytics (Phase 8)
```

Modules within a wave have no dependency on each other and can be built in parallel.
This ordering satisfies the PRD critical path (`§28.3`) and the rollout phases (`§27`).

### 3.3 Boundary decisions worth challenging now

These are the judgement calls in the map. If any is wrong, it is cheap to fix here and expensive later.

- **`business-approval` is separate from `reservation`.** Required, not stylistic: `FR-VC-001`
  mandates that Visit C approval state be independent from reservation state and separately auditable.
- **`guideline-delivery` does not depend on `shipping` / `payback-consent` / `reservation`.** The
  readiness predicate reads the workflow snapshot from `workflow-core`, where every `§14.2` state
  dimension already lives. This keeps the highest-stakes gate testable as a pure function over one
  input, and stops the flow modules from becoming a dependency hub.
- **`rules-engine` is separate from `campaign-config`.** Config owns storage and versioning; the
  engine is a pure evaluator. It is the single highest-value unit-test target in the codebase, and
  purity is what makes that cheap.
- **`provider-gateway` (inbound) is separate from `messaging` (outbound).** They are different trust
  postures — one validates untrusted input, the other guarantees exactly-once intent — and they mirror
  the inbox/outbox split in `§10.3`.
- **`ocr-extraction` is its own module, not a branch inside `ai-orchestration`.** It is Phase 5, it can
  be cut entirely without touching MVP requirements, and its confidence calibration (`§16.8`) is
  independent work.
- **`privacy-ops` is in the MVP** even though `§9.2` omits it, because `§16.11` routes privacy requests
  to a queue and `§21.6` requires working retention. Scope is minimal: intake, queue, retention jobs.
  Full data-rights automation is later.

---

## 4. Commands

Run from the repository root. Windows-friendly: everything goes through pnpm scripts rather than
shell chaining, so PowerShell and Git Bash behave identically.

```
# Setup
pnpm install                      Install all workspace dependencies
pnpm services:up                  Start PostgreSQL + Redis + MinIO via Docker Compose
pnpm services:down                Stop and remove local service containers
pnpm db:migrate                   Apply Drizzle migrations, then provision the app's database role
pnpm db:provision-role            Create/refresh the restricted role the api and worker connect as
pnpm db:seed                      Load fixture campaigns, rules, and templates
pnpm db:reset                     Drop, recreate, migrate, provision, seed  (development/test + localhost only)

# Protect
pnpm db:backup                    Dump roles + database to backups/<timestamp>/
pnpm db:verify-audit-protection   Assert audit_logs is still append-only — run after any restore

# Develop
pnpm dev                          api + worker + admin, all with fake providers
pnpm dev:api                      NestJS API only (port 3000)
pnpm dev:worker                   BullMQ worker only
pnpm dev:admin                    Next.js operator console only (port 3001)

# Verify — the pre-commit gate
pnpm verify                       typecheck && lint && test:unit && test:transitions
pnpm typecheck                    tsc --noEmit across all packages
pnpm lint                         ESLint across all packages
pnpm lint:fix                     ESLint with --fix
pnpm format                       Prettier --write

# Test
pnpm test                         Unit + transition + integration
pnpm test:unit                    Vitest, no I/O, no containers
pnpm test:transitions             Legal and illegal state transitions (§14.5, §14.6)
pnpm test:integration             Testcontainers: real Postgres + Redis, fake providers
pnpm test:security                Authorization, webhook spoofing, replay, PII-leak checks (§26.1)
pnpm test:e2e                     Playwright against the operator console
pnpm test:coverage                Coverage report with thresholds enforced
pnpm test:watch                   Vitest watch mode

# AI and OCR evaluation — scored, not pass/fail assertions
pnpm eval:ai                      Run §19.9 dataset against the configured text model
pnpm eval:ocr                     Run screenshot dataset (Phase 5)
pnpm eval:report                  Per-intent and per-field accuracy tables

# Database authoring
pnpm db:generate                  Generate a migration from Drizzle schema changes
pnpm db:studio                    Drizzle Studio

# Build
pnpm build                        Turborepo build of all apps and packages
```

`pnpm verify` is the command referenced everywhere else in this spec. It must pass before any commit.

---

## 5. Project Structure

```
HelloReview/
├─ SPEC.md                        This file — platform contract + capability map
├─ SPEC-<module-id>.md            One per module, written in build order (§3.2)
├─ docs/
│  ├─ PRD.md                      The source PRD (proposed move — see Open Questions)
│  └─ adr/                        Architecture decision records
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ app.module.ts
│  │  │  └─ modules/<module-id>/  One folder per capability-map module
│  │  └─ test/                    App-level integration tests
│  ├─ worker/
│  │  └─ src/processors/          One processor per queue
│  └─ admin/                      Next.js operator console
│     ├─ app/                     Routes mirroring the §20.1 page list
│     └─ components/
├─ packages/
│  ├─ contracts/                  Zod event envelopes (§18), reason codes, provider ports
│  ├─ db/                         Drizzle schema (§17.2), migrations, seed data
│  ├─ adapters/
│  │  ├─ kakao/  aligo/  website/  storage/  ai/  ocr/
│  │  └─ fakes/                   Default in dev and test — never optional
│  └─ testing/                    Fixtures, builders, transition harness, PII-leak matchers
├─ eval/
│  ├─ datasets/                   §19.9 anonymized or synthetic evaluation data
│  └─ runners/
├─ tests/
│  ├─ transitions/                §14.5 legal, §14.6 illegal
│  ├─ integration/
│  ├─ security/                   §26.1 security tests
│  └─ e2e/
└─ infra/
   ├─ docker-compose.yml
   └─ ...
```

### Module folder layout

Every module under `apps/api/src/modules/` has the same shape:

```
modules/guideline-delivery/
├─ index.ts                          The ONLY public surface — nothing else is importable
├─ guideline-delivery.module.ts      NestJS wiring
├─ guideline-gate.ts                 Pure predicate: no I/O, no clock, no randomness
├─ guideline-gate.spec.ts            Co-located unit tests
├─ guideline-delivery.service.ts     Orchestration and persistence
├─ guideline-delivery.service.spec.ts
├─ guideline-delivery.repository.ts  All SQL for this module
└─ reason-codes.ts                   Exhaustive const object of this module's decision reasons
```

**Module boundaries are enforced, not merely documented.** An ESLint `no-restricted-imports` rule
rejects any import that reaches past a module's `index.ts`. Cross-module imports must appear in that
module's `Depends on` column in §3.1 — a dependency not in the map is a lint failure, not a code review
conversation. This is what keeps the modular monolith from quietly becoming a ball of mud, and it is
what makes the later extraction of a module into its own service tractable (`§10.1`).

---

## 6. Code Style

Prettier and ESLint own formatting and mechanical rules. What follows is the part that carries
meaning — the patterns that encode the PRD's safety requirements into the type system.

### The primary pattern: deterministic gates are pure and return reasons, never booleans

This is the guideline readiness gate — the highest-stakes code path in the product, where the target
is literally zero incidents (`§25`). Every deterministic decision in the codebase follows this shape.

```typescript
// apps/api/src/modules/guideline-delivery/guideline-gate.ts
//
// Pure. Everything it needs arrives in the snapshot, including the clock reading.
// That is what makes the §26.2 edge-case matrix cheap to test exhaustively.

import type { WorkflowSnapshot, SeoulInstant } from '@helloreview/contracts'
import { GUIDELINE_BLOCK, type GuidelineBlockCode } from './reason-codes'

export type GateResult =
  | { ready: true; guidelineVersion: string }
  | { ready: false; blockedBy: GuidelineBlockCode; detail: Record<string, string> }

const blocked = (blockedBy: GuidelineBlockCode, detail: Record<string, string> = {}): GateResult => ({
  ready: false,
  blockedBy,
  detail,
})

export function evaluateGuidelineReadiness(wf: WorkflowSnapshot, now: SeoulInstant): GateResult {
  // §16.9 "All" row — these apply to every campaign type, so they come first.
  if (wf.automation.pause) return blocked(GUIDELINE_BLOCK.AUTOMATION_PAUSED, { scope: wf.automation.pause.scope })
  if (wf.handoff.ownedByHuman) return blocked(GUIDELINE_BLOCK.HUMAN_OWNERSHIP_ACTIVE)
  if (!wf.campaign.isActive(now)) return blocked(GUIDELINE_BLOCK.CAMPAIGN_NOT_ACTIVE)
  if (!isSelected(wf.selection.state)) return blocked(GUIDELINE_BLOCK.NOT_SELECTED, { observed: wf.selection.state })

  const active = wf.campaign.activeGuidelineVersion
  if (!active) return blocked(GUIDELINE_BLOCK.NO_ACTIVE_GUIDELINE_VERSION)
  if (wf.guideline.deliveredVersions.includes(active)) {
    return blocked(GUIDELINE_BLOCK.VERSION_ALREADY_DELIVERED, { version: active }) // FR-GDL-004
  }

  // §16.9 per-type rows. The switch is exhaustive: a new campaign type is a compile error here,
  // not a workflow that silently falls through to ready.
  const typeGate = ((): GateResult => {
    switch (wf.campaign.route) {
      case 'shipping':
        return wf.shipping.state === 'address_valid'
          ? { ready: true, guidelineVersion: active }
          : blocked(GUIDELINE_BLOCK.SHIPPING_ADDRESS_NOT_VALID, { observed: wf.shipping.state })
      case 'payback':
        return wf.consent.state === 'agreed' && wf.consent.termsVersion === wf.campaign.activeTermsVersion
          ? { ready: true, guidelineVersion: active }
          : blocked(GUIDELINE_BLOCK.CONSENT_NOT_CURRENT, { observed: wf.consent.state })
      case 'visit_a':
      case 'visit_b':
        return wf.reservation.currentVersionState === 'valid'
          ? { ready: true, guidelineVersion: active }
          : blocked(GUIDELINE_BLOCK.RESERVATION_NOT_VALID, { observed: wf.reservation.currentVersionState })
      case 'visit_c':
        // FR-VC-002. Approval is checked before reservation so the block reason names the real cause.
        if (wf.businessApproval.state !== 'approved') {
          return blocked(GUIDELINE_BLOCK.BUSINESS_APPROVAL_NOT_CURRENT, { observed: wf.businessApproval.state })
        }
        if (wf.businessApproval.expiresAt && wf.businessApproval.expiresAt <= now) {
          return blocked(GUIDELINE_BLOCK.BUSINESS_APPROVAL_EXPIRED)
        }
        return wf.reservation.currentVersionState === 'valid'
          ? { ready: true, guidelineVersion: active }
          : blocked(GUIDELINE_BLOCK.RESERVATION_NOT_VALID, { observed: wf.reservation.currentVersionState })
    }
  })()

  return typeGate
}
```

### The secondary pattern: writes go through one transition, one outbox, one dedupe key

```typescript
// Every state change and every outbound message in the codebase looks like this.
await this.db.transaction(async (tx) => {
  // Optimistic concurrency (§14.4). A stale expectedVersion throws StaleWorkflowVersionError → HTTP 409.
  const next = await this.workflow.transition(tx, {
    workflowId,
    expectedVersion: wf.version,
    dimension: 'guideline',
    to: 'delivery_queued',
    triggeringEventId: event.id,
    actor: SYSTEM_ACTOR,
    reason: GUIDELINE_BLOCK_NONE,
    correlationId: ctx.correlationId,
  })

  // Transactional outbox (§13.13 FR-MSG-004): state and send intent commit together or not at all.
  // The dedupe key is never hand-concatenated — buildDedupeKey owns the §17.4 format, and the
  // UNIQUE constraint on outbound_notifications.deduplication_key is the actual guarantee.
  await this.messaging.enqueueIntent(tx, {
    workflowId,
    purpose: MESSAGE_PURPOSE.GUIDELINE_DELIVERY,
    dedupeKey: buildDedupeKey({
      channel: 'KAKAO',
      workflowId,
      purpose: MESSAGE_PURPOSE.GUIDELINE_DELIVERY,
      contentVersion: gate.guidelineVersion,
    }),
    templateId: 'GUIDELINE_DELIVERY_KO_V1',
  })
})
```

### Conventions

- **Naming.** Files `kebab-case.ts`. Types and classes `PascalCase`. Functions and variables
  `camelCase`. Reason codes, purpose codes, and intent codes `SCREAMING_SNAKE` inside a `const` object
  with `as const`, exported alongside its derived union type.
- **Reason codes are exhaustive and module-owned.** Every gate, guard, and validator returns one from
  its own `reason-codes.ts`. A decision that cannot name its reason is a bug — participants get a
  specific correction (`FR-RES-011`) and operators get an explanation (`FR-ADM-008`), and both read
  from this code.
- **Purity is the boundary.** Predicates, validators, normalizers, and dedupe-key builders take
  everything as arguments — including the clock — and perform no I/O. Services own I/O and orchestration.
- **Untrusted input is parsed, never cast.** Provider webhooks, participant text, and AI/OCR output all
  cross a Zod `.parse()` at the module edge. `as` on external data is a lint error.
- **Time.** Store `timestamptz`. Compute in UTC. Render to participants in Asia/Seoul. The
  `SeoulInstant` branded type prevents a naive `Date` from reaching a business rule.
- **PII.** No raw phone, address, name, or screenshot content in logs (`§21.4`). Log lines use
  `mask()` and pseudonymous workflow/participant ids. A `tests/security` matcher greps structured log
  output for PII shapes and fails the build.
- **Comments** explain constraints the code cannot show — a PRD requirement id, a legal reason, an
  ordering that looks arbitrary but is not. Never restate the next line.
- **Errors** are typed and map to the `§18.4` status table. `409` specifically means stale workflow
  version or semantic conflict, and callers are expected to re-read and re-evaluate.

---

## 7. Testing Strategy

**Frameworks.** Vitest for unit, transition, and integration. Testcontainers for real PostgreSQL and
Redis in integration. Supertest for HTTP contracts. Playwright for operator-console e2e. A separate
scored evaluation harness for AI and OCR — those are measured, not asserted.

**Where tests live.** Unit tests co-locate with source as `*.spec.ts`. Transition, integration,
security, and e2e suites live under `tests/`. Evaluation datasets live under `eval/`.

### Levels

| Level       | Runs against                                    | Covers                                                                                                             | Command                 |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Unit        | Nothing — pure functions                        | Rule evaluation, normalization, dedupe-key construction, transition guards, date/time parsing (`§26.1`)            | `pnpm test:unit`        |
| Transition  | In-memory workflow store                        | Every `§14.5` legal transition; every `§14.6` illegal transition rejected; stale events; corrections; cancellation | `pnpm test:transitions` |
| Integration | Testcontainers Postgres + Redis, fake providers | Repositories, unique constraints, outbox, inbox idempotency, queue retry and dead-letter                           | `pnpm test:integration` |
| Contract    | Fake providers                                  | `§18` event envelopes in both directions; adapter conformance — real and fake adapters run the identical suite     | `pnpm test:integration` |
| Security    | Full app, fake providers                        | Authorization, cross-participant access, webhook spoofing and replay, file attacks, PII in logs                    | `pnpm test:security`    |
| E2E         | Full stack, fake providers                      | Operator workflows from `§20.1`                                                                                    | `pnpm test:e2e`         |
| Evaluation  | Real or recorded model responses                | Korean intents, entities, consent, dates, prompt injection, OCR field accuracy                                     | `pnpm eval:ai`          |

### Non-negotiable test requirements

These come straight from the PRD's Definition of Done (`§36`) and acceptance criteria (`§34`):

1. **Every illegal transition in `§14.6` has a test that proves it is rejected.** Not "returns an
   error" — the workflow must be unchanged and an audit record must exist.
2. **Every scenario in `§26.2` (46 rows) has a test.** They are enumerated in the module specs, each
   assigned to the module that owns it.
3. **The eight `§26.3` Gherkin acceptance tests are implemented verbatim** as e2e tests, and they gate
   release. AC-01 (Visit C approval gate) and AC-03 (guideline readiness) are the two that must never
   go red.
4. **Idempotency is proven per event type**, not assumed: deliver the same source event id twice,
   assert exactly one state transition and one outbound message.
5. **Every new outbound message purpose gets a duplicate-suppression test.**

### Coverage

| Target                                                                                                                       |         Threshold | Rationale                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------: | --------------------------------------------------------- |
| `rules-engine`, and every `*-gate.ts` / `*-predicate.ts` / `*-validator.ts`                                                  |       100% branch | These are pure and small; the safety guarantees live here |
| Business-flow modules (`selection`, `shipping`, `payback-consent`, `business-approval`, `reservation`, `guideline-delivery`) |          90% line | The `§14` state model                                     |
| All other modules                                                                                                            |          80% line | —                                                         |
| `operator-console`                                                                                                           | No line threshold | Covered by e2e against `§20.1` pages                      |

Coverage is a floor, not the goal. A module at 95% with no test for its illegal transitions fails
review; a module at 82% with the full `§26.2` matrix covered passes.

### Evaluation, not assertion, for AI

AI and OCR accuracy is reported as a scorecard against the `§19.9` dataset and compared to the `§25`
targets (95% critical OCR field accuracy at pilot, 97% mature). It never blocks a unit-test run,
because a model's non-determinism must not make the build flaky. Prompt-injection cases are the
exception: those are hard assertions, because "the model ignored the injected instruction" is a
security property, not a quality metric (`AC-07`).

---

## 8. Boundaries

### Always

- Run `pnpm verify` before every commit; it must pass.
- Route every state change through `workflow-core.transition()` with an explicit `expectedVersion`.
- Route every outbound message through `messaging` with a key from `buildDedupeKey()`.
- Commit state and send-intent in the same transaction (transactional outbox).
- Return a named reason code from every deterministic decision.
- Parse untrusted input — provider payloads, participant text, AI and OCR output — through Zod at the
  module edge.
- Keep provider-specific types inside `packages/adapters`; core modules see only `§18` contracts.
- Give every new provider a fake in `packages/adapters/fakes` and run the shared conformance suite
  against both.
- Add a transition test for each new legal transition _and_ its illegal counterparts.
- Mask PII in every log line and every default dashboard view.
- Write an audit record for every protected-state change and every sensitive-field reveal.
- Store `timestamptz`; render Asia/Seoul.
- Trace new code to a PRD requirement id, or raise that it has no requirement.

### Ask first

- Any change to `packages/db` schema, and any new migration.
- Adding, removing, or upgrading a dependency.
- Widening what AI may do: a new intent code, a new extraction field, a new schema, a new model,
  anything that expands the `§19.1` responsibility boundary.
- Changing a dedupe-key format (`§17.4`) or any readiness predicate (`§16.9`).
- Changing RBAC (`§20.2`), masking rules, or retention periods.
- Enabling any automation flag that ships disabled — auto-selection above all (`FR-SEL-002`).
- Editing an approved Korean participant-facing template (`§32`); they carry legal classification.
- Changing the `§22.1` service objectives or the `§22.2` retry matrix.
- CI configuration, deployment configuration, or anything that touches production secrets.
- Deviating from this spec or the capability map — update the spec first, then the code.

### Never

- Let AI or OCR output write a protected business state. Selection, consent, business approval,
  reservation validity, and guideline release are authorized by deterministic services only (`§2.3`,
  `§19.1`).
- Match an applicant on name alone (`FR-ID-001`).
- Send a Visit C booking instruction while approval is anything other than current and approved
  (`FR-VC-002`). This is a hard gate with a zero-incident target.
- Send a guideline without the readiness predicate returning `ready` (`FR-GDL-001`).
- Call a messaging provider outside the outbox.
- Delete or overwrite business history to simulate a rollback — corrections supersede, they do not
  erase (`§14.7`).
- Log full phone numbers, addresses, screenshot contents, secrets, or authorization headers (`§21.4`).
- Expose another participant's information in any participant-facing message (`FR-ID-007`).
- Commit secrets, real participant data, or real screenshots — fixtures are synthetic, always.
- Remove or skip a failing test to make the build green.
- Use unofficial KakaoTalk automation, scrape Naver Booking, or scrape blog scores from unapproved
  sources (`§6.2`).
- Make legal determinations in code or in spec text. Flag them for counsel.

---

## 9. Success Criteria

The platform is ready for controlled production when all of the following hold. These restate `§34`
in testable form; the parenthetical names the proving test.

**Correctness and safety**

1. Zero premature guideline deliveries across UAT and pilot (`AC-03`, `test:e2e`).
2. Zero Visit C booking instructions sent in any non-approved state (`AC-01`, `test:transitions`).
3. Zero cross-participant data exposures (`test:security`).
4. Every `§14.6` illegal transition is rejected with the workflow unchanged (`test:transitions`).
5. No applicant is bound by name alone (`test:unit`, `§16.1` decision table).
6. AI and OCR output cannot reach a protected state — proven by the absence of any write path, not by
   convention (`test:security`, architecture lint).

**Idempotency and recovery** 7. A duplicate source event id produces exactly one state transition and one outbound message
(`AC-02`, `test:integration`). 8. Duplicate outbound intents are blocked by the database `UNIQUE` constraint, not by application
logic alone (`test:integration`). 9. Event replay repeats no completed side effect (`test:integration`). 10. Out-of-order and stale events are rejected or reconciled, never silently applied (`test:transitions`).

**Business state** 11. Payback consent only satisfies the current terms version (`AC-05`). 12. A repeated guideline request does not resend a delivered version; a new version delivers exactly
once (`AC-08`). 13. Cancellation and rescheduling preserve prior versions as superseded, not deleted (`test:transitions`). 14. Human ownership suppresses automated replies (`AC-06`). 15. Reservation validation names the failed rule and the corrective action (`test:unit`, `§16.7`).

**Operations** 16. The participant timeline shows every item in `§20.3`. 17. Emergency pause works at global, campaign, workflow-type, and participant scope (`test:e2e`). 18. Sensitive fields are masked by default and every reveal is audited (`test:security`). 19. Uploaded files pass every `§21.5` control before reaching OCR (`test:security`). 20. `pnpm verify` is green and coverage thresholds in §7 are met.

**Spec completeness** (for this document specifically) 21. The capability map in §3 is approved by the product owner. 22. Every MVP module has a `SPEC-<module-id>.md` before its implementation begins. 23. Every module spec traces each requirement to a PRD requirement id.

---

## 10. Open Questions

**Blocking the next phase (module specs)**

1. **Capability-map approval.** §3 is the Phase 0 gate. Module specs are not written until the module
   list, dependency direction, and build order in §3.1–§3.2 are approved. The judgement calls in §3.3
   are where I would most expect disagreement.

**Blocking implementation, owned by discovery** (these are `§35` Open Decisions — restated here because
each one changes code, not just plans)

2. **Kakao 상담톡 dealer and capability** — whether stable user and conversation identifiers,
   attachment events, and human-takeover signalling exist at all. `§30` rates this high-probability,
   critical-impact. The fake-adapter approach means development proceeds, but `identity-resolution`
   and `messaging` cannot be _finished_ without it.
3. **Website integration shape** — API, webhook, or approved read replica; and whether source event
   ids and an application verification token can be added. Determines whether `application-sync` is
   event-driven or reconciliation-driven.
4. **Existing Aligo trigger inventory** — `§4.3`. A launch blocker for any outbound automation
   (`FR-MSG-005`). Until this audit lands, `messaging` cannot be enabled in production for any purpose
   an existing trigger already covers.
5. **Hosting region and overseas AI processing policy** — determines provider selection and whether
   `ai-orchestration` can call a non-Korean model at all.
6. **Retention periods** — `privacy-ops` needs concrete numbers per data class (`§21.6`) before its
   deletion jobs can be specified.
7. **Non-selection communication policy per campaign** — `FR-SEL-007` forbids inventing a rejection
   message. `selection` cannot complete its fail path without this.

**Lower-stakes, decidable now if you have a preference**

8. **Move the PRD to `docs/PRD.md`?** The current filename contains spaces and an em-dash, which makes
   it awkward to reference from CI, lint rules, and traceability tooling. I have left it in place
   rather than move a file you may have linked elsewhere.
9. **Operator-console authentication** — SSO or local accounts with MFA (`§20.2` says "SSO/MFA where
   available"). Affects `admin-api` from its first commit.
10. **Whether `analytics` should start earlier than Phase 8.** The `§25` metrics need to be _collected_
    from day one even if nothing renders them; I have assumed `platform-core` emits them and
    `analytics` only adds presentation.

---

## Appendix: Requirement Traceability

Each module spec carries its own traceability table mapping PRD requirement ids to implementation
units and tests. The platform-level mapping in `§31` of the PRD is the index; this spec's §3.1
`Responsibility` column is its module-level counterpart. No requirement may be implemented without
appearing in exactly one module spec, and no module spec may claim a requirement that §3.1 does not
assign it.
