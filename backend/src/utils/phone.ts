/**
 * Turning a saved phone number into something WhatsApp will accept.
 *
 * Customers are stored with a ten-digit Indian number — that is what
 * `PhoneSchema` normalises to, and what a shopkeeper types. WhatsApp and SNS
 * both want E.164, so the country code has to go back on somewhere, and it may
 * as well be in one place that every provider shares.
 *
 * The one thing this must not do is "fix" a number that was already right. A
 * shop with a supplier in Dubai has a +971 number on file; prefixing it with
 * +91 would send the message to a stranger, and the shopkeeper would be told it
 * was delivered.
 */

/** India's country code, the default for a bare ten-digit number. */
const INDIA = '91';

export type PhoneResult =
  /** Usable. `e164` is what goes to the provider. */
  | { ok: true; e164: string; national: string }
  /** Not usable, with a reason short enough to show the shopkeeper. */
  | { ok: false; reason: 'missing' | 'invalid'; detail: string };

/**
 * Normalises a phone number to E.164.
 *
 * Four shapes reach this, and all four are things a shopkeeper actually has on
 * file:
 *
 *   9876543210        ten digits, the common case   -> +919876543210
 *   919876543210      already carries 91            -> +919876543210
 *   +91 98765 43210   spaced, with a plus           -> +919876543210
 *   09876543210       a trunk 0, as dialled locally -> +919876543210
 *
 * Anything that already arrives with a `+` and a different country code is
 * passed through untouched.
 */
export function normalisePhone(raw: string | null | undefined): PhoneResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'missing', detail: 'No phone number saved for this customer.' };
  }

  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');

  if (!digits) {
    return { ok: false, reason: 'invalid', detail: 'That phone number has no digits in it.' };
  }

  /**
   * An explicit country code is the author's intent, so it is left alone —
   * except for +91, which still has to pass the Indian mobile check below.
   */
  if (hadPlus && !digits.startsWith(INDIA)) {
    return isPlausibleInternational(digits)
      ? { ok: true, e164: `+${digits}`, national: digits }
      : { ok: false, reason: 'invalid', detail: 'That phone number is not a valid number.' };
  }

  // A leading 0 is how the number is dialled inside India, not part of it.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === 12 && digits.startsWith(INDIA)) digits = digits.slice(2);

  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) {
      return {
        ok: false,
        reason: 'invalid',
        detail: 'An Indian mobile number starts with 6, 7, 8 or 9.',
      };
    }
    return { ok: true, e164: `+${INDIA}${digits}`, national: digits };
  }

  /**
   * Not ten digits and no plus sign. It could be an international number typed
   * without one, so it is accepted if the length is plausible rather than
   * assumed to be Indian — guessing +91 onto a foreign number is the one
   * mistake here that sends a message to the wrong person.
   */
  if (isPlausibleInternational(digits)) {
    return { ok: true, e164: `+${digits}`, national: digits };
  }

  return {
    ok: false,
    reason: 'invalid',
    detail: `"${trimmed}" is not a phone number we can send to.`,
  };
}

/** E.164 allows 8–15 digits, and no real subscriber number is shorter. */
function isPlausibleInternational(digits: string): boolean {
  return digits.length >= 8 && digits.length <= 15;
}

/**
 * The form WhatsApp's Cloud API wants: digits only, no leading `+`.
 *
 * Meta accepts both, but documents it without the plus, and a number sent one
 * way and logged another is harder to match up when a message goes missing.
 */
export function toWhatsAppNumber(e164: string): string {
  return e164.replace(/\D/g, '');
}

/** "+91 98765 43210" — for showing back to the shopkeeper, never for sending. */
export function formatE164(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith(INDIA)) {
    const local = digits.slice(2);
    return `+${INDIA} ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  return `+${digits}`;
}
