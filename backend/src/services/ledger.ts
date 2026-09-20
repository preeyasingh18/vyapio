import { getStore, keys, type TransactionOp } from './dynamodb';
import {
  commitments as commitmentRepo,
  customers as customerRepo,
  idempotency,
  products as productRepo,
  transactionItem,
  paymentItem,
  commitmentItem,
  inventoryEventItem,
  transactions as transactionRepo,
} from './repository';
import { matchProduct } from './inventory';
import { publish } from './events';
import { conflict, notFound } from '../utils/errors';
import { isoDaysAhead, nowIso } from '../utils/dates';
import {
  newCommitmentId,
  newInventoryEventId,
  newPaymentId,
  newTransactionId,
} from '../utils/ids';
import { TransactionSchema } from '../schemas/entities';
import type {
  Commitment,
  Customer,
  InventoryEvent,
  LineItem,
  Payment,
  Product,
  Settlement,
  Transaction,
} from '../schemas/entities';
import type { PaymentMethod, RecordSource } from '../schemas/common';

/**
 * The ledger.
 *
 * Recording a sale is never one write. It is, at minimum:
 *
 *   the transaction · an inventory event per line · a stock decrement per
 *   product · the customer's running balance and counters · a payment row if
 *   money changed hands · a commitment if it did not
 *
 * All of it goes through a single `transactWrite`, because the states in
 * between are all wrong: stock reduced but no sale recorded, or a balance owed
 * with nothing explaining it. Either the whole sale happened or none of it did.
 */

export type CreateTransactionInput = {
  vendorId: string;
  customerId: string;
  createdBy: string;
  items: Array<{
    productId?: string;
    name: string;
    quantity: number;
    unit: string;
    unitPrice: number;
  }>;
  discount: number;
  paid: number;
  paymentMethod: PaymentMethod;
  note: string;
  source: RecordSource;
  transcript?: string;
  createCommitment: boolean;
  dueInDays: number;
  idempotencyKey?: string;
  /** Overrides the timestamp. Used only by the seed script. */
  timestamp?: string;
};

export type CreateTransactionResult = {
  transaction: Transaction;
  payment: Payment | null;
  commitment: Commitment | null;
  customer: Customer;
  /** True when an earlier identical request already created this. */
  duplicate: boolean;
};

