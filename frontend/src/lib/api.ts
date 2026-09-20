import { apiBase, appConfig } from '@/app/config';

/**
 * The API client.
 *
 * One place that knows how to talk to the backend, so error handling, token
 * refresh and offline detection are uniform. Three behaviours matter:
 *
 *   • Errors arrive already written for a shopkeeper (the API shapes them), so
 *     the UI renders `error.message` directly and never invents its own copy.
 *   • A 401 triggers exactly one refresh attempt, and concurrent requests share
 *     it rather than stampeding the endpoint.
 *   • A network failure is surfaced as `offline`, which is a different thing
 *     from a server error and is presented differently.
 */

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    issues: Array<{ path: string; message: string }>;
  };
  requestId?: string;
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: Array<{ path: string; message: string }>;
  readonly requestId: string | undefined;
  /** True when the request never reached the server. */
  readonly offline: boolean;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    issues?: Array<{ path: string; message: string }>;
    requestId?: string;
    offline?: boolean;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.issues = options.issues ?? [];
    this.requestId = options.requestId;
    this.offline = options.offline ?? false;
  }

  /** Field-level message for a form input, if the API supplied one. */
  issueFor(path: string): string | undefined {
    return this.issues.find((issue) => issue.path === path)?.message;
  }
}

/* --------------------------------------------------------------- Tokens */

export type Tokens = {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
};

let tokens: Tokens | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setTokens(next: Tokens | null): void {
  tokens = next;
  try {
    if (next) localStorage.setItem(appConfig.storageKeys.tokens, JSON.stringify(next));
    else localStorage.removeItem(appConfig.storageKeys.tokens);
  } catch {
    // Private browsing blocks storage; the session still works in memory.
  }
}

export function getTokens(): Tokens | null {
  if (tokens) return tokens;
  try {
    const raw = localStorage.getItem(appConfig.storageKeys.tokens);
    tokens = raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    tokens = null;
  }
  return tokens;
}

/** Lets the auth provider react to a session that can no longer be refreshed. */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

/* -------------------------------------------------------------- Requests */

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skips the Authorization header, for the public auth endpoints. */
  anonymous?: boolean;
  /** Replay protection for writes that must not double-apply. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = apiBase();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

/**
 * A single shared refresh promise.
 *
 * Without this, a screen that fires six requests on mount would send six
 * refresh calls the moment the token expires — and five of them would race to
 * overwrite each other's tokens.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const current = getTokens();
  if (!current?.refreshToken) return false;

  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) return false;

      const data = (await response.json()) as { tokens: Tokens };
      setTokens({ ...data.tokens, refreshToken: data.tokens.refreshToken || current.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see it.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

async function send<T>(path: string, options: RequestOptions, isRetry = false): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (!options.anonymous) {
    const current = getTokens();
    if (current?.accessToken) headers.authorization = `Bearer ${current.accessToken}`;
  }
  if (options.idempotencyKey) headers['x-idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;

    // fetch only rejects on a network-level failure, so this is genuinely
    // "could not reach the server" — never a 500.
    throw new ApiError({
      code: 'OFFLINE',
      message: "You're offline. This action will sync when you're back.",
      status: 0,
      offline: true,
    });
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (response.ok) return payload as T;

  // One refresh attempt, then give up and let the app sign out.
  if (response.status === 401 && !isRetry && !options.anonymous) {
    const refreshed = await refreshTokens();
    if (refreshed) return send<T>(path, options, true);

    setTokens(null);
    onUnauthenticated?.();
  }

  const body = payload as Partial<ApiErrorBody>;
  throw new ApiError({
    code: body.error?.code ?? 'INTERNAL',
    // The API already writes these for a shopkeeper; do not paraphrase them.
    message: body.error?.message ?? 'Something went wrong. Please try again.',
    status: response.status,
    issues: body.error?.issues ?? [],
    ...(body.requestId ? { requestId: body.requestId } : {}),
  });
}

export const api = {
  get: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    send<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    send<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    send<T>(path, { ...options, method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    send<T>(path, { ...options, method: 'PUT', body }),

  delete: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    send<T>(path, { ...options, method: 'DELETE' }),
};

/** Reads the runtime description used by the "Local mode" badge. */
export type RuntimeInfo = {
  stage: string;
  region: string;
  demoMode: boolean;
  subsystems: Record<string, 'aws' | 'local'>;
  notificationProvider: string;
  fullyProvisioned: boolean;
  localSubsystems: string[];
};

export async function fetchHealth(): Promise<{ status: string; runtime: RuntimeInfo }> {
  return api.get('/health', { anonymous: true });
}
