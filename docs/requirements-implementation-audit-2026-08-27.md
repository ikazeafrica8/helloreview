# HelloReview requirements implementation audit

| Field                 | Value                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Audit date            | 2026-08-27                                                                                                                                       |
| Supplied requirement  | Korean operating process shared by the product owner in this thread                                                                              |
| Engineering baseline  | PR #16 merged tree (`ab7938eb6763076782e6af554002d70cfa668431`)                                                                                  |
| Primary specification | [Product Requirements Document](../HelloReview%20Reviewer%20Campaign%20Automation%20Platform%20%E2%80%94%20Product%20Requirements%20Document.md) |
| Engineering contract  | [SPEC.md](../SPEC.md) and [SPEC-ocr-extraction.md](../SPEC-ocr-extraction.md)                                                                    |
| Task ledgers          | [tasks/plan.md](../tasks/plan.md), Milestones 1–4, and [requirements gap tasks](../tasks/requirements-gap-todo.md)                               |

## Executive conclusion

The supplied business process is already represented substantially and correctly in the PRD. The
architecture also follows the right safety principle: AI interprets unstructured evidence, while
deterministic services and authorized operators control selection, consent, approval, reservation
validity, and guideline release.

The implementation is **not yet a working end-to-end HelloReview automation system**. It is a strong
domain and safety foundation containing real database schemas, deterministic services, immutable
history, internal deduplication, and extensive tests. However:

- the worker registers **zero** business processors, so accepted inbound events do not run a
  participant journey;
- only health and provider-neutral webhook HTTP controllers are exposed;
- there is no approved, real Kakao, Aligo, website, text-AI, OCR, or malware-scanner integration;
- the operator console uses deterministic fixtures and its production gateway is locked;
- direct-application and secret-comment journeys are not composed;
- Visit B/C remains deliberately shadow/manual and production-locked; and
- automatic selection remains deliberately disabled.

Therefore, passing builds and service-level tests must not be interpreted as the product requirement
being 100% operational. The repository currently proves many components in isolation; it does not
yet prove `Kakao/application -> identity -> workflow -> selection -> campaign journey -> outbound
message -> delivery callback` as a running system.

## Audit method and status definitions

The audit compared the supplied 13-section process and 12 launch questions against the PRD,
platform spec, OCR spec, task ledgers, database schemas, Nest composition, worker registry, provider
adapters, admin console, and tests.

The available installed skill catalog contained no skill literally named `spec`, `documentation`, or
`agent`. The PLAID product-build skill was inspected, but its required `docs/product-roadmap.md`,
`docs/prd.md`, and `docs/product-vision.md` files do not exist here. The repository-native PRD,
`SPEC.md`, `tasks/plan.md`, module documentation, and `apps/admin/AGENTS.md` were therefore used as
the authoritative workflow.

| Status                 | Meaning                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Implemented            | Durable code and relevant tests exist for the stated boundary.                                                          |
| Partial                | Useful layers exist, but a required transport, composition, authority source, or participant-facing surface is absent.  |
| Missing                | No implementation currently completes the requirement.                                                                  |
| External blocked       | Code cannot be completed or activated until a vendor, access, legal, privacy, policy, or business decision is supplied. |
| Intentionally deferred | The task is explicitly locked or planned for a later approved phase.                                                    |

## Requirements-to-implementation matrix

