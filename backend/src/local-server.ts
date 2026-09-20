import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleRequest, listRoutes, type RawRequest } from './app';
import { assertProductionSafety, config, describeRuntime } from './config/index';
import { logger } from './utils/logger';

/**
 * Local development server.
 *
 * A thin Node HTTP adapter over the same `handleRequest` the Lambda uses. The
 * point is that there is no second implementation: middleware, routing, auth,
 * error shaping and CORS all behave here exactly as they will in AWS, so a bug
 * cannot hide in the gap between dev and prod.
 *
 *   npm run dev   →   tsx watch src/local-server.ts
 */

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

assertProductionSafety();

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Guard before buffering, so an oversized upload cannot exhaust memory.
      if (size > config.http.maxBodyBytes) {
        reject(new Error('Body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function toRawRequest(
  request: IncomingMessage,
  rawBody: string,
): RawRequest {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
  }

  return {
    method: request.method ?? 'GET',
    path: url.pathname,
    query,
    headers,
    rawBody,
    sourceIp: request.socket.remoteAddress ?? '127.0.0.1',
  };
}

/**
 * Wrapped rather than passed as an async callback: `createServer` expects a
 * void-returning listener, so a rejected promise would become an unhandled
 * rejection instead of a 500. Everything inside is already guarded.
 */
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  void handleConnection(request, response);
});

async function handleConnection(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const rawBody = await readBody(request);
    const result = await handleRequest(toRawRequest(request, rawBody));

    response.writeHead(result.status, result.headers ?? {});
    response.end(result.body === undefined ? '' : JSON.stringify(result.body));
  } catch (error) {
    logger.error('local server error', { operation: 'localServer.request', error });
    const tooLarge = error instanceof Error && error.message === 'Body too large';
    response.writeHead(tooLarge ? 413 : 500, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL',
          message: tooLarge
            ? 'That file is too large.'
            : 'Something went wrong on our side. Please try again.',
          issues: [],
        },
      }),
    );
  }
}

/**
 * Which .env actually applied.
 *
 * Node prints "<file> not found" for each `--env-file-if-exists` that misses,
 * which reads like an error when it is simply the second of two candidates.
 * Stating the resolved file removes the doubt — "did my .env load?" is the
 * first thing anyone asks when a value does not take effect.
 */
function resolveEnvFile(): string | null {
  for (const candidate of ['../.env', '.env']) {
    const full = resolve(process.cwd(), candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

server.listen(PORT, HOST, () => {
  const runtime = describeRuntime();
  const envFile = resolveEnvFile();

  // A deliberately loud banner: the single most confusing thing in local
  // development would be not knowing which subsystems are real.
  const lines = [
    '',
    '  ▄ VYAPIO API',
    `  http://localhost:${PORT}`,
    '',
    `  stage        ${runtime.stage}`,
    `  region       ${runtime.region}`,
    `  routes       ${listRoutes().length}`,
    envFile
      ? `  env          ${envFile.replace(process.cwd(), '.')}`
      : '  env          none (using built-in defaults)',
    '',
    '  subsystems',
    ...Object.entries(runtime.subsystems).map(
      ([name, mode]) =>
        `    ${name.padEnd(12)} ${mode === 'aws' ? 'AWS' : 'local'}`,
    ),
    `    notifications ${runtime.notificationProvider}`,
    '',
  ];

  if (!runtime.fullyProvisioned) {
    lines.push(
      `  Running locally: ${runtime.localSubsystems.join(', ')}.`,
      '  Data is stored in .vyapio-data and does not reach AWS.',
      '  See .env.example to connect real services.',
      '',
    );
  }

  if (runtime.notificationProvider === 'mock') {
    lines.push('  Notifications are recorded but NOT delivered (provider: mock).', '');
  }

  if (envFile) {
    // `tsx watch` watches TypeScript, not .env, so an edited value silently
    // keeps the old one until the process is restarted.
    lines.push('  Edited .env? Restart this server — file changes are not hot-reloaded.', '');
  }

  process.stdout.write(lines.join('\n') + '\n');
});

/** Clean shutdown so `tsx watch` restarts do not leave the port held. */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
