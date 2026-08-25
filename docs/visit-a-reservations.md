# Visit A reservation flow

T83–T87 implement the text-based Visit A path while preserving the rule that extraction evidence
cannot authorize reservation validity or guideline delivery.

## Intake and extraction

- Only a manually selected Visit A workflow is eligible for intake.
- Korean date/time parsing runs deterministically first. Explicit year, month, day, and time can
  proceed to validation; missing or conflicting fields request one approved clarification.
- Unsupported text may use the bounded provider-neutral fallback. The configured provider remains
  unavailable by design, so provider failure and prompt-injection signals fail safely to human
  review.
- Extraction provenance, normalized candidates, ambiguity codes, preprocessing hash, and provider
  provenance are stored with the immutable reservation version.

## Validation and corrections

- Every complete candidate is evaluated by the existing fourteen deterministic rules. The stored
  evidence contains every pass, failure, submitted value, expected condition, correction code, and
  exact rule version.
- A valid state requires `deterministic_rules` authority and a rule version. Extraction alone can
  create only pending or human-review state.
- Participant corrections use an approved parameterized template named by the failed rule. Source
  event and outbox dedupe keys ensure replays do not create another message.
- Invalid rule configuration is an operator review, never a participant instruction.

## Lifecycle and delivery

- Cancellation and reschedule requests append new versions, preserve prior facts, revoke guideline
  readiness, acknowledge once, and create protected audit evidence.
- Duplicate source events return their original version; events older than the current head are
  rejected before they can change state or enqueue a message.
- The T87 composition requests guideline delivery only after the deterministic result is valid.
  Corrected evidence can queue one delivery; replay is suppressed and stale evidence is rejected.

## Verification

```text
pnpm exec vitest run --project integration tests/integration/visit-a-reservation-flow.test.mjs
pnpm exec vitest run --project e2e tests/e2e/visit-a-journey.test.mjs
```
