import { z } from 'zod';
import { Router, ok, created } from '../utils/router';
import { parseBody, parseParams, parseQuery } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { createTransaction, settlementByTransaction, settlementOf } from '../services/ledger';
import {
  commitments as commitmentRepo,
  transactions as transactionRepo,
} from '../services/repository';
import { notFound } from '../utils/errors';
import { lastNDaysRange, withinRange } from '../utils/dates';
import { CreateTransactionRequestSchema, TransactionQuerySchema } from '../schemas/requests';

/**
 * Sales.
 *
 * The POST here is the one endpoint that moves money and stock. It does nothing
 * clever itself — all of that is in services/ledger.ts, inside a single
 * transactional write — so the route stays a thin, auditable shell around
 * "authenticate, validate, delegate".
 */

export const transactionRoutes = new Router();

transactionRoutes.get('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const query = parseQuery(ctx, TransactionQuerySchema);

  const list = query.customerId
    ? await transactionRepo.listForCustomer(query.customerId, query.limit)
    : await transactionRepo.list(vendorId, {
        ...(query.from && query.to ? { from: query.from, to: query.to } : {}),
        limit: query.limit,
      });

  // A customerId from the query string reaches a GSI that is not partitioned by
  // vendor, so the tenant filter is re-applied on the way out.
  const scoped = list.filter((transaction) => transaction.vendorId === vendorId);

  const revenue = scoped.reduce((sum, transaction) => sum + transaction.total, 0);

  // `transaction.outstanding` is frozen at the time of sale, so summing it would
  // report money as pending that has since been collected. The Commitments are
  // what actually track settlement.
  const settlement = settlementByTransaction(await commitmentRepo.list(vendorId, 500));

  /**
   * Every row carries its live balance, not just the totals.
   *
   * Shipping the raw rows meant the page showed a settled bill as still
   * pending while the Outstanding figure above it — computed through the
   * Commitments — already said zero. A shopkeeper chases a customer who has
   * already paid, and the two numbers on one screen cannot both be right.
   *
   * `outstanding` stays on the row exactly as recorded, because the day's books
   * have to keep adding up to what happened at the counter. `pending` is the
   * one to display.
   */
  const rows = scoped.map((transaction) => ({
    ...transaction,
    ...settlementOf(transaction, settlement),
  }));

  const pending = rows.reduce((sum, row) => sum + row.pending, 0);

  return ok({
    transactions: rows,
    totals: { count: scoped.length, revenue, pending, collected: revenue - pending },
  });
});

transactionRoutes.post('/', async (ctx) => {
  const { vendorId, auth } = await requireVendor(ctx);
  const input = parseBody(ctx, CreateTransactionRequestSchema);

  // A header key is accepted too, so a retrying fetch wrapper can add it
  // without rewriting the body.
  const headerKey = ctx.headers['x-idempotency-key'];
  const idempotencyKey =
    input.idempotencyKey ?? (typeof headerKey === 'string' ? headerKey : undefined);

  const result = await createTransaction({
    vendorId,
    customerId: input.customerId,
    createdBy: auth.userId,
    items: input.items,
    discount: input.discount,
    paid: input.paid,
    paymentMethod: input.paymentMethod,
    note: input.note,
    source: input.source,
    ...(input.transcript ? { transcript: input.transcript } : {}),
    createCommitment: input.createCommitment,
    dueInDays: input.dueInDays,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  ctx.logger.info('transaction created', {
    operation: 'transactions.create',
    vendorId,
    userId: auth.userId,
    total: result.transaction.total,
    outstanding: result.transaction.outstanding,
    source: input.source,
    duplicate: result.duplicate,
  });

  return created({
    transaction: result.transaction,
    payment: result.payment,
    commitment: result.commitment,
    customer: result.customer,
    duplicate: result.duplicate,
    message: result.duplicate ? 'Already recorded.' : 'Saved to memory.',
  });
});

transactionRoutes.get('/summary', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const query = parseQuery(ctx, z.object({ days: z.coerce.number().int().min(1).max(365).default(1) }));

  const range = lastNDaysRange(query.days);
  const list = (await transactionRepo.list(vendorId, { limit: 500 })).filter((transaction) =>
    withinRange(transaction.timestamp, range),
  );

  const revenue = list.reduce((sum, transaction) => sum + transaction.total, 0);

  // Settlement lives on the Commitment, not on the frozen sale row — see the
  // note in the list handler above.
  const settlement = settlementByTransaction(await commitmentRepo.list(vendorId, 500));
  const pending = list.reduce(
    (sum, transaction) => sum + settlementOf(transaction, settlement).pending,
    0,
  );
  const collected = revenue - pending;

  // Profit needs cost price, which lives on the product — lines without a
  // resolved productId contribute revenue but no margin, so the figure is
  // labelled "estimated" wherever it is shown.
  const { products } = await import('../services/repository');
  const catalogue = await products.list(vendorId);
  const costById = new Map(catalogue.map((product) => [product.productId, product.costPrice]));

  let estimatedProfit = 0;
  for (const transaction of list) {
    for (const item of transaction.items) {
      const cost = item.productId ? costById.get(item.productId) : undefined;
      if (cost === undefined) continue;
      estimatedProfit += (item.unitPrice - cost) * item.quantity;
    }
  }

  // Daily breakdown, so a trend can be drawn without a second round trip.
  // Every bucket is seeded to zero: a day with no sales is real information —
  // dropping it would silently redraw the x-axis and make a quiet Tuesday
  // disappear rather than show as a gap.
  const buckets = new Map<string, { date: string; revenue: number; saleCount: number }>();
  for (let offset = query.days - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    buckets.set(day, { date: day, revenue: 0, saleCount: 0 });
  }
  for (const transaction of list) {
    const bucket = buckets.get(transaction.timestamp.slice(0, 10));
    if (!bucket) continue;
    bucket.revenue += transaction.total;
    bucket.saleCount += 1;
  }

  return ok({
    days: query.days,
    revenue,
    collected,
    pending,
    estimatedProfit: Math.round(estimatedProfit),
    saleCount: list.length,
    customerCount: new Set(list.map((transaction) => transaction.customerId)).size,
    series: [...buckets.values()],
  });
});

transactionRoutes.get('/:transactionId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { transactionId } = parseParams(ctx, z.object({ transactionId: z.string().min(1) }));

  const transaction = await transactionRepo.findById(vendorId, transactionId);
  if (!transaction) throw notFound('transaction');
  return ok({ transaction });
});
