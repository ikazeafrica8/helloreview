# Human-review operations

This runbook covers T88–T92: masked case packets, durable handoff episodes, holding-message
deduplication, operator assignment, policy-required SLA timestamps, and validated return to
automation.

## Safety boundary

- A human-review recommendation or case packet never changes selection, consent, approval,
  reservation validity, or guideline readiness.
- The default case packet contains masked or pseudonymous references only. Raw messages, addresses,
  provider payloads, attachment bytes, and model output are excluded.
- A handoff holding notice uses an active, approved `HUMAN_HANDOFF_HOLDING` template. The service
  does not embed or approve participant-facing copy.
- Conversation ownership is exclusive. Automated message intents are suppressed while an operator
  owns the workflow.
- Returning a case only resumes from current state. It does not apply a protected decision or replay
  an old recommendation.

## Durable records

`human_review_tasks` is the current queue projection. It holds the workflow/campaign scope, episode,
masked packet version, current assignee, approved SLA-policy timestamps, and resolution projection.

`human_review_task_events` is append-only evidence for creation, holding, assignment/release,
resolution, rejected resume, and return. `human_review_holding_messages` is append-only linkage from
one episode/template version to one outbox notification. The application role can insert and read
these tables but cannot update, delete, or truncate them.

Older resolved tasks are upgraded explicitly as `LEGACY_RESOLUTION_UNRECORDED`. The migration does
not invent the original operator or reason.

Legacy `legacy-case-packet-v0` tasks remain visible in the queue, including pre-workflow tasks with
no workflow or campaign identifier. Assignment, release, and return-to-automation fail closed until
the task has an explicitly upgraded v1 packet and workflow/campaign scope.

## Opening an episode

The operation requires:

- current expected workflow version;
- a `human-review-case-packet-v1` packet whose workflow and reason match the command;
- an idempotency key tied to the source trigger;
- an active approved holding-template version;
- an explicit SLA policy, or `null` when policy is not approved.

Task creation, workflow pause/queue projection, transactional outbox intent, holding-message link,
and event history commit together. Replaying the source key returns the original task and produces no
second holding notice.

## SLA behavior

The SLA calculator accepts only a versioned Asia/Seoul policy with service weekdays, daily service
window, holidays, and targets for normal/high/critical priority.

- Service minutes outside the approved window and on holidays do not count.
- Escalation cannot precede the response target.
- Missing policy produces `SLA_POLICY_MISSING` and stores no due or escalation timestamp.
- Service hours and response targets still require operational approval before production
  activation.

## Assignment and release

Claiming a task locks both task and workflow. It creates the workflow-level operator assignment and
changes the workflow to human-owned within the same transaction. Another operator cannot claim it.

Releasing ends the current assignment, returns the task to the queue, and keeps automation paused.
Every assignment and release remains in both assignment history and task-event history.

## Return-to-automation gate

The assigned operator must supply a non-empty resolution reason and a current, versioned validation
result. Return is rejected when any of these is false or stale:

- the packet permits `RETURN_TO_AUTOMATION`;
- opt-out is clear;
- required evidence is current;
- deterministic readiness passes;
- validation is no older than five minutes and not from the future;
- expected workflow version is current;
- campaign is active;
- no applicable automation pause exists;
- no other open/in-progress task exists for the workflow.

Rejected return attempts remain committed as append-only `resume_rejected` evidence while the task
and ownership stay unchanged. A successful return records resolution, releases ownership, changes
the handoff projection to `returned_to_automation`, and changes automation mode to `active` in one
transaction.

## Verification

```powershell
pnpm db:check
pnpm build:fresh
pnpm typecheck
pnpm lint
pnpm exec vitest run --project unit tests/unit/human-review-case-packet.test.mjs tests/unit/human-review-sla.test.mjs
pnpm exec vitest run --project integration tests/integration/human-review-operations.test.mjs
```

The integration journey proves duplicate holding suppression, stored-policy replay, append-only
evidence, exclusive assignment, release/reassignment, queue filtering, opt-out rejection,
active-pause rejection, successful audited return, missing-policy no-deadline behavior, and safe
visibility of legacy pre-workflow tasks.
