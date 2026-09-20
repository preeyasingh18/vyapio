import { AppError, notFound } from './errors';
import type { Logger } from './logger';

/**
 * A tiny, dependency-free HTTP router.
 *
 * The whole API is one Lambda, so the routing that would normally live in API
 * Gateway lives here instead. Writing ~150 lines rather than pulling in Express
 * keeps the container image small and cold starts short, and it means the exact
 * same request pipeline runs under Lambda and under the local dev server.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/** Everything a handler is allowed to see about the caller. */
export type RequestContext = {
  requestId: string;
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed JSON body, or undefined. Validated by middleware/validation.ts. */
  body: unknown;
  rawBody: string;
  sourceIp: string;
  logger: Logger;
  /**
   * Populated by middleware/auth.ts for authenticated routes. Handlers reach
   * for `requireAuth(ctx)` rather than reading this directly.
   */
  auth?: AuthContext;
};

export type AuthContext = {
  userId: string;
  email: string;
  /** Display name from the token, when it carries one. Never required. */
  name?: string;
  role: 'SHOPKEEPER' | 'CUSTOMER';
  /** Resolved server-side from userId. Never read from the request. */
  vendorId?: string;
  /** For customer-app sessions: the customer rows this user may read. */
  customerLinks?: string[];
  tokenUse: 'access' | 'id' | 'local';
};

export type HttpResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type Handler = (ctx: RequestContext) => Promise<HttpResponse> | HttpResponse;

type Route = {
  method: HttpMethod;
  /** Compiled from a pattern like '/customers/:customerId'. */
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  /** Human name used in logs and metrics: 'GET /customers/:customerId'. */
  operation: string;
};

function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^/${source}/?$`), paramNames };
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: HttpMethod, path: string, handler: Handler): this {
    const { pattern, paramNames } = compile(path);
    this.routes.push({ method, pattern, paramNames, handler, operation: `${method} ${path}` });
    return this;
  }

  get = (path: string, handler: Handler) => this.add('GET', path, handler);
  post = (path: string, handler: Handler) => this.add('POST', path, handler);
  put = (path: string, handler: Handler) => this.add('PUT', path, handler);
  patch = (path: string, handler: Handler) => this.add('PATCH', path, handler);
  delete = (path: string, handler: Handler) => this.add('DELETE', path, handler);

  /** Mounts another router's routes under a prefix. */
  mount(prefix: string, router: Router): this {
    for (const route of router.export()) {
      this.add(route.method, `${prefix}${route.path}`, route.handler);
    }
    return this;
  }

  /** Flat view used by `mount` and by the route listing on the health check. */
  export(): Array<{ method: HttpMethod; path: string; handler: Handler }> {
    return this.routes.map((route) => ({
      method: route.method,
      path: route.operation.slice(route.operation.indexOf(' ') + 1),
      handler: route.handler,
    }));
  }

  list(): string[] {
    return this.routes.map((route) => route.operation);
  }

  match(
    method: HttpMethod,
    path: string,
  ): { handler: Handler; params: Record<string, string>; operation: string } | null {
    const normalised = path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(normalised);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        const raw = match[index + 1];
        if (raw !== undefined) params[name] = decodeURIComponent(raw);
      });
      return { handler: route.handler, params, operation: route.operation };
    }
    return null;
  }

  /**
   * Whether any route exists at this path under a different verb. Lets the
   * caller answer 405 instead of a misleading 404.
   */
  allowedMethods(path: string): HttpMethod[] {
    const normalised = path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
    return this.routes
      .filter((route) => route.pattern.test(normalised))
      .map((route) => route.method);
  }
}

export const ok = (body: unknown): HttpResponse => ({ status: 200, body });
export const created = (body: unknown): HttpResponse => ({ status: 201, body });
export const accepted = (body: unknown): HttpResponse => ({ status: 202, body });
export const noContent = (): HttpResponse => ({ status: 204 });

export function routeNotFound(path: string, allowed: HttpMethod[]): AppError {
  if (allowed.length > 0) {
    return new AppError('BAD_REQUEST', `Method not allowed for ${path}`, {
      userMessage: 'That action is not available.',
    });
  }
  return notFound('route');
}
