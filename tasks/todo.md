# Task List: Milestone 1 — Core Spine

Plan: [tasks/plan.md](plan.md) · Spec: [SPEC.md](../SPEC.md) · Requirements: PRD v1.0

56 tasks across 8 phases. Every task clears the project Definition of Done in PRD `§36` in addition to
its own acceptance criteria. `pnpm verify` must pass before every commit.

---

## Task Index

### Phase 0 — Foundation

- [x] T1 — Workspace and toolchain scaffold
- [x] T2 — Lint, format, and the `pnpm verify` gate
- [x] T3 — Local services via Docker Compose
- [x] T4 — NestJS `api` app boot and health endpoint
- [x] T5 — `worker` app boot and queue connection
- [x] T6 — Module-boundary lint rule
- [x] T7 — Test harness: Vitest and Testcontainers
- [x] T8 — Config and secrets validation
- [x] T9 — Drizzle setup and initial migration

### Checkpoint A — Foundation

- [x] `pnpm verify` passes on a clean clone — verified by actually cloning HEAD into an empty
      directory with no `.env` and nothing built: install, then 45/45, exit 0
- [x] `pnpm services:up && pnpm db:reset && pnpm dev` brings up api and worker — **not admin**, which
      is Milestone 3 work and does not exist yet. Health answered 200 while `pnpm dev` was running
- [x] The boundary lint rule rejects a deliberately invalid cross-module import — both a deep import
      past a module's index and an undeclared edge, each naming both modules
- [ ] **Review with human before proceeding** ← the gate

### Phase 1 — Observability and audit

- [x] T10 — Correlation ID propagation
- [x] T11 — Structured logger with masking
- [x] T12 — PII-leak test matcher
- [x] T13 — Append-only audit log

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

- [x] `pnpm install` succeeds and resolves `apps/*` and `packages/*` workspaces — 7 projects resolved
- [x] `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`
- [x] `pnpm typecheck` runs across all workspaces and exits 0 — 6/6 successful

**Verification:**

- [x] Build succeeds: `pnpm build` — 6/6 successful
- [x] Typecheck passes: `pnpm typecheck` — 6/6 successful
- [x] Tests pass: `pnpm test:toolchain` — 9/9 passing
- [x] Manual check: directory tree matches SPEC.md §5, except `apps/admin` (deferred to Milestone 3)
- [x] Manual check: strictness flags proven _effective_, not merely present — a probe violating each of
      the five flags was rejected by `tsc` (TS2322, TS2375, TS2366, TS7029), then removed

**Dependencies:** None

