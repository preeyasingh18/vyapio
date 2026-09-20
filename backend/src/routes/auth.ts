import { Router, ok, created, type RequestContext } from '../utils/router';
import {
  checkCode,
  discardPending,
  normaliseEmail,
  OTP_TTL_MINUTES,
  reissueCode,
  startVerification,
  type PendingDraft,
} from '../services/verification';
import { sendEmail } from '../services/email';
import { verificationEmail } from '../services/emailTemplates';
import type { BusinessCategory, Language, Role } from '../schemas/common';
import { parseBody } from '../middleware/validation';
import { requireAuth, requireVendor } from '../middleware/auth';
import { authService } from '../services/auth';
import { vendors, customers as customerRepo } from '../services/repository';
import { config } from '../config/index';
import { AppError, badRequest, forbidden, notFound, unauthenticated } from '../utils/errors';
import { nowIso } from '../utils/dates';
import { newVendorId } from '../utils/ids';
import {
  ClaimProfileRequestSchema,
  CompleteOnboardingRequestSchema,
  ConfirmSignupRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  ResendCodeRequestSchema,
  ResetPasswordRequestSchema,
  SignupRequestSchema,
  UpdateVendorRequestSchema,
} from '../schemas/requests';
import { VendorSchema, type Vendor } from '../schemas/entities';

/**
 * Authentication and identity.
 *
 * Sign-up creates two things for a shopkeeper: an auth account (Cognito or
 * local) and a Vendor row that binds `userId -> vendorId`. That binding is the
 * root of tenancy — everything else in the API derives the shop from it rather
 * than trusting the client.
 */

export const authRoutes = new Router();

/** Shared serialisation so the client sees one consistent session shape. */
async function sessionPayload(userId: string) {
  const vendor = await vendors.findByUserId(userId);
  return {
    vendor: vendor ?? null,
    needsOnboarding: !vendor || !vendor.onboardingComplete,
  };
}

/**
 * Signup, step one of two.
 *
 * Nothing is created here. The form's answers are parked against the email
 * address and a code is posted to it; the User and Vendor rows are written by
 * /auth/confirm, once that code comes back.
 *
 * The order matters and is the point of the whole route: an account that
 * exists before the address is proven is an account belonging to whoever
 * typed it, which need not be the person who owns the mailbox.
 */
/** The shop row, written once an account is real. */
async function createVendorFor(
  userId: string,
  input: { shopName?: string; ownerName: string; phone: string; email: string; category?: BusinessCategory; city?: string; language: Language },
): Promise<void> {
  const vendor: Vendor = VendorSchema.parse({
    vendorId: newVendorId(),
    userId,
    shopName: input.shopName!,
    ownerName: input.ownerName,
    phone: input.phone,
    email: normaliseEmail(input.email),
    category: input.category ?? 'other',
    city: input.city ?? 'India',
    language: input.language,
    voiceLanguage: input.language,
    onboardingComplete: false,
    isDemo: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } satisfies Vendor);
  await vendors.put(vendor);
}

/**
 * The signup form's answers, ready to park.
 *
 * The password is hashed here and the plaintext goes no further — the pending
 * record is an ordinary row, and a row is a thing that gets backed up, logged
 * and exported.
 */
function draftFrom(
  input: { ownerName: string; phone: string; role: Role; shopName?: string; category?: BusinessCategory; city?: string; language: Language; password: string },
  email: string,
): PendingDraft {
  const { salt, hash } = authService.hashNewPassword(input.password);
  return {
    email,
    role: input.role,
    ownerName: input.ownerName,
    phone: input.phone,
    ...(input.shopName ? { shopName: input.shopName } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.city ? { city: input.city } : {}),
    language: input.language,
    passwordSalt: salt,
    passwordHash: hash,
  };
}

