# Secure attachment operations

Phase 8 stores attachment evidence without placing raw file bytes in PostgreSQL, Redis jobs,
workflow events, structured logs, or audit detail. The application encrypts every object with
AES-256-GCM before sending it to S3-compatible storage. PostgreSQL retains only immutable evidence,
append-only security/lifecycle history, and SHA-256 digests of one-time access tokens.

## Current safety boundary

- Accepted files are PNG, JPEG, GIF, WebP, and PDF, up to `ATTACHMENT_MAX_BYTES`.
- Filename extensions do not establish type. The ingest gate checks the declared type, final
  extension, byte signature, double extensions, size, and plaintext SHA-256 hash.
- New evidence starts quarantined. Only the latest `clean` security state can be linked or receive a
  read grant.
- Upload and read grants are scoped to one workflow and participant, stored only as token digests,
  consumed atomically once, and recorded in append-only grant history.
- The configured object-store reference is opaque in the database. A signed read lasts at most 15
  minutes; the local default is five minutes.
- A missing retention policy blocks deletion. An active legal hold overrides a supplied policy.

No malware-scanner vendor is approved or configured yet. The deployed default intentionally returns
`MALWARE_SCANNER_UNAVAILABLE`, records `scan_failed`, keeps the encrypted object for operator review,
and refuses linking or reading it. Do not replace this with an allow-on-error fallback.

## Required deployment configuration

Set these through the deployment secret/configuration service, never a committed environment file:

| Variable                            | Requirement                                                            |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `S3_ENDPOINT`                       | HTTPS S3-compatible endpoint in deployed environments                  |
| `S3_BUCKET`                         | Private bucket dedicated to the environment                            |
| `S3_ACCESS_KEY_ID`                  | Scoped service-account key; no bucket-administration permission        |
| `S3_SECRET_ACCESS_KEY`              | Scoped service-account secret                                          |
| `ATTACHMENT_ENCRYPTION_KEY_BASE64`  | Base64 encoding of exactly 32 random bytes, kept in the secret manager |
| `ATTACHMENT_MAX_BYTES`              | Whole bytes, 1 through 52,428,800; local default 10,485,760            |
| `ATTACHMENT_READ_GRANT_TTL_SECONDS` | 30 through 900 seconds; local default 300                              |

The encryption key is independent of the object-store credential. Losing it makes stored objects
unrecoverable; disclosing it exposes every object encrypted with it. Back it up under the same
controls as production database credentials. Key rotation is not implemented in Phase 8, so do not
replace an active key until a versioned re-encryption procedure has been approved and tested.

The bucket must remain private. Grant the application only object read, write, head, and delete for
the attachment prefix. The application creates short-lived presigned reads; no object should have a
public ACL.

## Local verification

The local stack uses MinIO on loopback only. `.env.example` contains local placeholders; copy it to
the ignored `.env` file and run:

```powershell
pnpm services:up
pnpm db:migrate
pnpm exec vitest run --project integration tests/integration/attachment-storage-minio.test.mjs
pnpm exec vitest run --project security tests/security/attachment-security.test.mjs
pnpm exec vitest run --project e2e tests/e2e/secure-attachment-journey.test.mjs
```

Stop the stack without deleting its volumes:

```powershell
pnpm services:down
```

Use `pnpm services:reset` only when deliberately discarding all local PostgreSQL, Redis, and MinIO
data.

## Operator response

The latest security event controls the response:

| State         | Meaning                                               | Action                                                      |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| `quarantined` | Evidence is stored but scanning has not started       | Do not link or download; investigate a stalled pipeline     |
| `scanning`    | A scanner request is in progress                      | Do not link or download; investigate if it remains stale    |
| `clean`       | Approved scanner returned clean                       | Evidence may be linked and read through a one-time grant    |
| `rejected`    | Malware was detected                                  | Keep isolated; follow the approved incident process         |
| `scan_failed` | Scanner was unavailable, timed out, or returned error | Keep isolated; retry only through an approved operator flow |

Repeated grant failures should be investigated using grant event reason codes and correlation IDs.
Never log, paste into tickets, or store the raw token, signed reference, object-store credential, or
attachment bytes. Cross-owner and missing-object requests intentionally return indistinguishable
errors.

## Retention and deletion

Phase 8 does not invent retention periods. Until a reviewed policy reference is supplied, deletion
records `deletion_blocked_policy_missing` and leaves the encrypted object untouched. A legal hold
records `deletion_blocked_legal_hold` even when a policy is supplied. Physical deletion occurs only
after the eligibility event and only when no other active evidence row references the encrypted
object.

Do not schedule a production deletion job until attachment-class retention periods, legal-hold
authority, operator permissions, and recovery expectations have been approved.

## Rollout and rollback

Roll out in this order:

1. Create the private bucket and scoped service account.
2. Store and back up the attachment encryption key.
3. Configure the environment and verify object put/read/delete in staging.
4. Apply migration `0022_add_secure_attachments.sql`.
5. Deploy the API and run the security and end-to-end smoke tests.

For an application rollback, stop attachment writers, deploy the previous application version, and
leave migration 0022 and encrypted objects in place. The added tables are isolated from earlier
modules, so dropping them is unnecessary and would destroy evidence. Keep the encryption key and
object-store credentials available for the forward fix. Any later schema or object cleanup requires
an approved retention decision, backup verification, and a separately reviewed operation.
