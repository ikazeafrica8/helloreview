# OCR Extraction Boundary Specification

| Field        | Value                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| Status       | T118–T123 complete as an engineering-only, shadow/manual boundary                        |
| Plan tasks   | T118–T123                                                                                |
| Parent spec  | [SPEC.md](SPEC.md)                                                                       |
| Requirements | PRD FR-SC-005–FR-SC-007, §§16.8–16.9, §§19.4–19.9, AC-07                                 |
| Dependencies | `attachments`, `ai-orchestration`                                                        |
| Not enabled  | Real provider, persistence, production images, readiness changes, retries, or automation |

## Purpose

This document fixes the responsibility and security boundary for the `ocr-extraction` module. The
T119–T123 approval authorizes the `reservation-image-v1` request/result contract, the PRD §19.4
allowlist, a provider-neutral port, a deterministic fake, in-memory safe orchestration, a structural
quality evaluator, a synthetic evaluation harness, and prompt-injection tests.

That approval does not authorize a real OCR/AI provider, database or migration work, persistence,
production screenshots, a readiness-predicate change, calibrated production confidence policy,
automated retries, or workflow automation. T124–T132 remain separately gated.

## Responsibilities

The approved engineering boundary may:

- receive only a secure reference to an attachment that already passed the `attachments` file-safety
  controls;
- request provider-neutral extraction of visible reservation evidence;
- validate provider output against the explicitly approved `reservation-image-v1` allowlist;
- report bounded value/confidence pairs, missing fields, conflicting fields, image quality, and
  human-review evidence;
- compare independent extraction results without treating either provider as authoritative; and
- return a coded safe-fallback or human-review recommendation when evidence is unsafe, incomplete,
  conflicting, suspicious, timed out, or unavailable.

The module may never:

- bind identity, select a participant, approve a reservation, approve a business, release a
  guideline, or write any other protected business state;
- treat screenshot text, URLs, markup, or provider output as system instructions or tool calls;
- choose an internal participant, campaign, workflow, or attachment identifier from image content;
- receive database credentials, arbitrary tools, authorization policy, secrets, or raw production
  storage paths in a model context; or
- make an uncalibrated provider confidence value sufficient for workflow progression;
- persist OCR requests, results, idempotency records, or evaluation reports; or
- schedule a retry or issue a workflow command.

## Approved inputs and outputs

The strict request identifies one `reservation_image_extraction` operation and includes:

- a UUID request ID;
- the literal schema version `reservation-image-v1` plus bounded prompt and input versions;
- one `attachment-ref:<token>` opaque secure reference, with no internal attachment identifier;
- a lowercase SHA-256 content hash and allowlisted media type (`image/jpeg`, `image/png`, or
  `image/webp`); and
- the fixed locale `ko-KR` and timezone `Asia/Seoul`.

It does not carry image bytes, a production storage path, a download URL, participant/campaign/
workflow identity, credentials, authorization policy, or tools.

The result repeats request identity and version metadata, names the provider and model, carries
bounded provider-or-orchestrator provenance, and is exactly one of `evidence`, `refused`, or
`failure`. Refusal/failure reason codes are exhaustively allowlisted, so a provider cannot mint
business-state semantics. Refusal and failure outcomes always require human review. Evidence is
limited to the following PRD §19.4 fields (the code contract uses camelCase JSON names):

| PRD field                | Contract field         | Representation                                                     |
| ------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `schema_version`         | `schemaVersion`        | Literal `reservation-image-v1`                                     |
| `business_name`          | `businessName`         | Bounded text and confidence, or both `null`                        |
| `reservation_date`       | `reservationDate`      | ISO date and confidence, or both `null`                            |
| `reservation_time`       | `reservationTime`      | 24-hour `HH:mm` and confidence, or both `null`                     |
| `reservation_status`     | `reservationStatus`    | `confirmed`, `pending`, `cancelled`, or `unknown`, with confidence |
| `reservation_holder`     | `reservationHolder`    | Bounded text and confidence, or both `null`                        |
| `visible_booking_method` | `visibleBookingMethod` | `naver_booking`, `other`, or `unknown`, with confidence            |
| `missing_fields`         | `missingFields`        | Unique names from the six evidence fields                          |
| `conflicting_fields`     | `conflictingFields`    | Unique names from the six evidence fields                          |
| `image_quality_status`   | `imageQualityStatus`   | `acceptable`, `cropped`, `blurred`, `incomplete`, or `unusable`    |
| `requires_human_review`  | `requiresHumanReview`  | Boolean evidence flag                                              |

Value and confidence must be present together or both be `null`. A null value must be named in
`missingFields`, and one field cannot be both missing and conflicting. Unknown fields, invalid
versions, raw provider material, and protected-state fields fail closed rather than being stripped.

## Security and authority boundary

