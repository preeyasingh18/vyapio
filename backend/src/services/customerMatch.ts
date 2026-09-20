import { customers as customerRepo } from './repository';
import type { Customer } from '../schemas/entities';

/**
 * Resolving a spoken name to a person on the shop's books.
 *
 * One rule, in one place, used by both the voice parser and the confirm step.
 * Two implementations of "is this Ramesh?" that disagree is worse than either
 * of them alone: the preview would say a name is new, the save would find it,
 * and the shopkeeper would be told two different things about the same person.
 *
 * Names are not unique and never will be — a neighbourhood has several Rameshes
 * — so this never picks between candidates. It reports what it found and lets
 * the shopkeeper decide, because merging two customers is not something they
 * can undo from the till.
 */

/**
 * How many customers to consider.
 *
 * There is no index on name, so matching reads the shop's customer list. The
 * ceiling is deliberately far above what a neighbourhood shop carries: at the
 * previous 200 a shop's 201st customer was invisible to the voice flow and
 * would have been silently created a second time on every sale.
 */
const MATCH_LIMIT = 2000;

export type CustomerMatch =
  /** Exactly one person answers to this name. */
  | { kind: 'one'; customer: Customer }
  /** Several do. The shopkeeper picks; nothing is guessed. */
  | { kind: 'many'; candidates: Customer[] }
  /** Nobody does, so this is someone new. */
  | { kind: 'none' };

/** Trims, lowercases and collapses runs of spaces. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Matches a spoken name against a list already in hand.
 *
 * Three widening passes, stopping at the first that finds anything: the whole
 * name, then the name as a prefix, then the first name alone. Widening in
 * order matters — "Ramesh" should find Ramesh Kumar, but if there is also a
 * customer saved as exactly "Ramesh", that exact row is the answer and the
 * question was never ambiguous.
 */
export function matchCustomersByName(spoken: string, candidates: readonly Customer[]): CustomerMatch {
  const needle = normalise(spoken);
  if (!needle) return { kind: 'none' };

  const passes: Array<(customer: Customer) => boolean> = [
    (customer) => normalise(customer.name) === needle,
    (customer) => normalise(customer.name).startsWith(needle),
    (customer) => normalise(customer.name).split(' ')[0] === needle,
  ];

  for (const matches of passes) {
    const found = candidates.filter(matches);
    if (found.length === 1) return { kind: 'one', customer: found[0]! };
    if (found.length > 1) return { kind: 'many', candidates: found };
  }

  return { kind: 'none' };
}

/** The same match, fetching the shop's customers first. */
export async function findCustomerByName(
  vendorId: string,
  spoken: string,
): Promise<CustomerMatch> {
  if (!spoken.trim()) return { kind: 'none' };
  const all = await customerRepo.list(vendorId, MATCH_LIMIT);
  return matchCustomersByName(spoken, all);
}
