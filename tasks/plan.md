# Implementation Plan: HelloReview Reviewer Campaign Automation Platform

| Field          | Value                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Plan version   | 1.1                                                                                                                           |
| Status         | Milestones 1–2 plus Milestone 3 T88–T99 and T103–T108 complete; policy approvals and remaining operations UI/API tasks remain |
| Spec           | [SPEC.md](../SPEC.md) (capability map in §3)                                                                                  |
| Requirements   | [PRD v1.0](../HelloReview%20Reviewer%20Campaign%20Automation%20Platform%20—%20Product%20Requirements%20Document.md)           |
| Task lists     | [Milestone 1](todo.md) · [Milestone 2](milestone-2.md) · [Milestone 3](milestone-3.md)                                        |
| Detailed scope | Milestone 1: 56 tasks; Milestone 2: 31 tasks; Milestone 3: 30 tasks                                                           |
| Outlined scope | Milestone 4, broken down at its checkpoint                                                                                    |

---

## Overview

Milestone 1 builds a **walking skeleton**: a thin but complete path through the architecture in
`§10.3` of the PRD — signed webhook → validated event → deduplicated inbox → workflow transition
under optimistic locking → deterministic gate → transactional outbox → provider send — with every
external provider replaced by an in-repo fake.

At the end of Milestone 1 no participant-facing campaign flow exists yet. What exists is proof that
the mechanisms the entire product depends on actually hold: duplicate events produce one effect,
illegal transitions are rejected, the guideline gate cannot be bypassed, and human ownership
suppresses automation. Six of the PRD's eight `§26.3` acceptance tests pass; AC-05 and AC-07 remain
with their planned Milestone 2/4 modules.

That ordering is deliberate. Every campaign flow in Milestone 2 is a consumer of these mechanisms.
Building shipping or payback first would mean building them twice — once against assumptions, once
against the real spine.

---

## Scope of this plan

**Milestones 1–3 are broken down.** Milestone 2 was expanded at Checkpoint E after the spine's real
shape was proven, and Milestone 3 was expanded at Checkpoint F after the participant-flow slices
were verified. Milestone 4 remains an outline and gets its task breakdown at the preceding
checkpoint.

---

## Architecture decisions

**The PRD's acceptance tests are the vertical slices.** `§26.3` gives eight Given/When/Then tests.
Each one is a participant-visible outcome that cuts through several modules, which is exactly the
vertical slice this plan needs. Rather than invent slice boundaries, the phases below are organized so
each terminates in one of these tests going green. Phases 2, 4, 6, and 7 each end on an acceptance
test task. This also means the tests that gate release are written during the build, not retrofitted.

**Only Phase 0 is horizontal, and it is kept as thin as it can be.** There is no vertical slice that
runs before a workspace, a database, and a test harness exist. Phase 0 builds those and stops — no
speculative abstractions, no modules that nothing yet consumes.

**The guideline gate is built in Milestone 1 despite being Wave 7 in the capability map.** The map's
waves express dependency, not priority. `evaluateGuidelineReadiness()` is a pure function over a
workflow snapshot, so it needs `workflow-core` to exist but needs nothing from `shipping`,
`payback-consent`, or `reservation` — which is precisely the boundary decision recorded in SPEC.md
§3.3. Building it now both de-risks the product's top critical requirement (`§25`: zero premature
deliveries) and validates that boundary decision empirically. If the gate turns out to need those
modules, the map is wrong and we learn it in Milestone 1 rather than Milestone 3.

**Module boundaries are enforced by lint from task T6, before there are modules to violate.** SPEC.md
§5 says a cross-module import not listed in the §3.1 dependency table is a lint failure. Adding that
rule after twenty modules exist means a large retroactive cleanup; adding it first means the rule is
never wrong.

**Fakes are the default, everywhere, permanently.** Per the approved vendor approach, `packages/adapters/fakes`
is what dev and every test tier run against. Real adapters land behind the identical port and are
proven by the same conformance suite (T20). No task in this milestone is blocked on a vendor contract,
which matters because `§30` rates Kakao inbound capability as high-probability, critical-impact.

