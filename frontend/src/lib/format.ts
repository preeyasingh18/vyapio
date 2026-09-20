/**
 * Display formatting.
 *
 * Money arrives from the API as integer paise and is only ever turned into a
 * fractional rupee value here, at the last possible moment. Nothing upstream of
 * this file does arithmetic on a float.
 */

export type Paise = number;

/** "₹1,240" / "₹1,240.50" — paise shown only when non-zero. */
export function formatMoney(paise: Paise, options: { sign?: boolean } = {}): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const remainder = abs % 100;

  // The Indian grouping (1,24,000 rather than 124,000) comes free from en-IN.
  const grouped = new Intl.NumberFormat('en-IN').format(rupees);
  const body = remainder === 0 ? grouped : `${grouped}.${String(remainder).padStart(2, '0')}`;

  const prefix = negative ? '-' : options.sign && paise > 0 ? '+' : '';
  return `${prefix}₹${body}`;
}

/** Compact form for dense tiles: ₹12.5k, ₹1.2L, ₹3.4Cr. */
export function formatMoneyCompact(paise: Paise): string {
  const rupees = Math.round(paise / 100);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';

  if (abs >= 10_000_000) return `${sign}₹${trim(abs / 10_000_000)}Cr`;
  if (abs >= 100_000) return `${sign}₹${trim(abs / 100_000)}L`;
  if (abs >= 1_000) return `${sign}₹${trim(abs / 1_000)}k`;
  return `${sign}₹${new Intl.NumberFormat('en-IN').format(abs)}`;
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

/* ------------------------------------------------------------------- Dates */

/**
 * Timeline-friendly dates: "Today", "Yesterday", "12 Sept", "28 Aug 2024".
 *
 * A shopkeeper scanning a customer's history reads relative time far faster
 * than a date, so the two most recent days get words.
 */
export function formatTimelineDate(iso: string, locale = 'en-IN', now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatTime(iso: string, locale = 'en-IN'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(iso: string, locale = 'en-IN'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "3 days ago" / "in 5 days" / "today". */
export function formatRelativeDays(iso: string, now = new Date()): string {
  const days = Math.round((Date.parse(iso) - now.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

export function daysBetween(fromIso: string, toIso = new Date().toISOString()): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/* ------------------------------------------------------------------ People */

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * A stable colour per person, so the same customer always gets the same avatar.
 * Hue only — saturation and lightness are fixed so every avatar sits at the
 * same visual weight and none of them shout.
 */
export function avatarHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

/** "98765 43210" — how an Indian mobile number is actually read aloud. */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 10) return phone;
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/* ------------------------------------------------------------------ Numbers */

export function formatNumber(value: number, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** "2 kg" / "1 piece" — hides the filler unit so lines read naturally. */
export function formatQuantity(quantity: number, unit: string): string {
  const amount = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2).replace(/\.?0+$/, '');
  return unit && unit !== 'unit' ? `${amount} ${unit}` : amount;
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
