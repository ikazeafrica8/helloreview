# Privacy operations

This runbook covers T96 privacy-request intake, T97 minimal identity verification with
affected-processing pauses, T98 approved retention-schedule evidence, and T99 legal holds plus
deletion-eligibility evidence. Deletion/masking execution, sensitive reveal, export, and
privacy-pause release remain later tasks.

## Intake boundary

- An intake stores a claimed participant only. `identity_verification_state = unverified` means the
  relationship cannot authorize a read, export, correction, or deletion.
- Request types are `unspecified`, `access`, `correction`, `deletion`, and `export`. An unclear
  request is retained as `unspecified`; it is not discarded or guessed.
- Scope uses `privacy-request-scope-v1` and one of two states. `unconfirmed` requires empty data-class
  and campaign/workflow lists. `declared` requires at least one coded data class or pseudonymous
  campaign/workflow reference.
- Intake evidence uses `privacy-request-intake-evidence-v1`. Only a channel code and pseudonymous
  evidence reference are stored; raw message text, phone numbers, email addresses, and URLs are not
  accepted as references.
- The intake source must be authorized. Request-reference replay returns the original request only
  when the canonical input digest matches; reuse with different semantics fails closed.

## Persistence and history

`privacy_requests` is the current queue projection. It stores request type, claimed participant,
verification state, versioned scope, status, optional request-deadline policy reference and
deadline, optional assignee, and a canonical input digest.

`privacy_request_events` is append-only evidence. The initial event records the received and
unverified states, actor/evidence/correlation references, scope snapshot, deadline-policy state, and
deduplication key. PostgreSQL rejects update, delete, and truncate operations, including attempts by
the restricted application role. The same transaction writes a protected `PRIVACY_REQUEST_RECEIVED`
audit row.

`privacy_request_processing_pauses` is an append-only link from the request to every exact pause it
created or reused. The current request projection stores the verification policy reference, method,
and verification time only after a successful verification. Failed-attempt evidence remains in the
immutable event timeline without storing raw contact data or provider payloads.

The privacy tables and `automation_pauses` have row-level security enabled. The internal
`helloreview_app` group receives operation-specific policies; Supabase `anon` and `authenticated`
roles are explicitly denied when those roles exist. No participant-facing Data API route is added.

## Identity verification and pause boundary

- Verification can start only for a request with a claimed participant, from an authorized privacy
  reviewer. Starting moves the request to `identity_verification` / `pending` and atomically creates
  the affected pauses and immutable event/audit evidence.
- An unconfirmed scope pauses that claimed participant only. A declared `campaign:<uuid>` reference
  maps to that participant in that campaign; a declared `workflow:<uuid>` maps to that exact
  workflow. Supplied pause targets must exactly equal those references. Global, campaign-wide, or
  workflow-type privacy pauses are not accepted.
- Every workflow target is checked against the claimed participant. Missing and cross-participant
  targets return the same `PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID` result, with no candidate or
  other-participant details and no partial pause.
- Privacy pauses are a distinct `privacy_request` kind. Ordinary automation-pause deactivation
  rejects them. T97 intentionally leaves them active after successful or failed verification; only
  the later privacy resolution/resume workflow may release them after revalidation.
- Completion accepts only `verified_channel_identity` evidence under an explicitly approved,
  versioned policy. The lookup asks only whether the identity ID is already verified for the claimed
  participant. Missing, revoked, and cross-participant identities all produce the same blocked/
  failed outcome.

The repository includes `privacy-verified-channel-fixture-v1` only as a deterministic test policy.
It is not a production approval. Production verification remains disabled until governance approves
a real policy and the chosen channel can provide a previously verified identity. T97 does not
invent a phone, email, document, or manual knowledge-check procedure.

## Deadline and retention boundary

A request deadline is stored only when a caller supplies both an explicit policy reference and a
deadline. Missing policy stores both values as null. This is a request-handling deadline, not a data
retention period.

T96 request records still contain no retention-days, delete-after, or retention-until value. T98
adds a separate append-only registry that accepts a schedule only when it is complete, versioned,
and carries distinct company and legal approval references. The repository seeds no schedule and
contains only clearly named test fixtures; production remains disabled until the company and legal
reviewer approve periods and dispositions for every PRD §21.6 data class.

## Retention schedule boundary

- `privacy-retention-schedule-v1` must cover exactly the eleven coded data classes. Each entry has a
  bounded positive integer day count and either `delete` or `irreversible_mask`; missing, duplicate,
  unknown, or extra fields fail closed.
- The first schedule cannot claim a predecessor. Every later version must exactly supersede the
  current latest version and have a later effective time. Reusing a policy version with changed
  semantics is a conflict.
- A publication time cannot predate the recorded approval. Schedule versions and entries are
  append-only, RLS-enabled, and inaccessible to Supabase `anon` and `authenticated` roles.
- `privacy-retention-test-fixture-v1` appears only in tests. Its durations and approval references
  are deterministic fixtures, not company policy, legal advice, or production approval.

## Legal hold and eligibility boundary

- A legal hold targets one participant, one participant plus data class, or one pseudonymous record.
  Application and release are separate append-only events; an earlier evaluation preserves the
  state that existed at its evaluation time.
- Eligibility checks legal hold first. An active matching hold returns `legal_hold_active` even when
  no schedule exists or the retention interval would otherwise have elapsed. After release, the
  schedule is evaluated normally.
- With no effective approved schedule, the result is `policy_missing`. With one, the result is only
  `retention_active` or `eligible`, together with its version, date, and disposition.
- Every evaluation is immutable and audited with `deletion_executed = false`. T99 creates no deletion
  queue, job, function, storage mutation, masking action, or automatic link from eligibility to an
  executor. T100 requires separate reviewed execution policy and approval.

## Verification

```powershell
pnpm db:check
pnpm build:fresh
pnpm typecheck
pnpm lint
pnpm exec vitest run --project unit tests/unit/privacy-request-contract.test.mjs
pnpm exec vitest run --project unit tests/unit/privacy-identity-verification.test.mjs
pnpm exec vitest run --project unit tests/unit/privacy-retention-contract.test.mjs
pnpm exec vitest run --project integration tests/integration/privacy-request-intake.test.mjs
pnpm exec vitest run --project integration tests/integration/privacy-identity-verification.test.mjs
pnpm exec vitest run --project integration tests/integration/privacy-retention-and-legal-hold.test.mjs
pnpm exec vitest run --project integration tests/integration/migrations.test.mjs
pnpm exec vitest run --project integration tests/integration/db-privileges.test.mjs
pnpm exec vitest run --project security tests/security/privacy-request-intake.test.mjs
```

## Rollback

Application rollback may stop new intake/verification/retention evaluation and deploy the previous
service version, but it must leave migrations 0028–0031 and all privacy, schedule, hold, pause-link,
eligibility, and audit evidence in place. Active
privacy pauses remain fail-closed. Dropping tables, releasing pauses in bulk, or rewriting events is
a destructive privacy operation and requires a separate approved recovery procedure.