Image text is untrusted content. Prompt-like text may be extracted only as inert evidence and cannot
change the output schema, authorization, system policy, provider configuration, or tool access.
Unexpected output fields are rejected, not ignored. Suspicious content is routed to human review
without accusing the participant. The signal is derived inside the evaluator from both allowlisted
free-text fields (`businessName` and `reservationHolder`); a caller cannot supply or suppress it, and
format/control characters are normalized before matching.

Only deterministic services may evaluate campaign state, selection state, reservation validity,
business approval, current guideline version, pauses, and delivery readiness. The T121 evaluator
does not perform those decisions: every result sets `requiresHumanReview: true`,
`deterministicValidationAllowed: false`, and `workflowProgressionAllowed: false`.

## Provider and fallback boundary

Core code depends on an immutable, abort-aware provider-neutral port. Development and tests use a
scripted, deterministic fake; the default unavailable fake returns `OCR_PROVIDER_NOT_CONFIGURED`.
The in-memory orchestrator deep-freezes canonical requests, validates both sides of the port, uses an
ordered primary/fallback chain, and keeps independent comparison providers explicit. It fingerprints
request IDs for concurrent/coalesced replay, applies a per-provider timeout, aborts timed-out work,
and returns named safe outcomes for invalid output, outage, timeout, request-ID conflict, exhausted
providers, unavailable comparison, and disagreement. Comparison sources must have distinct provider/
model identities. Provider exceptions cannot author orchestrator diagnostics, provider output that
echoes the attachment reference or content hash is rejected, and cached/returned results are
immutable. The provider's strict `requiresHumanReview` evidence flag is preserved as evidence; it
never grants authority because every evaluator decision independently requires manual review and
forbids workflow progression.

The orchestrator owns no repository, queue, workflow command, or readiness decision. Its in-memory
idempotency map is not durable persistence, it does not automatically retry, and safe failures require
human review without changing workflow state. `retryable: false` means that this orchestrator never
schedules an automatic retry. A settled failure is evicted so an operator/job runner may make a later
explicit retry under the same request ID; the content fingerprint remains fixed. A real adapter
cannot be selected until vendor,
processing region, privacy/data-flight, retention, security, cost, and accuracy decisions are
approved.

## Evaluation boundary

The structural evaluator checks only required-field presence, image-quality codes, missing/conflict
evidence, provider disagreement, suspicious content, and structural policy/provider/schema matching.
It never uses confidence for gating. Missing, invalid, or mismatched policy fails to human review;
unsafe image quality requests a manual retry; all otherwise acceptable evidence remains shadow-only.

The strict, size-bounded synthetic manifest contains allowlisted structured cases rather than image
files and declares that it has no real participant data or production images. Unknown keys, URLs,
binary/base64-like material, invalid probes, missing injection coverage, and malformed evidence fail
closed. `pnpm eval:ocr` produces a deterministic engineering scorecard whose runtime input requires
exact case/prediction shapes and complete security booleans. Quality scores and hard security
assertions are reported separately. Production release is always denied because no provider is
approved, confidence policy is not calibrated, the dataset is not production representative, and the
proposed corpus size has not been met.

Prompt-injection cases verify that extracted instructions stay inert, schemas cannot widen,
protected-state commands and tools cannot be invoked, and internal identifiers cannot be selected.
Suspicious content routes to human review without accusing a participant.

## Traceability

| Requirement         | Boundary consequence                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| FR-SC-005           | Extraction must use an approved schema and explicit confidence/missing evidence.                           |
| FR-SC-006           | Unclear, conflicting, cropped, or suspicious evidence cannot create a verified state.                      |
| FR-SC-007 and AC-07 | Image instructions remain inert content and cannot alter schema, authorization, or deterministic approval. |
| PRD §16.8           | Confidence treatment is field/provider calibrated; disagreement and unsafe quality stop progression.       |
| PRD §16.9           | Visit B/C progression remains a deterministic readiness decision outside OCR.                              |
| PRD §§19.6–19.8     | Output is allowlisted and validated; failures preserve state and fall back safely.                         |
| PRD §19.9           | Evaluation uses a synthetic manifest, including prompt injection and poor-quality cases.                   |
| SPEC.md §§3 and 7–8 | Module dependencies, evaluation tiers, approval gates, and protected-state prohibitions remain binding.    |

## Stop gates

Implementation stops before any of the following without a new explicit approval:

- changing `reservation-image-v1`, its request/result schema, or any extraction field;
- adding or upgrading an OCR/AI dependency or selecting a real provider/model;
- changing Visit B or Visit C readiness predicates;
- storing new OCR fields or adding a database migration;
- adding persistence or durable idempotency for OCR requests/results;
- setting production confidence thresholds or automatic retry/service-objective policy;
- using real participant screenshots or enabling OCR-dependent progression; or
- enabling any workflow automation, automatic selection, or blog-score source.
