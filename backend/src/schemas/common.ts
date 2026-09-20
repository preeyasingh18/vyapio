import { z } from 'zod';

/**
 * Shared primitives and vocabularies.
 *
 * This directory is deliberately dependency-free (zod only) because the
 * frontend imports it directly through the `@shared` alias. One definition of
 * a Transaction, used by the validator that guards the database and by the form
 * that collects it.
 */

/* --------------------------------------------------------------- Vocabulary */

export const BUSINESS_CATEGORIES = [
  'kirana',
  'pharmacy',
  'hardware',
  'electronics',
  'tailor',
  'stationery',
  'salon',
  'mechanic',
  'restaurant',
  'other',
] as const;

export const BusinessCategorySchema = z.enum(BUSINESS_CATEGORIES);
export type BusinessCategory = z.infer<typeof BusinessCategorySchema>;

/**
 * Languages Vyapio speaks.
 *
 * `transcribe` is the Amazon Transcribe streaming language code and `bcp47`
 * drives the browser's speech API and `Intl` formatting. The UI language and
 * the voice language are independent settings — a shopkeeper may well read
 * English menus while speaking Marathi.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', transcribe: 'en-IN', bcp47: 'en-IN' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', transcribe: 'hi-IN', bcp47: 'hi-IN' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা', transcribe: 'bn-IN', bcp47: 'bn-IN' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்', transcribe: 'ta-IN', bcp47: 'ta-IN' },
  { code: 'te', label: 'Telugu', native: 'తెలుగు', transcribe: 'te-IN', bcp47: 'te-IN' },
  { code: 'mr', label: 'Marathi', native: 'मराठी', transcribe: 'mr-IN', bcp47: 'mr-IN' },
  { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ', transcribe: 'kn-IN', bcp47: 'kn-IN' },
] as const;

export const LANGUAGE_CODES = ['en', 'hi', 'bn', 'ta', 'te', 'mr', 'kn'] as const;
export const LanguageSchema = z.enum(LANGUAGE_CODES);
export type Language = z.infer<typeof LanguageSchema>;

export function languageMeta(code: Language) {
  return LANGUAGES.find((entry) => entry.code === code) ?? LANGUAGES[0];
}

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'credit', 'other'] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

/** Where a record came from. Surfaced in the UI so AI-written rows are visible. */
export const RECORD_SOURCES = ['manual', 'voice', 'agent', 'scan', 'document', 'seed'] as const;
export const RecordSourceSchema = z.enum(RECORD_SOURCES);
export type RecordSource = z.infer<typeof RecordSourceSchema>;

export const ROLES = ['SHOPKEEPER', 'CUSTOMER'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/* --------------------------------------------------------------- Primitives */

export const NonEmptyString = z.string().trim().min(1);

/**
 * Indian mobile number, normalised to 10 digits. Accepts +91/0 prefixes and
 * spacing so a shopkeeper can type it however they think of it.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .transform((value) => {
    const digits = value.replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
  })
  .refine((value) => /^[6-9]\d{9}$/.test(value), {
    message: 'Enter a valid 10-digit Indian mobile number',
  });

/** Optional phone: empty string is allowed and means "not recorded". */
export const OptionalPhoneSchema = z.union([z.literal(''), PhoneSchema]).default('');

export const EmailSchema = z.email({ message: 'Enter a valid email address' });
export const OptionalEmailSchema = z.union([z.literal(''), EmailSchema]).default('');

export const IsoDateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Expected an ISO-8601 timestamp',
});

/**
 * Integer paise. Rejecting non-integers here is what keeps rounding errors out
 * of the ledger entirely — see utils/money.ts.
 */
/**
 * A calendar day, `YYYY-MM-DD`.
 *
 * Distinct from IsoDateTimeSchema on purpose: a purchase happened on a day, not
 * at an instant, and storing midnight-in-some-zone would make the date drift
 * across timezones for no gain.
 */
export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    // Round-trips only for real dates, so 2026-02-31 is rejected.
    return (
      date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    );
  }, 'That date does not exist');

/** A date, or '' meaning "not recorded". */
export const OptionalDateOnlySchema = z.union([z.literal(''), DateOnlySchema]).default('');

export const PaiseSchema = z.number().int().min(0).max(100_000_000_000);
export const SignedPaiseSchema = z.number().int().min(-100_000_000_000).max(100_000_000_000);

export const QuantitySchema = z.number().positive().max(1_000_000);

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export type Paginated<T> = {
  items: T[];
  cursor: string | null;
};
