import { z } from 'zod';
import { Router, ok, created, noContent } from '../utils/router';
import { parseBody, parseParams } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { getStore, keys } from '../services/dynamodb';
import { inventoryEventItem, products as productRepo } from '../services/repository';
import {
  buildInsight,
  getInventoryInsights,
  lowStockAt,
  LOW_STOCK_DAYS,
  LOW_STOCK_THRESHOLD,
  stockStatusOf,
  stockValueOf,
  type StockStatus,
} from '../services/inventory';
import { inventoryEvents as inventoryEventRepo } from '../services/repository';
import { narrate } from '../services/bedrock';
import { publish } from '../services/events';
import { formatMoney } from '../utils/money';
import { isoDaysAgo, nowIso } from '../utils/dates';
import { newInventoryEventId, newProductId } from '../utils/ids';
import {
  AdjustStockRequestSchema,
  CreateProductRequestSchema,
  UpdateProductRequestSchema,
} from '../schemas/requests';
import { ProductSchema, type InventoryEvent, type Product } from '../schemas/entities';

/**
 * Inventory.
 *
 * All the numbers here come from services/inventory.ts, which is pure
 * arithmetic. Bedrock is invited only to phrase the conclusion, and only on the
 * single-product view where a sentence earns its latency — the list endpoint
 * makes no model calls at all, so opening the Stock tab is always instant.
 */

export const inventoryRoutes = new Router();

const ProductIdParams = z.object({ productId: z.string().min(1) });

inventoryRoutes.get('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const insights = await getInventoryInsights(vendorId);

  const countOf = (status: StockStatus) =>
    insights.filter((insight) => insight.stockStatus === status).length;

  return ok({
    products: insights.map((insight) => ({
      ...insight.product,
      /** Quantity x cost. Sent rather than recomputed so every screen agrees. */
      stockValue: insight.stockValue,
      /** Derived server-side from quantity and reorder level; never stored. */
      stockStatus: insight.stockStatus,
      insight: {
        soldThisWeek: insight.soldThisWeek,
        salesVelocity: insight.salesVelocity,
        daysRemaining: insight.daysRemaining,
        lowStock: insight.lowStock,
        outOfStock: insight.outOfStock,
        belowReorderLevel: insight.belowReorderLevel,
        marginPercent: insight.marginPercent,
        suggestedRestockQuantity: insight.suggestedRestockQuantity,
      },
    })),
    totals: {
      count: insights.length,
      inStockCount: countOf('in_stock'),
      /** At or below the reorder level. */
      lowStockCount: countOf('low_stock'),
      outOfStockCount: countOf('out_of_stock'),
      /**
       * Separate from lowStockCount on purpose: this one counts what is running
       * out *soon* at the current rate, which is what the home screen warns
       * about. A well-stocked item selling fast belongs here and not above.
       */
      runningOutCount: insights.filter((insight) => insight.lowStock).length,
      stockValue: insights.reduce((sum, insight) => sum + insight.stockValue, 0),
    },
    thresholds: { lowStockDays: LOW_STOCK_DAYS },
  });
});

inventoryRoutes.post('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, CreateProductRequestSchema);

  const product: Product = ProductSchema.parse({
    productId: newProductId(),
    vendorId,
    name: input.name,
    sku: input.sku,
    category: input.category,
    unit: input.unit,
    costPrice: input.costPrice,
    sellingPrice: input.sellingPrice,
    stock: input.stock,
    reorderLevel: input.reorderLevel,
    supplier: input.supplier,
    // Omitted means "bought today", which is when stock is usually first entered.
    purchaseDate: input.purchaseDate || nowIso().slice(0, 10),
    salesVelocity: 0,
    aliases: input.aliases,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } satisfies Product);

  await productRepo.put(product);

  // Opening stock is recorded as an event so the ledger explains every unit.
  if (input.stock > 0) {
    const event: InventoryEvent = {
      inventoryEventId: newInventoryEventId(),
      vendorId,
      productId: product.productId,
      productName: product.name,
      type: 'stock_in',
      quantityDelta: input.stock,
      stockAfter: input.stock,
      unitPrice: input.costPrice,
      note: 'Opening stock',
      timestamp: nowIso(),
      source: 'manual',
    };
    await getStore().put(inventoryEventItem(event));
  }

  return created({ product });
});

