# Backup and restore

The audit log is the only table in this system whose value comes entirely from being trustworthy.
Migration `0002` and the coming role split make it hard to _rewrite_; neither makes it possible to
_recover_. That is what this document is for.

It is deliberately short and deliberately drilled. A backup procedure that has never been restored
from is a belief, not a control.

## Why two artifacts, not one

`pg_dump` captures a database: its schema, its data, its grants, and its `ALTER DEFAULT PRIVILEGES`
rules. It does **not** capture roles — `CREATE ROLE` lives at the cluster level, not the database
level.

That matters more than it sounds. Once the application has its own role, a restore from `pg_dump`
alone into a fresh cluster fails on every `GRANT` statement, because the grantee does not exist.

So: **two files, always taken together.**

| File               | Command                     | Contains                                     |
| ------------------ | --------------------------- | -------------------------------------------- |
| `globals.sql`      | `pg_dumpall --globals-only` | Roles, their passwords, cluster-level grants |
| `helloreview.dump` | `pg_dump -Fc`               | Schema, data, ACLs, default privileges       |

## Taking a backup

```bash
pnpm db:backup
```

Writes both files to `backups/<timestamp>/` and prints their sizes. The directory is in
`.gitignore` — a dump contains every participant record the platform holds, and belongs nowhere
near the repository.

To do it by hand, or on a server:

```bash
docker exec helloreview-postgres-1 pg_dumpall -U helloreview --globals-only > globals.sql
docker exec helloreview-postgres-1 pg_dump  -U helloreview -Fc helloreview > helloreview.dump
```

## Restoring

Roles first, always. The dump's `GRANT` statements reference them by name.

```bash
# 1. Roles (cluster-level, and idempotent enough to re-run — CREATE ROLE errors are expected
#    and harmless if the role already exists).
docker exec -i helloreview-postgres-1 psql -U helloreview -d postgres < globals.sql

# 2. The database itself.
docker exec -i helloreview-postgres-1 pg_restore -U helloreview -d helloreview --clean --if-exists \
  < helloreview.dump
```

### About `--no-owner --no-acl`

If a restore fails on a missing role, the fix is to load `globals.sql` first. Reaching for
`--no-owner --no-acl` instead is worth understanding precisely, because the common description of
it is wrong and the real hazard is one step further along.

Measured, on a dump containing an application role with the `audit_logs` carve-out:

|                                         | Correct restore  | `--no-owner --no-acl`        |
| --------------------------------------- | ---------------- | ---------------------------- |
| Triggers still `ENABLE ALWAYS`          | 3 of 3           | **3 of 3**                   |
| `audit_logs` ACL                        | carve-out intact | `NULL` — every grant dropped |
| App role can `DELETE` from `audit_logs` | no               | no                           |

So the flags do **not** silently reopen the audit log. Trigger state survives either way, and
stripping the ACL leaves the table with no grants at all — the application loses _all_ access and
fails closed with `permission denied` on every query. Loud, not silent.

**The hazard is the next command, not this one.** Faced with an application that cannot read
anything, the natural reflex is:

```sql
GRANT ALL ON ALL TABLES IN SCHEMA public TO helloreview_app;   -- ⚠️ re-grants DELETE on audit_logs
```

That single line restores the application's access _and_ its ability to erase history, and nothing
reports it. The recovery:

```bash
pnpm db:migrate && pnpm db:verify-audit-protection
```

**What is actually doing the work there, because it is not the migration.** A drizzle migration runs
exactly once: it is recorded in `drizzle.__drizzle_migrations`, and afterwards the migrator applies a
file only when the recorded timestamp is older than the file's. Migration 0009 is therefore skipped
forever once applied, and `pnpm db:migrate` on an existing database applies **zero SQL**. An earlier
version of this page claimed the migration was re-applied "because it is idempotent by design" —
the SQL is idempotent, but nothing ever replays it. Measured: after the `GRANT ALL` above,
`db:migrate` alone left `DELETE` on `audit_logs` still granted.

The repair comes from `tools/db-provision-role.mjs`, which `db:migrate` runs afterwards **every
time**. It re-asserts `USAGE` on the schema, the table and sequence grants, the `audit_logs`
carve-out, and the `REVOKE EXECUTE ... FROM PUBLIC` on every non-extension function. That covers
both failure modes on this page — the broad `GRANT ALL`, and a `--no-owner --no-acl` restore that
stripped every grant — and it covers them on a staging or production host, where `pnpm db:reset`
(the only other thing that replays migrations) refuses to run at all.

It also recovers a restore where `globals.sql` was never loaded and the `helloreview_api` login role
is missing entirely: the role is recreated from `APP_DB_USER`/`APP_DB_PASSWORD` and put back in the
`helloreview_app` group. It will not restore a **password** you no longer have — set
`APP_DB_PASSWORD` to whatever you want it to become and re-run, since the password is reset on every
run.

If provisioning still refuses after this, it is telling you the carve-out could not be restored —
do not reach for `GRANT ALL` to make the error go away, because that is the command that caused it.

### After any restore, verify the protection came back

A restore that produces a working application but an unprotected audit table is the failure mode
worth checking for explicitly:

```bash
pnpm db:verify-audit-protection
```

It exits non-zero unless all four of these hold:

1. The three triggers exist and are `ENABLE ALWAYS` (`tgenabled = 'A'`, not `'O'`).
2. No non-superuser, non-owner role holds `UPDATE`, `DELETE` or `TRUNCATE` on `audit_logs`.
3. The role named by `APP_DB_USER` is not a superuser, does not own `audit_logs`, and is not a
   member of the owner — by inheritance or by `SET ROLE`. Checks 1 and 2 exclude superusers and the
   owner, correctly, since no ACL constrains them; without check 3 that exclusion is a blind spot,
   and pointing `DATABASE_URL` back at the owner would pass everything while the table stayed
   freely deletable.
4. No `SECURITY DEFINER` function in `public` is executable by the application role. Such a function
   runs as its owner, so it routes around checks 1–3 entirely.

## The backup is also your tamper evidence

Diffing yesterday's `audit_logs` against today's answers "did any existing row change or
disappear?" — which is the question a hash chain would answer, at the cost of rewriting the insert
path and introducing a real concurrency problem around sequence ordering.

The dump has two advantages over a chain: it needs no schema change, and unlike a chain it
**recovers** rather than merely detecting. Its weakness is granularity — it catches tampering
within a day, not within a minute.

That trade is right for now. Revisit it if a dispute actually occurs, or if the records ever need
to be provable to a third party rather than to you — at which point the missing piece is an
off-machine anchor (S3 Object Lock or equivalent), not a cleverer hash.

## Drill record

This procedure has been executed end to end, not just written down. On 2026-08-23, against the
local stack: a row was inserted into `audit_logs`, `pnpm db:backup` was taken, and the dump was
restored into a throwaway database. The row came back with its contents intact, and all three
triggers came back as `ENABLE ALWAYS` — so trigger protection survives a `pg_dump`/`pg_restore`
round trip. The `--no-owner --no-acl` comparison in the table above was measured in the same
session.

**Re-drill when any of these change:** the Postgres major version, the migration set touching
`audit_logs`, or the role model (specifically, when Commit B splits the application role out). A
drill result is only evidence about the system it was run against.
