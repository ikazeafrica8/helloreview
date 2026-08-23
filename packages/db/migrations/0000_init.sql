-- Initial migration: extensions and shared enumerations only.
--
-- Entity tables arrive with the module that owns them (T21 campaigns, T26 applications, T34
-- workflow instances), so this file stays small on purpose.
--
-- FROZEN ONCE APPLIED ANYWHERE. Drizzle records that a migration ran but never re-checks its
-- contents, so editing this file after it has been applied to any database — including a colleague's
-- — leaves that database silently different from what the file now says. Change it by adding 0001,
-- never by editing 0000.
--
-- The CREATE EXTENSION lines are hand-written: drizzle-kit diffs the schema, and extensions are not
-- part of a schema definition. They are safe to keep here because the diff source is
-- meta/0000_snapshot.json rather than this SQL, so `generate` and `check` stay clean.

-- citext: case-insensitive text. Business names and approved aliases are compared for equality
-- under the §16.7 reservation rules, where "강남점" and "강남점 " differing only by case or padding
-- must not read as different businesses.
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint

-- pg_trgm: trigram similarity, for the fuzzy half of §16.1 applicant matching and §16.7 business
-- alias matching. Deterministic equality still decides; this only ranks candidates for review.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint

-- No pgcrypto: PostgreSQL 16 provides gen_random_uuid() in core, and nothing here needs digest or
-- hmac. Add it in a later migration if and when something does.

CREATE TYPE "public"."campaign_type" AS ENUM('shipping', 'payback', 'visit');--> statement-breakpoint
CREATE TYPE "public"."visit_method" AS ENUM('not_applicable', 'visit_a', 'visit_b', 'visit_c');
