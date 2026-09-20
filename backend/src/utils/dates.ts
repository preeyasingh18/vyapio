/**
 * Date helpers.
 *
 * All timestamps are stored as ISO-8601 UTC strings, which sort lexicographically
 * — that is what lets DynamoDB range keys work as chronological indexes without
 * a secondary sort. Presentation in IST happens in the client.
 */

export const DAY_MS = 86_400_000;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoDaysAgo(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() - days * DAY_MS).toISOString();
}

export function isoDaysAhead(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() + days * DAY_MS).toISOString();
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

export function isBefore(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

/** Start of the given day, in UTC. */
export function startOfDayIso(date: Date = new Date()): string {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString();
}

/** Inclusive-start, exclusive-end window for "today". */
export function todayRange(now: Date = new Date()): { from: string; to: string } {
  return { from: startOfDayIso(now), to: new Date(now.getTime() + 1).toISOString() };
}

export function lastNDaysRange(days: number, now: Date = new Date()): { from: string; to: string } {
  return { from: isoDaysAgo(days, now), to: new Date(now.getTime() + 1).toISOString() };
}

/** Calendar month containing `now`, as an inclusive/exclusive ISO window. */
export function monthRange(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Previous calendar month — what "last month" means in shop-memory questions. */
export function lastMonthRange(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: start.toISOString(), to: end.toISOString() };
}

export function withinRange(iso: string, range: { from: string; to: string }): boolean {
  const time = Date.parse(iso);
  return time >= Date.parse(range.from) && time < Date.parse(range.to);
}

/** Greeting used across the shopkeeper and customer home screens (IST). */
export function greetingFor(now: Date = new Date()): 'morning' | 'afternoon' | 'evening' {
  const istHour = (now.getUTCHours() + 5 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
  if (istHour < 12) return 'morning';
  if (istHour < 17) return 'afternoon';
  return 'evening';
}