**Files touched:** 25. Root config — `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`turbo.json`, `tsconfig.base.json`, `.gitignore`, `.gitattributes`. Six workspace placeholders
(`apps/api`, `apps/worker`, `packages/contracts`, `packages/db`, `packages/adapters`,
`packages/testing`) × `package.json` + `tsconfig.json` + `src/index.ts`. Plus
`tests/toolchain/workspace-contract.test.mjs`.

> **Estimate correction.** The original list named 5 files. A monorepo scaffold cannot satisfy
> criterion 1 without real workspaces to resolve, and each needs a manifest, a tsconfig, and a source
> entry. Still one unit of work — 18 of the 25 files are three-line generated placeholders — but the
> file count in the original estimate was wrong.

**Estimated scope:** S (25 files, but 18 are generated boilerplate)

---

## T2 — Lint, format, and the `pnpm verify` gate

**Description:** Configure ESLint and Prettier, and wire the `pnpm verify` composite script that
SPEC.md §8 requires before every commit. `verify` runs typecheck, lint, unit tests, and transition
tests; the last two announce themselves as pending until T7 (see the correction below).

**Acceptance criteria:**

- [x] `pnpm lint` and `pnpm format` run across all workspaces — one root ESLint invocation, so
      `tests/`, `tools/` and root config files (which belong to no workspace) are covered too
- [x] ESLint rejects `as` casts applied to values typed `unknown` from external sources —
      proven behaviourally, not by config inspection: a real fixture is linted and must be rejected
      by `@typescript-eslint/no-unsafe-type-assertion`
- [x] `pnpm verify` chains typecheck → lint → test:unit → test:transitions and fails on any non-zero exit

**Verification:**

- [x] `pnpm verify` exits 0 on the clean scaffold
- [x] `pnpm test:toolchain` — 19/19 passing
- [x] Manual check: a deliberate `as`-cast violation makes `pnpm verify` exit 1, name the rule, and
      short-circuit _before_ the test tiers run
- [x] Manual check: `tools/pending-tier.mjs` expires correctly — exit 1 once a vitest config exists,
      exit 0 with a visible notice before that, exit 2 on an unknown tier name

**Dependencies:** T1

**Files touched:** `eslint.config.js`, `.prettierrc`, `.prettierignore`, `tsconfig.json` (new root
config), `tools/pending-tier.mjs`, `package.json`, `pnpm-lock.yaml`,
`tests/toolchain/lint-contract.test.mjs`

> **Two corrections to this task as written.**
>
> 1. _"the last two are no-ops until T7"_ was wrong to accept. A tier that exits 0 without running
>    anything makes the gate report success for work nobody has done. `tools/pending-tier.mjs`
>    instead prints a notice saying the gate is green because the tier is empty, and **fails** once
>    it detects Vitest in the tree — so the placeholder cannot outlive T7.
> 2. The file list omitted `.prettierignore` (without it `pnpm format` rewrites `pnpm-lock.yaml`)
>    and a root `tsconfig.json`. The latter is not optional: under `projectService`, a `.ts` file no
>    tsconfig includes is a hard parsing error rather than a skipped file, so `tests/` and `tools/`
>    need coverage before T7 and T9 add TypeScript there.

**Estimated scope:** S

---

## T3 — Local services via Docker Compose

**Description:** Compose file for PostgreSQL 16, Redis 7, and MinIO with pinned versions, named
volumes, and health checks. These back local development and Testcontainers-free local runs.

**Acceptance criteria:**

- [x] `pnpm services:up` starts all three and reports healthy; `pnpm services:down` removes them —
      `--wait` makes health an exit code rather than a claim
- [x] MinIO starts with a private bucket and no anonymous read policy (`§21.3`) — the init container
      sets the policy, reads it back, and independently confirms an unauthenticated request returns
      403, failing `services:up` if either check does not hold
- [x] Credentials come from `.env.example`, with no secret committed — `.env` is gitignored and every
      committed value is an obvious local-only placeholder

**Verification:**

- [x] Manual check: `pnpm services:up` → all three healthy, `[init] MINIO_INIT_OK`, exit 0
- [x] Manual check: Postgres reachable, `UTF8 | C.UTF-8` as configured; Redis returns `PONG` with
      `maxmemory-policy noeviction` (BullMQ requires it)
- [x] Manual check: bucket policy is `private` and anonymous list returns HTTP 403
- [x] Manual check: `pnpm services:down` leaves no running container but preserves the three named
      volumes; a row written before `down` is still there after the next `up`
- [x] Manual check: re-running `services:up` is idempotent — the bucket and service account are both
      reported as already present, exit 0
- [x] Manual check: the developer's unrelated `db-scraper`, `supabase` and `thepopebot` stacks keep
      running untouched throughout
- [x] `pnpm verify` exits 0; 36/36 toolchain tests; `pnpm format:check` clean

**Dependencies:** T1

**Files touched:** `infra/docker-compose.yml`, `infra/scripts/preflight.mjs`, `.env.example`,
`package.json`, `tests/toolchain/local-services-contract.test.mjs`

> **Three corrections to this task as written.**
>
> 1. **Host ports cannot use the defaults.** This machine already runs another project's stack
>    (`D:\VIBE CODING\DB-Scraper`) on 5432/6379/9000/9001. Two containers cannot bind one host port,
>    so `services:up` would have failed on first run. The stack uses 15432/16379/19000/19001,
>    parameterized through `.env`; container-internal ports stay standard, so nothing inside the
>    compose network changes and both stacks run side by side. A contract test now fails if a
>    default is reinstated.
> 2. **A preflight script was needed and was not in the file list.** Compose resolves `.env` next to
>    the compose file, so without `--project-directory .` every credential silently falls back to
>    empty. The preflight also creates `.env` on a fresh clone, checks `DATABASE_URL`/`REDIS_URL`
>    agree with the `POSTGRES_*`/`REDIS_*` parts they duplicate (disagreement yields a healthy stack
>    the app cannot connect to), and names the container holding a conflicting port.
> 3. **`services:reset` was added.** `services:down` deliberately preserves volumes — losing data
>    should never be a side effect of stopping a stack — so deliberate destruction needs its own
>    command. A contract test asserts `down` carries no `-v` and `reset` does.

**Estimated scope:** S

---

## T4 — NestJS `api` app boot and health endpoint

**Description:** Minimal NestJS application with an empty `modules/` directory and a health endpoint
reporting database and queue reachability.

**Acceptance criteria:**

- [x] `pnpm dev:api` serves on port ~~3000~~ **13000** — see correction 1
- [x] `GET /health` returns 200 with per-dependency status, and 503 when a dependency is unreachable
- [x] The health endpoint requires no authentication and exposes no version or environment detail

**Verification:**

- [x] Tests pass: `pnpm verify` — 46/46, exit 0
- [x] Healthy response, confirmed by hand:
      `{"status":"ok","dependencies":{"postgres":{"status":"up","latencyMs":5},"redis":{"status":"up","latencyMs":3}}}`
- [x] 503 path proven by booting against a dead Postgres port rather than stopping the container —
      Postgres reports `down`, Redis still reports `up`, so the response distinguishes the failed
      dependency instead of failing wholesale. Nothing on the machine is disturbed by the test.
- [x] Leak test: the response contains no connection string, password, hostname, version, environment
      or uptime
- [x] Graceful shutdown proven via `app.close()` — the hook logs `closing dependencies` and both
      connections close. See correction 4 for why signals could not be used.
- [x] NestJS 11 verified working under ESM + NodeNext with every strictness flag including
      `exactOptionalPropertyTypes`; DI resolves at runtime

**Dependencies:** T1, T3

**Files touched:** `apps/api/{package.json,tsconfig.json}`, `apps/api/src/{main.ts,app.module.ts}`,
`apps/api/src/modules/platform-core/` (`index.ts`, `platform-core.module.ts`, `tokens.ts`,
`config/{env-source.ts,load-app-config.ts}`, `health/{health.controller.ts,health.service.ts,dependency-probes.ts,reason-codes.ts}`),
`tools/dev-runner.mjs`, `eslint.config.js`, `.env.example`, `package.json`,
`tests/toolchain/api-contract.test.mjs`

> **Five corrections to this task as written.**
>
> 1. **Port 3000 → 13000, a deliberate SPEC.md §4 deviation.** Port 3000 is held on this machine by an
>    unrelated Next.js dev server, and two processes cannot bind one host port. Parameterized through
>    `.env` as `API_PORT`, same treatment as the T3 service ports; set it to 3000 where that port is
>    free. **SPEC.md §4 should be updated or this backed out — it is an "Ask first" item under §8.**
> 2. **Health lives in `modules/platform-core/health/`, not `src/health/`.** SPEC.md §3.1 assigns
>    health to `platform-core`, and §5 requires modules to live under `src/modules/<module-id>/` with
>    `index.ts` as the only public surface. The original file list contradicted the spec.
> 3. **A config module was required and was not in the file list.** T4 cannot health-check Postgres
>    and Redis without `DATABASE_URL`/`REDIS_URL`, but `eslint.config.js` bans `process.env` outside
>    the loader — and T8, which owns the loader, is listed as depending on T4. Resolved by keeping the
>    impure read to a single line in `config/env-source.ts` (one narrowly-scoped lint exemption) with
>    `loadAppConfig()` a pure function of its input. **T8 is left with: a Zod schema over the full
>    environment surface, marking secret keys for redaction, and consolidating this loader with the
>    worker's.** T8's dependency should read T1, not T4.
> 4. **SIGTERM shutdown is unverifiable on Windows.** Measured: `child.kill(sig)` on win32 maps to
>    `TerminateProcess` for SIGTERM, SIGINT, SIGBREAK and SIGHUP alike, so no programmatically sent
>    signal reaches a handler — the hook was skipped and the process died in 11ms. The shutdown _logic_
>    is proven correct via `app.close()`; only the signal→handler delivery is untestable here. It works
>    normally on the Linux hosts this deploys to. **The same limitation applies to T5's "SIGTERM drains
>    in-flight jobs" criterion.**
> 5. **tsx cannot run this app, and fails silently.** Measured: under tsx the API boots, maps its
>    routes, and then returns HTTP 500 on every DI-dependent request, because esbuild does not emit
>    `emitDecoratorMetadata`. Node's native type stripping fails outright. `tsc` is the only runner in
>    this toolchain that emits correct metadata, which is why `tools/dev-runner.mjs` pairs
>    `tsc --watch` with `node --watch` instead of using a single fast transpiler.

**Estimated scope:** S → **M** (16 files; the config module and dev runner were not anticipated)

---

## T5 — `worker` app boot and queue connection

**Description:** Standalone BullMQ worker process connecting to Redis, with graceful shutdown that
drains in-flight jobs. No processors yet.

**Acceptance criteria:**

- [x] `pnpm dev:worker` connects to Redis and logs a ready state — verified by hand:
      `[worker] connected to redis` then `[worker] ready — 0 processors registered`
- [x] SIGTERM drains in-flight jobs before exit rather than dropping them — see correction 2 for how
      this was proven without a deliverable signal
- [x] Queue names are defined in one shared constant, not string literals at call sites

**Verification:**

- [x] Tests pass: `pnpm verify` — 54/54, exit 0
- [x] The drain test **bites**: swapping `worker.close()` for `close(true)` makes it fail in 472ms
      with "stop() returned before the in-flight job completed — jobs are being dropped". A test that
      passes either way would prove nothing
- [x] Boot path covered separately from the runtime — a regression test exists because the first
      `verifyRedis` failed against a _healthy_ Redis and every runtime test still passed
- [x] Refusing to start against an unreachable Redis is asserted, not just hoped for
- [x] The test process exits on its own, which is how the connection-ownership bug in correction 4
      was found

**Dependencies:** T1, T3

**Files touched:** `packages/contracts/src/{queues.ts,index.ts}`, `apps/worker/{package.json}`,
`apps/worker/src/{main.ts,runtime.ts}`, `apps/worker/src/config/{env-source.ts,load-worker-config.ts}`,
`apps/worker/src/processors/index.ts`, `eslint.config.js`, `pnpm-workspace.yaml`, `package.json`,
`tests/toolchain/worker-contract.test.mjs`

> **Four corrections to this task as written.**
>
> 1. **The queue registry is in `packages/contracts`, not `apps/worker/src/queues.ts`.** The worker is
>    only the consumer; the api is the PRODUCER — T43's outbox enqueues inside the same transaction as
>    the state change — and `apps/api` cannot import from `apps/worker`. A name known to only one side
>    of a queue is not a contract. The `queueNames` lint message was updated to match.
> 2. **SIGTERM cannot be delivered on Windows, so the criterion was proven a different way.** Measured
>    in T4: `child.kill(sig)` on win32 maps to `TerminateProcess` for every signal. The test therefore
>    calls the same `stop()` the signal handler calls, with a job genuinely in flight, and asserts it
>    ran to completion. `worker.close()` (no argument) waits for in-flight jobs; `close(true)` abandons
>    them — that distinction _is_ the criterion, so it is deliberately not parameterized. What stays
>    unverified here is signal→handler delivery, which is Node's concern and works on POSIX.
> 3. **A worker config module was needed and was not in the file list**, for the same reason as T4.
>    It duplicates the api's twelve lines: `apps/worker` cannot import from `apps/api`, and inventing a
>    shared package the SPEC.md §3.1 capability map does not describe would be worse than the
>    duplication. **T8 consolidates both.** The lint exemption is keyed on the filename
>    `**/config/env-source.ts`, so it already covers both without widening to a folder.
> 4. **A connection-ownership bug was found and fixed during verification.** Passing ioredis
>    _instances_ to BullMQ leaks a socket on every `close()`, because BullMQ only closes connections it
>    created itself — the test suite hung rather than exiting. Fixed by passing connection _options_
>    so BullMQ owns the lifecycle. `--test-force-exit` would have hidden this; the hang was the signal.

> **Also decided here:** `msgpackr-extract` (an optional native accelerator for BullMQ's job
> serialization) is recorded in `pnpm-workspace.yaml` as a deliberately un-approved build. msgpackr
> falls back to pure JavaScript, so the only cost is throughput, and no developer needs a native
> toolchain to install this repo. pnpm 10 exits 0 on a blocked build script, so an unrecorded decision
> is indistinguishable from nobody noticing.

**Estimated scope:** S → **M** (11 files; the config module and shared registry were not anticipated)

---

## T6 — Module-boundary lint rule

**Description:** Encode the SPEC.md §3.1 dependency table as an ESLint rule. An import that reaches
past a module's `index.ts`, or that crosses to a module not listed in the importer's `Depends on`
column, fails lint. Built before the modules exist so the rule is never retroactive.

**Acceptance criteria:**

- [x] Deep imports into another module's internals fail lint
- [x] A cross-module import absent from the §3.1 dependency table fails lint with a message naming both modules
- [x] The dependency table lives in one machine-readable file that the rule reads, not duplicated in config —
      a test asserts the rule does not inline it

**Verification:**

- [x] Tests pass: `pnpm verify` — 58/58, exit 0. The rule has 4 fixture tests via ESLint's `RuleTester`
- [x] Manual check: a deep import into `platform-core/config/` is rejected with
      _"Reaching past the public surface of platform-core"_
- [x] Manual check: `platform-core` importing `rules-engine` is rejected with
      _"Module platform-core may not import rules-engine. That edge is not in module-graph.json"_ —
      both modules named, as the criterion requires
- [x] Manual check: introducing a cycle (`platform-core -> audit-log -> platform-core`) makes the rule
      refuse to load, naming the cycle path

**Dependencies:** T2

**Files touched:** `module-graph.json`, `tools/eslint-rules/module-boundaries.js`, `eslint.config.js`,
`tests/toolchain/module-boundaries.test.mjs`

> **Two notes.**
>
> 1. **The rule also proves the graph is acyclic**, which nothing else in the toolchain did. SPEC.md
>    §3.1 asserts it; now `pnpm lint` enforces it. The check runs at rule load and throws, because a
>    cyclic map is a configuration error — reporting it against some arbitrary import would point at
>    the wrong thing entirely.
> 2. **`no-restricted-imports` genuinely could not do this job.** It matches the import specifier
>    STRING via minimatch, not the resolved path, so a relative deep import like
>    `'../campaign-config/internal/rule-table.js'` slips past any `**/modules/*/!(index)*` pattern.
>    Resolving first is also what lets the message name both modules. Dynamic `import()` and
>    `export ... from` are covered too — either would otherwise be a silent way around the rule.
>
> **Process note:** the rule was written before its fixture tests, so this task did not follow
> RED-then-GREEN. The tests passed on first run, which is weaker evidence than a test seen to fail.
> The two manual violation checks above are what actually establish the rule bites.

**Estimated scope:** M

---

## T7 — Test harness: Vitest and Testcontainers

**Description:** Vitest projects for the unit, transition, integration, security, and e2e tiers from
SPEC.md §7, with a Testcontainers helper that provisions PostgreSQL and Redis per integration run and
a `packages/testing` home for fixtures and builders.

**Acceptance criteria:**

- [x] Each tier runs independently via its own script and together via `pnpm test` — five Vitest
      projects: unit, transitions, integration, security, e2e
- [x] The integration tier provisions and tears down containers without touching local dev services —
      asserted, not assumed: the harness test checks the ephemeral port differs from the dev port,
      that no container leaks, and that all three dev services are still healthy afterwards
- [x] Coverage thresholds from SPEC.md §7 are configured and enforced by `pnpm test:coverage` —
      with one documented deviation on the global number, see correction 3

**Verification:**

- [x] `pnpm test` — 72 tests across the populated tiers; `pnpm verify` — 42, exit 0
- [x] Testcontainers verified working on Windows/Docker Desktop: a real Postgres started in ~15s and
      Ryuk reaped it in ~5s
- [x] Empty tiers (transitions, security, e2e) pass rather than failing the run

**Dependencies:** T1, T3

**Files touched:** `vitest.config.ts`, `packages/testing/{package.json,src/containers.ts,src/index.ts}`,
`package.json`, `pnpm-workspace.yaml`, `eslint.config.js`, `tests/` (six files moved into tiers),
`tests/unit/config-loaders.test.ts`, `tests/integration/testcontainers.test.mjs`,
`apps/api/src/modules/platform-core/config/load-app-config.ts`,
`apps/worker/src/config/load-worker-config.ts`, and `tools/pending-tier.mjs` (deleted)

> **Three corrections, and a bug the new tier found.**
>
> 1. **Tests moved into tier directories.** They were all in `tests/toolchain/`. Assignment is by what
>    a file actually does: reads files only → unit; spawns a process or touches the stack →
>    integration. `vitest.workspace.ts` does not exist in Vitest 4 — tiers are `projects` inside
>    `vitest.config.ts`.
> 2. **Per-tier timeouts were needed.** Vitest defaults to 5s, which is right for a pure function and
>    wrong for compiling a workspace or starting a container. The slow tiers get 180s; the unit tier
>    keeps the tight default so a genuinely hung unit test still fails fast.
> 3. ~~**The global coverage threshold is 30%, not SPEC.md §7's 80% — a documented deviation needing a
>    decision.**~~ **RESOLVED in the Phase 0/1 audit — it is SPEC.md §7's 80%, and the suite passes at
>    82% lines / 84% statements with no new tests.** The deviation was a measurement artifact, twice
>    over: `excludeAfterRemap` defaults to `false`, so every coverage exclusion was inert (the globs
>    are written against `.ts` paths and were being matched against emitted `.js`); and `dist` held 28
>    orphaned modules from the T8 refactor plus 88 leaked lint fixtures, all counted as real uncovered
>    code. Fixing both moved lines from 57% to 82%. The per-glob 100%-branch entries for gates,
>    predicates, validators and the rules engine are unchanged and will bite the moment those files
>    exist.
>
> **Two findings from a parallel recon agent, both acted on.** First, excluding `dist/` from coverage
> silently discarded real measurements: v8 _does_ remap through the tsc source maps back to
> `src/*.ts`, so the exclusion zeroed out every test that imports compiled output. Fixing it moved
> coverage from 32.6% to 42.3% with no new tests written. Second, `testcontainers` requires Node
> 22.22 or newer while the root `engines` field allowed `^22.13.0`, so a developer on 22.13–22.21
> satisfied the repo but not the dependency; `engines` has been narrowed.
>
> **Considered and not adopted:** `unplugin-swc` with explicit `jsc` options is a verified alternative
> that would let Nest-DI tests import `.ts` sources directly. Deferred because the compiled-output
> approach already works and needs no extra dependency (SPEC.md §8 puts that under Ask first). Worth
> revisiting if a later task needs Nest's `TestingModule` over sources — but note the failure mode is
> **silent**: `compile()` succeeds and the injected field is simply `undefined`, so a test asserting
> only that the module compiles would pass while proving nothing.
>
> **A real bug surfaced:** the first in-process unit tests found that both config loaders accepted
> `nonsense://`. `new URL()` parses a non-special scheme with an empty host, so a bare try/catch
> accepted values that could never connect. Both loaders now check scheme and host. This is exactly
> the class of defect the unit tier exists to catch, found within minutes of it existing.

> **Carried forward from T2 — three obligations this task inherits.**
>
> 1. **Extend type-aware linting to `tests/`.** T2 scopes it to `apps/*/src` and `packages/*/src`,
>    because under `projectService` a `.ts` file no tsconfig includes is a hard parsing error. That
>    means `no-floating-promises` and the whole `no-unsafe-*` family are currently silent in
>    `tests/` — and a dropped `await` on container startup is the textbook Testcontainers bug. Add a
>    tsconfig covering `tests/` and one glob to `TYPE_AWARE` in `eslint.config.js`; both are additive.
> 2. **Retire the pending-tier placeholder.** `tools/pending-tier.mjs` fails the build as soon as it
>    detects Vitest in any workspace manifest or a root config. Point `test:unit` and
>    `test:transitions` at the real tiers and delete both entries — the guard is designed to make
>    forgetting impossible, so this is not optional.
> 3. **Move the toolchain tests into the unit tier.** `tests/toolchain/*.test.mjs` runs on `node:test`
>    only because Vitest did not exist. Convention worth keeping when they move: a toolchain test
>    must not write outside a per-file temp path, or the fixture races return.

**Estimated scope:** M

---

## T8 — Config and secrets validation

**Description:** A Zod-validated environment schema loaded once at boot. Missing or malformed
configuration fails fast at startup rather than surfacing as a runtime error, and no secret is ever
logged.

**Acceptance criteria:**

- [x] Invalid or missing required config aborts startup with a message naming every offending key
- [x] Config is injectable as a typed object; `process.env` access outside the loader fails lint
- [x] Secret-valued keys are marked in the schema and redacted from any diagnostic output

**Verification:**

- [x] Tests pass: `pnpm verify` — 45 unit tests, exit 0
- [x] Manual check: with all three variables unset, the api aborts and prints all three at once —
      `DATABASE_URL is not set. Copy .env.example to .env`, and the same for `REDIS_URL` and `API_PORT`
- [x] Manual check: no message ever contains a value. Zod's defaults quote the input, which for
      `DATABASE_URL` would print a password into the startup log of a process that has not started;
      problems are assembled from the key and the rule only
- [x] Manual check: both deployables boot on the shared loader — worker reports ready, api answers
      `/health` with 200

**Dependencies:** ~~T4~~ **T1**. T4 could not wait for T8: the health endpoint needs `DATABASE_URL`
and `REDIS_URL`, so T4 and T5 each carried a minimal loader. The stated direction was backwards.

**Files touched:** `packages/config/` (new: `package.json`, `tsconfig.json`, `src/env-source.ts`,
`src/schema.ts`, `src/load.ts`, `src/index.ts`), `apps/api/package.json`,
`apps/api/src/modules/platform-core/{platform-core.module.ts,index.ts}`, `apps/api/src/main.ts`,
`apps/worker/{package.json,src/main.ts}`, `eslint.config.js`, `tests/unit/config-loaders.test.ts`,
and the two per-app config folders (deleted)

> **Three decisions worth recording.**
>
> 1. **Shared config lives in `packages/config`, a new package — and that is a gap in SPEC.md §5, not
>    a whim.** §3.1 assigns configuration to `platform-core`; §5 says modules live under
>    `apps/api/src/modules/`. Neither says where a module needed by TWO deployables belongs, and
>    `apps/worker` cannot import from `apps/api`. T4 and T5 each carried a copy as a stopgap; this
>    package removes the duplication. **§5 should gain a sentence about shared modules.**
> 2. **The worker schema is `.pick()`ed from the api's, not written twice.** A copy would let the
>    `REDIS_URL` rule drift between deployables. The worker never reads `API_PORT`, and a worker that
>    refuses to start over a value it does not use is a confusing failure for whoever is on call.
> 3. **Secrets are an explicit `SECRET_KEYS` set, not schema metadata.** This list is a security
>    control and should be readable at a glance by someone auditing what the platform can leak, rather
>    than reconstructed by walking a schema. Redaction replaces the value wholesale — a truncated
>    prefix still leaks scheme, host and usually username, and "only the first few characters" is how
>    credentials reach a log aggregator.

**Estimated scope:** S → **M** (a new package, and both deployables rewired)

---

## T9 — Drizzle setup and initial migration

**Description:** Drizzle ORM with drizzle-kit migrations in `packages/db`, plus the `db:generate`,
`db:migrate`, `db:seed`, and `db:reset` scripts. The initial migration creates shared enums and
extensions only; entity tables arrive with their owning modules.

**Acceptance criteria:**

- [x] `pnpm db:reset` drops, recreates, migrates, and seeds without manual steps
- [x] Migrations are checked in as SQL and reviewable — no runtime schema push, and a test asserts no
      `db:push` script exists anywhere
- [x] The integration test harness runs migrations against its container automatically —
      `withPostgres()` plus `applyMigrations(url)`, with no path knowledge in `packages/testing`

**Verification:**

- [x] `pnpm test:integration` — migrations apply to an empty container, twice, and the extensions,
      enums and enum VALUES are all asserted
- [x] Manual check: `pnpm db:reset` twice in a row succeeds and is idempotent
- [x] Manual check: **dropping the `drizzle` schema proved load-bearing.** Dropping only `public`
      leaves the ledger, and the next migrate reports `migrations applied` against a database with
      **zero enums** — a silent empty database. The full reset repairs it
- [x] Manual check: `tstz()` emits `timestamp with time zone`, and the lint rule rejects a raw
      `timestamp` import while accepting `tstz`
- [x] Manual check: the `db:generate` guard exits 1 on a missing name and on a broken schema file
      (where drizzle-kit itself exits 0), and exits 0 on a legitimate "no schema changes"

**Dependencies:** T3, T7, T8

**Files touched:** `packages/db/{package.json,drizzle.config.ts}`,
`packages/db/src/{index.ts,columns.ts,migrate.ts,schema/index.ts,schema/enums.ts}`,
`packages/db/migrations/0000_init.sql` (+ `meta/`), `tools/{db-generate.mjs,db-migrate.mjs,db-reset.mjs,db-seed.mjs}`,
`eslint.config.js`, `pnpm-workspace.yaml`, `package.json`, `tests/integration/migrations.test.mjs`

> **Four things worth knowing before touching this again.**
>
> 1. **`drizzle-kit generate` exits 0 when it fails.** A schema file that will not compile, and an
>    ambiguous rename needing a TTY prompt it cannot show, both end with a zero exit and no migration
>    written — so an unguarded script can never fail a build, and the missing migration surfaces later
>    against a database that does not match. `tools/db-generate.mjs` asserts on the output and on
>    whether a file actually appeared. Verified: a deliberately broken schema now exits 1.
>    `drizzle-kit check` **does** exit non-zero on a real journal collision, which is why it is the one
>    worth running in CI.
> 2. **`db:reset` must drop the `drizzle` schema, not only `public`.** Drizzle keeps its applied-
>    migration ledger in its own schema. Drop only `public` and the ledger survives, so the next
>    migrate treats every migration as already applied and reports success against an empty database.
>    Demonstrated above: `migrations applied`, zero enums.
> 3. **There is no `db:push` script and there should not be.** Push diffs a schema straight into a
>    live database with no artifact anyone reviews, and SPEC.md §8 puts schema changes under Ask
>    first. A test asserts the script does not exist rather than trusting that nobody adds it.
> 4. **`0000_init.sql` is frozen.** Drizzle records that a migration ran but never re-checks its
>    contents, so editing an applied migration leaves every database that already ran it silently
>    different from what the file says. The `CREATE EXTENSION` lines were hand-prepended, which is safe
>    only because the diff source is `meta/0000_snapshot.json` rather than the SQL.
>
> **Also:** the deferred `no-restricted-imports` block T2 left commented is now active — a raw
> `timestamp` import from `drizzle-orm/pg-core` is rejected in schema files, because Drizzle's default
> is `WITHOUT time zone` and SPEC.md §8 requires timestamptz. Verified that `tstz()` emits
> `timestamp with time zone`. It cannot catch a namespace import (`import * as pg`), which stays a
> review matter.

**Estimated scope:** M

---

# Phase 1 — Observability and audit

## T10 — Correlation ID propagation

**Description:** Every inbound request and every queued job carries a correlation id, generated at the
edge if absent and propagated through HTTP handlers, service calls, and job payloads so one participant
interaction is traceable end to end (`§18.3`, `§23.1`).

**Acceptance criteria:**

- [x] An inbound request without a correlation id gets one; one with a valid id reuses it
- [x] Enqueued jobs inherit the enqueuing context's correlation id and restore it in the worker
- [x] The id is retrievable from async context without threading it through every signature

**Verification:**

- [x] Tests pass — unit covers the async context (nesting, await boundaries, scope leakage);
      integration covers the two boundaries that matter: the HTTP header and the enqueue hop
- [x] An inbound id is ADOPTED only if valid. It arrives from outside, so a newline in it would let a
      caller forge a second JSON log line inside the first; `adoptCorrelationId` mints a fresh id
      rather than sanitizing, because a forged trace is worse than a discontinuous one
- [x] `enqueueJob()` stamps the id and the worker restores it — asserted end to end through Redis

**Dependencies:** T4, T5

**Files likely touched:** `apps/api/src/modules/platform-core/correlation/*`, `apps/worker/src/context.ts`

**Estimated scope:** S

---

## T11 — Structured logger with masking

**Description:** JSON logger emitting the required `§23.1` fields, with a `mask()` helper for personal
data. Phone numbers, names, addresses, and channel identifiers are masked at the call site; the logger
never receives raw values.

**Acceptance criteria:**

- [x] Every log line carries timestamp, environment, module, correlation id, operation, and result
- [x] `mask()` handles Korean and international phone formats, names, and addresses, preserving enough
      for debugging — masks are STABLE (one participant stays one identity across lines) and
      DISTINGUISHING (two participants never collapse into one)
- [x] Passing an object containing a known-sensitive key name to the logger fails lint — the
      `piiLogger` selector landed in T2 and is still active

**Verification:**

- [x] Tests pass: 28 unit tests over masking, correlation and the logger
- [x] Manual check: a real emitted line, with the name masked to the §20.4 convention —
      `{"timestamp":"…","level":"info","environment":"test","module":"security-probe","correlationId":"cor_security_probe","message":"matched an applicant","operation":"identity.match","result":"strong_match","actorId":"홍**"}`

**Dependencies:** T10

**Files likely touched:** `apps/api/src/modules/platform-core/logging/*`, `packages/contracts/src/mask.ts`

**Estimated scope:** S

---

## T12 — PII-leak test matcher

**Description:** A Vitest matcher that captures log output during a test and fails if it contains
anything shaped like a phone number, address fragment, resident identifier, or authorization header.
Wired into `test:security` so `§21.4` is enforced by the build, not by review.

**Acceptance criteria:**

- [x] The matcher detects Korean local and international phone shapes, resident registration numbers,
      address fragments, and `Authorization` values
- [x] Any test tier can opt in via `expect(...).toContainNoPii()`; `test:security` additionally
      captures ALL output automatically, so a leak is caught in a test whose author never thought
      about PII
- [x] The matcher has its own fixture tests covering both detection and non-detection

**Verification:**

- [x] Tests pass: `pnpm test:security`, plus 24 unit fixtures
- [x] Manual check: a deliberate `logger.warn('applicant 010-1234-5678 called')` in a security test —
      which asserted nothing about PII — failed with
      `personal data reached the output of this test (SPEC.md §21.4): korean-phone: 010********78`
- [x] The failure message does not repeat the leak; the excerpt is itself redacted

**Dependencies:** T7, T11

**Files likely touched:** `packages/testing/src/matchers/no-pii.ts`, `vitest.workspace.ts`

**Estimated scope:** S

---

## T13 — Append-only audit log

**Description:** The `audit_logs` table and write API from `§17.2`, with database-level append-only
enforcement. A failed audit write for a protected action raises a critical alert rather than being
swallowed (`§23.3`).

**Acceptance criteria:**

- [x] `UPDATE` and `DELETE` on `audit_logs` are rejected at the database level — **and `TRUNCATE`,
      which does not fire DELETE triggers and would otherwise empty the table in one statement**
- [x] Every record carries actor, action, target, result, timestamp, reason and correlation id, with
      PII masked before it arrives. The correlation id is taken from the ambient scope, not passed in
- [x] A failed write for a protected action emits a critical alert and surfaces the failure to the
      caller — an unprotected one still throws, but at `error` rather than `fatal`

**Verification:**

- [x] Tests pass: 4 integration tests against an EPHEMERAL database, so the triggers are exercised
      from a real migration rather than from whatever state the dev database is in
- [x] Manual check in psql: `UPDATE`, `DELETE` and `TRUNCATE` each rejected with
      `audit_logs is append-only: … is not permitted`, and the row survived all three

**Dependencies:** T9, T11

**Files touched (Phase 1 as a whole):** `packages/observability/` (new: correlation, logger, mask),
`packages/testing/src/matchers/{no-pii,register,security-setup}.ts`,
`apps/api/src/modules/platform-core/correlation/correlation.middleware.ts`,
`apps/api/src/modules/audit-log/`, `packages/db/src/schema/audit-logs.ts`,
`packages/db/migrations/0001_audit_logs.sql`, `packages/config/src/schema.ts` (NODE_ENV),
`apps/worker/src/{main.ts,runtime.ts}`, `vitest.config.ts`, `.env.example`, and four test files

> **Decisions worth recording for Phase 1.**
>
> 1. **`packages/observability` is a THIRD shared package**, after `config` and `contracts`. SPEC.md
>    §3.1 assigns correlation and structured logging to `platform-core`; §5 says modules live under
>    `apps/api/src/modules/`, and `apps/worker` cannot import from there. This is now the third time
>    that gap has forced a package — **§5 needs a sentence about shared modules, and the capability
>    map arguably needs to say which parts of `platform-core` are shared rather than api-local.**
> 2. **The logger is hand-written rather than pino or winston.** Two specific reasons, not taste:
>    §21.4 masks by VALUE SHAPE (Korean phone numbers, address fragments) while those libraries redact
>    by object PATH, so it would need wrapping regardless; and the api runs under NestJS while the
>    worker is a plain process, so one small implementation both import beats reconciling two
>    integrations. Revisit if sampling or transports are ever needed.
> 3. **The logger deliberately does NOT mask for you.** Masking happens at the call site so a reviewer
>    can see which field is personal data, and the `piiLogger` lint rule can see it too. A logger that
>    quietly masked would hide the mistake rather than surface it.
> 4. **`protected_action` is stored, not derived.** A later change to the protected list must not
>    retroactively reclassify what was already written — the row says what the rule was at the time.
> 5. **A trigger that RAISES, not a RULE that discards.** `DO INSTEAD NOTHING` would make an UPDATE
>    silently succeed while changing nothing: history preserved, but the caller believing it was
>    rewritten. Raising tells the truth. The triggers are statement-level, so an UPDATE matching zero
>    rows is rejected too — the intent was still wrong.

**Estimated scope:** M

---

# Audit — Phase 0 and Phase 1 (before Phase 2)

A full review of everything T1–T13 delivered, run before starting Phase 2. 50 raw findings, triaged
to 30 confirmed / 17 overstated / 3 refuted. The central criticism was not about the code but about
its comments: eight comments asserted guarantees the code did not provide, and four checked
acceptance criteria were untrue. Everything below was verified by measurement, not by reading.

## Fixed and verified

- [x] **The audit log was bypassable two ways.** Setting `session_replication_role` to `replica` and
      then deleting wiped it with no DDL at all, because the triggers were `O` (origin). Migration
      `0002` sets them `ENABLE ALWAYS`, and the bypass is now rejected — verified against a live
      database. The second route, `ALTER TABLE ... DISABLE TRIGGER ALL`, is only available to the
      table owner and needs role separation to close. **See the open decision below.**
- [x] **The worker exited 545 ms after logging "ready".** With no processors registered nothing
      referenced the event loop, so `pnpm dev:worker` handed back a worker that was already gone and
      T5's drain path was unreachable. A `keepAlive` interval holds it open; verified still running
      after 10 s. T5's own test passed only because it killed the child on seeing "ready".
- [x] **Request logs carried the query string**, which is where an id or a phone number ends up. The
      path is now split off before logging.
- [x] **`maskIdentifier` was an unkeyed SHA-256 of a low-entropy id — reversible by brute force.** It
      is now HMAC-SHA-256 keyed with `MASKING_PEPPER`, and throws rather than degrading if no pepper
      is supplied. `MASKING_PEPPER` was added to the config schema and to `SECRET_KEYS`.
- [x] **`maskAddress` failed open**, returning the input unchanged when it matched no administrative
      unit. It now returns a fully-masked value in that case.
- [x] **`preflight.mjs` printed passwords in cleartext** on a `DATABASE_URL`/`POSTGRES_PASSWORD`
      mismatch — a SPEC.md §8 "Never", in the script written to protect configuration. It now reports
      length only for secret parts; non-secret mismatches still show values.
- [x] **`dev-runner.mjs` never built the workspace packages**, so a fresh clone failed on first run.
- [x] **The PII lint rule rejected all four purpose-built maskers** — it errored on exactly the code
      it exists to encourage. Cause: esquery's `!=` with a REGEX value silently excludes nothing.
      `:not([attr=/re/])` is the form that works. Now fixture-tested in both directions.
- [x] **The integration suite was destructive against the developer's own Redis.** Three tests ran on
      database 0 under real queue names; one bound a Worker with a no-op handler, which SILENTLY
      CONSUMED queued jobs — measured, a job planted on `send-outbound` was gone by the end of the
      run. All three now use database 15 and per-process queue names derived from the registry.
      Verified: db 0 is byte-identical after a full run, planted job and payload intact.
- [x] **Coverage was measuring files that do not exist.** `excludeAfterRemap` defaults to `false`, so
      every exclusion was inert; and `dist` held 28 orphaned modules from the T8 refactor plus 88
      leaked lint fixtures. Fixing both moved lines from 57% to 82%, which **closed the documented
      deviation from SPEC.md §7** — the threshold is back at 80 and passes. Added `pnpm clean` and
      `tests/integration/build-output.test.mjs`, which fails if `dist` goes stale again.
- [x] **The root program was not typechecked.** `pnpm typecheck` now runs it before the workspaces.

## Decided — least-privilege database roles

**Hosting: self-hosted Postgres (Docker/VPS).** Settled 2026-08-23. This was upstream of the role
design: on managed Postgres (Supabase/RDS/Neon) there is no superuser at all, so the split would
have been imposed rather than chosen, and `CREATE ROLE` would need `CREATEROLE` from a role that is
itself not owner. Self-hosting means the shape below is ours to pick.

**Approach: split the credential in two commits.** The operator keeps the `helloreview` superuser
and loses nothing. What gets restricted is the credential `apps/api` and `apps/worker` read from
`.env` — two long-running, internet-reachable processes that have never needed to drop a table or
rewrite an audit row.

### Measured, before committing to the design

- A non-owner application role is refused on every route: `DELETE`/`UPDATE`/`TRUNCATE` →
  `permission denied`; `ALTER TABLE ... DISABLE TRIGGER` and `DROP TABLE` → `must be owner`;
  `SET session_replication_role` → `permission denied to set parameter`. `INSERT`/`SELECT` on
  `audit_logs` and full DML on ordinary tables are unaffected.
- `ALTER DEFAULT PRIVILEGES` means **no future migration has to write a `GRANT`** — a table created
  afterwards was immediately usable by the app role with no grant statement.
- **Three traps found by measurement, each of which would have silently voided the scheme:**
  1. `GRANT owner TO app` — one line — let the app disable the triggers and wipe the table
     **despite never being granted `DELETE`**, because ownership checks follow role inheritance.
     `WITH INHERIT FALSE` does not help: `SET ROLE` still works.
  2. `pnpm db:reset` destroys it. `DROP SCHEMA public CASCADE` wipes every `pg_default_acl` row and
     leaves the recreated schema with a `NULL` ACL, so the app loses even `USAGE`. **Grants must
     therefore live in a replayed migration, never in one-time setup.**
  3. Drop-and-recreate silently re-grants `DELETE` from default privileges — and
     `tools/db-generate.mjs` explicitly instructs expressing renames as drop+add.

### Commit A — done (this commit)

No privilege change at all, so nothing could break. Pays most of the plumbing cost up front.

- [x] **`db:reset` guarded.** It dropped every schema against whatever the environment pointed at,
      with no check. Now refuses unless `NODE_ENV` is in an allow-list (`development`, `test` — an
      allow-list, not a "not production" deny-list, which would do nothing against `staging`) **and**
      the host is loopback. Both, because `NODE_ENV` is a claim and the host is a fact. The refusal
      never echoes the connection string. Verified: exits 1 on production, 1 on a remote host, 0 in
      development.
- [x] **`DATABASE_MIGRATION_URL` introduced**, byte-identical to `DATABASE_URL`. `db:migrate`,
      `db:reset`, `db:seed` and `drizzle.config.ts` all read it; a test asserts none of them reads
      `process.env.DATABASE_URL`, and that `db-target.mjs` has no fallback to it. The later split is
      now a value change rather than a refactor.
- [x] **`pnpm db:backup` and `pnpm db:verify-audit-protection`** added, plus
      [docs/backup-and-restore.md](../docs/backup-and-restore.md). **The restore was actually
      drilled**, not just documented: data and all three `ENABLE ALWAYS` triggers survived a
      `pg_dump`/`pg_restore` round trip.
- [x] **A documented claim was measured and found wrong before shipping.** `--no-owner --no-acl` does
      _not_ silently reopen the audit log — it strips every grant, so the app fails closed and
      loudly. The real hazard is the reflex fix, `GRANT ALL ON ALL TABLES`, which does re-grant
      `DELETE`. `db:verify-audit-protection` catches exactly that, verified by simulating it.

### Commit B — before T15 creates `event_inbox`

Migration `0003` (idempotent, because `db:reset` replays it), a `NOLOGIN` group role holding the
grants, a separate `LOGIN` role provisioned from the environment (a password may never enter a
committed migration), the `REVOKE` carve-out on `audit_logs`, an assertion block inside the
migration that raises if a privilege is ever silently restored, and an integration test on a **real
app-role connection** — `SET ROLE` inside a superuser session proves nothing, since the session can
`SET ROLE` back.

Keep 0002's `ENABLE ALWAYS` triggers: they are the backstop that still catches the operator's own
superuser session, which is the one actor an ACL cannot constrain.

Estimated 20–28 hours, mostly the Testcontainers harness and tooling — not the SQL.

### Deliberately deferred

Hash chain on `audit_logs` (the obvious implementation has a real concurrency defect around
sequence ordering, and only detects rather than recovers — the dump diff gets most of the value);
a separate migrator login (the operator _is_ the migrator); a read-only analytics role (no consumer
until Phase 8); RLS (the owner is exempt from its own RLS anyway).

### What this will and will not buy — stated plainly so it is never overclaimed

It stops the _application_ rewriting history. It does **not** stop the operator, who keeps the
superuser. It does not stop **forged** audit rows (the app must keep `INSERT`), and it does not stop
**omitted** ones — a forgotten `record()` call is invisible and is the larger real risk.

## Superseded — the original open question

The application connects as a SUPERUSER that also OWNS `audit_logs`. `ENABLE ALWAYS` closes the
replication-role bypass, but an owner can still `ALTER TABLE ... DISABLE TRIGGER ALL` and then
delete history. No trigger can defend against its own table's owner; only role separation can.

This needs deciding **before Phase 2 provisions a real role**, because it changes what the migration
runner and the application connect as:

- a migration/owner role that owns the schema and runs DDL, and
- an application role with `UPDATE`, `DELETE` and `TRUNCATE` revoked on `audit_logs`.

Until then, SPEC.md §8's "never delete business history" is enforced by convention, not by the
database.

## Not yet fixed — backlog

Roughly 15 medium and 13 low findings remain, none of which block Phase 2. The ones most worth
scheduling: the PII detector misses 02/070/03x Korean landlines and every non-Korean number, and
false-positives on the prose "Basic authentication"; the PII gate runs in no aggregate command;
`db:reset` has no environment guard; `createQueue` registers no error listener; `verifyRedis`
discards the underlying error; and the worker's `stop()` releases nothing when the drain times out.

---

# Phase 2 — Idempotency spine

## T14 — Event contracts (`§18`)

**Description:** Zod schemas in `packages/contracts` for the common event envelope (`§18.1`), the
acceptance response (`§18.2`), and the error model (`§18.4`), plus the message purpose and reason code
registries. These types are the only shape core modules ever see.

**Acceptance criteria:**

- [x] Envelope, acceptance response, and each `§18.5`–`§18.15` payload have a schema and a derived type
- [x] The `§18.4` status table is a typed exception hierarchy mapping to HTTP status codes
- [x] Message purpose codes are a single `as const` registry with a derived union

**Verification:**

- [x] Tests pass: `pnpm test:unit` — 45 new tests, 204 total across 18 files
- [x] Manual check: every payload example in PRD `§18` parses against its schema as a fixture —
      all eleven are copied **verbatim** from the document, and a twelfth test asserts the fixture
      count matches `EVENT_TYPES` so a deleted schema cannot shrink the loop into a green run

**Dependencies:** T1

**Files likely touched:** `packages/contracts/src/events/*`, `packages/contracts/src/errors.ts`, `packages/contracts/src/purposes.ts`

**Estimated scope:** S

> **Notes.**
>
> 1. **The wire format is snake_case; the domain shape is camelCase.** Each schema validates the PRD
>    shape exactly and transforms it. Same boundary decision `packages/config` already makes with
>    `DATABASE_URL` → `config.databaseUrl`. A provider renaming a field then changes one line in the
>    schema rather than every call site, which is what SPEC.md §3.1's adapters boundary is for.
> 2. **`z.union`, not `z.discriminatedUnion`.** Every member is a transforming schema (a `ZodPipe`),
>    and `discriminatedUnion` needs to read a literal discriminant directly off its members. The
>    OUTPUT is still a discriminated union, which is what call sites need; the cost is that a bad
>    payload reports issues from all eleven branches rather than one.
> 3. **Zod 4 cannot infer through a generic payload schema.** A generic `eventOf(type, payload)`
>    helper made `raw.payload` stop existing — TS2339, its optional-key detection collapsing to an
>    unresolved mapped type. Fixed by spreading the envelope fields at each concrete call site and
>    absorbing the repetition into one generic `toDomain` function instead. Measured, not guessed.
> 4. **`strictObject` everywhere: an unmodelled field is rejected, not dropped.** A provider sending
>    something new is a contract change worth failing loudly at the edge. Silently discarding it
>    means the first symptom is a business rule acting on data it never received.
> 5. **Parameterised purposes hold the STEM only.** The PRD writes four as
>    `GUIDELINE_DELIVERY:<version>`. The parameter belongs to the dedupe key T43 builds — a code
>    with a version baked in is a key, and mixing the two is how `GUIDELINE_DELIVERY:v4` ends up
>    compared against `GUIDELINE_DELIVERY`.
> 6. **`VISIT_C_BOOKING_INSTRUCTIONS` is separate from `VISIT_C_APPROVAL_STATUS`.** §26.3 asserts no
>    notification with the booking purpose exists while approval is pending, and SPEC.md §8 lists
>    sending it early under "Never" — neither is expressible if the two share one code.
> 7. **The tests were mutation-checked rather than trusted for passing first time.** Weakening
>    `strictObject` to `object`, duplicating a purpose code, and loosening the timestamp each
>    produced a failure. A suite that goes green on the first run is indistinguishable from one that
>    cannot fail.

---

## T15 — Event inbox schema

**Description:** The `event_inbox` table with `UNIQUE(source, external_event_id)` — the constraint that
is the actual idempotency guarantee, not the application logic layered over it (`§17.3`).

**Acceptance criteria:**

- [x] The unique constraint exists in the migration and a test proves a second insert violates it
- [x] Records store source, external event id, payload hash, status, and received time, with payload minimized or encrypted
- [x] Failed events are retained in a queryable state for replay (`§22.3`)

**Verification:**

- [x] Tests pass: `pnpm test:integration` — 6 integration + 18 unit, against a real migrated Postgres
- [x] Manual check: a duplicate insert is rejected with SQLSTATE 23505 on
      `event_inbox_source_external_id_key`, asserted by code rather than message text

**Dependencies:** T9, T14

**Files likely touched:** `packages/db/src/schema/event-inbox.ts`, `packages/db/migrations/*`

**Estimated scope:** S

---

## T16 — Webhook gateway: signature and replay

**Description:** Signature verification and replay-window validation at the webhook edge (`§18.3`).
Verification is provider-pluggable because each vendor signs differently, and the scheme is unverified
for all of them.

**Acceptance criteria:**

- [x] An invalid or absent signature is rejected with 401 before the body is parsed or persisted
- [x] A timestamp outside the configured replay window is rejected, and the window is configurable per provider
- [x] Signature comparison is constant-time, and no signature or secret reaches the logs

**Verification:**

- [x] Tests pass: `pnpm test:security` — 38 tests, including a real HTTP server over a socket
- [x] Manual check: a stale request is refused 401; malformed JSON with a BAD signature returns 401
      rather than 400, which is the proof that verification precedes parsing

**Dependencies:** T14, T15

**Files likely touched:** `apps/api/src/modules/provider-gateway/signature/*`, `apps/api/src/modules/provider-gateway/webhook.controller.ts`

**Estimated scope:** M

---

## T17 — Webhook gateway: schema, limits, rate limiting

**Description:** Schema validation, payload and attachment size limits, and per-provider rate limiting,
applied after signature verification and before inbox insertion (`§18.3`).

**Acceptance criteria:**

- [x] A body failing envelope schema validation is rejected 400 without side effects
- [x] Payloads over the configured limit are rejected 413 without being buffered entirely into memory
- [x] Rate limiting is per provider and returns 429 with no partial processing

**Verification:**

- [x] Tests pass: `pnpm test:security` — 14 HTTP-level tests; plus 8 integration tests for the
      limiter against a real Redis, including a 40-way concurrency test that a read-then-write
      implementation fails
- [x] Manual check: a 2 MB body returns 413. Memory is bounded by PAUSING the stream rather than
      destroying it — the first version destroyed the socket before the 413 could be written, so the
      client saw ECONNRESET and never learned why

**Dependencies:** T16

**Files likely touched:** `apps/api/src/modules/provider-gateway/validation/*`, `apps/api/src/modules/provider-gateway/rate-limit.ts`

**Estimated scope:** M

---

## T18 — Idempotent accept semantics

**Description:** The accept path from `§10.3`: insert into the inbox keyed on source event id; on
conflict, return the prior accepted result rather than reprocessing. New events return 202 and enqueue
processing.

**Acceptance criteria:**

- [x] A duplicate returns the original acceptance response with `duplicate: true` and enqueues nothing
- [x] A new event returns 202 and enqueues exactly one processing job
- [x] Concurrent delivery of the same event id yields one inbox row and one job, under a concurrency test

**Verification:**

- [x] Tests pass: `pnpm test:integration` — 7 tests against a real Postgres and Redis
- [x] Manual check: 25 concurrent deliveries of the same event id produce exactly one row, one job,
      and exactly one `duplicate: false` response. A check-then-insert implementation passes every
      sequential test and fails this one

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
