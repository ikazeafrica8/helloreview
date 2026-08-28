# Supplied operating process — requirement crosswalk

| Field            | Value                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Purpose          | Give the product owner's supplied Korean operating process a stable identifier per item               |
| Source of record | [Requirements implementation audit, 2026-08-27](requirements-implementation-audit-2026-08-27.md)      |
| Requirements     | [PRD v1.0](<../HelloReview Reviewer Campaign Automation Platform — Product Requirements Document.md>) |
| Contract         | [SPEC.md](../SPEC.md)                                                                                 |
| Gap tasks        | [tasks/requirements-gap-todo.md](../tasks/requirements-gap-todo.md)                                   |
| Status as of     | 2026-08-28, after T136                                                                                |
| Owning task      | T134                                                                                                  |

## Why this file exists

The supplied process arrived as a conversation. Every audit since has re-derived it from that
transcript, which means each audit's scope depends on which messages the auditor happened to read,
and a claim like "the process is 80% implemented" cannot be checked by anyone else.

This file fixes that by giving each supplied item a stable identifier that later work can cite. It
does not restate the process in Korean, replace the PRD, or add requirements: it is an index from
what was asked for to where the answer lives.

**It is a crosswalk, not an authority.** Where this file and the PRD disagree, the PRD wins. Where
this file and the code disagree, the code wins and this file is wrong.

## Identifier scheme

- `HRP-nn` — one supplied process capability. Numbers are permanent: an item that turns out to be
  out of scope is marked withdrawn, never renumbered or reused.
- `HRQ-nn` — one of the twelve launch questions the product owner asked.

The wording in the "Supplied capability" column is the audit's summary of the supplied item, kept
verbatim so the two documents cannot drift apart. Requirement references name a PRD requirement
family rather than a single id where the capability spans several.

## Process capabilities

| ID     | Supplied capability                                                   | PRD requirements         | Status (2026-08-27)                       | Closing task                    |
| ------ | --------------------------------------------------------------------- | ------------------------ | ----------------------------------------- | ------------------------------- |
| HRP-01 | Website application remains the source of truth                       | FR-APP-001…008           | Implemented for the manual pilot          | —                               |
| HRP-02 | Manual CSV workaround without website API/database access             | FR-APP-001…008           | Implemented                               | —                               |
| HRP-03 | Direct website applicant journey                                      | FR-APP, FR-ID, FR-SEL    | Missing end to end                        | T137, T138, T139                |
| HRP-04 | Kakao secret-comment claim journey                                    | FR-SC-001…004            | Missing                                   | T139, T145                      |
| HRP-05 | Match Kakao user to website application                               | FR-ID-001…012            | Partial                                   | T137, T147                      |
| HRP-06 | Blog ranking kept separate from application status                    | FR-APP, FR-SEL           | Implemented                               | — (UI naming fixed in T133)     |
| HRP-07 | Selection recommendation and manual approval                          | FR-SEL-001…012           | Implemented at the domain boundary        | T140                            |
| HRP-08 | Automatic selection when criteria clearly pass                        | FR-SEL-001…012           | Intentionally deferred                    | T127–T129                       |
| HRP-09 | Campaign type and Visit A/B/C routing                                 | FR-CAM-001…008           | Partial                                   | T136, T139                      |
| HRP-10 | Persistent multi-dimensional participant state                        | PRD §14                  | Implemented foundation                    | —                               |
| HRP-11 | Shipping address flow                                                 | FR-SHP-001…009           | Partial                                   | T141                            |
| HRP-12 | Payback explanation, explicit consent, decline, and one clarification | FR-PAY-001…008           | Partial                                   | T142                            |
| HRP-13 | Visit A phone instructions                                            | FR-VA-001…007            | Missing                                   | T136, T143                      |
| HRP-14 | Visit A date/time validation and guideline gate                       | FR-VA, FR-RES, FR-GDL    | Partial                                   | T143, T146                      |
| HRP-15 | Reservation validation rules                                          | FR-RES-001…012           | Implemented                               | — (parser defect fixed in T133) |
| HRP-16 | Visit B instructions and screenshot flow                              | FR-VB-001…008            | Intentionally deferred / partial          | T124–T126, T144, T150           |
| HRP-17 | Visit C approval-before-booking hard gate                             | FR-VC-001…008            | Implemented core                          | T144                            |
| HRP-18 | Guideline delivery only after all conditions pass                     | FR-GDL-001…007           | Partial                                   | T146                            |
| HRP-19 | Internal duplicate-message prevention                                 | FR-MSG-001…012           | Implemented                               | —                               |
| HRP-20 | Prevent duplicates with existing website/Aligo triggers               | FR-MSG-001…012           | External blocked                          | T148                            |
| HRP-21 | Human handoff and safe resume                                         | FR-HUM-001…009           | Partial                                   | T138, T151                      |
| HRP-22 | Complete operator timeline and campaign configuration                 | FR-ADM-001…012           | Partial                                   | T151                            |
| HRP-23 | Korean AI interpretation                                              | PRD §19                  | Partial / external blocked                | T149                            |
| HRP-24 | Reservation screenshot OCR                                            | FR-SC-006…007, PRD §19.4 | Intentionally deferred / external blocked | T150                            |
| HRP-25 | Production runtime                                                    | PRD §22, §27             | Missing                                   | T138, T147–T152                 |

