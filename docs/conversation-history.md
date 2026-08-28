# Inbound conversation and evidence history

T135 adds the durable records for conversations, inbound messages, attachment linkage, and
secret-comment evidence. It stores history; it does not run a journey. Consuming these records from
a dispatcher is T138, and the participant-facing routes that produce them are T139 onward.

## What each table is for

| Table                              | Shape                  | Holds                                                                      |
| ---------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `conversations`                    | Mutable head           | One provider thread, its current bindings, and its lifecycle state         |
| `conversation_events`              | Append-only            | Every binding change and lifecycle transition, with justifying evidence    |
| `inbound_messages`                 | Append-only            | One row per provider message, with coded metadata and the participant text |
| `secret_comment_evidence_versions` | Append-only, versioned | The participant's secret-comment claim and its screenshot, supporting-only |

`attachments.inbound_message_id` and `outbound_notifications.conversation_id` are additive nullable
columns that connect the existing tables to this history. `attachments` has UPDATE revoked, so rows
written before `inbound_messages` existed keep only the free-text `source_message_reference` they
have carried since T88; new rows set both.

## Idempotency

Two unique constraints carry the guarantee, and neither is advisory:

- `conversations (provider, provider_conversation_id)` — a provider retry updates the observation
  window and returns the same row instead of creating a rival conversation. The constraint is on the
  pair for the same reason `event_inbox` constrains `(source, external_event_id)`: two providers
  numbering threads from 1 is ordinary, and constraining the thread id alone would discard the
  second provider's traffic while looking like successful deduplication.
- `inbound_messages (conversation_id, provider_message_id)` — the same message arriving twice
  collapses to one row and the caller is told it was deduplicated.

**A provider retry and a participant repeating themselves are different facts.** The unique pair
collapses the first. `content_digest` — computed in the service from the normalized body, never
accepted from the caller — lets an operator see the second without the two being merged. A
caller-supplied digest could be made to match anything, and duplicate detection a caller can steer is
not duplicate detection.

An out-of-order redelivery moves `last_observed_at` forward with `GREATEST`, so a late arrival cannot
rewind the window.

## Reassignment, closure, deletion, and ambiguity

A conversation that turns out to belong to someone else is **rebound**, not overwritten. The
rebinding is its own event type carrying both the old and the new participant, because the previous
belief is evidence: an identity dispute needs to see that the thread was once routed elsewhere.
The database refuses a rebinding event that does not name both sides or names the same one twice.

`closed_by_provider` and `deleted_by_provider` are distinct states. A closed thread can be reopened
and still reconciles; a deleted one means the provider will not serve it again and our copy is the
only record, so it is terminal and the service refuses to reopen it. `ambiguous` and its resolution
are recorded the same way, so a thread that could not be attributed leaves a reconstructable trail
rather than a gap.

A workflow binding requires a participant binding first. The service refuses it and
`conversations_binding_coherence` refuses it again, so a direct writer cannot route around the
service.

## Secret-comment evidence is supporting evidence

Versions supersede rather than replace: a replacement screenshot appends a new version pointing at
the previous one, so an operator can see the participant sent a different image the second time.

The table has **no** column that could bind an application, decide a selection, record a
verification, or approve anything, and `supporting_only` carries a CHECK pinning it true. "This
evidence is authoritative" is not a row anyone can write — not a caller, not a later migration
author. FR-SC-001–004 make the claim a hint that a deterministic service must still confirm. Reading
the screenshot itself automatically is T145 and is not implemented.

## Retention, masking, and disclosure

Every table here is `conversation_content` under the §21.6 retention classes, which the schedule enum
already carried before this task; the linked file stays `attachments`. Legal-hold record references
follow the existing `<kind>:<pseudonymous-id>` convention: `conversation:<uuid>`,
`inbound_message:<uuid>`, `secret_comment_evidence:<uuid>`.

`inbound_messages.body_text` is the participant's own words and is the only free-text content here.
It is **stored** and **not disclosed**:

- no read path in the `conversations` module selects it — `body_text` appears in no column list in
  that module outside the insert;
- the operator timeline projects codes, versions, and reason codes only, exactly as
  `outbound_notifications.rendered_content` has always been treated; and
- reading it back would need a governed sensitive-access operation, which does not exist. Adding one
  is a new RBAC and privacy decision, not a code change.

A security test asserts all three, and separately asserts the text really is stored — this is a
disclosure boundary, not a claim that nothing is kept.

## Immutability

`conversation_events`, `inbound_messages`, and `secret_comment_evidence_versions` are protected
twice, because the two mechanisms fail differently:

- `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` stops the application role from issuing the
  statement at all, and `tools/db-provision-role.mjs` asserts it on every provision; and
- `ENABLE ALWAYS` triggers stop the table owner and anything running as it, which a REVOKE cannot.

`conversations` is deliberately not protected: it is a mutable head whose every change is written to
the frozen `conversation_events`.

## Verification

```text
pnpm exec vitest run --project integration tests/integration/conversation-history.test.mjs
pnpm exec vitest run --project security tests/security/conversation-history-boundary.test.mjs
pnpm db:check
```