export async function createTransaction(
  input: CreateTransactionInput,
): Promise<CreateTransactionResult> {
  const customer = await customerRepo.require(input.vendorId, input.customerId);

  // Replay protection comes first: an offline client retrying must not be able
  // to charge twice, so the key is claimed before any money is computed.
  if (input.idempotencyKey) {
    const outcome = await idempotency.claim(
      input.vendorId,
      input.idempotencyKey,
      'pending',
    );
    if (outcome === 'duplicate') {
      const existingId = await idempotency.lookup(input.vendorId, input.idempotencyKey);
      const existing = existingId
        ? await transactionRepo.findById(input.vendorId, existingId)
        : null;
      if (existing) {
        return {
          transaction: existing,
          payment: null,
          commitment: null,
          customer,
          duplicate: true,
        };
      }
      throw conflict('Duplicate request', 'This sale was already recorded.');
    }
  }

  const catalogue = await productRepo.list(input.vendorId);
  const timestamp = input.timestamp ?? nowIso();
  const transactionId = newTransactionId();

  // ── Price and resolve each line ────────────────────────────────────────────
  const items: LineItem[] = [];
  const stockMoves: Array<{ product: Product; quantity: number; unitPrice: number }> = [];

  for (const raw of input.items) {
    let product: Product | null = null;

    if (raw.productId) {
      product = await productRepo.get(input.vendorId, raw.productId);
    } else {
      const match = matchProduct(raw.name, catalogue);
      // Only auto-link on a strong match; a weak guess would silently move the
      // wrong product's stock.
      if (match && match.confidence >= 0.8) product = match.product;
    }

    // An explicit price wins; otherwise fall back to the catalogue price.
    const unitPrice = raw.unitPrice > 0 ? raw.unitPrice : (product?.sellingPrice ?? 0);
    const lineTotal = Math.round(unitPrice * raw.quantity);

    items.push({
      ...(product ? { productId: product.productId } : {}),
      name: product?.name ?? raw.name,
      quantity: raw.quantity,
      unit: raw.unit || product?.unit || 'unit',
      unitPrice,
      lineTotal,
    });

    if (product) stockMoves.push({ product, quantity: raw.quantity, unitPrice });
  }

  // ── Arithmetic, in integer paise ──────────────────────────────────────────
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const discount = Math.min(input.discount, subtotal);
  const total = subtotal - discount;
  const paid = Math.min(input.paid, total);
  const outstanding = total - paid;

  // The schema's refinements are the last line of defence: a row where
  // paid + outstanding ≠ total cannot be constructed.
  const transaction = TransactionSchema.parse({
    transactionId,
    vendorId: input.vendorId,
    customerId: customer.customerId,
    customerName: customer.name,
    items,
    subtotal,
    discount,
    total,
    paid,
    outstanding,
    paymentMethod: input.paymentMethod,
    note: input.note,
    timestamp,
    source: input.source,
    createdBy: input.createdBy,
    ...(input.transcript ? { transcript: input.transcript } : {}),
    createdAt: nowIso(),
  } satisfies Transaction);

  const ops: TransactionOp[] = [{ kind: 'put', item: transactionItem(transaction) }];

  // ── Payment row, when money actually changed hands ────────────────────────
  let payment: Payment | null = null;
  if (paid > 0) {
    payment = {
      paymentId: newPaymentId(),
      vendorId: input.vendorId,
      customerId: customer.customerId,
      customerName: customer.name,
      transactionId,
      amount: paid,
      method: input.paymentMethod,
      note: '',
      timestamp,
      source: input.source,
      createdBy: input.createdBy,
    };
    ops.push({ kind: 'put', item: paymentItem(payment) });
  }

  // ── Commitment for the unpaid remainder ───────────────────────────────────
  let commitment: Commitment | null = null;
  if (outstanding > 0 && input.createCommitment) {
    commitment = {
      commitmentId: newCommitmentId(),
      vendorId: input.vendorId,
      customerId: customer.customerId,
      customerName: customer.name,
      transactionId,
      amount: outstanding,
      settledAmount: 0,
      description: items.map((item) => item.name).join(', ').slice(0, 300),
      dueDate: isoDaysAhead(input.dueInDays),
      status: 'open',
      reminderStatus: 'none',
      reminderCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    ops.push({ kind: 'put', item: commitmentItem(commitment) });
  }

  // ── Stock movements ───────────────────────────────────────────────────────
  const inventoryChanges: Array<{ productId: string; stockAfter: number }> = [];
  for (const move of stockMoves) {
    const stockAfter = move.product.stock - move.quantity;

    const event: InventoryEvent = {
      inventoryEventId: newInventoryEventId(),
      vendorId: input.vendorId,
      productId: move.product.productId,
      productName: move.product.name,
      type: 'sale',
      quantityDelta: -move.quantity,
      stockAfter,
      unitPrice: move.unitPrice,
      transactionId,
      note: '',
      timestamp,
      source: input.source,
    };
    ops.push({ kind: 'put', item: inventoryEventItem(event) });

    // Atomic ADD, not read-modify-write: two tills selling the last two bags of
    // rice at the same moment must both be reflected.
    ops.push({
      kind: 'update',
      ...keys.product(input.vendorId, move.product.productId),
      add: { stock: -move.quantity },
      set: { updatedAt: nowIso() },
    });
    inventoryChanges.push({ productId: move.product.productId, stockAfter });
  }

  // ── Customer running totals ───────────────────────────────────────────────
  ops.push({
    kind: 'update',
    ...keys.customer(input.vendorId, customer.customerId),
    add: { outstanding, totalSpent: total, transactionCount: 1 },
    set: { lastInteractionAt: timestamp, updatedAt: nowIso() },
  });

  if (input.idempotencyKey) {
    ops.push({
      kind: 'update',
      ...keys.idempotency(input.vendorId, input.idempotencyKey),
      set: { resultId: transactionId },
    });
  }

  await getStore().transactWrite(ops);

  const updatedCustomer = await customerRepo.require(input.vendorId, customer.customerId);

  // Events are published after the commit, so a handler can never observe a
  // sale that has not been durably written.
  await publish(
    'TransactionCreated',
    input.vendorId,
    {
      transactionId,
      customerId: customer.customerId,
      total,
      outstanding,
      productIds: stockMoves.map((move) => move.product.productId),
    },
    `TransactionCreated:${transactionId}`,
  );

  if (inventoryChanges.length > 0) {
    await publish(
      'InventoryChanged',
      input.vendorId,
      { productIds: inventoryChanges.map((change) => change.productId), reason: 'sale' },
      `InventoryChanged:${transactionId}`,
    );
  }

  if (payment) {
    await publish(
      'PaymentRecorded',
      input.vendorId,
      { paymentId: payment.paymentId, customerId: customer.customerId, amount: paid },
      `PaymentRecorded:${payment.paymentId}`,
    );
  }

  if (commitment) {
    await publish(
      'CommitmentCreated',
      input.vendorId,
      {
        commitmentId: commitment.commitmentId,
        customerId: customer.customerId,
        amount: outstanding,
      },
      `CommitmentCreated:${commitment.commitmentId}`,
    );
  }

  return { transaction, payment, commitment, customer: updatedCustomer, duplicate: false };
}

/* ------------------------------------------------------------- Settlements */

export type RecordPaymentInput = {
  vendorId: string;
  customerId: string;
  createdBy: string;
  amount: number;
  method: PaymentMethod;
  note: string;
  commitmentId?: string;
  source: RecordSource;
  idempotencyKey?: string;
  timestamp?: string;
};

/**
 * Records money received against a customer's balance.
 *
 * Payments are applied oldest-commitment-first, which is both what shopkeepers
 * expect and what keeps the overdue list meaningful.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<{
  payment: Payment;
  settled: Commitment[];
  customer: Customer;
  duplicate: boolean;
}> {
  const customer = await customerRepo.require(input.vendorId, input.customerId);

  if (input.idempotencyKey) {
    const outcome = await idempotency.claim(input.vendorId, input.idempotencyKey, 'pending');
    if (outcome === 'duplicate') {
      throw conflict('Duplicate request', 'This payment was already recorded.');
    }
  }

  const timestamp = input.timestamp ?? nowIso();
  const payment: Payment = {
    paymentId: newPaymentId(),
    vendorId: input.vendorId,
    customerId: customer.customerId,
    customerName: customer.name,
    ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
    amount: input.amount,
    method: input.method,
    note: input.note,
    timestamp,
    source: input.source,
    createdBy: input.createdBy,
  };

  const ops: TransactionOp[] = [{ kind: 'put', item: paymentItem(payment) }];

  // Choose which debts this money clears.
  const open = (await commitmentRepo.listForCustomer(customer.customerId, 100))
    .filter(
      (commitment) =>
        commitment.vendorId === input.vendorId &&
        (commitment.status === 'open' || commitment.status === 'partly_paid'),
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const targets = input.commitmentId
    ? open.filter((commitment) => commitment.commitmentId === input.commitmentId)
    : open;

  if (input.commitmentId && targets.length === 0) throw notFound('commitment');

  let remaining = input.amount;
  const settled: Commitment[] = [];

  for (const commitment of targets) {
    if (remaining <= 0) break;
    const owed = commitment.amount - commitment.settledAmount;
    if (owed <= 0) continue;

    const applied = Math.min(owed, remaining);
    remaining -= applied;

    const settledAmount = commitment.settledAmount + applied;
    const status = settledAmount >= commitment.amount ? 'settled' : 'partly_paid';

    ops.push({
      kind: 'update',
      ...keys.commitment(input.vendorId, commitment.dueDate, commitment.commitmentId),
      set: { settledAmount, status, lastPaymentAt: timestamp, updatedAt: nowIso() },
    });
    settled.push({ ...commitment, settledAmount, status, lastPaymentAt: timestamp });
  }

  // The balance drops by the full amount even if it exceeds recorded debts —
  // an advance payment leaves a credit, which is a real thing shops do.
  ops.push({
    kind: 'update',
    ...keys.customer(input.vendorId, customer.customerId),
    add: { outstanding: -input.amount },
    set: { lastInteractionAt: timestamp, updatedAt: nowIso() },
  });

  if (input.idempotencyKey) {
    ops.push({
      kind: 'update',
      ...keys.idempotency(input.vendorId, input.idempotencyKey),
      set: { resultId: payment.paymentId },
    });
  }

  await getStore().transactWrite(ops);

  await publish(
    'PaymentRecorded',
    input.vendorId,
    { paymentId: payment.paymentId, customerId: customer.customerId, amount: input.amount },
    `PaymentRecorded:${payment.paymentId}`,
  );

  const updatedCustomer = await customerRepo.require(input.vendorId, customer.customerId);
  return { payment, settled, customer: updatedCustomer, duplicate: false };
}

/* ------------------------------------------------- Settlement, after the fact */

/**
 * The settlement state of each sale, keyed by transactionId.
 *
 * `Transaction.outstanding` is deliberately frozen: it records what was unpaid
 * at the moment of the sale and is never rewritten, so the day's books always
 * add up to what actually happened at the counter. The debt itself lives on the
 * Commitment, which `recordPayment` settles.
 *
 * That means `transaction.outstanding` answers "how much was left that day?",
 * NOT "how much is left now" — reading it as the latter tells a shopkeeper that
 * a settled bill is still pending, which is the one direction they must never
 * be misled in. Anything showing a *current* balance resolves it through here.
 *
 * There is one settlement answer, not one for totals and another for rows: a
 * page whose column total disagrees with the rows above it is worse than either
 * number alone, because now neither can be trusted.
 */
export type { Settlement };

export function settlementByTransaction(commitments: Commitment[]): Map<string, Settlement> {
  const settlements = new Map<string, Settlement>();

  for (const commitment of commitments) {
    if (!commitment.transactionId) continue;

    const remaining = Math.max(0, commitment.amount - commitment.settledAmount);

    /**
     * `updatedAt` is the fallback, not the answer: sending a payment reminder
     * also touches it, so on its own it would date a payment to the day the
     * shopkeeper nagged about it. It is used only for commitments written
     * before `lastPaymentAt` existed, where it is the closest thing on record.
     */
    const paidAt =
      commitment.settledAmount > 0
        ? (commitment.lastPaymentAt ?? commitment.updatedAt)
        : null;

    const previous = settlements.get(commitment.transactionId);
    settlements.set(commitment.transactionId, {
      pending: (previous?.pending ?? 0) + remaining,
      // Several debts can point at one sale; the latest payment is the news.
      paidAt: [previous?.paidAt, paidAt].filter(Boolean).sort().at(-1) ?? null,
    });
  }

  return settlements;
}

/**
 * The settlement state of one sale.
 *
 * A sale with no Commitment — cash at the counter, or one recorded with
 * `createCommitment: false` — has no separate debt record, so its frozen figure
 * is still the only truth there is, and the money arrived when the sale did.
 */
export function settlementOf(
  transaction: Pick<Transaction, 'transactionId' | 'outstanding' | 'paid' | 'timestamp'>,
  settlements: Map<string, Settlement>,
): Settlement {
  const tracked = settlements.get(transaction.transactionId);
  if (tracked) return tracked;

  return {
    pending: transaction.outstanding,
    paidAt: transaction.paid > 0 ? transaction.timestamp : null,
  };
}

/** Current unpaid amount for one sale. */
export function currentlyPending(
  transaction: Pick<Transaction, 'transactionId' | 'outstanding' | 'paid' | 'timestamp'>,
  settlements: Map<string, Settlement>,
): number {
  return settlementOf(transaction, settlements).pending;
}
