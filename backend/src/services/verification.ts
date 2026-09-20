import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { getStore, keys } from './dynamodb';
import { nowIso } from '../utils/dates';
import { AppError } from '../utils/errors';
import type { BusinessCategory, Language, Role } from '../schemas/common';

/**
 * Email verification for signup.
 *
 * The rule this exists to enforce: **an account does not exist until the email
 * is verified.** Creating the user first and flipping a flag afterwards leaves
 * the shop's books reachable by whoever typed the address — including someone
 * who typed it by mistake, or on purpose, for a mailbox they do not own.
 *
 * So the signup form's answers are parked in a pending record, keyed by email,
 * and the real User and Vendor rows are written only by `consume()` — after a
 * code that was emailed to that address comes back.
 *
 * The code itself is never stored. What is stored is a salted SHA-256 of it,
 * compared in constant time, so a leaked table does not hand out live codes.
 */

/** Long enough to fetch a phone and read an email, short enough to matter. */
export const OTP_TTL_MINUTES = 10;

/** After this many wrong guesses the code is dead and a new one is needed. */
export const MAX_ATTEMPTS = 5;

/** How long before another code can be requested for the same address. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Abandoned signups expire themselves rather than accumulating for ever. */
const PENDING_TTL_HOURS = 24;

export type PendingSignup = {
  email: string;
  role: Role;
  ownerName: string;
  phone: string;
  shopName?: string;
  category?: BusinessCategory;
  city?: string;
  language: Language;
  /** Never the password itself. Hashed with the same function login uses. */
  passwordSalt: string;
  passwordHash: string;
  codeHash: string;
  codeSalt: string;
  expiresAt: string;
  attempts: number;
  lastSentAt: string;
  createdAt: string;
  /** Unix seconds, for DynamoDB's TTL sweeper. Ignored by the local store. */
  ttl: number;
};

/* ------------------------------------------------------------------ Codes */

/**
 * A six-digit code.
 *
 * `randomInt` draws from the same source as the rest of Node's crypto, and is
 * free of the modulo bias that `Math.random() * 900000` would introduce — that
 * bias is small, but it is a bias in a secret, which is where it matters.
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('base64');
}

/** Constant time, so a wrong guess reveals nothing about how wrong it was. */
function codeMatches(code: string, salt: string, expected: string): boolean {
  const actual = Buffer.from(hashCode(code, salt));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

/* ------------------------------------------------------------- Persistence */

/** Trimmed and lowercased, everywhere — the key has to be one thing. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function readPending(email: string): Promise<PendingSignup | null> {
  const { pk, sk } = keys.pendingSignup(normaliseEmail(email));
  const item = await getStore().get(pk, sk);
  return item ? (item as unknown as PendingSignup) : null;
}

async function writePending(record: PendingSignup): Promise<void> {
  await getStore().put({
    ...keys.pendingSignup(record.email),
    entity: 'PendingSignup',
    ...record,
  });
}

export async function discardPending(email: string): Promise<void> {
  const { pk, sk } = keys.pendingSignup(normaliseEmail(email));
  await getStore().delete(pk, sk);
}

/* -------------------------------------------------------------- The flow */

export type PendingDraft = Omit<
  PendingSignup,
  'codeHash' | 'codeSalt' | 'expiresAt' | 'attempts' | 'lastSentAt' | 'createdAt' | 'ttl'
>;

/**
 * Parks a signup and returns the code to email.
 *
 * The code is returned to the caller *only* so the caller can put it in an
 * email. It is never persisted in the clear and never reaches a response body
 * — see the signup route, which discards it once the mail is away.
 */
export async function startVerification(
  draft: PendingDraft,
): Promise<{ pending: PendingSignup; code: string }> {
  const code = generateCode();
  const salt = randomBytes(16).toString('base64');
  const now = Date.now();

  const pending: PendingSignup = {
    ...draft,
    email: normaliseEmail(draft.email),
    codeSalt: salt,
    codeHash: hashCode(code, salt),
    expiresAt: new Date(now + OTP_TTL_MINUTES * 60_000).toISOString(),
    attempts: 0,
    lastSentAt: nowIso(),
    createdAt: nowIso(),
    ttl: Math.floor((now + PENDING_TTL_HOURS * 3_600_000) / 1000),
  };

  await writePending(pending);
  return { pending, code };
}

/**
 * Issues a fresh code for a signup already in progress.
 *
 * The previous code stops working the moment this is called: two live codes
 * for one address doubles what a guesser has to hit, and the older one is the
 * one more likely to have been seen by someone else.
 */
export async function reissueCode(
  email: string,
): Promise<{ pending: PendingSignup; code: string }> {
  const existing = await readPending(email);
  if (!existing) {
    throw new AppError('NOT_FOUND', 'No signup in progress', {
      userMessage: 'That signup has expired. Please start again.',
    });
  }

  const waited = Date.now() - Date.parse(existing.lastSentAt);
  if (waited < RESEND_COOLDOWN_SECONDS * 1000) {
    const left = Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - waited) / 1000);
    throw new AppError('RATE_LIMITED', 'Resend too soon', {
      userMessage: `Please wait ${left} more second${left === 1 ? '' : 's'} before asking for another code.`,
    });
  }

  const code = generateCode();
  const salt = randomBytes(16).toString('base64');

  const pending: PendingSignup = {
    ...existing,
    codeSalt: salt,
    codeHash: hashCode(code, salt),
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
    // Attempts reset with the code: the new one has not been guessed at yet.
    attempts: 0,
    lastSentAt: nowIso(),
  };

  await writePending(pending);
  return { pending, code };
}

export type CheckOutcome =
  | { ok: true; pending: PendingSignup }
  | { ok: false; reason: 'unknown' | 'expired' | 'exhausted' | 'wrong'; message: string };

/**
 * Checks a code, counting the attempt.
 *
 * Every failure path costs an attempt, including an expired code — otherwise
 * the expiry check becomes a free oracle for finding out whether an address is
 * mid-signup.
 */
export async function checkCode(email: string, code: string): Promise<CheckOutcome> {
  const pending = await readPending(email);
  if (!pending) {
    return {
      ok: false,
      reason: 'unknown',
      message: 'That signup has expired. Please start again.',
    };
  }

  if (pending.attempts >= MAX_ATTEMPTS) {
    return {
      ok: false,
      reason: 'exhausted',
      message: 'Too many incorrect codes. Ask for a new one.',
    };
  }

  if (Date.parse(pending.expiresAt) < Date.now()) {
    return {
      ok: false,
      reason: 'expired',
      message: 'This code has expired. Please request a new code.',
    };
  }

  if (!codeMatches(code, pending.codeSalt, pending.codeHash)) {
    const attempts = pending.attempts + 1;
    await writePending({ ...pending, attempts });

    const left = MAX_ATTEMPTS - attempts;
    return {
      ok: false,
      reason: left > 0 ? 'wrong' : 'exhausted',
      message:
        left > 0
          ? `Invalid verification code. ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'Too many incorrect codes. Ask for a new one.',
    };
  }

  return { ok: true, pending };
}