/**
 * What needs buying, right now.
 *
 * Derived from the current quantity every time it is asked for. There is no
 * "seen" or "dismissed" flag anywhere in this path on purpose: an alert that
 * can be marked read is an alert that stops telling you the shelf is empty
 * while the shelf is still empty. The only thing that clears an item from this
 * list is putting stock back on the shelf.
 *
 * Out of stock comes first, then the lowest quantities — the order a shopkeeper
 * would deal with them in.
 */
inventoryRoutes.get('/alerts', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const insights = await getInventoryInsights(vendorId);

  const alerts = insights
    .filter((insight) => insight.stockStatus !== 'in_stock')
    .sort((a, b) => {
      if (a.stockStatus !== b.stockStatus) return a.stockStatus === 'out_of_stock' ? -1 : 1;
      return a.product.stock - b.product.stock;
    })
    .map((insight) => ({
      productId: insight.product.productId,
      name: insight.product.name,
      unit: insight.product.unit,
      stock: insight.product.stock,
      reorderLevel: insight.product.reorderLevel,
      /** The quantity this item is judged against, so the UI need not guess. */
      lowStockAt: lowStockAt(insight.product),
      supplier: insight.product.supplier,
      status: insight.stockStatus,
      suggestedRestockQuantity: insight.suggestedRestockQuantity,
    }));

  return ok({
    alerts,
    counts: {
      lowStock: alerts.filter((alert) => alert.status === 'low_stock').length,
      outOfStock: alerts.filter((alert) => alert.status === 'out_of_stock').length,
    },
    threshold: LOW_STOCK_THRESHOLD,
  });
});

inventoryRoutes.get('/:productId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { productId } = parseParams(ctx, ProductIdParams);

  const product = await productRepo.require(vendorId, productId);
  const events = await inventoryEventRepo.list(vendorId, { from: isoDaysAgo(30), limit: 500 });
  const insight = buildInsight(product, events);

  // Narration is best-effort: the card is already complete without it.
  const explanation = await narrate(
    [
      `Product: ${product.name}`,
      `Stock: ${product.stock} ${product.unit}`,
      `Sales velocity: ${insight.salesVelocity} per day`,
      insight.daysRemaining === null
        ? 'Days remaining: not selling right now'
        : `Days remaining: ${insight.daysRemaining}`,
      `Margin: ${insight.marginPercent}%`,
      `Sold in last 7 days: ${insight.soldThisWeek}`,
      `Suggested restock: ${insight.suggestedRestockQuantity} ${product.unit}`,
    ].join('\n'),
    'inventory.explain',
  );

  return ok({
    product,
    insight: {
      soldInWindow: insight.soldInWindow,
      soldThisWeek: insight.soldThisWeek,
      salesVelocity: insight.salesVelocity,
      daysRemaining: insight.daysRemaining,
      lowStock: insight.lowStock,
      outOfStock: insight.outOfStock,
      belowReorderLevel: insight.belowReorderLevel,
      marginPercent: insight.marginPercent,
      revenueInWindow: insight.revenueInWindow,
      profitInWindow: insight.profitInWindow,
      suggestedRestockQuantity: insight.suggestedRestockQuantity,
    },
    // Deterministic fallback so the panel is never empty.
    explanation: explanation ?? defaultExplanation(insight.daysRemaining, product.name),
    explanationEngine: explanation ? 'bedrock' : 'deterministic',
    events: events
      .filter((event) => event.productId === productId)
      .slice(0, 20),
  });
});

function defaultExplanation(daysRemaining: number | null, name: string): string {
  if (daysRemaining === null) return `${name} has not sold recently, so stock is holding steady.`;
  if (daysRemaining <= 1) return `${name} runs out today at the current rate. Restock now.`;
  if (daysRemaining <= LOW_STOCK_DAYS) {
    return `${name} lasts about ${Math.round(daysRemaining)} more days. Consider restocking today.`;
  }
  return `${name} has roughly ${Math.round(daysRemaining)} days of stock left.`;
}