| Supplied capability                                                   | Status                                     | Implemented evidence                                                                                                                                                                                                             | Remaining gap                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website application remains the source of truth                       | Implemented for the manual pilot           | Strict XLSX conversion, CSV validation, source IDs, source timestamps, freshness, idempotent import, and ranking/status separation exist in `docs/manual-application-import.md`, `application-sync`, and the application schema. | New website applications are not ingested automatically. The approved pilot still requires an operator export/import.                                                                                                                                                              |
| Manual CSV workaround without website API/database access             | Implemented                                | The CLI validates the verified 33-column export, supports campaign mapping, rejects unknown status codes, and safely replays imports.                                                                                            | Importing rows does not create participants/workflows or start the next journey. There is no governed upload screen yet.                                                                                                                                                           |
| Direct website applicant journey                                      | Missing end to end                         | Application, identity, workflow, selection, campaign, and message services exist separately.                                                                                                                                     | No coordinator connects an imported/application event to participant creation, workflow creation, selection review, campaign routing, or the next participant message.                                                                                                             |
| Kakao secret-comment claim journey                                    | Missing                                    | Intent vocabulary, secret-comment workflow states, screenshot-request purpose, supporting-only identity treatment, and secure attachments exist.                                                                                 | There is no application-link configuration/purpose, inbound journey service, once-only screenshot request, secret-comment evidence table, or comment-screenshot extraction contract.                                                                                               |
| Match Kakao user to website application                               | Partial                                    | Phone normalization, verification tokens, deterministic match table, persisted channel identities, ambiguity cases, and safe human review exist.                                                                                 | No live candidate-query/orchestration service consumes a Kakao contact and binds it to the correct imported application. Kakao stable identifiers remain unverified.                                                                                                               |
| Blog ranking kept separate from application status                    | Implemented in storage; one UI bug remains | `blogger_level`, `blog_daily_visitors`, and `blogger_region` are separate from application lifecycle status.                                                                                                                     | Admin API/UI incorrectly rename the source's average-daily metric as `previousDayVisitors` / `전일 방문자 수`. This must be corrected before operators rely on it.                                                                                                                 |
| Selection recommendation and manual approval                          | Implemented at domain boundary             | Versioned evidence, pure recommendations, manual-review band, immutable operator decisions, overrides, revocation, shadow comparison, and audit evidence exist.                                                                  | No governed selection command is exposed through the admin API/production console, and no journey consumes the result.                                                                                                                                                             |
| Automatic selection when criteria clearly pass                        | Intentionally deferred                     | The evaluator can recommend select/not-select/review and records its evidence.                                                                                                                                                   | `AUTOMATIC_SELECTION_ENABLED` is hard-disabled. T127–T129 still require approved score provenance, metric-period definition, campaign-region mapping, legal review, shadow targets, kill switch, and explicit activation approval. AI itself must never write the selection state. |
| Campaign type and Visit A/B/C routing                                 | Partial                                    | Shipping/payback/visit and A/B/C are structured enums; activation checks validate route configuration.                                                                                                                           | Selection records a `ROUTE_CAMPAIGN` side effect, but no worker consumes it. There is also no stored application URL for the secret-comment route.                                                                                                                                 |
| Persistent multi-dimensional participant state                        | Implemented foundation                     | Workflow instances store application, selection, campaign, visit, secret-comment, consent, approval, shipping, reservation, guideline, handoff, and automation states with immutable events and versions.                        | No runtime coordinator advances these states from real inbound events. Shipping currently initializes as `address_requested` before any request was sent, which is semantically incorrect.                                                                                         |
| Shipping address flow                                                 | Partial                                    | Selected-only one-time tokens, encryption, versioning, deterministic validation, masking, cutoffs, locking, and deduplication exist.                                                                                             | No participant GET/POST form or UI exists. Submission accepts a caller-supplied policy instead of loading the published campaign rule. No completion/correction message or automatic guideline re-evaluation is composed.                                                          |
| Payback explanation, explicit consent, decline, and one clarification | Partial                                    | Current terms, request correlation, explicit response states, one clarification, decline, supersession, withdrawal, history, and human review exist.                                                                             | No live inbound Kakao router invokes the service, and agreement does not automatically trigger the next deterministic readiness check.                                                                                                                                             |
| Visit A phone instructions                                            | Missing                                    | Versioned business phone and `VISIT_A_INSTRUCTIONS` purpose exist.                                                                                                                                                               | No service loads the current business version and sends the phone number plus the request for confirmed date/time.                                                                                                                                                                 |
| Visit A date/time validation and guideline gate                       | Partial                                    | Korean date/time extraction, deterministic reservation rules, immutable versions, cancellation/rescheduling, corrections, human review, and a valid-only guideline composition exist.                                            | No live inbound processor invokes it; it currently accepts only manually selected workflows. Correction messages pass no submitted/expected values into the template.                                                                                                              |
| Reservation validation rules                                          | Implemented with a parser defect           | Campaign, business, branch, date, weekday, time, boundary, timezone, method, approval, status, lead time, blackout, status, and capacity checks return reason/correction evidence.                                               | Single-location businesses may use an empty branch in the complete schema, while the evaluation parser rejects it. Specific Korean corrections are not rendered from the stored submitted and expected values.                                                                     |
| Visit B instructions and screenshot flow                              | Intentionally deferred / partial           | Booking URL storage, secure attachment primitives, reservation OCR contracts, provider-neutral fake, structural evaluator, and synthetic injection tests exist.                                                                  | No Visit B journey sends the URL, receives a live Kakao screenshot, invokes a real scanner/OCR provider, persists extraction, maps it to reservation evidence, or releases guidelines. T124–T126 remain proposed.                                                                  |
| Visit C approval-before-booking hard gate                             | Implemented core                           | Approval is independent, versioned, scope-bound, authorized, expiring/revocable, and rechecked in the booking service and outbox.                                                                                                | Recording approval does not automatically invoke the booking service; the booking message provides no booking URL variables. Pre-approval screenshot/bookings cannot yet be recognized and handed off because the B/C journey is absent.                                           |
| Guideline delivery only after all conditions pass                     | Partial                                    | A deterministic route-specific predicate, immutable guideline versions, suppression, re-delivery controls, incident detection, pause, and outbox evidence exist.                                                                 | Several readiness facts are accepted from the caller (`safeScreenshotReceived`, critical fields, consent versions, shipping/payback prerequisites) instead of being derived entirely from durable current records. The real send worker/provider is not active.                    |
| Internal duplicate-message prevention                                 | Implemented                                | Unique inbox IDs, transactional outbox, canonical purpose/dedupe keys, delivery history, human-ownership suppression, and idempotent retry logic exist.                                                                          | The worker registry is empty, so the delivery processors do not run in the shipped runtime.                                                                                                                                                                                        |
| Prevent duplicates with existing website/Aligo triggers               | External blocked                           | The PRD correctly makes the existing-trigger audit a launch blocker.                                                                                                                                                             | Internal dedupe cannot suppress a legacy website trigger it cannot observe. Trigger inventory, purpose mapping, sender ownership, callbacks, and a cutover/coexistence ledger do not exist.                                                                                        |
| Human handoff and safe resume                                         | Partial                                    | Durable episodes, one holding message, assignment history, SLA fields, priority, protected override evidence, and readiness-checked resume exist.                                                                                | Production-authenticated command transport and console data access remain locked.                                                                                                                                                                                                  |
| Complete operator timeline and campaign configuration                 | Partial                                    | Masked query services and a broad persisted timeline query exist; campaign/rule/template/guideline command services are transport-neutral and tested.                                                                            | The HTTP controller/authentication adapter is absent, and the visible console is fixture-backed. Inbound conversations/messages and secret-comment evidence are not persisted, so the operational timeline is not yet complete.                                                    |
| Korean AI interpretation                                              | Partial / external blocked                 | Strict schemas, sanitization, intent/date pipelines, timeout/fallback logic, budgets, synthetic evaluation, and protected-state isolation exist.                                                                                 | The Nest module wires only an unavailable provider; no approved real provider or representative 500-message corpus exists.                                                                                                                                                         |
| Reservation screenshot OCR                                            | Intentionally deferred / external blocked  | T119–T123 implement `reservation-image-v1`, a fake port, in-memory orchestration, structural evaluation, and prompt-injection tests.                                                                                             | No real provider, production images, persistence, calibrated confidence, durable retry, Visit B/C integration, or automation is allowed yet. The current OCR spec also overclaims FR-SC coverage: it cannot extract secret-comment campaign/blog/comment evidence.                 |
| Production runtime                                                    | Missing                                    | The API composes most domain modules and accepts signed platform-neutral envelopes.                                                                                                                                              | `apps/worker/src/processors/index.ts` exports an empty handler registry. Only `/health` and `/webhooks/:provider` controllers exist. Accepted events currently have no business processor.                                                                                         |

