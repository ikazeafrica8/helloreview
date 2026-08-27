# Operator console

The T111–T117 operator console lives in `apps/admin` and uses the Next.js App Router. It is a
server-rendered interface boundary over the T103–T110 administrative contracts; it never imports
Nest services, connects directly to PostgreSQL, or turns transport-neutral services into public
HTTP endpoints.

## Session and data boundaries

The console defaults to `ADMIN_CONSOLE_SESSION_MODE=disabled`. Every console route then renders a
Korean access-blocked screen before page content or commands are exposed.

For local UI and release-test development only:

```powershell
$env:ADMIN_CONSOLE_SESSION_MODE='test_fixture'
pnpm dev:admin
```

The server-only, asynchronous console gateway has two adapters:

- `DeterministicOperatorConsoleGateway` supplies pseudonymous, repeatable test records and evaluates
  command forms without external writes.
- `ProductionLockedConsoleGateway` returns no records or commands and is the default until an
  authenticated, authorized HTTP adapter is approved.

Pure gateway/session contracts are isolated from the server-only environment provider so they can
be tested deterministically without weakening the React Server Component boundary. Every read page
re-checks its canonical action and campaign scope, then passes the verified session into the
gateway, which repeats the same check at the data boundary. A layout session check is presentation
gating only. The deterministic fixture grants the complete read-only action set; it grants no
sensitive reveal/export permission.

The environment parser rejects `test_fixture` when `NODE_ENV=production`. The fixture is not an
operator identity, RBAC matrix, SSO session, cookie, token, or MFA result. Authentication is
evaluated at request time with `await connection()`, so a build cannot freeze a test session into
generated HTML.

## PRD page inventory

The canonical PRD §20.1 registry contains exactly twenty routes, including the two dynamic pages:

1. `/overview`
2. `/participants`
3. `/participants/[participantId]`
4. `/human-review`
5. `/campaigns`
6. `/campaigns/[campaignId]`
7. `/selection-rules`
8. `/reservation-rules`
9. `/business-approvals`
10. `/message-templates`
11. `/guidelines`
12. `/notifications`
13. `/deduplication`
14. `/failed-jobs`
15. `/integrations`
16. `/audit`
17. `/privacy`
18. `/users-roles`
19. `/automation-pauses`
20. `/ai-cost`

`/sensitive-access` and `/system` remain explicit governance extensions and do not substitute for a
PRD page.

T112 supplies the overview, POST-based masked participant search, campaign-scoped participant
detail, and the complete §20.3 timeline presentation contract. Search terms and cursors are sent in
the request body rather than copied into URL history. Application lifecycle status and blogger
evidence remain separate. The deterministic timeline represents every required category without
exposing raw messages, identity evidence, AI/OCR material, or personal data. Its typed response
reports category availability. A future production adapter must return only persisted sources and
mark unsupported categories explicitly; it must not invent events to fill current API gaps.
The participant-search Server Action independently re-checks the session, canonical action, and
campaign scope. Search and timeline cursors that were not issued by the fixture fail closed with
`ADMIN_CURSOR_INVALID` instead of silently replaying the first page.

T113 supplies the human-review, business-approval, failed-job, notification, and duplicate-history
queues. T114 supplies campaign, selection-rule, reservation-rule, message-template, and guideline
editors with actual fixture draft fields, deterministic schema validation, preview results,
versions, maker-checker evidence, and lifecycle states. Draft previews return coded results without
storing content or calling an external system. T115 supplies integration, audit, privacy,
users/roles, automation-pause, and AI/cost pages. T113 and T115 data remains read-only fixture
projection until authorized query and command transports exist.
The campaign editor accepts only the current command contract's `draft`, `active`, `paused`, and
`closed` states and rejects invalid calendar dates or an end date that is not after the start date.

## Command safeguards

All fixture command forms use one typed evaluator and make their non-production behavior visible.
Scenario IDs are separate from the canonical T103 authorization action shared by the API and
console. Depending on the action, forms require an operator reason, the exact phrase `실행 확인`,
and the expected version. The discriminated action contract makes version fields structurally
impossible on policy-blocked actions; the UI withholds them and evaluates policy before input or
stale-state checks. Allowed actions report stale versions explicitly, distinguish previews from
commands, and never perform an external write.

Sensitive data stays masked. Reveal actions remain policy-denied, ordinary bulk export is absent,
production changes are visibly blocked, and the emergency automation-pause banner is present on
every console route. Versioned rule, template, and guideline examples show the
draft/approved/scheduled/active/retired lifecycle without bypassing manual approval.

## Accessibility and release verification

The console provides Korean-first navigation, a keyboard skip link, native interactive elements,
visible focus, semantic status text, an accessible mobile disclosure, reduced-motion support,
request-time loading and error states, and no-index metadata.

Run the reproducible browser release suite with installed Chrome:

```powershell
pnpm test:operator-e2e
```

The runner first builds the standalone production artifact. A fixture-development lane exercises
all twenty canonical routes, POST search, masked and campaign-scoped participant behavior,
deterministic editors, permitted, preview, stale, and denied command outcomes, keyboard and
390-pixel navigation, and representative desktop/mobile axe WCAG A/AA checks. A second lane starts
the built standalone artifact with the default locked session and proves representative static and
dynamic routes expose no fixture content. Both lanes fail on browser page errors, browser
`console.error`, or unexpected server runtime errors. The runner terminates only the process trees
it started and refuses to use an occupied port.

Next.js owns `apps/admin/next-env.d.ts`; it is ignored as generated output. The admin typecheck runs
`next typegen` first so a fresh checkout receives current route declarations without leaving
environment-dependent generated changes in Git.

Production rollout remains blocked on the approved authentication adapter, current RBAC and
campaign scope, authorized read/command transports, and the policy decisions named in Milestone 3.
