import { config } from '../config/index';
import { AppError, toAppError } from '../utils/errors';
import type { HttpResponse, RequestContext } from '../utils/router';

/**
 * The outermost error boundary.
 *
 * Nothing thrown anywhere in a handler reaches the client unshaped. Raw AWS
 * exception names, stack traces and internal identifiers stay in CloudWatch;
 * the client gets a stable error code and a sentence written for a shopkeeper.
 */

export function handleError(error: unknown, ctx: RequestContext, startedAt: number): HttpResponse {
  const appError = toAppError(error);
  const durationMs = Date.now() - startedAt;

  const logContext = {
    operation: ctx.path,
    method: ctx.method,
    status: appError.status,
    errorCode: appError.code,
    durationMs,
    ...appError.context,
  };

  // 5xx is our fault and gets a stack; 4xx is expected traffic and does not.
  if (appError.status >= 500) {
    ctx.logger.error(appError.message, { ...logContext, error: appError.cause ?? appError });
  } else {
    ctx.logger.warn(appError.message, logContext);
  }

  return {
    status: appError.status,
    body: {
      ...appError.toResponse(),
      requestId: ctx.requestId,
      // Development only: the real message, so a developer is not left guessing.
      ...(config.stage === 'dev' ? { debug: appError.message } : {}),
    },
  };
}

/* ----------------------------------------------------------- Rate limiting */

type Bucket = { count: number; resetAt: number };

/**
 * In-process fixed-window rate limiter.
 *
 * Per-container, which means the real ceiling scales with concurrency — enough
 * to stop a runaway client or a stuck retry loop, which is what this is for.
 * A distributed limit belongs in API Gateway usage plans, and CDK configures
 * throttling there too.
 */
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

export function enforceRateLimit(ctx: RequestContext): void {
  const limit = config.http.rateLimitPerMinute;
  if (limit <= 0) return;

  // Keyed by identity when known, so one busy shop cannot lock out another
  // behind the same NAT.
  const key = ctx.auth?.userId ?? ctx.sourceIp;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (buckets.size > 10_000) pruneBuckets(now);
    return;
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    throw new AppError('RATE_LIMITED', `Rate limit exceeded for ${key}`, {
      context: { limit, windowMs: WINDOW_MS },
    });
  }
}

function pruneBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
}

/* -------------------------------------------------------------------- CORS */

/**
 * In prod, only configured origins get CORS headers — an unlisted origin gets
 * none, and the browser blocks the response. In dev the caller is reflected so
 * that testing from a phone on the LAN does not need a config change.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = config.http.allowedOrigins;
  const permitted = origin && allowed.includes(origin);

  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (permitted) {
    return { ...base, 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' };
  }
  if (!config.isProd && origin) {
    return { ...base, 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' };
  }
  return base;
}

/** Applied to every response, including errors. */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cache-Control': 'no-store',
};
