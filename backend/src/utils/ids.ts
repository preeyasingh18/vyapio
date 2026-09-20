import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Identifiers.
 *
 * Every id is opaque and carries no business meaning. QR tokens in particular
 * must never encode a phone number, a name or any balance — they are pure
 * lookup keys, resolved server-side against the authenticated vendor.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export const newVendorId = () => `ven_${randomId(16)}`;
export const newCustomerId = () => `cus_${randomId(16)}`;
export const newProductId = () => `prd_${randomId(16)}`;
export const newTransactionId = () => `txn_${randomId(16)}`;
export const newPaymentId = () => `pay_${randomId(16)}`;
export const newCommitmentId = () => `cmt_${randomId(16)}`;
export const newOrderId = () => `ord_${randomId(16)}`;
export const newInventoryEventId = () => `ive_${randomId(16)}`;
export const newActionId = () => `act_${randomId(16)}`;
export const newNotificationId = () => `ntf_${randomId(16)}`;
export const newDocumentId = () => `doc_${randomId(16)}`;
export const newUserId = () => `usr_${randomId(16)}`;
export const newRequestId = () => `req_${randomId(12)}`;

/**
 * Opaque customer QR token: 24 base36 chars ≈ 124 bits of entropy, so it is not
 * enumerable. Possession of the token alone reveals nothing — resolving it
 * requires an authenticated vendor session, and it only resolves within that
 * vendor's own tenant.
 */
export const newQrId = () => `vq_${randomId(24)}`;

/** Constant-time string compare for tokens and signatures. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Deterministic, non-reversible key for de-duplicating by phone number. */
export function hashKey(value: string, salt = 'vyapio'): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 32);
}
