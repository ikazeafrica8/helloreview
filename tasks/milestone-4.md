# Task List: Milestone 4 — Evidence Automation and Analytics

Plan: [tasks/plan.md](plan.md) · Boundary spec:
[SPEC-ocr-extraction.md](../SPEC-ocr-extraction.md) · Parent spec: [SPEC.md](../SPEC.md) ·
Requirements: PRD v1.0

Status: **T118–T123 complete within the explicitly approved engineering-only OCR boundary. T124–T132
remain proposed and blocked by their named approvals. No real provider, database migration,
persistence, production image, readiness change, calibrated confidence gate, retry automation, or
workflow automation is authorized.**

Milestone 4 covers PRD rollout phases 5–8 while preserving operator review. It introduces image
evidence in shadow mode first, keeps blog ranking as evidence rather than application status, and
does not enable automatic participant selection.

## Decisions required before affected tasks

| Decision                                                                        | Blocks                                                  | Safe work that may proceed                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Approved `reservation-image-v1` schema and PRD §19.4 allowlist                  | Resolved for T119–T123; changes and T124+ need approval | Strict contract, fake, structural evaluator, synthetic evaluation  |
| OCR/model vendor, region, privacy/data-flight, retention, and security approval | Real adapter and production images                      | Provider-neutral port, deterministic fake, synthetic tests         |
| Field/provider/layout confidence calibration                                    | Production threshold policy and automated progression   | Structural evaluator and engineering scorecard; no production gate |
| Visit B/C readiness predicate approval                                          | T125 production predicate changes                       | Shadow evidence and human-review recommendation only               |
| Approved blog-score source and legal review                                     | T127 real adapter and T128–T129 rollout                 | Provider-neutral provenance contract proposal only                 |
| Explicit automatic-selection activation approval                                | T129 activation                                         | Recommendation-only shadow comparison                              |
| Approved analytics definitions and any required persistence                     | T130–T131 production metrics                            | Read-only projections over already approved audit/API data         |

---

# Phase 18 — OCR boundary and deterministic evidence

## T118 — OCR responsibility, security, and traceability boundary

Status: **Complete (2026-08-26) as boundary documentation. T119–T123 were subsequently approved;
all later stop gates remain binding.**

Record module dependencies, protected-state prohibitions, prompt-injection isolation, provider and
evaluation boundaries, PRD traceability, and explicit stop gates.

**Verification:** document review against PRD FR-SC-005–FR-SC-007, §§16.8–16.9, §§19.4–19.9,
AC-07, and SPEC.md §§3, 7, and 8.

## T119 — Strict OCR request and result contracts

Status: **Complete (2026-08-27) within the approved `reservation-image-v1` boundary.**

Encode exact versioned request/result contracts with the PRD §19.4 allowlist, bounded values,
explicit missing/conflict/quality evidence, opaque attachment references, and rejection of unknown
fields, raw payloads, and protected state.

**Verification:** request/version/reference/hash/media matrix, allowlist and cross-field invariants,
unexpected-field rejection, protected-state boundary, and synthetic-data PII checks.

**Dependencies:** T118; approved extraction schema

## T120 — Provider-neutral extraction port and deterministic fake

Status: **Complete (2026-08-27) with no real provider connection.**

Define an immutable, abort-aware provider-neutral port over the T119 contract, a deterministic
scripted fake, an unavailable default, ordered primary/fallback roles, explicit comparison providers,
per-provider time budget, in-memory coalescing/replay, and named safe fallbacks for timeout, invalid
output, outage, unavailable comparison, and disagreement. Provider-specific types stay in adapters;
provider-authored reasons are normalized and no failure path owns or writes workflow state.

**Verification:** fake conformance, timeout/abort, invalid-output, outage, replay, and no-state-write
tests.

**Dependencies:** T119

## T121 — Deterministic evidence-quality evaluator

Status: **Complete (2026-08-27) as structural-only evaluation; production thresholds remain blocked.**

Evaluate only approved structural evidence: required-field presence, image-quality code, conflicts,
provider disagreement, suspicious content, and an externally supplied structural policy. Missing,
invalid, or mismatched policy returns a safe no-progression reason. Every outcome remains
shadow/manual, retry/manual, or human review and explicitly forbids workflow progression.

**Verification:** pure decision table with 100% branch coverage; no provider confidence is treated as
portable or authoritative.

**Dependencies:** T119–T120

## T122 — Synthetic OCR evaluation harness

Status: **Complete (2026-08-27) with synthetic structured fixtures only.**

Add a deterministic synthetic manifest and `pnpm eval:ocr` scorecard for supported layouts,
cropped/blurred/incomplete images, wrong business/branch, missing fields, disagreements, and prompt
injection. Store no real participant screenshot.

**Verification:** reproducible scorecard, provenance checks, no real-data/PII matcher, and explicit
separation of quality scores from hard security assertions.

**Dependencies:** T119–T121

## T123 — Screenshot prompt-injection hard boundary

Status: **Complete (2026-08-27) at the contract, evaluator, and synthetic-test boundary.**

