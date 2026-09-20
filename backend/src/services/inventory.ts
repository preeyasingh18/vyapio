import { inventoryEvents, products } from './repository';
import { isoDaysAgo, nowIso, DAY_MS } from '../utils/dates';
import { marginPercent } from '../utils/money';
import { hasDevanagari, soundsLike } from '../utils/transliterate';
import type { InventoryEvent, Product } from '../schemas/entities';

/**
 * Inventory intelligence.
 *
 * Everything in this file is arithmetic. No model is consulted, because a
 * shopkeeper deciding whether to buy another crate of oil needs a number that
 * is *right*, not one that is plausible. Bedrock's role is downstream: it turns
 * `daysRemaining: 2.2` into "Cooking Oil may run out in about 2 days", and the
 * card still renders correctly when Bedrock is unavailable.
 */

/** Window over which sales velocity is measured. */
const VELOCITY_WINDOW_DAYS = 14;

/** Below this many days of cover, a product is worth surfacing on the home screen. */
export const LOW_STOCK_DAYS = 3;

/* ------------------------------------------------------- Stock status */

export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/**
 * The quantity at or below which anything counts as low.
 *
 * One number for the whole shop, deliberately. `reorderLevel` is still kept per
 * product and still drives what to buy and how much — see
 * `suggestedRestockQuantity` and `belowReorderLevel` — but it does not decide
 * the badge. Two competing definitions of "low" produce a screen where an item
 * reads LOW STOCK next to a quantity that looks fine, and the shopkeeper learns
 * to ignore the colour.
 */
export const LOW_STOCK_THRESHOLD = 5;

/** The quantity at or below which this product counts as low. */
export function lowStockAt(_product: Pick<Product, 'reorderLevel'>): number {
  return LOW_STOCK_THRESHOLD;
}

/**
 * Stock status, derived — never stored.
 *
 * Keeping this a function of `stock` and `reorderLevel` means it cannot fall
 * out of step with the quantity. A stored status would need updating from every
 * path that moves stock (sale, restock, correction, return, order collection),
 * and the first one anybody forgets leaves a shelf that is empty on the shelf
 * and "IN STOCK" on the screen.
 *
 *   out of stock  nothing left
 *   low stock     five or fewer left, so it is time to buy
 *   in stock      more than that
 *
 * Stock can be negative — a shop sells from a sack before recording the
 * restock — and that still reads as out of stock, which is what it is.
 */
export function stockStatusOf(product: Pick<Product, 'stock' | 'reorderLevel'>): StockStatus {
  if (product.stock <= 0) return 'out_of_stock';
  if (product.stock <= lowStockAt(product)) return 'low_stock';
  return 'in_stock';
}

/* ------------------------------------------------------ Availability */

