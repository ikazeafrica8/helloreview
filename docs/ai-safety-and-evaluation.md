# AI safety and evaluation boundary

T62–T66 implement an evidence-only Korean text boundary. No real AI provider is configured, and
the production release gate is intentionally closed.

## What is implemented

- Strict versioned request/result schemas reject unknown fields and evidence whose task does not
  match the requested task.
- Participant text is normalized, stripped of markup, redacted for phone/email/URL values, and
  serialized inside an explicit untrusted-data boundary.
- Opt-out, operator ownership, human requests, complaints, and privacy requests bypass the provider
  and outrank routine automation.
- Suspected prompt injection never reaches a provider and routes to human review.
- Provider evidence can only route to deterministic validation, clarification, or human review. It
  cannot write selection, consent, reservation, business-approval, or guideline state.
- Korean explicit and relative date/time expressions are normalized against an injected reference
  clock and `Asia/Seoul`. Missing timezones, impossible or past dates, conflicts, missing years, and
  missing a.m./p.m. markers fail closed.
- Request and scope budgets are explicit, idempotent by request ID, and fail closed when policy is
  absent or exhausted.

## Evaluation

Run:

```text
pnpm eval:ai
```

The checked-in `korean-engineering-v1` corpus is synthetic and contains no applicant records. It is
an engineering harness, not evidence that a production model is accurate. The report records model,
prompt, schema, and dataset versions; intent/route accuracy; critical recall; exact date/time match;
injection bypasses; and protected-state violations.

The production gate stays closed until all stop criteria are cleared:

- an AI provider is formally approved;
- the overseas-processing decision is recorded;
- dataset provenance is verified;
- at least the PRD-proposed 500 Korean text cases are scored; and
- each critical category has at least the PRD-proposed 30 representative cases.

Those corpus counts are planning proposals from PRD §19.9, not claims about current production
readiness. Threshold or governance changes require an explicit versioned decision; they must not be
lowered merely to make the gate pass.

## Current limitations

- Only `Asia/Seoul` campaign time is accepted. Another campaign timezone routes to review until its
  normalization policy and fixtures exist.
- The deterministic parser supports explicit Korean dates, `오늘`, `내일`, `모레`, 24-hour times,
  `오전`/`오후`, `정오`, and `자정`. Unsupported relative phrases route to clarification or review.
- The default application module still exposes only the unavailable provider cascade. A real
  adapter must not be wired before the production stop criteria above are cleared.