Prove that image instructions remain inert content, cannot widen schemas or authorization, cannot
select internal identifiers, and cannot trigger tools or protected state. Suspicious content is a
human-review signal, never an instruction.

**Verification:** hard security assertions for allowlist rejection, identifier isolation, tool-free
provider context, suspicious-output handoff, and safe logs.

**Dependencies:** T119–T122

---

# Phase 19 — Visit B/C shadow evidence

## T124 — Visit B shadow extraction orchestration

Status: **Proposed; human review remains mandatory.**

Process an already safe attachment through T120, persist only already-approved evidence, and create
a deduplicated human-review recommendation. Do not approve a reservation or release a guideline.

**Verification:** duplicate/retry, timeout, unsafe attachment, invalid result, disagreement, human
ownership, and no-protected-state integration cases.

**Dependencies:** T123, T89–T92

## T125 — Deterministic Visit B/C readiness integration

Status: **Proposed; blocked pending explicit readiness-predicate and any schema/migration approval.**

After approval, connect validated evidence to deterministic current-state checks for Visit B/C. OCR
never supplies campaign, participant, reservation, approval, or guideline authority.

**Verification:** current-version, campaign, selection, reservation, approval, pause, guideline, and
duplicate-delivery matrix; stale or missing evidence always stops.

**Dependencies:** T124; approved readiness predicate and persistence design

## T126 — AC-07 and Visit B/C release E2E

Status: **Proposed.**

Run the screenshot injection acceptance test through attachment safety, extraction, deterministic
validation, human review, and guideline gating. Include production-locked provider behavior.

**Verification:** AC-07 plus poor-quality, wrong-business, stale-reservation, revoked-approval,
duplicate, pause, and outage journeys.

**Dependencies:** T125

---

# Phase 20 — Blog-score evidence and controlled selection

## T127 — Approved blog-score provenance port

Status: **Proposed; real source blocked by source/legal approval. No scraping.**

Define source identity, observation time, freshness, campaign/region scope, and unavailable/stale
outcomes without treating blogger level as application lifecycle status. A deterministic fake is the
only allowed adapter until approval.

**Verification:** provenance/freshness contract, fake conformance, missing/stale/source-mismatch, and
no-scraping checks.

## T128 — Shadow recommendation comparison

Status: **Proposed; recommendation-only.**

Compare versioned system evidence with the operator decision while preserving manual approval and
recording disagreement. Regional context remains campaign evidence, not a universal selection rule.

**Verification:** no selection-state writes, explicit operator ownership, version/provenance evidence,
and false-selection/abstention reporting.

**Dependencies:** T127, T67–T72

## T129 — Controlled automatic-selection gate

Status: **Proposed; blocked until a separate explicit activation approval. Ships disabled.**

If later authorized, limit activation by campaign, versioned policy, approved source freshness,
measured precision, kill switch, rollback, and immutable decision evidence. Unknown or borderline
cases remain manual.

**Verification:** disabled default, allowlisted campaigns, stale/missing evidence, capacity, pause,
rollback, and zero-write shadow-mode tests.

**Dependencies:** T128; approved source/legal review, calibrated targets, explicit activation approval

---

# Phase 21 — Analytics and release controls

## T130 — Versioned metric and projection contracts

Status: **Proposed; persistence changes require separate approval.**

Define PRD §25 operational, quality, safety, cost, and AI/OCR metric semantics with numerator,
denominator, window, version, provenance, and actual-versus-projection labels. Prefer existing audit
and admin API data.

**Verification:** deterministic fixtures for empty, partial, late, duplicate, and corrected data;
cost and quality estimates remain clearly labeled.

## T131 — Read-only analytics console

Status: **Proposed.**

Expose authorized, campaign-scoped dashboards with masked drill-down, freshness, definition version,
and unsupported-data states. No direct database writes or sensitive exports.

**Verification:** RBAC/scope, masking, stale/empty/error, accessibility, and browser runtime checks.

**Dependencies:** T130, T103–T117

## T132 — Milestone 4 release E2E and rollout handbook

Status: **Proposed.**

Prove production-locked defaults, shadow-only OCR and selection, operator approval, kill switches,
safe fallbacks, metrics provenance, and rollback procedures. Real provider and activation lanes run
only after their approvals.

**Verification:** unit, security, integration, coverage, AC-07, operator E2E, synthetic evaluation,
and documented approval/rollback evidence.

**Dependencies:** T126, T129, T131

---

# Checkpoint H — Later phases controlled

- [x] OCR responsibility and prompt-injection boundary are documented; T119 contract widening was explicitly approved.
- [x] OCR contracts and deterministic fake are approved and verified.
- [ ] AC-07 passes through the complete production-locked journey.
- [ ] Visit B/C evidence remains shadow or human-reviewed until approved readiness criteria pass.
- [ ] Blog-score source and legal use are approved; scraping is absent.
- [ ] Automatic selection remains disabled until separately approved.
- [ ] Analytics definitions, provenance, masking, and authorization are verified.
- [ ] Review with human before any real provider, production image, or activation work.
