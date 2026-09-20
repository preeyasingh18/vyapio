/**
 * Money.
 *
 * Every monetary value in Vyapio is an integer count of paise (1 rupee = 100
 * paise). Floating-point rupees lose money across enough transactions — a
 * shop's khata is exactly the place that must not happen. Conversion to a
 * fractional rupee value happens only at the display edge.
 */

export type Paise = number;

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce((total, value) => total + value, 0);
}

/** "₹1,240" / "₹1,240.50" — paise shown only when non-zero. */
export function formatMoney(paise: Paise): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const remainder = abs % 100;
  const grouped = new Intl.NumberFormat('en-IN').format(rupees);
  const body = remainder === 0 ? grouped : `${grouped}.${String(remainder).padStart(2, '0')}`;
  return `${negative ? '-' : ''}₹${body}`;
}

/**
 * Splits a total across line items so the parts always sum back to the total.
 * The remainder from integer division lands on the first item rather than
 * silently vanishing.
 */
export function distributePaise(total: Paise, weights: readonly number[]): Paise[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0 || weights.length === 0) return weights.map(() => 0);

  const parts = weights.map((weight) => Math.floor((total * weight) / weightSum));
  const distributed = parts.reduce((sum, part) => sum + part, 0);
  const remainder = total - distributed;
  if (parts.length > 0) parts[0] = parts[0]! + remainder;
  return parts;
}

/** Gross margin as a percentage of selling price. Returns 0 for free items. */
export function marginPercent(costPrice: Paise, sellingPrice: Paise): number {
  if (sellingPrice <= 0) return 0;
  return ((sellingPrice - costPrice) / sellingPrice) * 100;
}