`HRQ-05` moved forward in T136: the visitor metric period (`website_average_daily`), campaign-region
mapping, thresholds, review band, and non-selection policy are now versioned campaign policy that no
service may invent. The approved score source and controlled automatic selection remain T127–T129.

`HRP-22` and `HRQ-12` moved forward in T135: the inbound conversation, message, and secret-comment
history they named as absent now exists and projects into the operator timeline, so only the locked
production console remains.

Three rows changed after the audit was written, all in T133: HRP-06 and HRP-15 moved to
**Implemented** (the admin/console visitor-metric label and the disagreeing branch parsers were the
named defects), and HRP-14's corrections now carry safe Korean submitted and expected values. HRP-11
lost its caller-supplied validation policy but stays **Partial** — the pre-request state and the
participant-facing form are T141.

## Launch questions

| ID     | Question                                               | Answer today                                                                                                                     | Resolved by    |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| HRQ-01 | Website DB/API integration possible?                   | No verified API or database access. Manual XLSX-to-CSV import is the approved pilot path.                                        | Owner decision |
| HRQ-02 | How is Kakao identity matched to website applications? | Deterministic rules and persistence exist; no verified live Kakao identifier or orchestration.                                   | T137, T147     |
| HRQ-03 | Can existing Aligo trigger conditions be confirmed?    | Not from this repository. An account/source inventory is still required.                                                         | T148           |
| HRQ-04 | Can AI and existing-message duplicates be controlled?  | Inside the new outbox, yes. Across the legacy sender, not until the trigger audit and ownership plan exist.                      | T148           |
| HRQ-05 | Can blog score be checked automatically?               | Metric period and region mapping are now versioned campaign policy; the real score source and controlled auto-selection are not. | T127–T129      |
| HRQ-06 | Can secret-comment screenshots be analyzed?            | No. Attachment primitives exist; the OCR contract is reservation-only.                                                           | T145, T150     |
| HRQ-07 | Can Naver screenshots yield business/date/time?        | Contract, fake, and synthetic evaluation only; no real provider or live journey.                                                 | T150           |
| HRQ-08 | Can campaign weekdays/times be configured?             | Configuration services exist; the production-authenticated console is not connected.                                             | T151           |
| HRQ-09 | Can Visit A/B/C be configured per campaign?            | Yes in durable configuration; no end-to-end route dispatcher consumes it.                                                        | T138, T139     |
| HRQ-10 | Can difficult cases be handed to an operator?          | The durable service exists; production transport and real Kakao ownership signalling are missing.                                | T147, T151     |
| HRQ-11 | Are guidelines technically gated?                      | The predicate is strong; some caller-authoritative inputs remain and the real send runtime is inactive.                          | T146, T148     |
| HRQ-12 | Can operators see all history?                         | Inbound conversation, message, and secret-comment history now exist and project into the timeline; the console is locked.        | T151           |

## Keeping this current

An audit or task that touches a supplied capability cites its `HRP` or `HRQ` id and updates the
status column here in the same change. A status may only move to **Implemented** when the closing
task's acceptance criteria are met and its verification has actually been run — a passing build or a
service-level test is not evidence that a participant-facing journey works.

Do not add a row for something the product owner did not ask for. New scope belongs in the PRD
first, and reaches this file only once it has a requirement id.
