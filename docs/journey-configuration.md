# Journey configuration and notification ownership

T136 stores the configuration the participant journeys assumed but could not resolve, and turns
"missing configuration" from a runtime surprise into an activation refusal. It connects no provider
and enables no automation.

## What was already there

Most of T136 needed no schema change, which is worth recording so nobody adds a second home for it:

- `campaign_businesses.phone` and `.booking_url` have been versioned and effective-dated since T23.
  T136 does not add them — it makes activation **require** them for the routes that send them.
- `message_templates` already records all five §21.9 review outcomes per template: legal
  classification, prior consent, quiet hours, opt-out notice, sender identification, plus Alimtalk
  approval and the provider template code.
- `campaign_rules` already had `rule_type = 'selection'` with frozen published versions. T136 adds
  the parser, not the storage.

## What is new

### `campaign_journey_configurations`

Versioned per campaign, same shape and freeze rules as `campaign_businesses`. Holds the website
`application_url`.

PRD §14.5 has always made _"Campaign application URL exists"_ a mandatory guard on
`Not Applied → Application Requested`, and §32.1 defines the Korean template that interpolates
`{{application_url}}` — but there was nowhere to put one, so the guard could not be evaluated and the
message could not be composed.

The URL is interpolated into a participant message verbatim, so the CHECKs are strict: HTTPS only,
no userinfo, no query string, no fragment. `http://` would send a participant to a page their browser
flags, and a `?token=` would turn a template into a credential leak.

### `message_purpose_ownership`

Versioned per campaign **and** purpose stem. Records who authoritatively sends each participant-facing
message during the Aligo cutover: `website_legacy_trigger`, `helloreview_platform`, or
`operator_manual` — plus the trigger-audit status, a pseudonymous reference to the legacy trigger, and
whether this platform must suppress its own send.

The load-bearing constraint:

```sql
CHECK (authoritative_sender <> 'helloreview_platform' OR trigger_audit_status <> 'not_audited')
```

**This platform cannot claim a purpose whose legacy trigger nobody has looked for.** T148's inventory
has not happened, and without this constraint a campaign could activate believing it owns a message
the website also still sends — the participant receives both. The legacy trigger may own a purpose
while unaudited, because that is the honest cutover state, but then it has to be pointed at:
`authoritative_sender = 'website_legacy_trigger'` requires a `legacy_trigger_reference`.

There is deliberately no `unknown` sender. Absence of a row **is** "not decided", and that is what
activation refuses on. Making it storable would let a campaign activate while declaring that nobody
in particular owns its participant messages.

`legacy_trigger_reference` is shape-checked to reject anything URL-like or credential-like: this table
is read by the operator console, and "queryable without secrets" is one of T136's criteria.

### `APPLICATION_REQUEST` message purpose

Found missing during this task. §14.5 required the application URL, §32.1 defined the template, and
FR-SC-002 required a secret-comment claimant to receive it — but `MESSAGE_PURPOSES` had all twenty
codes and none was that message, so the one message that starts the secret-comment route could not
pass through the outbox. It is now purpose 0, and activation requires an active template for it.

### Versioned selection policy

`parseSelectionRuleConfiguration` reads a published `campaign_rules` selection configuration:
measurement period, eligible levels, general and regional visitor thresholds, review band, region
mapping, eligible and regional regions, and the non-selection notice policy.

Nothing in it is defaulted. A threshold this parser invented would be a selection policy nobody
approved. `automaticSelectionEnabled` is pinned `false` by the schema — the field exists so it is
provably false rather than absent and assumed, and T129 is the only task that may ever change it.

This **stores** the product owner's stated preferences as versioned policy. It does not enable them:
selection stays manual.

## The visitor metric period

The website exports `블로그일평균방문자수` — average daily blog visitors — into
`applications.blog_daily_visitors`. The approved period name is **`website_average_daily`**, and it is
currently the only member of `VISITOR_MEASUREMENT_PERIODS`.

`RankingEvidenceAdapter.read` no longer accepts `measurementPeriod` from its caller. It used to, and
that made the evaluator's period-agreement check meaningless: a caller could label the evidence
`previous_calendar_day` and declare the same on the policy, and the check would pass while scoring a
metric that is actually average-daily. The adapter now reports the period of the column it reads.

**Consequence, stated plainly:** a policy claiming `previous_calendar_day` now mismatches and routes
to `human_review` with `VISITOR_MEASUREMENT_PERIOD_MISMATCH`. That is the correct fail-closed
behaviour. A genuine previous-day metric would be a new period member **and** a new evidence source,
never a rename of this one.

## Activation now refuses

`validateCampaignActivation` stays a pure function over a snapshot. It now also requires:

| Requirement                                                 | Applies to                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A current published application URL                         | Every campaign — §14.5 puts the guard on the Application dimension, which every type has |
| A current business phone                                    | Visit A only (§13.8)                                                                     |
| A current booking URL                                       | Visit B and C only (§13.9, §13.10)                                                       |
| A named authoritative sender per required purpose           | Every route                                                                              |
| An audited legacy trigger before a platform ownership claim | Every route                                                                              |
| A parseable selection policy                                | Every campaign                                                                           |

Every issue is reported together, as the validator already did — an operator sees the whole gap, not
the first item.

## Verification

```text
pnpm exec vitest run --project unit tests/unit/campaign-activation-validator.test.mjs
pnpm exec vitest run --project unit tests/unit/selection-policy-configuration.test.ts
pnpm exec vitest run --project integration tests/integration/journey-configuration-and-ownership.test.mjs
```
