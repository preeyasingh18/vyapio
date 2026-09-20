import { beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld, type TestShop } from './helpers';
import { customers, products, commitments } from '../src/services/repository';

/**
 * The ledger.
 *
 * Recording a sale touches six things at once. These tests pin the arithmetic
 * and the all-or-nothing behaviour, because a partially-applied sale — stock
 * down but no transaction, or a balance owed with nothing explaining it — is
 * the kind of bug a shopkeeper discovers weeks later and cannot reconstruct.
 */

describe('transactions', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'ledger@test.app', shopName: 'Sharma Stores' });
  });

  it('records a fully paid sale and moves stock', async () => {
    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ productId: shop.product.productId, name: 'Rice', quantity: 2, unit: 'kg', unitPrice: 6200 }],
        paid: 12400,
        paymentMethod: 'upi',
      },
    });

    expect(response.status).toBe(201);
    const transaction = response.body.transaction as Record<string, number>;
    expect(transaction.subtotal).toBe(12400);
    expect(transaction.total).toBe(12400);
    expect(transaction.paid).toBe(12400);
    expect(transaction.outstanding).toBe(0);

    const product = await products.require(shop.vendor.vendorId, shop.product.productId);
    expect(product.stock).toBe(98);

    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.outstanding).toBe(0);
    expect(customer.totalSpent).toBe(12400);
    expect(customer.transactionCount).toBe(1);
  });

  it('creates a commitment for the unpaid remainder', async () => {
    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ productId: shop.product.productId, name: 'Rice', quantity: 10, unit: 'kg', unitPrice: 6200 }],
        paid: 30000,
        paymentMethod: 'upi',
        dueInDays: 7,
      },
    });

    const transaction = response.body.transaction as Record<string, number>;
    expect(transaction.total).toBe(62000);
    expect(transaction.outstanding).toBe(32000);

    const commitment = response.body.commitment as Record<string, unknown>;
    expect(commitment).not.toBeNull();
    expect(commitment.amount).toBe(32000);
    expect(commitment.status).toBe('open');

    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.outstanding).toBe(32000);
  });

  it('applies a discount before splitting paid and pending', async () => {
    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ productId: shop.product.productId, name: 'Rice', quantity: 10, unit: 'kg', unitPrice: 6200 }],
        discount: 2000,
        paid: 30000,
        paymentMethod: 'cash',
      },
    });

    const transaction = response.body.transaction as Record<string, number>;
    expect(transaction.subtotal).toBe(62000);
    expect(transaction.discount).toBe(2000);
    expect(transaction.total).toBe(60000);
    // The invariant that makes a malformed sale unrepresentable.
    expect(transaction.paid! + transaction.outstanding!).toBe(transaction.total);
  });

  it('rejects a payment larger than the bill', async () => {
    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 }],
        paid: 999999,
        paymentMethod: 'cash',
      },
    });

    expect(response.status).toBe(422);
    const error = response.body.error as { code: string };
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an empty basket', async () => {
    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [],
        paid: 0,
        paymentMethod: 'cash',
      },
    });

    expect(response.status).toBe(422);
  });

  it('matches a spoken product name to the catalogue', async () => {
    // "chawal" is an alias for Rice, so stock must move even though the request
    // never names the product id.
    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ name: 'chawal', quantity: 3, unit: 'kg', unitPrice: 0 }],
        paid: 0,
        paymentMethod: 'credit',
        source: 'voice',
      },
    });

    expect(response.status).toBe(201);
    const transaction = response.body.transaction as { items: Array<{ name: string; unitPrice: number }> };
    expect(transaction.items[0]!.name).toBe('Rice');
    // Price came from the catalogue, not from the request.
    expect(transaction.items[0]!.unitPrice).toBe(6200);

    const product = await products.require(shop.vendor.vendorId, shop.product.productId);
    expect(product.stock).toBe(97);
  });

  it('treats a replayed idempotency key as a no-op', async () => {
    const body = {
      customerId: shop.customer.customerId,
      items: [{ productId: shop.product.productId, name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 }],
      paid: 6200,
      paymentMethod: 'cash',
      idempotencyKey: 'offline-queue-1',
    };

    const first = await request('POST', '/transactions', { token: shop.token, body });
    const second = await request('POST', '/transactions', { token: shop.token, body });

    expect(first.status).toBe(201);
    expect(second.body.duplicate).toBe(true);

    // The decisive assertion: the customer was charged once, not twice.
    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.totalSpent).toBe(6200);
    expect(customer.transactionCount).toBe(1);

    const product = await products.require(shop.vendor.vendorId, shop.product.productId);
    expect(product.stock).toBe(99);
  });
});

