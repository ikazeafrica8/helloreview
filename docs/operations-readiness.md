# Operations readiness and rollback

This runbook covers the current manual-pilot release boundary after Milestone 2. It does not approve
a production AI provider, overseas processing, automatic selection, retention periods, RBAC, or
participant-facing template changes.

## Release boundary

- Website applications enter through the reviewed CSV import only.
- Selection recommendations are shadow evidence. An authorized operator remains the only selection
  decision-maker.
- AI uses the deterministic fake/evaluation fixture. `productionReleaseAllowed: false` is expected
  until every evaluation stop criterion is resolved.
- Missing policy fails closed: no automatic selection, no retention deletion job, and no unsafe
  attachment release.
- Privacy intake records an unverified claim and masked evidence only. Approved minimal
  verified-channel checks can advance identity, while exact participant/campaign/workflow pauses
  remain active. Verification does not authorize disclosure, correction, export, deletion, or an
  affected-processing resume.

## Pre-release checks

Run from a clean worktree:

```powershell
pnpm build:fresh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm db:check
pnpm test:unit
pnpm test:transitions
pnpm services:up
pnpm test:integration
pnpm test:security
pnpm test:e2e
pnpm eval:ai
pnpm services:down
```

The release is blocked by any non-zero command, any leaked test container, any protected-state AI
violation, or any premature/duplicate guideline delivery. An AI evaluation can pass its engineering
checks while still blocking production through `productionReleaseAllowed: false`; that is a correct
stop, not a warning to ignore.

The integration tier is intentionally serial and can exceed short automation-runner windows. A
runner timeout is not a pass or a failed assertion. Preserve the output, confirm no orphaned test
process/container remains, and rerun the named files in deterministic groups until every file has a
recorded result.

## Operator checks before processing a pilot export

1. Confirm the export schema matches the verified manual-import profile and identify the campaign by
   `캠페인번호`.
2. Preview the import and resolve every blocked or review row before applying it.
3. Confirm applicant lifecycle status and blogger ranking evidence remain separate fields.
4. Confirm automatic selection is disabled globally and for the campaign.
5. Confirm outbound provider enablement is approved; otherwise use fakes and do not represent a
   message as delivered.
6. Confirm the automation-pause view has no unexplained global or campaign pause.

## Application rollback

1. Stop new writers and outbound workers for the affected release.
2. Activate the narrowest safe automation pause; use the global emergency switch for an uncertain or
   cross-campaign incident.
3. Preserve correlation IDs, failed jobs, outbox rows, workflow events, and audit evidence.
4. Deploy the last verified application version.
5. Reconcile inbox and outbox state before retrying. Reuse the original idempotency key; never create
   a second logical send to make progress.
6. Validate current workflow versions and deterministic readiness gates before resuming.
7. For an emergency switch, confirm incident resolution, reconciliation completion, and current-state
   validation under the approved versioned resume policy.
8. Deactivate the pause only through a separately authorized, audited command with a reason.

Rollback never deletes or rewrites business history. If a state needs correction, append a new
correction/superseding version. Database downgrade or destructive cleanup requires a separate,
reviewed recovery plan and verified backup; application rollback alone does not authorize it.

## Incident stop conditions

Keep automation paused and create/retain a human task when any of these is observed:

- a guideline may have been sent before readiness;
- an owner-bound object may have crossed participant/workflow scope;
- selection, consent, approval, reservation validity, or guideline release changed from AI evidence
  without deterministic authorization;
- an outbound delivery has unknown provider status and reconciliation is incomplete;
- event order, workflow version, or source identity is ambiguous;
- required campaign policy, retention policy, provider approval, or authorization context is absent.

## Evidence to retain for review

- commit and migration journal identifiers;
- exact commands and pass/fail counts;
- AI evaluation report and unresolved stop criteria;
- active pause scope and reason;
- correlation IDs for the affected workflow and messages;
- operator decisions and override reasons;
- reconciliation outcome and the explicit resume authorization.
