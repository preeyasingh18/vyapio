import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
  EventBridgeEvent,
} from 'aws-lambda';
import { handleRequest, listRoutes, type RawRequest } from './app';
import { dispatch, type VyapioEvent } from './services/events';
import { assertProductionSafety, config, describeRuntime } from './config/index';
import { logger } from './utils/logger';
import { toAppError } from './utils/errors';

/**
 * Lambda entry point.
 *
 * One function serves the whole API, and also receives the EventBridge rules,
 * so the same container handles both the request path and the asynchronous
 * consequences. That keeps a hackathon deployment to a single image while the
 * code inside stays modular — routing is in app.ts, business logic in services.
 *
 * Packaged as a Docker image (see Dockerfile) and run on the AWS-provided
 * Node.js base image, which supplies the runtime interface client.
 */

/* ------------------------------------------------------------ Cold start */

// Runs once per container. Failing fast here is deliberate: a misconfigured
// production environment should never serve a single request.
assertProductionSafety();

logger.info('cold start', {
  operation: 'lambda.init',
  stage: config.stage,
  region: config.region,
  routeCount: listRoutes().length,
  runtime: describeRuntime(),
});

/* ----------------------------------------------------------- Event typing */

type LambdaEvent = APIGatewayProxyEventV2 | EventBridgeEvent<string, VyapioEvent>;

function isHttpEvent(event: LambdaEvent): event is APIGatewayProxyEventV2 {
  return 'requestContext' in event && 'http' in (event.requestContext ?? {});
}

/* ------------------------------------------------------------------ HTTP */

/**
 * API Gateway strips the stage prefix on the default route, but a custom domain
 * base-path mapping may not. Normalising here keeps route patterns clean.
 */
function normalisePath(rawPath: string, stage?: string): string {
  let path = rawPath || '/';
  if (stage && stage !== '$default' && path.startsWith(`/${stage}`)) {
    path = path.slice(stage.length + 1) || '/';
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function toRawRequest(event: APIGatewayProxyEventV2, context: Context): RawRequest {
  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : '';

  // Header names arrive lower-cased from API Gateway v2, but normalise anyway
  // so the local server and Lambda behave identically.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers[key.toLowerCase()] = value;
  }

  return {
    method: event.requestContext.http.method,
    path: normalisePath(event.rawPath, event.requestContext.stage),
    query: (event.queryStringParameters ?? {}) as Record<string, string>,
    headers,
    rawBody: body,
    sourceIp: event.requestContext.http.sourceIp ?? 'unknown',
    // Correlates CloudWatch logs with the client's X-Request-Id.
    requestId: context.awsRequestId,
  };
}

/* ------------------------------------------------------------------ Entry */

export async function handler(
  event: LambdaEvent,
  context: Context,
): Promise<APIGatewayProxyResultV2 | void> {
  // The response is sent as soon as the handler returns; nothing depends on
  // draining the event loop.
  context.callbackWaitsForEmptyEventLoop = false;

  if (!isHttpEvent(event)) {
    // EventBridge delivery. Failures are logged and swallowed rather than
    // thrown, because a retry storm on a derived calculation is worse than a
    // stale number that the next read recomputes anyway.
    try {
      const detail = event.detail;
      logger.info('event received', {
        operation: 'lambda.event',
        eventType: detail?.type,
        vendorId: detail?.vendorId,
      });
      if (detail) await dispatch(detail);
    } catch (error) {
      logger.error('event handling failed', { operation: 'lambda.event', error });
    }
    return;
  }

  try {
    const response = await handleRequest(toRawRequest(event, context));
    return {
      statusCode: response.status,
      headers: response.headers ?? {},
      body: response.body === undefined ? '' : JSON.stringify(response.body),
    };
  } catch (error) {
    // Last resort. handleRequest has its own boundary, so reaching here means
    // something failed in the transport layer itself.
    const appError = toAppError(error);
    logger.error('unhandled lambda error', {
      operation: 'lambda.handler',
      requestId: context.awsRequestId,
      errorCode: appError.code,
      error,
    });
    return {
      statusCode: appError.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...appError.toResponse(), requestId: context.awsRequestId }),
    };
  }
}

export default handler;
