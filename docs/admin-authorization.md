# Administrative authorization

This document covers T103's provider-neutral operator principal and T104's deny-by-default
authorization boundary. T105–T110 use this boundary for the administrative service surface and its
end-to-end proof. It does not select an identity provider, approve the production role matrix, or
expose an administrative HTTP endpoint. Sensitive access has an additional independent policy
documented in [Sensitive reveal and export controls](sensitive-access-controls.md).

## Operator principal

`operator-principal-v1` is accepted only when all of the following are explicit:

- a pseudonymous principal, session, and authentication-context reference;
- `verified = true` from a future trusted authentication adapter;
- one or more known PRD §20.2 roles;
- either global scope or a non-empty canonical list of campaign UUIDs;
- an assurance level (`single_factor`, `mfa`, or `phishing_resistant`);
- the authorization-policy version and current authorization snapshot version;
- test or production environment plus a finite issue/expiry window.

Unknown fields, unknown or duplicate roles, ambiguous scope, raw phone/email/URL references, invalid
versions, and invalid time windows fail closed. The contract deliberately contains no SSO, local
account, password, token, JWT, cookie, or vendor-specific claim. A future adapter must verify its
provider credential and then construct this internal principal.

## Authorization policy and enforcement

`admin-authorization-policy-v1` must map every action in the fixed `ADMIN_ACTIONS` inventory exactly
once. The inventory covers the administrative reads and commands anticipated by T105–T109,
including human-task commands, configuration publication, retries, privacy controls, sensitive
reveals, and exports. Each entry supplies:

- allowed roles;
- `campaign_required`, `global_required`, or `unscoped` scope;
- minimum assurance.

Authorization rejects an unknown action before evaluation. A known action is denied when the
principal or policy environment differs, production policy is not approved, the policy or current
authorization version is stale, the session is not yet valid or expired, no role matches, assurance
is insufficient, or scope is missing/outside the principal's campaign list.

Allow and deny decisions retain pseudonymous principal/session/correlation context, policy and
authorization versions, matched role, action, and evaluation time. This makes them suitable as input
to the immutable audit writer when the administrative command layer lands; no identity-provider
payload is copied into the decision.

## Test fixture versus production

`admin-rbac-test-fixture-v1` is deterministic test data only. The policy parser permits a
`test_fixture` only in the test environment with no approval references, and authorization rejects
it in production before considering its permissions.

The fixture is not the approved HelloReview RBAC matrix. Production requires:

1. a company-approved role/action/scope matrix;
2. a security approval reference;
3. the authentication decision (SSO or local accounts with MFA);
4. a trusted adapter that supplies current authorization versions and immediate deprovisioning;
5. administrative command handlers that call `assertAdminAuthorized` and append the decision to
   protected audit evidence.

## Verification

```powershell
pnpm build:fresh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec vitest run --project unit tests/unit/operator-principal.test.mjs
pnpm exec vitest run --project unit tests/unit/admin-authorization.test.mjs
pnpm exec vitest run --project unit tests/unit/module-boundaries.test.mjs
```