authRoutes.post('/signup', async (ctx: RequestContext) => {
  const input = parseBody(ctx, SignupRequestSchema);
  const email = normaliseEmail(input.email);

  if (input.role === 'SHOPKEEPER' && !input.shopName) {
    throw badRequest('shopName is required for shopkeepers', 'Tell us your shop name.');
  }

  /**
   * Cognito runs this journey itself — it holds the unconfirmed user, mails
   * the code and refuses a sign-in until it is entered. Duplicating that here
   * would mean two systems deciding whether an account exists.
   */
  if (authService.mode() === 'aws') {
    const { userId, requiresVerification } = await authService.signup({
      email,
      password: input.password,
      name: input.ownerName,
      phone: input.phone,
      role: input.role,
    });

    // The shop is written only for an account Cognito already considers
    // confirmed; otherwise it waits for /auth/confirm, like local mode.
    if (input.role === 'SHOPKEEPER' && userId && !requiresVerification) {
      await createVendorFor(userId, input);
    } else if (input.role === 'SHOPKEEPER' && userId) {
      // Parked so /auth/confirm can write the shop once Cognito confirms.
      await startVerification(draftFrom(input, email));
    }

    ctx.logger.info('signup complete', {
      operation: 'auth.signup',
      userId,
      role: input.role,
      requiresVerification,
    });

    return created({
      userId,
      requiresVerification,
      message: requiresVerification
        ? 'Check your email for a 6-digit verification code.'
        : 'Your account is ready. Please sign in.',
    });
  }

  // An address that already has an account is not a signup.
  const existing = await authService.findByEmail(email);
  if (existing) {
    throw new AppError('CONFLICT', 'Email already registered', {
      userMessage: 'This email is already registered. Please sign in.',
    });
  }

  const { code } = await startVerification(draftFrom(input, email));

  const message = verificationEmail({
    name: input.ownerName,
    code,
    expiresInMinutes: OTP_TTL_MINUTES,
  });
  const delivery = await sendEmail({ ...message, to: email });

  /**
   * A failed send is a failed signup.
   *
   * Moving the user to the code screen when no mail left the machine leaves
   * them waiting on something that is not coming, with no way to tell whether
   * to wait or start again. The pending record is cleared so a retry is clean.
   */
  if (!delivery.ok) {
    await discardPending(email);
    throw new AppError('NOTIFICATION_FAILED', 'Verification email not sent', {
      userMessage: 'Unable to send the verification email. Please try again.',
    });
  }

  ctx.logger.info('signup awaiting verification', {
    operation: 'auth.signup',
    role: input.role,
    emailProvider: delivery.provider,
    // Never the code, and never the password.
    delivered: delivery.sent,
  });

  return created({
    requiresVerification: true,
    /**
     * False when the console provider handled it — there is no inbox to check,
     * and the UI says where to find the code instead of sending the shopkeeper
     * hunting for an email that was never posted.
     */
    emailSent: delivery.sent,
    message: delivery.sent
      ? 'Check your email for a 6-digit verification code.'
      : 'No email provider is configured, so the code was written to the server log instead.',
  });
});

authRoutes.post('/login', async (ctx) => {
  const input = parseBody(ctx, LoginRequestSchema);
  const tokens = await authService.login(input.email, input.password);
  const auth = await authService.verify(tokens.accessToken);
  const session = await sessionPayload(auth.userId);

  ctx.logger.info('login', { operation: 'auth.login', userId: auth.userId });

  return ok({
    tokens,
    user: { userId: auth.userId, email: auth.email, role: auth.role },
    ...session,
  });
});

/**
 * Signup, step two: the code comes back and the account is created.
 *
 * This is the only place a locally-authenticated User row is written, which is
 * what makes "verified" mean something: there is no path that produces an
 * account without having posted a code to the address and had it returned.
 */
authRoutes.post('/confirm', async (ctx) => {
  const input = parseBody(ctx, ConfirmSignupRequestSchema);
  const email = normaliseEmail(input.email);

  const outcome = await checkCode(email, input.code);
  if (!outcome.ok) {
    ctx.logger.warn('verification code rejected', {
      operation: 'auth.confirm',
      reason: outcome.reason,
    });
    throw new AppError(outcome.reason === 'exhausted' ? 'RATE_LIMITED' : 'VALIDATION_FAILED', `code ${outcome.reason}`, {
      userMessage: outcome.message,
    });
  }

  const pending = outcome.pending;

  /**
   * Cognito holds its own unconfirmed user, so there the code is its to check
   * and this record exists only to carry the shop details across.
   */
  if (authService.mode() === 'aws') {
    await authService.confirmSignup(email, input.code);
  }

  // Checked again here, not just at signup: two tabs could have got this far.
  const already = await authService.findByEmail(email);
  const userId = already
    ? already.userId
    : await authService.createVerifiedUser({
        email,
        ownerName: pending.ownerName,
        phone: pending.phone,
        role: pending.role,
        passwordSalt: pending.passwordSalt,
        passwordHash: pending.passwordHash,
      });

  if (pending.role === 'SHOPKEEPER' && !already) {
    const vendor: Vendor = VendorSchema.parse({
      vendorId: newVendorId(),
      userId,
      shopName: pending.shopName!,
      ownerName: pending.ownerName,
      phone: pending.phone,
      email,
      category: pending.category ?? 'other',
      city: pending.city ?? 'India',
      language: pending.language,
      voiceLanguage: pending.language,
      onboardingComplete: false,
      isDemo: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } satisfies Vendor);
    await vendors.put(vendor);
  }

  // One-time use: the record is gone, so the same code cannot be replayed.
  await discardPending(email);

  ctx.logger.info('email verified, account created', {
    operation: 'auth.confirm',
    userId,
    role: pending.role,
  });

  return ok({ message: 'Email verified. You can sign in now.', emailVerified: true });
});

