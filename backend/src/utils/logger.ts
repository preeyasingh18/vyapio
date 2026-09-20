import { config } from '../config/index';

/**
 * Structured JSON logging for CloudWatch Logs Insights.
 *
 * Every line is one JSON object carrying requestId / userId / vendorId /
 * operation / duration / status / errorCode, so a request can be traced with:
 *
 *   fields @timestamp, operation, durationMs, status, errorCode
 *   | filter vendorId = "ven_..."
 *   | sort @timestamp desc
 *
 * Sensitive keys are redacted structurally rather than by convention, because
 * "remember not to log the token" fails eventually.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

/**
 * Keys whose values are never written to logs. Matched case-insensitively on
 * substrings, so `idToken`, `ID_TOKEN` and `refresh_token` are all caught.
 */
const REDACTED_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'accesskey',
  'sessionkey',
  'credential',
  'signature',
  'otp',
  'code',
  'pin',
];

/**
 * Field names that survive redaction despite matching a pattern above.
 *
 * `code` has to be redacted — it catches verification codes and reset codes —
 * but it also matches `errorCode` and `statusCode`, which are exactly the
 * fields CloudWatch queries filter on. Without this allowlist, redaction
 * quietly destroys the observability it is meant to protect.
 */
const ALWAYS_LOGGED = new Set([
  'errorcode',
  'statuscode',
  'httpcode',
  'countrycode',
  'languagecode',
  'currencycode',
  'categorycode',
]);

const REDACTED = '[redacted]';

function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();
  if (ALWAYS_LOGGED.has(lower)) return false;
  return REDACTED_KEYS.some((needle) => lower.includes(needle));
}

/** Depth- and size-bounded so a rogue payload cannot blow up the log line. */
function sanitise(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitise(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shouldRedact(key) ? REDACTED : sanitise(entry, depth + 1);
    }
    return out;
  }
  // Anything left is a symbol, function or bigint. `String()` on an object
  // would emit "[object Object]", so objects are handled above and never
  // reach here.
  return typeof value === 'symbol' || typeof value === 'bigint'
    ? value.toString()
    : '[unserialisable]';
}

export type LogContext = {
  requestId?: string;
  userId?: string;
  vendorId?: string;
  operation?: string;
  durationMs?: number;
  status?: number;
  errorCode?: string;
  [key: string]: unknown;
};

export type Logger = {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that carries `context` on every subsequent line. */
  child(context: LogContext): Logger;
};

function emit(level: LogLevel, message: string, base: LogContext, extra?: LogContext): void {
  if (LEVELS[level] < threshold) return;

  const line = {
    level,
    time: new Date().toISOString(),
    app: config.appName,
    stage: config.stage,
    message,
    ...(sanitise({ ...base, ...extra }) as Record<string, unknown>),
  };

  const serialised = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialised}\n`);
  else process.stdout.write(`${serialised}\n`);
}

export function createLogger(base: LogContext = {}): Logger {
  return {
    debug: (message, context) => emit('debug', message, base, context),
    info: (message, context) => emit('info', message, base, context),
    warn: (message, context) => emit('warn', message, base, context),
    error: (message, context) => emit('error', message, base, context),
    child: (context) => createLogger({ ...base, ...context }),
  };
}

export const logger = createLogger();
