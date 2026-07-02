/**
 * Leveled logging for the agent. The host passes a console-like sink and a
 * level; everything below the level is a no-op. Default: 'warn' onto the
 * global console — silent in normal operation, but salvage fallbacks, empty
 * plans, degraded tool modes and failed tool calls stay visible.
 *
 * Set `logLevel: 'debug'` to see every phase's raw model output, parsed
 * results and tool dispatches — the first thing to reach for when the agent
 * "says it did something but nothing happened".
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

/** Console-compatible sink (pass `console`, or your own collector). */
export interface AgentLoggerSink {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export interface AgentLogger extends AgentLoggerSink {
  readonly level: LogLevel
}

const WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

const PREFIX = '[agent-web]'

const noop = (): void => undefined

export const createLogger = (
  level: LogLevel = 'warn',
  sink: AgentLoggerSink = console,
): AgentLogger => {
  const at = (min: LogLevel, fn: (...args: unknown[]) => void) =>
    WEIGHT[level] >= WEIGHT[min] ? (...args: unknown[]) => fn.call(sink, PREFIX, ...args) : noop
  return {
    level,
    error: at('error', sink.error),
    warn: at('warn', sink.warn),
    info: at('info', sink.info),
    debug: at('debug', sink.debug),
  }
}
