// Correlation context, structured logging and PII masking (T10, T11).
//
// Shared by both deployables, for the same reason packages/config is: SPEC.md §3.1 assigns these to
// `platform-core`, §5 says modules live under apps/api/src/modules/, and neither says where a module
// two deployables need belongs. That gap is flagged in tasks/todo.md.

export {
  isCorrelationId,
  newCorrelationId,
  adoptCorrelationId,
  runWithCorrelation,
  currentCorrelationId,
} from './correlation.js'

export { createLogger } from './logger.js'
export type { Logger, LogLevel, LogContext, LoggerOptions } from './logger.js'

export { mask, maskPhone, maskName, maskAddress, maskIdentifier } from './mask.js'
