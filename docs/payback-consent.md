# Payback consent response boundary

T78–T80 and T82 implement explicit, version-bound payback consent without allowing AI evidence to
write consent state.

## Implemented behavior

- Only the bounded exact Korean responses documented by the deterministic classifier can become
  `agreed` or `declined`. A bare yes, emoji, extra instructions, or other text is ambiguous.
- A response must match the current request ID and terms version while the aggregate is awaiting a
  response. Old, unrelated, and post-completion messages are immutable evidence but do not change
  consent state.
- The first ambiguous response for a current request sends one approved clarification. Replays are
  deduplicated by evidence-message ID and outbound dedupe key.
- A second ambiguous response creates one human-review task, queues handoff, pauses active
  automation, and records `human_review_required`; it never records agreement.
- Response events and consent versions are append-only. PostgreSQL, not an in-memory conversation,
  owns the current head and immutable history.

## AC-05 proof

The release-gate test first records agreement to terms version 1, publishes and requests version 2,
then submits another explicit agreement linked to the old request. Version 2 remains
`awaiting_response`, and the version-2 request remains the current request. One explicit response
linked to version 2 can then record agreement.

## Deliberately not included

T81 remains pending. Its complete terms-supersession lifecycle, withdrawal policy, fulfillment-begun
review behavior, and corresponding guideline/audit tests must land before the payback flow is
considered complete for production.

## Verification

```text
pnpm exec vitest run --project unit tests/unit/payback-consent-classifier.test.mjs
pnpm exec vitest run --project integration tests/integration/payback-consent-response.test.mjs
pnpm exec vitest run --project e2e tests/e2e/ac-05-payback-consent-versioning.test.mjs
```
