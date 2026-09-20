import { Router, ok, type HttpMethod, type HttpResponse, type RequestContext } from './utils/router';
import { attachAuth } from './middleware/auth';
import { corsHeaders, enforceRateLimit, handleError, SECURITY_HEADERS } from './middleware/errorHandler';
import { AppError, notFound } from './utils/errors';
import { createLogger } from './utils/logger';
import { newRequestId } from './utils/ids';
import { config, describeRuntime } from './config/index';

import { authRoutes } from './routes/auth';
import { customerRoutes } from './routes/customers';
import { transactionRoutes } from './routes/transactions';
import { khataRoutes } from './routes/khata';
import { inventoryRoutes } from './routes/inventory';
import { orderRoutes } from './routes/orders';
import { paymentRoutes } from './routes/payments';
import { voiceRoutes } from './routes/voice';
import { documentRoutes } from './routes/documents';
import { searchRoutes } from './routes/search';
import { aiRoutes } from './routes/ai';
import { agentRoutes } from './routes/agent';
import { syncRoutes } from './routes/sync';
import { customerAppRoutes } from './routes/customerApp';
import './handlers';

/**
 * The application.
 *
 * One Lambda, mounted internally. Every request goes through the same pipeline
 * regardless of transport:
 *
 *   request id → logger → CORS → auth → rate limit → route → handler → errors
 *
 * `handler.ts` (Lambda) and `local-server.ts` (dev) both reduce their transport
 * to a RequestContext and call `handleRequest`, so there is exactly one copy of
 * the middleware chain and local behaviour matches deployed behaviour.
 */

export const router = new Router();

router
  .mount('/auth', authRoutes)
  .mount('/customers', customerRoutes)
  .mount('/transactions', transactionRoutes)
  .mount('/khata', khataRoutes)
  .mount('/inventory', inventoryRoutes)
  .mount('/orders', orderRoutes)
  .mount('/payments', paymentRoutes)
  .mount('/voice', voiceRoutes)
  .mount('/documents', documentRoutes)
  .mount('/search', searchRoutes)
  .mount('/ai', aiRoutes)
  .mount('/agent', agentRoutes)
  .mount('/sync', syncRoutes)
  .mount('/me', customerAppRoutes);

/**
 * Health and capability discovery.
 *
 * The client reads this at boot to learn which subsystems are real and which
 * are local, and renders the "Local mode" badge from it. Public by design —
 * it exposes configuration shape, never configuration values.
 */
router.get('/health', async () =>
  ok({
    status: 'ok',
    app: config.appName,
    stage: config.stage,
    time: new Date().toISOString(),
    runtime: describeRuntime(),
  }),
);

router.get('/', async () =>
  ok({
    app: config.appName,
    tagline: 'Your shop. Your memory. Your AI.',
    health: '/health',
  }),
);

/* -------------------------------------------------------------- Pipeline */

export type RawRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string;
  sourceIp: string;
  requestId?: string;
};

/** Paths that never require a session. Everything else demands one. */
const PUBLIC_PATHS = new Set([
  'GET /',
  'GET /health',
  'POST /auth/signup',
  'POST /auth/login',
  'POST /auth/confirm',
  'POST /auth/resend-code',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
  'POST /auth/refresh',
  'POST /auth/demo-login',
]);

export async function handleRequest(raw: RawRequest): Promise<HttpResponse> {
  const startedAt = Date.now();
  const requestId = raw.requestId ?? newRequestId();
  const method = raw.method.toUpperCase() as HttpMethod;
  const origin = raw.headers.origin;

  const baseHeaders = {
    ...SECURITY_HEADERS,
    ...corsHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
  };

  // Preflight never reaches a handler.
  if (method === 'OPTIONS') {
    return { status: 204, headers: baseHeaders };
  }

  const ctx: RequestContext = {
    requestId,
    method,
    path: raw.path,
    params: {},
    query: raw.query,
    headers: raw.headers,
    body: undefined,
    rawBody: raw.rawBody,
    sourceIp: raw.sourceIp,
    logger: createLogger({ requestId }),
  };

  try {
    if (raw.rawBody.length > config.http.maxBodyBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', `Body of ${raw.rawBody.length} bytes rejected`);
    }

    if (raw.rawBody.length > 0) {
      try {
        ctx.body = JSON.parse(raw.rawBody) as unknown;
      } catch {
        throw new AppError('BAD_REQUEST', 'Body is not valid JSON');
      }
    }

    const match = router.match(method, raw.path);
    if (!match) {
      const allowed = router.allowedMethods(raw.path);
      if (allowed.length > 0) {
        return {
          status: 405,
          headers: { ...baseHeaders, Allow: allowed.join(', ') },
          body: {
            error: { code: 'BAD_REQUEST', message: 'That action is not available.', issues: [] },
            requestId,
          },
        };
      }
      throw notFound('route');
    }

    ctx.params = match.params;
    ctx.logger = ctx.logger.child({ operation: match.operation });

    // Auth is attached before the rate limiter so the limit is keyed per user
    // rather than per shared IP.
    await attachAuth(ctx);
    enforceRateLimit(ctx);

    // Defence in depth: a route that forgot `requireVendor` still cannot be
    // reached anonymously.
    if (!PUBLIC_PATHS.has(match.operation) && !ctx.auth) {
      throw new AppError('UNAUTHENTICATED', `Anonymous request to ${match.operation}`);
    }

    const response = await match.handler(ctx);
    const durationMs = Date.now() - startedAt;

    ctx.logger.info('request complete', {
      method,
      status: response.status,
      durationMs,
    });

    return {
      ...response,
      headers: { ...baseHeaders, ...response.headers },
    };
  } catch (error) {
    const response = handleError(error, ctx, startedAt);
    return { ...response, headers: { ...baseHeaders, ...response.headers } };
  }
}

/** Every mounted route, for the boot log and for docs. */
export function listRoutes(): string[] {
  return router.list().sort();
}