## The 12 supplied implementation questions

| Question                                               | Current answer                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Website DB/API integration possible?                   | No verified API or database access. The manual XLSX-to-CSV import is the approved pilot workaround.                                                          |
| How is Kakao identity matched to website applications? | The deterministic rules and persistence model exist, but no verified live Kakao identifier or orchestration exists.                                          |
| Can existing Aligo trigger conditions be confirmed?    | Not from this repository. An account/source inventory is still required.                                                                                     |
| Can AI and existing-message duplicates be controlled?  | Inside the new outbox, yes. Across the legacy website/Aligo sender, not until the trigger audit and sender-ownership plan exist.                             |
| Can blog score be checked automatically?               | Only imported ranking evidence and shadow recommendations exist. The approved metric period, campaign-region mapping, and real source remain unresolved.     |
| Can secret-comment screenshots be analyzed?            | No. Secure attachment primitives exist, but the current OCR contract is reservation-only.                                                                    |
| Can Naver screenshots yield business/date/time?        | Contract/fake/synthetic evaluation only; no real OCR provider or live screenshot journey.                                                                    |
| Can campaign weekdays/times be configured?             | Database/configuration services exist; the production-authenticated console is not connected.                                                                |
| Can Visit A/B/C be configured per campaign?            | Yes in durable configuration; no end-to-end route dispatcher consumes it.                                                                                    |
| Can difficult cases be handed to an operator?          | The durable service exists; production transport and real Kakao ownership signalling are missing.                                                            |
| Are guidelines technically gated?                      | The predicate is strong, but some caller-authoritative inputs must be replaced with repository-derived facts and the real send runtime is inactive.          |
| Can operators see all history?                         | Many business histories are queryable, but inbound message/conversation and secret-comment evidence history are absent and the production console is locked. |

