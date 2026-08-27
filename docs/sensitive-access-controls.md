# Sensitive reveal and export controls

This document covers T109 and the T110 end-to-end authorization proof. It does not approve a
production reveal/export policy, connect an export destination, or permit the operator console to
display raw personal data by default.

## Two independent gates

A shipping-address reveal requires both of these versioned decisions:

1. `admin-authorization-policy-v1` must authorize `sensitive_values.reveal` for the verified
   principal. The deterministic fixture requires a globally scoped `privacy_reviewer` session with
   phishing-resistant assurance.
2. `sensitive-access-policy-v1` must allow exactly one `shipping_address.reveal` record for the
   supplied reason code in the current environment.

Commands submit only a policy-version reference. `SensitiveAccessAdminService` resolves the current
document through the injected trusted `SensitiveAccessPolicyProvider` and then validates it; a
caller cannot submit or replace the policy object. The default module provider is production-locked
and returns `SENSITIVE_ACCESS_POLICY_PROVIDER_LOCKED` until an approved durable policy store is
implemented. The deterministic provider accepts test fixtures only and rejects stale versions or
environment mismatches.

The sensitive-access parser rejects unknown fields, missing/duplicate operations, unapproved
production fixtures, missing dual approval references, unknown reason codes, and record counts
above the operation limit. The included policy is deterministic test data only and cannot parse as
a production fixture.

## Evidence boundary

Masked address reads remain the ordinary path. Every rejected admin reveal attempt writes a
protected `SENSITIVE_FIELD_REVEALED` audit row without plaintext. A successful reveal inserts the
append-only `shipping_address_reveals` row and the protected `audit_logs` row in the same database
transaction before decrypting and returning the address. If either insert or decryption fails, the
transaction rolls back and no plaintext is returned.

The protected audit detail contains only pseudonymous object references and authorization evidence:
the workflow, participant, campaign, request, and session references plus the admin and sensitive
policy versions. It never contains the decrypted address, name, phone, or provider credential.

## Export safe fallback

`sensitive_data.export` has the same RBAC and separate-policy gates. Even after both test gates pass,
the current implementation performs no export and returns `unavailable_safe_fallback`. The request
is recorded as a protected `SENSITIVE_DATA_EXPORT_REQUESTED` rejection with only the requested
record count and policy metadata.

This is intentional. A real bulk export still needs the company-approved reveal/export policy, an
approved destination and format, bounded retention, delivery authentication, and a durable job
boundary that can prove whether a multi-record export partially completed. None of those decisions
are inferred from the test fixture.

## End-to-end proof

`tests/integration/admin-api-authorization-e2e.test.mjs` applies every migration to an isolated
PostgreSQL instance and proves:

- permitted and denied campaign scope;
- rejection of a stale authorization version;
- masked participant search against real SQL;
- rejected and successful reveal audit evidence;
- rejection of caller-supplied or stale sensitive-policy state;
- stale failed-job status rejection; and
- one immutable retry receipt across an identical replay.

Run the focused checks with:

```powershell
pnpm run build:fresh
pnpm exec vitest run --project unit tests/unit/sensitive-access-admin.test.mjs
pnpm exec vitest run --project integration tests/integration/participant-flow-foundations.test.mjs
pnpm exec vitest run --project integration tests/integration/admin-api-authorization-e2e.test.mjs
```

Container-backed tests require Docker or another Testcontainers-compatible runtime.