**Idempotency is proven before any flow can depend on it.** T21 (AC-02) lands in Phase 2, before a
single business flow exists. Every later flow inherits a mechanism that has already been demonstrated
rather than one that is assumed.

**Nothing AI-related is in Milestone 1.** `ai-orchestration` is a Wave 5 module and the spine does not
need it. Deferring it keeps the milestone deterministic — every test in Milestone 1 is a hard
assertion, with no scored-evaluation tier to reason about.

---

## Dependency graph

```
Phase 0  toolchain · services · api+worker boot · boundary lint · test harness · config · drizzle
            │
Phase 1  correlation+logging+mask ──► PII-leak matcher
            │                              │
            └──► audit-log ◄───────────────┘
                    │
Phase 2  contracts (§18) ──► event_inbox ──► webhook gateway ──► fake inbound + conformance
                                                  │
                                                  └──► [AC-02] duplicate webhook
            │
Phase 3  campaign-config (campaigns · rules · windows · blackouts · business · versions · activation)
            │                                   │
            └──► application-sync ◄─────────────┘
                    │
Phase 4  identity-resolution ──► human-tasks (minimal) ──► [AC-04] ambiguous identity
                    │
Phase 5  workflow-core (transition · guards · illegal · pauses · corrections · stale events)
                    │
Phase 6  messaging (dedupe key · outbox · templates · send worker · ownership) ──► [AC-06] concurrency
                    │
Phase 7  rules-engine ──► business-approval ──► [AC-01] Visit C gate
                    │                                   │
                    └──► guideline-delivery ◄───────────┘
                                    │
                                    └──► [AC-03] readiness · [AC-08] version update
```

Build order runs bottom-up. Phases 3 and 4 are the only place with meaningful parallelism within
Milestone 1: `campaign-config` (T22–T26) and the `application-sync` port work (T27) can proceed
concurrently once Phase 2 closes, provided the applications schema lands after campaigns.

---

## Task list

Full task detail — description, acceptance criteria, verification, dependencies, files, size — is in
[tasks/todo.md](todo.md). Index:

| Phase                                | Tasks   | Delivers                                                   | Ends on                                  |
| ------------------------------------ | ------- | ---------------------------------------------------------- | ---------------------------------------- |
| 0. Foundation                        | T1–T9   | Buildable, testable, lintable workspace with a database    | Checkpoint A                             |
| 1. Observability and audit           | T10–T13 | Correlation IDs, masked structured logs, append-only audit | —                                        |
| 2. Idempotency spine                 | T14–T20 | Signed webhook → deduplicated inbox, with fakes            | **AC-02** · Checkpoint B                 |
| 3. Configuration and source of truth | T21–T27 | Versioned campaign rules; synchronized applications        | —                                        |
| 4. Identity                          | T28–T33 | Deterministic matching, ambiguity → human task             | **AC-04** · Checkpoint C                 |
| 5. Workflow core                     | T34–T40 | State machine, optimistic locking, pauses, corrections     | Checkpoint D                             |
| 6. Outbound and deduplication        | T41–T47 | Transactional outbox, dedupe keys, ownership lock          | **AC-06**                                |
| 7. The gates                         | T48–T56 | Rules engine, Visit C hard gate, guideline readiness       | **AC-01 · AC-03 · AC-08** · Checkpoint E |

Two of the eight `§26.3` acceptance tests are deferred with their modules: AC-05 (payback consent
versioning) to Milestone 2, and AC-07 (screenshot prompt injection) to Milestone 4 with
`ocr-extraction`.

---

## Milestones 2–4

**Milestone 2 — Participant Flows.** Detailed as T57–T87 in
[tasks/milestone-2.md](milestone-2.md): `attachments`, `ai-orchestration`, `selection`
(recommendation-only), `shipping`, `payback-consent`, and `reservation` (Visit A path). It delivers
the first participant journeys and **AC-05**, while keeping the manual website CSV pilot and
automatic selection disabled. It introduces the scored-evaluation tier for Korean intent and date
parsing. Maps to PRD rollout phases 2–4.