## Verified defects and safety gaps that should be fixed first

1. OCR evaluation category keys can collide with `Object.prototype` and corrupt counts.
2. OCR in-memory idempotency retains successful evidence and fingerprints without a size/expiry
   bound.
3. OCR decision objects are runtime-mutable and required enum value `unknown` can receive the clean
   shadow label.
4. Fixture console commands do not enforce their command-specific authorization action.
5. Rejected sensitive-command audit inputs need runtime pseudonymous-reference validation and must
   retain the validated authorization-policy version.
6. Average-daily blog visitors are mislabeled as previous-day visitors in the admin contract/UI.
7. Shipping starts in `address_requested` before a request exists and accepts a caller-authoritative
   validation policy.
8. Reservation configuration disagrees on whether an empty branch is valid.
9. Reservation correction messages omit the safe submitted/expected values needed for a specific
   explanation.
10. Guideline readiness accepts multiple caller-authoritative booleans and versions.

Items 1–6 and the non-schema correctness portions of 7–9 are recorded in T133. The shipping-state
schema correction is part of T141, and authoritative readiness reconstruction is T146.

## What “100% implemented” must mean

For the agreed **manual-CSV pilot**, completion does not require website API or database access. It
does require every post-import step to be runnable and recoverable through authorized transports,
with real provider sandbox evidence, operator approval where policy requires it, complete history,
and no duplicate or premature messages.

For the **fully automated target**, completion additionally requires an approved automated website
ingestion method and controlled automatic selection. If the outsourced website never exposes a
supported integration, operator-controlled recurring CSV import remains an intentional manual step;
it must not be represented as automatic website synchronization.

The target is complete only after:

1. T100–T102, T124–T132, and the new T133–T152 gap tasks are closed or explicitly removed from the
   approved product scope;
2. Kakao, Aligo, AI/OCR, scanner/storage, authentication, RBAC, privacy, retention, messaging, and
   selection-policy decisions are approved;
3. real or official sandbox adapters pass the same conformance suites as the fakes;
4. the complete HTTP/webhook/queue/database/outbound/callback journeys pass without direct service
   construction;
5. operator UAT, Korean template review, rollback, monitoring, and production ownership are signed
   off; and
6. the PRD §34 acceptance criteria and §36 Definition of Done are evidenced, not merely checked in
   a planning document.

## Recommended implementation order

1. Fix T133 and rebaseline traceability in T134.
2. Build the durable communication/orchestration spine in T135–T140.
3. Complete the participant journeys in T141–T146 while keeping selection and OCR manual/shadow.
4. Complete official provider lanes in T147–T150 and existing T124–T129 approval-gated work.
5. Connect the production admin surface in T151.
6. Run T152 end-to-end UAT and controlled-pilot release evidence.

Do not start with automatic selection or a real OCR provider. The highest-value next implementation
is the dispatcher/journey spine, because without it the already-built domain services remain
independent components rather than an automation system.
