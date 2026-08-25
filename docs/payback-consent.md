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

## Terms supersession, decline, and withdrawal

- A newly current terms version creates a new request and records protected supersession evidence;
  an incomplete older request cannot authorize the new terms.
- An explicit decline is terminal for that request and guideline readiness remains blocked.
- Withdrawal is a distinct immutable participant response and consent version. When fulfillment has
  begun, it queues one high-priority review and pauses active automation; replay is deduplicated.
- Agreement, decline, supersession, and withdrawal decisions are reconstructable from protected
  audit entries without storing raw participant text in the audit log.

## Verification

```text
pnpm exec vitest run --project unit tests/unit/payback-consent-classifier.test.mjs
pnpm exec vitest run --project integration tests/integration/payback-consent-response.test.mjs
pnpm exec vitest run --project e2e tests/e2e/ac-05-payback-consent-versioning.test.mjs
```
