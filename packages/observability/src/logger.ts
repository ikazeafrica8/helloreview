import { currentCorrelationId } from './correlation.js'

// Structured logging (T11), emitting the field set SPEC.md §23.1 requires.
//
// Hand-written rather than wrapping pino or winston, for two reasons that are specific rather than
// stylistic. First, §21.4 masks by VALUE SHAPE — Korean phone numbers, address fragments — and the
// redaction those libraries offer is keyed on object PATHS, so it would need wrapping anyway.
// Second, the api runs under NestJS and the worker is a plain process; one small implementation both
// import is simpler than reconciling two integrations. Revisit if sampling or transports are needed.
//
// The logger deliberately does NOT mask for you. Masking happens at the CALL SITE, so the reviewer
// of a line can see which field is personal data — and eslint.config.js rejects a known-sensitive key
// reaching a logger unmasked. A logger that quietly masked would hide the mistake instead.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** The §23.1 fields a caller may attach. All optional: not every line has a workflow. */
export interface LogContext {
  operation?: string
  result?: string
  eventId?: string
  workflowId?: string
  campaignId?: string
  provider?: string
  errorCategory?: string
  /** SCREAMING_SNAKE machine-readable cause (PRD §23.1). A code, never a message. */
  reasonCode?: string
  retryCount?: number
  stateVersion?: number
  /** HTTP status, for request lines. Separate from retryCount, which counts RETRIES. */
  statusCode?: number
  /** A small count the line is about — processors bound, rows written. Never a retry count. */
  count?: number
  /** Already masked by the caller — see maskIdentifier. */
  actorId?: string
}

export interface LoggerOptions {
  module: string
  environment: string
  /** Injected so tests can capture without touching global state. Defaults to stdout. */
  write?: (line: string) => void
  /** Injected so a test can assert on timestamps deterministically. */
  now?: () => Date
}

export interface Logger {
  trace: (message: string, context?: LogContext) => void
  debug: (message: string, context?: LogContext) => void
  info: (message: string, context?: LogContext) => void
  warn: (message: string, context?: LogContext) => void
  error: (message: string, context?: LogContext) => void
  fatal: (message: string, context?: LogContext) => void
  /** A child logger for a sub-component, sharing environment and output. */
  child: (module: string) => Logger
}

/**
 * Collapse control characters in a message.
 *
 * One log line must be one JSON document. A newline inside a message would otherwise let untrusted
 * text — a participant's KakaoTalk message, a provider error — split itself into a second, forged
 * line that a log shipper would parse as a real event.
 */
const singleLine = (message: string): string => message.replace(/[\r\n\t]+/g, ' ').trim()

export const createLogger = (options: LoggerOptions): Logger => {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const now = options.now ?? (() => new Date())

  const emit =
    (level: LogLevel) =>
    (message: string, context: LogContext = {}): void => {
      const line = {
        timestamp: now().toISOString(),
        level,
        environment: options.environment,
        module: options.module,
        // null, not omitted and never invented: an absent correlation id is a real fact about the
        // line, and fabricating one would join unrelated interactions into a single trace.
        correlationId: currentCorrelationId() ?? null,
        message: singleLine(message),
        operation: context.operation ?? null,
        result: context.result ?? null,
        // Everything below is omitted when absent, so a line stays readable.
        ...(context.eventId === undefined ? {} : { eventId: context.eventId }),
        ...(context.workflowId === undefined ? {} : { workflowId: context.workflowId }),
        ...(context.campaignId === undefined ? {} : { campaignId: context.campaignId }),
        ...(context.provider === undefined ? {} : { provider: context.provider }),
        ...(context.errorCategory === undefined ? {} : { errorCategory: context.errorCategory }),
        ...(context.retryCount === undefined ? {} : { retryCount: context.retryCount }),
        ...(context.stateVersion === undefined ? {} : { stateVersion: context.stateVersion }),
        ...(context.statusCode === undefined ? {} : { statusCode: context.statusCode }),
        ...(context.count === undefined ? {} : { count: context.count }),
        ...(context.actorId === undefined ? {} : { actorId: context.actorId }),
      }

      write(JSON.stringify(line))
    }

  const logger: Logger = {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
    child: (module: string) => createLogger({ ...options, module }),
  }

  return logger
}
