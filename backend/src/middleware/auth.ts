import { authService } from '../services/auth';
import { customers as customerRepo, vendors } from '../services/repository';
import { forbidden, unauthenticated } from '../utils/errors';
import { logger } from '../utils/logger';
import type { AuthContext, RequestContext } from '../utils/router';
import type { Vendor } from '../schemas/entities';

/**
 * Authentication and tenancy.
 *
 * The single most important property of this file: **`vendorId` is resolved
 * from the store using the verified token's `sub`, and is never read from a
 * request body, query string, path parameter or header.**
 *
 * Handlers ask for `requireVendor(ctx)` and get a vendorId they can trust. A
 * handler that wanted to serve another shop's data would have to go out of its
 * way to construct one, rather than merely forgetting a check.
 */

/** Extracts the bearer token, or null when the request is anonymous. */
function bearerToken(ctx: RequestContext): string | null {
  const header = ctx.headers.authorization ?? ctx.headers.Authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * Populates `ctx.auth` when a valid token is present.
 *
 * Deliberately non-fatal: public routes still work, and routes that need a user
 * call `requireAuth`. A bad token is treated as no token so an expired session
 * lands on the sign-in screen rather than an error page.
 */
export async function attachAuth(ctx: RequestContext): Promise<void> {
  const token = bearerToken(ctx);
  if (!token) return;

  try {
    const auth = await authService.verify(token);
    ctx.auth = auth;
    ctx.logger = ctx.logger.child({ userId: auth.userId });
  } catch (error) {
    logger.debug('token verification failed', {
      requestId: ctx.requestId,
      operation: 'auth.attach',
      error,
    });
  }
}

export function requireAuth(ctx: RequestContext): AuthContext {
  if (!ctx.auth) throw unauthenticated('No valid session on request');
  return ctx.auth;
}

export function requireRole(ctx: RequestContext, role: 'SHOPKEEPER' | 'CUSTOMER'): AuthContext {
  const auth = requireAuth(ctx);
  if (auth.role !== role) {
    logger.warn('role check failed', {
      requestId: ctx.requestId,
      userId: auth.userId,
      operation: 'auth.requireRole',
      required: role,
      actual: auth.role,
    });
    throw forbidden(`Requires ${role} role`, { required: role, actual: auth.role });
  }
  return auth;
}

/**
 * Resolves the caller's shop.
 *
 * Caches onto `ctx.auth` so several handlers in one request do not each hit the
 * store, but the lookup itself always starts from the verified userId.
 */
export async function requireVendor(ctx: RequestContext): Promise<{
  auth: AuthContext;
  vendor: Vendor;
  vendorId: string;
}> {
  const auth = requireRole(ctx, 'SHOPKEEPER');

  const vendor = await vendors.findByUserId(auth.userId);
  if (!vendor) {
    throw forbidden('No shop is linked to this account', { userId: auth.userId });
  }

  auth.vendorId = vendor.vendorId;
  ctx.logger = ctx.logger.child({ vendorId: vendor.vendorId });
  return { auth, vendor, vendorId: vendor.vendorId };
}

/**
 * Resolves which customer profiles a customer-app session may read.
 *
 * A customer can be a customer of many shops, so this returns every
 * (vendorId, customerId) pair linked to their login — and nothing else.
 */
export async function requireCustomerLinks(ctx: RequestContext): Promise<{
  auth: AuthContext;
  links: Array<{ vendorId: string; customerId: string }>;
}> {
  const auth = requireRole(ctx, 'CUSTOMER');
  const links = await customerRepo.findLinksForUser(auth.userId);
  auth.customerLinks = links.map((link) => link.customerId);
  return { auth, links };
}

/**
 * Asserts that a customer-app caller may read one specific customer row.
 *
 * Without this, a customer could page through `/khata/:customerId` and read
 * strangers' balances.
 */
export async function assertCustomerAccess(
  ctx: RequestContext,
  vendorId: string,
  customerId: string,
): Promise<void> {
  const { links } = await requireCustomerLinks(ctx);
  const allowed = links.some(
    (link) => link.vendorId === vendorId && link.customerId === customerId,
  );
  if (!allowed) {
    logger.warn('customer access denied', {
      requestId: ctx.requestId,
      userId: ctx.auth?.userId,
      operation: 'auth.assertCustomerAccess',
      vendorId,
    });
    throw forbidden('This profile is not linked to your account', { vendorId, customerId });
  }
}