describe('payments', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'payments@test.app', shopName: 'Sharma Stores' });
  });

  it('settles commitments oldest first', async () => {
    // Two debts, the second due later.
    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ productId: shop.product.productId, name: 'Rice', quantity: 5, unit: 'kg', unitPrice: 6200 }],
        paid: 0,
        paymentMethod: 'credit',
        dueInDays: 1,
      },
    });
    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ productId: shop.product.productId, name: 'Rice', quantity: 5, unit: 'kg', unitPrice: 6200 }],
        paid: 0,
        paymentMethod: 'credit',
        dueInDays: 30,
      },
    });

    let customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.outstanding).toBe(62000);

    // Enough to clear the first debt and part of the second.
    const response = await request('POST', '/khata/payment', {
      token: shop.token,
      body: { customerId: shop.customer.customerId, amount: 40000, method: 'upi' },
    });

    expect(response.status).toBe(201);

    const open = await commitments.list(shop.vendor.vendorId);
    const sorted = [...open].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    expect(sorted[0]!.status).toBe('settled');
    expect(sorted[1]!.status).toBe('partly_paid');
    expect(sorted[1]!.settledAmount).toBe(9000);

    customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.outstanding).toBe(22000);
  });

  it('rejects a zero payment', async () => {
    const response = await request('POST', '/khata/payment', {
      token: shop.token,
      body: { customerId: shop.customer.customerId, amount: 0, method: 'cash' },
    });

    expect(response.status).toBe(422);
  });

  it('refuses a replayed payment', async () => {
    const body = {
      customerId: shop.customer.customerId,
      amount: 5000,
      method: 'cash',
      idempotencyKey: 'offline-payment-1',
    };

    const first = await request('POST', '/khata/payment', { token: shop.token, body });
    const second = await request('POST', '/khata/payment', { token: shop.token, body });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);

    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.outstanding).toBe(-5000);
  });
});

/**
 * Settlement, as every surface reports it.
 *
 * A Transaction's `outstanding` is frozen at the time of sale and is never
 * rewritten, so once the customer clears the debt it no longer describes what
 * is owed. Anything showing a *live* balance must resolve it through the
 * Commitment instead. These tests exist because the arithmetic below was
 * previously read straight off the frozen field, and a paid-off bill went on
 * reporting itself as pending — in search results, on the customer's timeline
 * and in the figures handed to the model.
 */