/**
 * Another code for a signup already under way.
 *
 * Rate limited in services/verification.ts rather than here, so the cooldown
 * is the same however this is reached.
 */
authRoutes.post('/resend-code', async (ctx) => {
  const input = parseBody(ctx, ResendCodeRequestSchema);
  const email = normaliseEmail(input.email);

  if (authService.mode() === 'aws') {
    await authService.resendCode(email);
    return ok({ message: 'We sent another code to your email.' });
  }

  const { pending, code } = await reissueCode(email);

  const message = verificationEmail({
    name: pending.ownerName,
    code,
    expiresInMinutes: OTP_TTL_MINUTES,
  });
  const delivery = await sendEmail({ ...message, to: email });

  if (!delivery.ok) {
    throw new AppError('NOTIFICATION_FAILED', 'Verification email not sent', {
      userMessage: 'Unable to send the verification email. Please try again.',
    });
  }

  return ok({
    emailSent: delivery.sent,
    message: delivery.sent
      ? 'We sent another code to your email.'
      : 'No email provider is configured, so the code was written to the server log instead.',
  });
});

authRoutes.post('/forgot-password', async (ctx) => {
  const input = parseBody(ctx, ForgotPasswordRequestSchema);
  await authService.forgotPassword(input.email);
  // Deliberately identical whether or not the account exists, so this endpoint
  // cannot be used to discover who has an account.
  return ok({ message: 'If that email is registered, a reset code is on its way.' });
});

authRoutes.post('/reset-password', async (ctx) => {
  const input = parseBody(ctx, ResetPasswordRequestSchema);
  await authService.resetPassword(input.email, input.code, input.password);
  return ok({ message: 'Password updated. Please sign in.' });
});

authRoutes.post('/refresh', async (ctx) => {
  const input = parseBody(ctx, RefreshRequestSchema);
  const email = typeof ctx.headers['x-user-email'] === 'string' ? ctx.headers['x-user-email'] : '';
  const tokens = await authService.refresh(input.refreshToken, email);
  return ok({ tokens });
});

authRoutes.post('/logout', async (ctx) => {
  const header = ctx.headers.authorization ?? '';
  const token = header.split(' ')[1] ?? '';
  if (token) await authService.logout(token);
  return ok({ message: 'Signed out.' });
});

/** Current session. The client calls this on boot to restore state. */
authRoutes.get('/me', async (ctx) => {
  const auth = requireAuth(ctx);

  // Boot is the one place worth confirming the account is still there. A local
  // token survives the data store being reset, which would otherwise leave the
  // holder "signed in" to an account that no longer exists — bounced past the
  // landing page into an app with nothing in it. Rejecting here makes the
  // client drop the session and show the landing page, which is the truth.
  if (
    auth.tokenUse === 'local' &&
    !(await authService.localSessionIsLive(auth.userId, auth.email))
  ) {
    ctx.logger.info('session outlived its account', {
      operation: 'auth.me',
      userId: auth.userId,
    });
    throw unauthenticated('Session refers to an account that no longer exists');
  }

  const session = await sessionPayload(auth.userId);

  // Customer-app sessions carry their linked shops instead of a vendor.
  const links =
    auth.role === 'CUSTOMER' ? await customerRepo.findLinksForUser(auth.userId) : [];

  return ok({
    user: { userId: auth.userId, email: auth.email, role: auth.role },
    ...session,
    links,
  });
});

/* ------------------------------------------------------------- Onboarding */

/**
 * Completes onboarding — and creates the shop if it is somehow missing.
 *
 * Signup normally writes the Vendor row, so this usually just fills it in. But
 * `/auth/me` reports `needsOnboarding` whenever no vendor resolves, and the
 * client sends those users here. If this route then refused to create one, that
 * pairing would be a dead end: the app routes the user to the only screen that
 * can fix the problem, and the screen answers "we couldn't find that shop" for
 * ever, with no way out through the UI. It happens whenever a Vendor row is
 * gone but the session is not — a reset local store, a restored backup, a
 * signup that failed after the account was made.
 *
 * Creating it here is also exactly what the user asked for by filling the form
 * in: every field a shop needs is in this request already.
 */
