// The ONE place in the application that reads process.env.
//
// SPEC.md §5 and the `processEnv` selector in eslint.config.js forbid process.env everywhere else,
// so that configuration cannot be read ad hoc from arbitrary code. Keeping the impure read to a
// single line means the lint exemption is one narrow path rather than a whole module, and it lets
// loadAppConfig() stay a pure function of its input — which is what makes it testable.
//
// T8 replaces the validation in load-app-config.ts with a Zod schema over the full environment
// surface. This file does not change: it is already as small as it can be.

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

export const readEnvironment = (): EnvironmentSource => process.env
