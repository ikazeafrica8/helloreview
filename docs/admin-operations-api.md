# Governed admin operations API (T105-T108)

The admin API is a transport-neutral Nest application boundary. It is intentionally not exposed by
an HTTP controller until the approved operator authentication adapter exists. A future console or
HTTP adapter must construct the verified `operator-principal-v1`; it must not accept a principal,
role, campaign scope, policy, or authorization version from request JSON.

## Operator-console adapter

The T112–T117 console consumes a separate server-only, asynchronous `OperatorConsoleGateway`
contract. Campaign scope is explicit on participant reads, and timeline responses report available
or unsupported PRD categories. Its local test adapter is deterministic and pseudonymous; its
production adapter is locked and returns no records or commands. The Next.js application does not
import these Nest services or connect to the database. An authenticated HTTP adapter can replace
the locked implementation only after the identity, RBAC, campaign-scope, and transport decisions
are approved.

Every Server Component read and Server Action re-checks the provider-neutral session, canonical
action authorization, and target campaign scope before invoking the gateway. The gateway repeats
that check using the explicitly supplied verified session. Layout rendering is presentation gating
only and is not an authorization boundary.

Canonical administrative action IDs now live in `@helloreview/contracts`. Console scenario IDs
remain separate, so stale and preview fixtures cannot silently become authorization actions.

The fixture demonstrates the complete PRD §20.3 presentation contract. That does not expand the
persisted timeline described below: a production adapter must report unavailable source categories
honestly until their query services exist and must never synthesize operational history.

## Participant reads

`ParticipantAdminQueryService.search` requires a campaign scope, uses bound database parameters,
and returns masked name and phone fields. Website application lifecycle status and blogger ranking
evidence are separate response fields. The API does not turn blogger level, average daily visitors,
or region into an automated selection decision.

`timeline` verifies that the participant belongs to the authorized campaign and merges application,
workflow, selection recommendation, manual selection, consent, shipping, reservation, approval,
guideline, notification, and human-review history. Pagination is stable on `(occurred_at, event_id)`.
Only IDs, versions, state codes, and reason codes are returned; source payloads, rendered messages,
addresses, names, and phone numbers are excluded.

## Commands

`AdminCommandService` resolves campaign scope from the target human task or workflow before
authorization. Assignment, resolution/resume, workflow correction, and Visit C business approval
commands reuse the existing expected-version and current-state checks. A resolution that returns a
task to automation requires both `human_tasks.resolve` and `human_tasks.resume_automation`.
Business-approval evidence and its protected audit record commit atomically.

`ConfigurationAdminCommandService` provides optimistic campaign versions, rule preview and
publication, guideline publication, and template approve/activate/retire transitions. Published
rules and guidelines remain immutable. Template content remains global, but the current test policy
requires a campaign-scoped manager authorization for its transition.

## Diagnostics and retry

`OperationsAdminService` provides integration health, failed inbound/outbound jobs,
notification/suppression and deduplication history, active pauses, pause activation/resume, and the
AI/cost state. Because T63 deliberately connects no billable provider, the AI state reports the
unavailable safe fallback, zero estimated provider cost, and no real provider connection.

Only failed or dead-lettered inbound events can be requeued. Retry locks the event and writes an
immutable `admin_retry_operations` receipt in the same transaction. Repeating the same operation
reference and input returns a deduplicated result; reusing the reference for changed input is an
idempotency conflict. Processing attempts are retained, while the processing status and coded error
are reset so the existing inbox relay can enqueue the event again.

The retry receipt table has RLS enabled. Direct `anon` and `authenticated` access is revoked; the
application role has only `SELECT` and `INSERT`. Update, delete, and truncate are also blocked by
always-enabled triggers. Database grants and RLS are maintained as separate controls, consistent
with Supabase's current API security model.

## Production boundary

The repository RBAC matrix is a deterministic test fixture. Production use remains fail-closed
until the company approves the RBAC/campaign-scope matrix and the selected authentication adapter
can issue current, verified principals. No sensitive reveal or export is added by T105-T108.

T109 sensitive operations accept only a policy-version reference. A trusted injected provider must
resolve the current policy; request data cannot supply a policy document. The shipped provider is
locked, while the deterministic test provider is test-only, environment-bound, and rejects stale
versions. No real reveal/export policy is configured by the repository.
