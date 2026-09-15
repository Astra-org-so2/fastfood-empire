import type { EventSeverity } from '@aido/types';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  level: LogLevel;
  child(fields: LogFields): Logger;
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  isEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  level: LogLevel;
  /** 'pretty' for dev terminals, 'json' for production/collectors. */
  format?: 'pretty' | 'json';
  base?: LogFields;
  /** Injected for tests. */
  sink?: (line: string, level: LogLevel, fields: LogFields) => void;
  redact?: (fields: LogFields) => LogFields;
}

const COLOURS: Record<LogLevel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

/**
 * Minimal structured logger. We intentionally avoid pino/transport plumbing:
 * one dependency fewer, JSON output that a collector can ingest, pretty output
 * for humans. Redaction is applied by default via the injected `redact`.
 */
export function createLogger(options: LoggerOptions): Logger {
  const format = options.format ?? 'pretty';
  const base = options.base ?? {};

  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[options.level]) return;
    const merged: LogFields = { ...base, ...(fields ?? {}) };
    const safe = options.redact ? options.redact(merged) : merged;
    if (format === 'json') {
      const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...safe });
      (options.sink ?? defaultSink)(line, level, safe);
      return;
    }
    const time = new Date().toISOString().slice(11, 23);
    const scope = typeof safe.scope === 'string' ? ` ${String(safe.scope)}` : '';
    const rest: LogFields = { ...safe };
    delete rest.scope;
    const extras = Object.keys(rest).length ? ` ${formatFields(rest)}` : '';
    (options.sink ?? defaultSink)(
      `${COLOURS[level]}${time} ${level.toUpperCase().padEnd(5)}${RESET}${scope} ${msg}${extras}`,
      level,
      safe,
    );
  };

  const logger: Logger = {
    level: options.level,
    isEnabled: (level) => LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[options.level],
    child(fields) {
      return createLogger({ ...options, base: { ...base, ...fields } });
    },
    trace: (m, f) => write('trace', m, f),
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
  return logger;
}

function defaultSink(line: string, level: LogLevel) {
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return JSON.stringify({ name: v.name, message: v.message });
  try {
    const s = JSON.stringify(v);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return '[unserialisable]';
  }
}

export const silentLogger: Logger = (() => {
  const noop = () => {};
  const l: Logger = {
    level: 'error',
    isEnabled: () => false,
    child: () => l,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return l;
})();

export function severityToLogLevel(severity: EventSeverity): LogLevel {
  switch (severity) {
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    case 'warning':
      return 'warn';
    case 'error':
    case 'critical':
      return 'error';
    default:
      return 'info';
  }
}
