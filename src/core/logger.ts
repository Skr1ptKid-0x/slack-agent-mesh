import { redactString, redactValue } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  /** Minimum level to emit. */
  level?: LogLevel
  /** When false (default), prompts and message bodies are never printed in full. */
  debug?: boolean
  /** Sink for lines; defaults to console.error so stdout stays clean for the demo. */
  sink?: (line: string) => void
}

/**
 * Structured, redaction-safe logger. Every string and every field value passes
 * through the redactor, so tokens cannot leak even if a caller logs raw config.
 * Full prompt bodies are suppressed unless debug mode is explicitly enabled.
 */
export class Logger {
  private readonly level: LogLevel
  readonly debug: boolean
  private readonly sink: (line: string) => void

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info'
    this.debug = opts.debug ?? false
    this.sink = opts.sink ?? ((line) => process.stderr.write(`${line}\n`))
  }

  child(): Logger {
    return this
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const safeFields = fields ? redactValue(fields) : undefined
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...(safeFields ?? {}),
    }
    this.sink(JSON.stringify(record))
  }

  logDebug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields)
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields)
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields)
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields)
  }

  /**
   * Redact a prompt for logging: if debug is off, only length and a short digest
   * are recorded so complete prompts never hit the logs.
   */
  promptForLog(prompt: string): string {
    if (this.debug) return redactString(prompt)
    return `<${prompt.length} chars, redacted>`
  }
}
