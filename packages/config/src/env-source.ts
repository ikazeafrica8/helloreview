// The ONE place in the entire platform that reads process.env.
//
// SPEC.md §5 and the `processEnv` selector in eslint.config.js forbid process.env everywhere else,
// so configuration cannot be read ad hoc from arbitrary code. Keeping the impure read to a single
// line means the lint exemption is one narrow filename, and it lets loadConfig() stay a pure
// function of its input — which is what makes it testable without touching the environment.
//
// T5 and T4 each had their own copy of this file, because apps/worker cannot import from apps/api.
// T8 replaced both with this one.

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export const readEnvironment = (): EnvironmentSource => process.env