**Milestone 3 — Operations Surface.** Detailed as T88–T117 in
[tasks/milestone-3.md](milestone-3.md): `human-tasks` (full case packet, SLA, return-to-automation),
`privacy-ops`, `admin-api` with RBAC, `operator-console` across the `§20.1` page list. This is what
makes the platform operable — until it lands, everything above is only reachable through tests.
Maps to PRD rollout phases 1 and 3.

**Milestone 4 — Later Phases.** `ocr-extraction` unlocking Visit B and full Visit C (**AC-07**),
`blog-score` unlocking shadow-mode auto-selection, `analytics`. Each is separately gated on vendor,
accuracy, or legal approval per PRD `§27` phases 5–8.

---

## Risks and mitigations

Plan-level risks — what could derail this task sequence, as distinct from the product risks in PRD `§30`.

| Risk                                                                                                 | Impact                                                                                                | Mitigation                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kakao 상담톡 exposes no stable user or conversation identifier                                       | High — `identity-resolution` (T28–T31) and channel persistence are built on the assumption one exists | The fake defines the port we need. T19's conformance suite becomes the exact question list for the dealer. If no stable id exists, the fallback is per-conversation re-verification, and we learn the cost in Phase 4 rather than at integration |
| The website cannot emit source event ids                                                             | High — the entire inbox idempotency model (T15–T18) assumes them                                      | T27 builds the reconciliation path alongside the event path, so `application-sync` works in polling mode if events never arrive. Slower, not blocked                                                                                             |
| `workflow-core` (T34–T40) is underestimated                                                          | Medium — it is the largest single module and everything after Phase 5 waits on it                     | It is split into seven tasks with the transition table (T36) and illegal transitions (T37) separated, so the guard logic can be reviewed before the full `§14.5` table is encoded. Checkpoint D exists specifically to catch overrun here        |
| The guideline gate turns out to need flow-module state                                               | Medium — would invalidate the SPEC.md §3.3 boundary decision and reorder Milestone 2                  | This is why the gate is in Milestone 1. T53 constructs snapshots directly; if a required fact is not on the snapshot, the map is wrong and we revise it with one module built, not six                                                           |
| Coverage thresholds on pure modules (100% branch on `rules-engine`, gates, validators) slow delivery | Low                                                                                                   | These modules are pure and small by construction. If a threshold is fighting the work rather than the risk, that is a signal the module is not actually pure — treat it as a design smell, not a threshold to lower                              |
| 56 tasks is a large batch to review before any of it runs                                            | Medium                                                                                                | Checkpoints A–E each leave the system in a working, demonstrable state. Checkpoint B (AC-02 green) is the first real proof and arrives at task 20                                                                                                |

---

## Open questions

Carried forward from SPEC.md §10 — restated here only where they change _this plan's_ task ordering.

1. **Capability-map approval was implicit.** This plan proceeds on the map in SPEC.md §3 as written.
   If the four boundary decisions in §3.3 are contested — particularly `guideline-delivery` not
   depending on the flow modules — Phase 7 changes shape. Worth settling before T48.
2. **Hosting region and overseas AI processing** (PRD `§35`). Does not block Milestone 1, which has no
   AI. Must be settled before Milestone 2 begins.
3. **Retention periods per data class** (`§21.6`). Does not block Milestone 1. Blocks `privacy-ops` in
   Milestone 3.
4. **Operator-console authentication — SSO or local accounts with MFA.** Blocks `admin-api` in
   Milestone 3; T13's audit schema should be reviewed against the answer, since actor identity shape
   depends on it. Low cost to change now, higher later.
5. **Should the PRD move to `docs/PRD.md`?** T1 sets up the workspace and is the natural moment. Left
   in place pending your call.
