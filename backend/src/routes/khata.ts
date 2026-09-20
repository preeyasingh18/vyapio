import { z } from 'zod';
import { Router, ok, created } from '../utils/router';
import { parseBody, parseParams, parseQuery } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { recordPayment, settlementByTransaction, settlementOf } from '../services/ledger';
import {
  commitments as commitmentRepo,
  customers as customerRepo,
  orders as orderRepo,
  payments as paymentRepo,
  transactions as transactionRepo,
} from '../services/repository';
import { commitmentItem } from '../services/repository';
import { getStore } from '../services/dynamodb';
import { publish } from '../services/events';
import { daysBetween, isoDaysAhead, nowIso } from '../utils/dates';
import { newCommitmentId } from '../utils/ids';
import {
  CommitmentQuerySchema,
  CreateCommitmentRequestSchema,
  RecordPaymentRequestSchema,
} from '../schemas/requests';
import type { Commitment } from '../schemas/entities';

/**
 * Khata — the balance book.
 *
 * The customer timeline lives here. It is deliberately not a ledger table: a
 * shopkeeper thinks in visits, not debits, so transactions, payments, orders
 * and commitments are merged into one reverse-chronological stream that reads
 * like what happened, in order.
 */

export const khataRoutes = new Router();

const CustomerIdParams = z.object({ customerId: z.string().min(1) });

/* ----------------------------------------------------------- Customer view */

export type TimelineEntry = {
  id: string;
  kind: 'transaction' | 'payment' | 'order' | 'commitment';
  timestamp: string;
  title: string;
  subtitle: string;
  amount: number;
  paid?: number;
  pending?: number;
  /** When money last came in against this row, if it ever did. */
  paidAt?: string | null;
  items?: Array<{ name: string; quantity: number; unit: string; lineTotal: number }>;
  status?: string;
  source?: string;
};

khataRoutes.get('/:customerId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { customerId } = parseParams(ctx, CustomerIdParams);

  const customer = await customerRepo.require(vendorId, customerId);

  const [sales, receipts, debts, customerOrders] = await Promise.all([
    transactionRepo.listForCustomer(customerId, 100),
    paymentRepo.listForCustomer(customerId, 100),
    commitmentRepo.listForCustomer(customerId, 100),
    orderRepo.listForCustomer(customerId, 50),
  ]);

  // GSI2 is keyed by customer, not by vendor, so re-scope before anything is
  // returned.
  const scope = <T extends { vendorId: string }>(rows: T[]) =>
    rows.filter((row) => row.vendorId === vendorId);

  /**
   * A sale's own `outstanding` is frozen at the time of sale. The timeline shows
   * a live balance, so it resolves each row through the Commitments instead —
   * otherwise a bill the customer has since cleared still reads "part paid".
   */
  const settlements = settlementByTransaction(scope(debts));

  const timeline: TimelineEntry[] = [
    ...scope(sales).map((transaction) => {
      const { pending: stillPending, paidAt } = settlementOf(transaction, settlements);
      return {
        id: transaction.transactionId,
        kind: 'transaction' as const,
        timestamp: transaction.timestamp,
        title: transaction.items.map((item) => item.name).join(', ') || 'Purchase',
        subtitle:
          stillPending > 0
            ? `${transaction.paymentMethod.toUpperCase()} · part paid`
            : transaction.paymentMethod.toUpperCase(),
        amount: transaction.total,
        paid: transaction.total - stillPending,
        pending: stillPending,
        paidAt,
        items: transaction.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          lineTotal: item.lineTotal,
        })),
        source: transaction.source,
      };
    }),

    // A payment attached to a sale is already visible on that row; showing it
    // twice would make the timeline read as double the money.
    ...scope(receipts)
      .filter((payment) => !payment.transactionId)
      .map((payment) => ({
        id: payment.paymentId,
        kind: 'payment' as const,
        timestamp: payment.timestamp,
        title: 'Payment received',
        subtitle: payment.method.toUpperCase(),
        amount: payment.amount,
        source: payment.source,
      })),

    ...scope(customerOrders).map((order) => ({
      id: order.orderId,
      kind: 'order' as const,
      timestamp: order.createdAt,
      title: `Order · ${order.items.map((item) => item.name).join(', ')}`,
      subtitle: order.status,
      amount: order.total,
      status: order.status,
      items: order.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        lineTotal: item.lineTotal,
      })),
    })),

    // Only standalone commitments; ones created by a sale are implied by it.
    ...scope(debts)
      .filter((commitment) => !commitment.transactionId)
      .map((commitment) => ({
        id: commitment.commitmentId,
        kind: 'commitment' as const,
        timestamp: commitment.createdAt,
        title: commitment.description || 'Amount due',
        subtitle: `Due ${commitment.dueDate.slice(0, 10)}`,
        amount: commitment.amount,
        pending: commitment.amount - commitment.settledAmount,
        status: commitment.status,
      })),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const openDebts = scope(debts).filter(
    (commitment) => commitment.status === 'open' || commitment.status === 'partly_paid',
  );
  const now = nowIso();

  return ok({
    customer,
    summary: {
      totalSpent: customer.totalSpent,
      purchaseCount: customer.transactionCount,
      outstanding: customer.outstanding,
      openCommitments: openDebts.length,
      // Drives the "overdue" treatment in the UI.
      overdueAmount: openDebts
        .filter((commitment) => commitment.dueDate < now)
        .reduce((sum, commitment) => sum + (commitment.amount - commitment.settledAmount), 0),
      lastInteractionAt: customer.lastInteractionAt ?? null,
    },
    timeline,
    commitments: openDebts,
  });
});

