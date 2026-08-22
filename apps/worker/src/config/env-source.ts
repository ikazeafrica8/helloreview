// The ONE place the worker reads process.env. See the api's equivalent for the full reasoning.
//
// T8 consolidates this file and apps/api's into a single shared loader. Until then the duplication
// is deliberate and small: apps/worker cannot import from apps/api, and inventing a shared package
// that the SPEC.md §3.1 capability map does not describe would be a worse answer than twelve
// duplicated lines.

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export const readEnvironment = (): EnvironmentSource => process.env
