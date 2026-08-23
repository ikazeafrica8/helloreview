import { defineConfig } from 'drizzle-kit'

// drizzle-kit configuration.
//
// `schema` is a GLOB so each module drops in its own file with no edit here — T21 adds campaigns,
// T34 adds workflow instances, and neither needs to touch this config.
//
// There is deliberately no `db:push` script anywhere in this repo. Push diffs a schema straight
// into a live database with no reviewable artifact, and SPEC.md §8 puts schema changes under Ask
// first: a migration is the thing a human reads before it runs.

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*.ts',
  out: './migrations',
  dbCredentials: {
    // drizzle-kit is a developer tool run from the repo root with the root .env loaded, so this is
    // the one place a direct environment read is correct — it is not application code, and the
    // lint rule scopes process.env by filename rather than banning it in tooling.
    //
    // DATABASE_MIGRATION_URL, not DATABASE_URL. Everything drizzle-kit does — generating a
    // migration by diffing the live schema, `check`, and `studio` — is schema-ownership work. The
    // application's credential is deliberately a different variable, and once it loses DDL rights
    // this would fail here first.
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
  strict: true,
  verbose: true,
})
