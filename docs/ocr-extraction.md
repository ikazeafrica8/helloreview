# OCR Extraction Engineering Boundary

The T119–T123 implementation is a production-locked engineering boundary for reservation screenshot
evidence. It provides strict contracts, a deterministic fake, safe in-memory orchestration, a
structural evaluator, and synthetic security/quality evaluation. It is not an OCR API endpoint or an
automated Visit B/C workflow.

## Approved contract

`reservation-image-v1` is the only accepted schema version and
`reservation_image_extraction` is the only accepted task. The strict request carries:

- a UUID request ID and bounded prompt/input versions;
- one `attachment-ref:<token>` opaque secure reference, with no internal attachment identifier;
- a lowercase SHA-256 content hash;
- `image/jpeg`, `image/png`, or `image/webp`;
- `ko-KR` and `Asia/Seoul`.

No image bytes, production storage path, URL, credentials, database context, tools, or protected
participant/campaign/workflow state belongs in the request.

The strict result is `evidence`, `refused`, or `failure`, with request/version identity and bounded
provider-or-orchestrator provenance. Refusal/failure reasons use an exhaustive OCR allowlist rather
than provider-authored business semantics. Evidence may contain only the PRD §19.4 allowlist:

- business name;
- reservation date and time;
- reservation status;
- reservation holder;
- visible booking method;
- missing and conflicting fields;
- image-quality status; and
- whether human review is required.

Extracted values use atomic value/confidence pairs: both are present or both are `null`. Missing and
conflicting fields are cross-validated. Unknown keys, invalid versions, raw provider payloads, and
protected-state fields are rejected.

## Provider and orchestration behavior

The provider port is provider-neutral, immutable, and abort-aware. The scripted fake snapshots and
validates requests/results, records only non-sensitive version/identity observations, produces
deterministic steps, and honors pre-start and in-flight abort signals. The unavailable fake
consistently returns `OCR_PROVIDER_NOT_CONFIGURED`. There is no real provider adapter.

The in-memory orchestration service:

1. validates the request before provider execution;
2. fingerprints each request ID and replays identical calls idempotently;
3. rejects reuse of a request ID with different content;
4. deep-freezes the canonical minimum-context request;
5. runs an ordered primary/fallback chain with explicit comparison providers;
6. enforces a per-provider timeout and abort signal;
7. validates result shape, request identity, provider, and model;
8. requires distinct provider/model identities for comparison sources;
9. rejects provider output that echoes the secure attachment reference or content hash;
10. returns immutable snapshots and prevents provider exceptions from authoring diagnostics; and
11. returns named, non-automatically-retried human-review fallbacks for unsafe conditions.

The strict provider review flag is preserved as evidence rather than being confused with platform
authority. Every downstream quality decision independently requires manual review and forbids
workflow progression, even when the provider flag is false. This service has no repository, durable
idempotency, database write, retry queue, workflow command, or readiness authority. A settled failure
may be retried only by a later explicit call with the same request content; `retryable: false` means
nothing schedules an automatic retry.

In-memory idempotency is bounded by an explicit size and age policy
(`DEFAULT_OCR_IDEMPOTENCY_POLICY`: 1,000 request identities, 15 minutes), because a retained result
carries participant evidence. A request identity's fingerprint and its retained result share one
entry and one fixed lifetime, so they are always released together; the lifetime is never extended
by a replay. After release, replaying the same request identity re-runs the providers instead of
returning stale evidence.

## Structural evaluator

The evaluator considers required-field presence, unresolved required enum values, image-quality
status, missing/conflicting evidence, provider disagreement, suspicious content, and structural
policy/provider/schema matching. It does not compare confidence against a threshold. Suspiciousness
is derived internally from both allowlisted free-text evidence fields; callers cannot provide or
suppress the signal.

`reservationStatus` and `visibleBookingMethod` are the two evidence fields whose contract enum
carries an explicit `unknown` member. That value is schema-valid, so the field never appears in
`missingFields` and would otherwise be recorded as resolved evidence. When the structural policy
requires such a field, an `unknown` value is treated as unresolved
(`OCR_EVIDENCE_REQUIRED_FIELD_UNRESOLVED`) and routed to human review rather than clean shadow
evidence. The sentinel is only recognised for those enum fields; free text that happens to read
`unknown` is not a sentinel.

Its outcomes are deliberately non-authoritative:

| Outcome           | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `shadow_evidence` | Structurally acceptable evidence, still owned by an operator  |
| `retry_required`  | Unsafe image quality; a retry is recommended, not scheduled   |
| `human_review`    | Missing/unresolved/conflicting/suspicious/mismatched evidence |

Every outcome sets `requiresHumanReview` to true and both deterministic validation and workflow
progression to false. Missing, invalid, or mismatched policy fails closed to human review. Every
decision is returned deeply frozen, so a caller cannot widen its reason codes or affected fields
after the fact.

## Synthetic evaluation

Run:

```powershell
pnpm eval:ocr
```

The command builds fresh artifacts, reads the structured synthetic manifest in `datasets/ocr/`, and
prints an `ocr-evaluation-report-v1` scorecard. The manifest parser enforces exact versioned fields,
bounded data, synthetic/non-production provenance, contract-valid evidence, allowlisted security
probes, injection coverage, and rejection of URLs or binary/base64-like material.

The report separately validates regression quality, exact runtime case/prediction shapes, and complete
hard security assertions. Prompt-injection cases must route to human review with zero protected-state
commands, tool invocations, schema widening, or internal-identifier selection. Even when engineering
checks pass, `productionReleaseAllowed` remains false.

## Remaining stop gates

T124–T132 are not authorized by T119–T123. A new explicit approval is required before:

- changing the OCR schema or allowlisted fields;
- connecting a real provider or adding/upgrading an AI/OCR dependency;
- storing OCR requests/results or adding a database migration;
- using real participant or production images;
- calibrating production confidence thresholds;
- changing Visit B/C readiness;
- adding durable/automatic retries or workflow automation; or
- enabling OCR-dependent progression, blog-score sourcing, or automatic selection.

See [SPEC-ocr-extraction.md](../SPEC-ocr-extraction.md) for the normative boundary and
[tasks/milestone-4.md](../tasks/milestone-4.md) for task status.
