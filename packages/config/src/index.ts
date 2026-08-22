// The environment contract, shared by every deployable.
//
// WHY A PACKAGE RATHER THAN A MODULE. SPEC.md §3.1 assigns configuration to `platform-core`, and §5
// says modules live under `apps/api/src/modules/`. Neither says where a module shared by TWO
// deployables belongs — and apps/worker cannot import from apps/api. T4 and T5 each carried their
// own copy as a stopgap; this package is the resolution, and the §5 gap is flagged in tasks/todo.md.

export { readEnvironment } from './env-source.js'
export type { EnvironmentSource } from './env-source.js'
export { loadApiConfig, loadWorkerConfig, redactEnvironment, ConfigurationError } from './load.js'
export type { ApiConfig, WorkerConfig } from './load.js'
export { apiConfigSchema, workerConfigSchema, SECRET_KEYS, isSecret } from './schema.js'