/* ------------------------------------------------------------- Collections */

khataRoutes.get('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const query = parseQuery(ctx, CommitmentQuerySchema);
  const now = nowIso();

  let list = await commitmentRepo.list(vendorId);
  if (query.status) {
    list = list.filter((commitment) => commitment.status === query.status);
  } else {
    list = list.filter(
      (commitment) => commitment.status === 'open' || commitment.status === 'partly_paid',
    );
  }
  if (query.overdueOnly) list = list.filter((commitment) => commitment.dueDate < now);
  if (query.minAmount !== undefined) {
    list = list.filter(
      (commitment) => commitment.amount - commitment.settledAmount >= query.minAmount!,
    );
  }

  const enriched = list
    .map((commitment) => ({
      ...commitment,
      remaining: commitment.amount - commitment.settledAmount,
      daysOverdue: Math.max(0, daysBetween(commitment.dueDate, now)),
      isOverdue: commitment.dueDate < now,
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || b.remaining - a.remaining);

  return ok({
    commitments: enriched,
    totals: {
      count: enriched.length,
      outstanding: enriched.reduce((sum, entry) => sum + entry.remaining, 0),
      overdue: enriched
        .filter((entry) => entry.isOverdue)
        .reduce((sum, entry) => sum + entry.remaining, 0),
      overdueCount: enriched.filter((entry) => entry.isOverdue).length,
      customerCount: new Set(enriched.map((entry) => entry.customerId)).size,
    },
  });
});

khataRoutes.post('/payment', async (ctx) => {
  const { vendorId, auth } = await requireVendor(ctx);
  const input = parseBody(ctx, RecordPaymentRequestSchema);

  const headerKey = ctx.headers['x-idempotency-key'];
  const idempotencyKey =
    input.idempotencyKey ?? (typeof headerKey === 'string' ? headerKey : undefined);

  const result = await recordPayment({
    vendorId,
    customerId: input.customerId,
    createdBy: auth.userId,
    amount: input.amount,
    method: input.method,
    note: input.note,
    ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
    source: 'manual',
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  ctx.logger.info('payment recorded', {
    operation: 'khata.payment',
    vendorId,
    userId: auth.userId,
    amount: input.amount,
    settledCount: result.settled.length,
  });

  return created({
    payment: result.payment,
    settled: result.settled,
    customer: result.customer,
    message: 'Payment recorded.',
  });
});

khataRoutes.post('/commitment', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, CreateCommitmentRequestSchema);
  const customer = await customerRepo.require(vendorId, input.customerId);

  const commitment: Commitment = {
    commitmentId: newCommitmentId(),
    vendorId,
    customerId: customer.customerId,
    customerName: customer.name,
    amount: input.amount,
    settledAmount: 0,
    description: input.description,
    dueDate: isoDaysAhead(input.dueInDays),
    status: 'open',
    reminderStatus: 'none',
    reminderCount: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // The commitment and the balance it represents are written together.
  const { keys } = await import('../services/dynamodb');
  await getStore().transactWrite([
    { kind: 'put', item: commitmentItem(commitment) },
    {
      kind: 'update',
      ...keys.customer(vendorId, customer.customerId),
      add: { outstanding: input.amount },
      set: { updatedAt: nowIso() },
    },
  ]);

  await publish(
    'CommitmentCreated',
    vendorId,
    { commitmentId: commitment.commitmentId, customerId: customer.customerId, amount: input.amount },
    `CommitmentCreated:${commitment.commitmentId}`,
  );

  return created({ commitment, message: 'Added to the khata.' });
});