export const AVAILABILITY_STATUSES = ['available', 'insufficient', 'unavailable'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export type Availability = {
  status: AvailabilityStatus;
  /** What was asked for. Preserved even when none of it can be supplied. */
  requestedQuantity: number;
  /** On the shelf right now. 0 when the product is not stocked at all. */
  availableQuantity: number;
  /** What this sale can actually hand over: the lesser of the two. */
  fulfilledQuantity: number;
  /** How much of the request cannot be met. 0 when it can be met in full. */
  shortBy: number;
};

/**
 * What can actually be supplied against a request.
 *
 * Three states, and the difference between the last two matters to the person
 * at the counter: `insufficient` means "I have some, just not that many", which
 * is a sale that can still go ahead in part, while `unavailable` means "I do
 * not have this", which is a different conversation with the customer.
 *
 * `requestedQuantity` is kept on the result whatever the outcome. Reducing a
 * request down to what happens to be in stock, and showing only that, would let
 * a shopkeeper confirm a sale believing they had supplied what was asked for.
 * The shortfall is a fact about the transaction, so it travels with it.
 *
 * A null product means the shop does not stock the item at all — which is not
 * the same as stocking it and having run out, but produces the same answer
 * here: nothing can be supplied.
 */
export function resolveAvailability(
  requestedQuantity: number,
  product: Pick<Product, 'stock'> | null,
): Availability {
  const requested = Math.max(0, requestedQuantity);
  const available = Math.max(0, product?.stock ?? 0);
  const fulfilled = Math.min(requested, available);

  const status: AvailabilityStatus =
    available <= 0 ? 'unavailable' : available >= requested ? 'available' : 'insufficient';

  return {
    status,
    requestedQuantity: requested,
    availableQuantity: available,
    fulfilledQuantity: fulfilled,
    shortBy: Math.max(0, requested - fulfilled),
  };
}

/**
 * What the stock on the shelf is worth, in paise.
 *
 * Valued at cost, not at retail: this is money already spent, and counting
 * unsold stock at the price the shop hopes to get would overstate the shop's
 * position. Negative stock contributes nothing rather than a negative value.
 */
export function stockValueOf(product: Pick<Product, 'stock' | 'costPrice'>): number {
  return Math.round(Math.max(0, product.stock) * product.costPrice);
}

export type ProductInsight = {
  product: Product;
  /** Units sold in the velocity window. */
  soldInWindow: number;
  soldThisWeek: number;
  /** Units per day, averaged over the window. */
  salesVelocity: number;
  /**
   * Days of cover at the current rate. `null` when velocity is zero — dividing
   * by it would give Infinity, and "never runs out" is a different statement
   * from "runs out in a very long time".
   */
  daysRemaining: number | null;
  /** Stock is at or below the reorder level. */
  belowReorderLevel: boolean;
  /** Derived from quantity and reorder level alone. See `stockStatusOf`. */
  stockStatus: StockStatus;
  /** Quantity x cost price, in paise. */
  stockValue: number;
  /** Running out within LOW_STOCK_DAYS. */
  lowStock: boolean;
  outOfStock: boolean;
  marginPercent: number;
  /** Revenue and gross profit attributable to the window's sales. */
  revenueInWindow: number;
  profitInWindow: number;
  /** Units to buy to restore two weeks of cover, rounded up. */
  suggestedRestockQuantity: number;
};

/**
 * Sales velocity from recorded events.
 *
 * Only `sale` and `return` move the needle: a restock is not demand, and a
 * manual correction is bookkeeping. Returns subtract, so a product that goes
 * out and comes back does not look like it is selling.
 */
export function computeVelocity(
  events: readonly InventoryEvent[],
  productId: string,
  windowDays = VELOCITY_WINDOW_DAYS,
  now: Date = new Date(),
): { unitsSold: number; velocity: number } {
  const cutoff = now.getTime() - windowDays * DAY_MS;

  let unitsSold = 0;
  for (const event of events) {
    if (event.productId !== productId) continue;
    if (Date.parse(event.timestamp) < cutoff) continue;

    if (event.type === 'sale') unitsSold += Math.abs(event.quantityDelta);
    else if (event.type === 'return') unitsSold -= Math.abs(event.quantityDelta);
  }

  unitsSold = Math.max(0, unitsSold);
  return { unitsSold, velocity: unitsSold / windowDays };
}

export function buildInsight(
  product: Product,
  events: readonly InventoryEvent[],
  now: Date = new Date(),
): ProductInsight {
  const { unitsSold, velocity } = computeVelocity(events, product.productId, VELOCITY_WINDOW_DAYS, now);
  const week = computeVelocity(events, product.productId, 7, now);

  const daysRemaining = velocity > 0 ? product.stock / velocity : null;
  const outOfStock = product.stock <= 0;
  const belowReorderLevel = product.reorderLevel > 0 && product.stock <= product.reorderLevel;
  const lowStock = outOfStock || belowReorderLevel || (daysRemaining !== null && daysRemaining <= LOW_STOCK_DAYS);

  const revenueInWindow = Math.round(unitsSold * product.sellingPrice);
  const profitInWindow = Math.round(unitsSold * (product.sellingPrice - product.costPrice));

  // Target two weeks of cover, never suggesting less than the reorder level.
  const targetUnits = Math.max(velocity * VELOCITY_WINDOW_DAYS, product.reorderLevel);
  const suggestedRestockQuantity = Math.max(0, Math.ceil(targetUnits - product.stock));

  return {
    product,
    stockStatus: stockStatusOf(product),
    stockValue: stockValueOf(product),
    soldInWindow: unitsSold,
    soldThisWeek: week.unitsSold,
    salesVelocity: Number(velocity.toFixed(2)),
    daysRemaining: daysRemaining === null ? null : Number(daysRemaining.toFixed(1)),
    belowReorderLevel,
    lowStock,
    outOfStock,
    marginPercent: Number(marginPercent(product.costPrice, product.sellingPrice).toFixed(1)),
    revenueInWindow,
    profitInWindow,
    suggestedRestockQuantity,
  };
}

/** Insights for an entire shop, most urgent first. */
export async function getInventoryInsights(vendorId: string): Promise<ProductInsight[]> {
  const [allProducts, events] = await Promise.all([
    products.list(vendorId),
    inventoryEvents.list(vendorId, { from: isoDaysAgo(VELOCITY_WINDOW_DAYS + 1), limit: 2000 }),
  ]);

  return allProducts
    .map((product) => buildInsight(product, events))
    .sort((a, b) => urgency(b) - urgency(a));
}

/**
 * Ordering score. Out of stock beats running out; running out beats a healthy
 * shelf; among products running out, the faster-selling one wins.
 */
function urgency(insight: ProductInsight): number {
  if (insight.outOfStock) return 1000 + insight.salesVelocity;
  if (insight.daysRemaining !== null && insight.daysRemaining <= LOW_STOCK_DAYS) {
    return 500 - insight.daysRemaining * 10 + insight.salesVelocity;
  }
  if (insight.belowReorderLevel) return 200 + insight.salesVelocity;
  return insight.salesVelocity;
}

/**
 * Refreshes the denormalised `salesVelocity` on product rows.
 *
 * Invoked from the InventoryChanged event handler. Idempotent by construction:
 * it recomputes from the event log rather than incrementing, so running it
 * twice yields the same value.
 */
export async function refreshSalesVelocity(vendorId: string, productIds?: string[]): Promise<void> {
  const [allProducts, events] = await Promise.all([
    products.list(vendorId),
    inventoryEvents.list(vendorId, { from: isoDaysAgo(VELOCITY_WINDOW_DAYS + 1), limit: 2000 }),
  ]);

  const targets = productIds
    ? allProducts.filter((product) => productIds.includes(product.productId))
    : allProducts;

  await Promise.all(
    targets.map(async (product) => {
      const { velocity } = computeVelocity(events, product.productId);
      const rounded = Number(velocity.toFixed(2));
      if (Math.abs(rounded - product.salesVelocity) < 0.005) return;
      await products.update(vendorId, product.productId, {
        salesVelocity: rounded,
        updatedAt: nowIso(),
      });
    }),
  );
}

/**
 * Resolves a spoken or typed product name to a catalogue row.
 *
 * Voice input arrives as "chawal", "2 kilo rice", "Rice (5kg)". Matching runs
 * exact → alias → prefix → token-overlap, and returns a confidence score so the
 * caller can decide whether to warn the shopkeeper rather than silently
 * guessing at their stock.
 */
export function matchProduct(
  name: string,
  catalogue: readonly Product[],
): { product: Product; confidence: number } | null {
  const needle = normalise(name);

  /**
   * `normalise` keeps only Latin letters and digits, so a name dictated in
   * Devanagari arrives here as an empty string and every pass below is skipped.
   * That is how forty kilos of साल्ट came back as "not in your product list".
   * The sound-alike pass at the bottom is what answers those.
   */
  if (needle) {
  for (const product of catalogue) {
    if (normalise(product.name) === needle) return { product, confidence: 1 };
  }
  for (const product of catalogue) {
    if (product.aliases.some((alias) => normalise(alias) === needle)) {
      return { product, confidence: 0.95 };
    }
  }
  for (const product of catalogue) {
    const candidate = normalise(product.name);
    if (candidate.startsWith(needle) || needle.startsWith(candidate)) {
      return { product, confidence: 0.8 };
    }
  }

  // Token overlap catches "cooking oil" ↔ "oil, cooking (1L)".
  const needleTokens = new Set(needle.split(' ').filter(Boolean));
  let best: { product: Product; confidence: number } | null = null;

  for (const product of catalogue) {
    const haystack = [product.name, ...product.aliases].map(normalise).join(' ');
    const tokens = new Set(haystack.split(' ').filter(Boolean));
    let overlap = 0;
    for (const token of needleTokens) if (tokens.has(token)) overlap += 1;
    if (overlap === 0) continue;

    const confidence = (overlap / needleTokens.size) * 0.7;
    if (!best || confidence > best.confidence) best = { product, confidence };
  }

    if (best && best.confidence >= 0.35) return best;
  }

  /**
   * Last resort: does it sound like exactly one of them?
   *
   * Devanagari only. This exists for the name the parser could not canonicalise
   * — a product the shop stocks but no lexicon knows — and the transliteration
   * reads no other script anyway. A Latin word that got this far is far more
   * likely a name or a stray word than a misspelled product: "there" shares a
   * skeleton with "toor", and the cost of being wrong here is moving the wrong
   * product's stock.
   *
   * Only a single answer counts. A skeleton shared by two products is not an
   * answer, it is a coin toss.
   *
   * Confidence is high enough for the caller to link the product, because a
   * skeleton match on a shop's few dozen items is a strong signal, not a guess
   * between near-misses.
   */
  if (!hasDevanagari(name)) return null;

  const heard = catalogue.filter(
    (product) =>
      soundsLike(name, product.name) ||
      product.aliases.some((alias) => soundsLike(name, alias)),
  );
  if (heard.length === 1) return { product: heard[0]!, confidence: 0.85 };

  return null;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