describe('settlement is reported from commitments, not the frozen sale row', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'settle@test.app', shopName: 'Sharma Stores' });

    // ₹124 of rice, ₹80 paid at the counter, ₹44 taken on credit.
    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [
          { productId: shop.product.productId, name: 'Rice', quantity: 2, unit: 'kg', unitPrice: 6200 },
        ],
        paid: 8000,
        paymentMethod: 'cash',
      },
    });
  });

  /** Clears the whole ₹44 balance. */
  async function settleInFull(): Promise<void> {
    const response = await request('POST', '/khata/payment', {
      token: shop.token,
      body: { customerId: shop.customer.customerId, amount: 4400, method: 'upi' },
    });
    expect(response.status).toBe(201);
  }

  it('reports the balance while it is genuinely unpaid', async () => {
    const list = await request('GET', '/transactions', { token: shop.token });
    const totals = (list.body.totals as Record<string, number>);
    expect(totals.pending).toBe(4400);
    expect(totals.collected).toBe(8000);

    const khata = await request('GET', `/khata/${shop.customer.customerId}`, { token: shop.token });
    const row = (khata.body.timeline as Array<Record<string, unknown>>).find(
      (entry) => entry.kind === 'transaction',
    )!;
    expect(row.pending).toBe(4400);
    expect(row.subtitle).toContain('part paid');
  });

  it('stops calling a settled sale pending, on every surface', async () => {
    await settleInFull();

    // The frozen row is deliberately untouched — that is the point.
    const list = await request('GET', '/transactions', { token: shop.token });
    const rows = list.body.transactions as Array<Record<string, number>>;
    expect(rows[0]?.outstanding).toBe(4400);

    // …but nothing that describes the balance *now* may repeat it.
    const totals = list.body.totals as Record<string, number>;
    expect(totals.pending).toBe(0);
    expect(totals.collected).toBe(12400);

    const khata = await request('GET', `/khata/${shop.customer.customerId}`, { token: shop.token });
    const row = (khata.body.timeline as Array<Record<string, unknown>>).find(
      (entry) => entry.kind === 'transaction',
    )!;
    expect(row.pending).toBe(0);
    expect(row.paid).toBe(12400);
    expect(row.subtitle).not.toContain('part paid');

    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.outstanding).toBe(0);
  });

  it('does not describe a settled sale as pending in search', async () => {
    await settleInFull();

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'who bought rice' },
    });

    const citations = (response.body.result as Record<string, unknown>).citations as Array<
      Record<string, string>
    >;
    const sale = citations.find((citation) => citation.kind === 'transaction')!;
    expect(sale.detail).toContain('paid');
    expect(sale.detail).not.toContain('pending');
  });

  it('still trusts the frozen figure when a sale has no commitment', async () => {
    // createCommitment: false records the shortfall on the sale and nowhere
    // else, so there the frozen number is the only record of it.
    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [
          { productId: shop.product.productId, name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 },
        ],
        paid: 2000,
        paymentMethod: 'cash',
        createCommitment: false,
      },
    });

    const list = await request('GET', '/transactions', { token: shop.token });
    const totals = list.body.totals as Record<string, number>;
    // ₹44 from the first sale's commitment + ₹42 frozen on the second.
    expect(totals.pending).toBe(4400 + 4200);
  });

  /**
   * The rows, not just the column totals.
   *
   * The totals were resolved through the Commitments from the start, but each
   * sale still shipped its frozen `outstanding` and the list rendered that. A
   * customer who had cleared her bill kept a "₹600 pending" badge next to a
   * header that already read ₹0 outstanding, and the shopkeeper had no way to
   * tell which of the two numbers on the screen to believe.
   */
  describe('the row a shopkeeper actually reads', () => {
    const rowsOf = (body: Record<string, unknown>) =>
      body.transactions as Array<Record<string, number | string | null>>;

    it('reports the sale as settled once the money is in', async () => {
      await settleInFull();

      const list = await request('GET', '/transactions', { token: shop.token });
      const row = rowsOf(list.body)[0]!;

      expect(row.pending).toBe(0);
      // The frozen figure stays exactly as recorded: the day's books still have
      // to add up to what happened at the counter.
      expect(row.outstanding).toBe(4400);
    });

    it('never lets the rows disagree with the total above them', async () => {
      await settleInFull();

      const list = await request('GET', '/transactions', { token: shop.token });
      const summed = rowsOf(list.body).reduce((total, row) => total + (row.pending as number), 0);

      expect(summed).toBe((list.body.totals as Record<string, number>).pending);
    });

    it('says when the money arrived', async () => {
      const before = Date.now();
      await settleInFull();

      const list = await request('GET', '/transactions', { token: shop.token });
      const paidAt = rowsOf(list.body)[0]!.paidAt as string;

      expect(paidAt).toBeTruthy();
      expect(Date.parse(paidAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(paidAt)).toBeLessThanOrEqual(Date.now());
    });

    it('keeps the sale pending, and dates the part payment, when some is left', async () => {
      await request('POST', '/khata/payment', {
        token: shop.token,
        body: { customerId: shop.customer.customerId, amount: 1400, method: 'cash' },
      });

      const list = await request('GET', '/transactions', { token: shop.token });
      const row = rowsOf(list.body)[0]!;

      expect(row.pending).toBe(3000);
      // The shopkeeper needs to know money came in, and when, even though the
      // bill is not closed — that is what they will be asked about.
      expect(row.paidAt).toBeTruthy();
    });

    it('leaves paidAt empty while nothing has been paid against the sale', async () => {
      const list = await request('GET', '/transactions', { token: shop.token });
      const row = rowsOf(list.body)[0]!;

      // ₹80 went across the counter, but nothing has come in against the ₹44
      // still owed. Dating that as a payment would be an answer to a question
      // nobody asked.
      expect(row.pending).toBe(4400);
      expect(row.paidAt).toBeNull();
    });

    it('does not mistake a reminder for a payment', async () => {
      await settleInFull();
      const before = await request('GET', '/transactions', { token: shop.token });
      const paidAt = rowsOf(before.body)[0]!.paidAt as string;

      // Chasing a customer touches the commitment. Dating the payment from that
      // would move it to whenever the shopkeeper last nagged.
      const [commitment] = (await commitments.list(shop.vendor.vendorId)).filter(
        (entry) => entry.transactionId,
      );
      await commitments.update(commitment!, { reminderStatus: 'sent', reminderCount: 1 });

      const after = await request('GET', '/transactions', { token: shop.token });
      expect(rowsOf(after.body)[0]!.paidAt).toBe(paidAt);
    });

    it('dates a cash sale to when it happened', async () => {
      const list = await request('GET', '/transactions', { token: shop.token });
      const row = rowsOf(list.body)[0]!;

      // Nothing was owed on the counter payment, so its own timestamp is when
      // the money arrived — there is no commitment to ask.
      expect(row.pending).toBe(4400);
      expect(rowsOf(list.body).length).toBe(1);

      await request('POST', '/transactions', {
        token: shop.token,
        body: {
          customerId: shop.customer.customerId,
          items: [
            { productId: shop.product.productId, name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 5000 },
          ],
          paid: 5000,
          paymentMethod: 'cash',
        },
      });

      const after = await request('GET', '/transactions', { token: shop.token });
      const cash = rowsOf(after.body).find((entry) => entry.total === 5000)!;
      expect(cash.pending).toBe(0);
      expect(cash.paidAt).toBe(cash.timestamp);
    });
  });
});