authRoutes.post('/onboarding', async (ctx) => {
  const auth = requireAuth(ctx);
  const input = parseBody(ctx, CompleteOnboardingRequestSchema);

  // Same liveness check as /auth/me, because this is the route that *creates*
  // a shop. Without it a token for a rebuilt account walks straight in here and
  // strands a vendor on a userId no account owns — reachable only by whoever
  // still holds that token, and invisible to everyone else.
  if (
    auth.tokenUse === 'local' &&
    !(await authService.localSessionIsLive(auth.userId, auth.email))
  ) {
    throw unauthenticated('Session refers to an account that no longer exists');
  }

  const existing = await vendors.findByUserId(auth.userId);

  if (!existing) {
    const vendor: Vendor = VendorSchema.parse({
      vendorId: newVendorId(),
      userId: auth.userId,
      shopName: input.shopName,
      // Signup collected the owner's name and number; a session only carries
      // the name, so the number is left blank rather than invented. Settings
      // is where it gets filled back in.
      ownerName: auth.name || auth.email.split('@')[0] || 'Owner',
      phone: '',
      email: auth.email,
      category: input.category,
      city: input.city,
      language: input.language,
      voiceLanguage: input.voiceLanguage,
      onboardingComplete: true,
      isDemo: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } satisfies Vendor);
    await vendors.put(vendor);

    ctx.logger.warn('onboarding recreated a missing shop', {
      operation: 'auth.onboarding',
      userId: auth.userId,
      vendorId: vendor.vendorId,
    });

    return ok({ vendor, seedRequested: input.seedDemoData });
  }

  const vendor = await vendors.update(existing.vendorId, {
    shopName: input.shopName,
    category: input.category,
    city: input.city,
    language: input.language,
    voiceLanguage: input.voiceLanguage,
    onboardingComplete: true,
  });

  ctx.logger.info('onboarding complete', {
    operation: 'auth.onboarding',
    userId: auth.userId,
    vendorId: vendor.vendorId,
  });

  return ok({ vendor, seedRequested: input.seedDemoData });
});

authRoutes.patch('/vendor', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, UpdateVendorRequestSchema);
  const vendor = await vendors.update(vendorId, input);
  return ok({ vendor });
});

/* ---------------------------------------------------------- Customer link */

/**
 * Links a customer-app login to a shop profile.
 *
 * Possession of the printed QR token is the proof. That is deliberate and
 * modest: it is the same trust model as handing someone your loyalty card, and
 * it never exposes anything until the holder authenticates.
 */
authRoutes.post('/claim-profile', async (ctx) => {
  const auth = requireAuth(ctx);
  if (auth.role !== 'CUSTOMER') {
    throw forbidden('Only customer accounts can claim a profile');
  }

  const input = parseBody(ctx, ClaimProfileRequestSchema);
  const qrId = extractQrToken(input.qrId);

  // Resolved globally here (unlike the vendor-scoped scanner) because the
  // customer is arriving without a shop context.
  const { getStore } = await import('../services/dynamodb');
  const result = await getStore().query(`QR#${qrId}`, { index: 'gsi1', limit: 2 });
  const row = result.items[0];
  if (!row) throw notFound('profile');

  const vendorId = String(row.vendorId);
  const customerId = String(row.customerId);

  const customer = await customerRepo.get(vendorId, customerId);
  if (!customer) throw notFound('profile');
  if (customer.linkedUserId && customer.linkedUserId !== auth.userId) {
    throw forbidden('This profile is already linked to another account');
  }

  await customerRepo.link(vendorId, customerId, auth.userId);
  const vendor = await vendors.get(vendorId);

  ctx.logger.info('customer profile claimed', {
    operation: 'auth.claimProfile',
    userId: auth.userId,
    vendorId,
  });

  return ok({
    linked: true,
    shopName: vendor?.shopName ?? 'Shop',
    customerId,
    vendorId,
  });
});

/**
 * QR payloads may be a bare token or a `vyapio://c/<token>` URL. Both reduce to
 * the token; anything else is rejected rather than guessed at.
 */
export function extractQrToken(raw: string): string {
  const trimmed = raw.trim();
  const urlMatch = /(?:vyapio:\/\/c\/|\/c\/)([\w-]+)$/.exec(trimmed);
  if (urlMatch?.[1]) return urlMatch[1];
  return trimmed;
}

/* ------------------------------------------------------------------- Demo */

/**
 * One-tap sign-in to the seeded shop.
 *
 * Only available when DEMO_MODE is on, and it goes through the ordinary login
 * path — there is no bypass, just a known credential.
 */
authRoutes.post('/demo-login', async (ctx) => {
  if (!config.demo.enabled) {
    throw forbidden('Demo mode is disabled on this environment');
  }

  const tokens = await authService.login(config.demo.email, config.demo.password);
  const auth = await authService.verify(tokens.accessToken);
  const session = await sessionPayload(auth.userId);

  ctx.logger.info('demo login', { operation: 'auth.demoLogin', userId: auth.userId });

  return ok({
    tokens,
    user: { userId: auth.userId, email: auth.email, role: auth.role },
    ...session,
  });
});