inventoryRoutes.patch('/:productId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { productId } = parseParams(ctx, ProductIdParams);
  const input = parseBody(ctx, UpdateProductRequestSchema);

  await productRepo.require(vendorId, productId);
  const product = await productRepo.update(vendorId, productId, input);
  return ok({ product });
});

inventoryRoutes.delete('/:productId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { productId } = parseParams(ctx, ProductIdParams);
  await productRepo.require(vendorId, productId);
  await productRepo.delete(vendorId, productId);
  return noContent();
});

/**
 * Manual stock movement.
 *
 * The event and the stock change are written together, so the running total can
 * always be reconciled against the event log.
 */
inventoryRoutes.post('/adjust', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, AdjustStockRequestSchema);

  const product = await productRepo.require(vendorId, input.productId);
  const stockAfter = product.stock + input.quantityDelta;

  /**
   * Stock coming in is a purchase, so it may carry a new price and a date.
   *
   * The cost price is overwritten rather than averaged: a shop pricing today's
   * shelf works from what it paid this time, and a weighted average would need
   * per-batch quantities the shop never records. Stock going out is a sale or a
   * correction and changes neither.
   */
  const isPurchase = input.quantityDelta > 0;
  const unitPrice = isPurchase ? (input.unitPrice ?? product.costPrice) : product.sellingPrice;
  const purchaseDate = isPurchase
    ? (input.purchaseDate || nowIso().slice(0, 10))
    : product.purchaseDate;

  const event: InventoryEvent = {
    inventoryEventId: newInventoryEventId(),
    vendorId,
    productId: product.productId,
    productName: product.name,
    type: input.type,
    quantityDelta: input.quantityDelta,
    stockAfter,
    unitPrice,
    note: input.note,
    timestamp: nowIso(),
    source: 'manual',
  };

  await getStore().transactWrite([
    { kind: 'put', item: inventoryEventItem(event) },
    {
      kind: 'update',
      ...keys.product(vendorId, product.productId),
      add: { stock: input.quantityDelta },
      set: {
        updatedAt: nowIso(),
        ...(isPurchase ? { costPrice: unitPrice, purchaseDate } : {}),
      },
    },
  ]);

  await publish(
    'InventoryChanged',
    vendorId,
    { productIds: [product.productId], reason: input.type },
    `InventoryChanged:${event.inventoryEventId}`,
  );

  ctx.logger.info('stock adjusted', {
    operation: 'inventory.adjust',
    vendorId,
    type: input.type,
    delta: input.quantityDelta,
  });

  const updated = {
    ...product,
    stock: stockAfter,
    ...(isPurchase ? { costPrice: unitPrice, purchaseDate } : {}),
  };

  return ok({
    product: updated,
    // Derived here too, so a caller acting on the response never has to guess.
    stockStatus: stockStatusOf(updated),
    stockValue: stockValueOf(updated),
    event,
    message: `${product.name} is now ${stockAfter} ${product.unit}.`,
  });
});

/** Restock suggestions. Read-only: it drafts a list and orders nothing. */
inventoryRoutes.get('/restock/suggestions', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const insights = await getInventoryInsights(vendorId);

  const lines = insights
    .filter((insight) => insight.lowStock || insight.belowReorderLevel)
    .filter((insight) => insight.suggestedRestockQuantity > 0)
    .map((insight) => ({
      productId: insight.product.productId,
      name: insight.product.name,
      unit: insight.product.unit,
      currentStock: insight.product.stock,
      daysRemaining: insight.daysRemaining,
      suggestedQuantity: insight.suggestedRestockQuantity,
      estimatedCost: Math.round(insight.suggestedRestockQuantity * insight.product.costPrice),
    }));

  const estimatedCost = lines.reduce((sum, line) => sum + line.estimatedCost, 0);

  return ok({
    lines,
    estimatedCost,
    summary:
      lines.length === 0
        ? 'Nothing needs restocking right now.'
        : `${lines.length} product${lines.length === 1 ? '' : 's'} to restock, about ${formatMoney(estimatedCost)}.`,
  });
});
