import { beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld, type TestShop } from './helpers';
import { MemoryAnswerSchema } from '../src/schemas/ai';
import { NOT_ENOUGH_INFORMATION } from '../src/services/knowledgeBase';
import { products } from '../src/services/repository';
import { nowIso } from '../src/utils/dates';
import { newProductId } from '../src/utils/ids';
import { formatMoney } from '../src/utils/money';

/**
 * Shop Memory.
 *
 * The property under test is grounding, not eloquence: an answer must either
 * cite real rows from this shop or say it could not find anything. A confident
 * sentence about a purchase that never happened is the worst output this
 * feature can produce, so it is tested for directly.
 */

describe('shop memory', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'search@test.app', shopName: 'Sharma Stores' });

    await products.put({
      productId: newProductId(),
      vendorId: shop.vendor.vendorId,
      name: 'Cooking Oil',
      sku: 'OIL',
      category: 'staples',
      unit: 'litre',
      costPrice: 12800,
      sellingPrice: 15200,
      stock: 40,
      reorderLevel: 10,
      supplier: '',
    purchaseDate: '',
    salesVelocity: 0,
      aliases: ['tel'],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  });

  async function sell(items: Array<{ name: string; quantity: number; unitPrice: number }>, paid: number) {
    return request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: items.map((item) => ({ ...item, unit: 'kg' })),
        paid,
        paymentMethod: paid > 0 ? 'upi' : 'credit',
      },
    });
  }

  it('refuses to answer when there is nothing to stand on', async () => {
    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'Did anyone buy a helicopter last month?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);

    expect(result.grounded).toBe(false);
    expect(result.answer).toBe(NOT_ENOUGH_INFORMATION);
    // No evidence means no citations to dress it up with.
    expect(result.citations).toHaveLength(0);
  });

  it('answers a purchase-history question with citations', async () => {
    await sell([{ name: 'Rice', quantity: 2, unitPrice: 6200 }], 12400);

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'What did Ramesh buy?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);

    expect(result.grounded).toBe(true);
    expect(result.answer).toContain('Ramesh');
    expect(result.answer).toContain('Rice');
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]!.kind).toBe('transaction');
  });

  it('every citation points at a record that really exists', async () => {
    await sell([{ name: 'Rice', quantity: 2, unitPrice: 6200 }], 12400);

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'What did Ramesh buy?' },
    });
    const result = MemoryAnswerSchema.parse(response.body.result);

    const list = await request('GET', '/transactions', { token: shop.token });
    const realIds = new Set(
      (list.body.transactions as Array<{ transactionId: string }>).map((t) => t.transactionId),
    );

    for (const citation of result.citations.filter((c) => c.kind === 'transaction')) {
      expect(realIds.has(citation.id)).toBe(true);
    }
  });

  it('answers a money-owed question', async () => {
    await sell([{ name: 'Rice', quantity: 10, unitPrice: 6200 }], 0);

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'Who owes me money?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);

    expect(result.grounded).toBe(true);
    expect(result.answer).toContain('Ramesh Kumar');
    expect(result.answer).toContain('₹620');
  });

  // Retrieval is capped at 20 balances so the model context stays small. The
  // headline figure must still describe the whole book: a total computed from
  // the visible sample understates the debt, and understating what a shop is
  // owed is the one direction that costs the shopkeeper money.
  it('totals every unpaid balance, not just the ones retrieved', async () => {
    const BILLS = 25;
    for (let i = 0; i < BILLS; i += 1) {
      await sell([{ name: 'Rice', quantity: 1, unitPrice: 6200 }], 0);
    }

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'How much money is pending in total?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);
    const expected = BILLS * 6200;

    expect(result.grounded).toBe(true);
    // ₹1,550 across 25 bills — not the ₹1,240 that the first 20 would give.
    expect(result.answer).toContain(formatMoney(expected));
    expect(result.answer).not.toContain(formatMoney(20 * 6200));
  });

  it('finds products bought together in one basket', async () => {
    await sell(
      [
        { name: 'Rice', quantity: 2, unitPrice: 6200 },
        { name: 'Cooking Oil', quantity: 1, unitPrice: 15200 },
      ],
      27600,
    );
    // A basket with only one of the two must not match.
    await sell([{ name: 'Rice', quantity: 1, unitPrice: 6200 }], 6200);

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'Who bought rice and oil together?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);

    expect(result.grounded).toBe(true);
    expect(result.answer).toContain('Ramesh Kumar');
    expect(result.citations).toHaveLength(1);
  });

  it('summarises sales for a period', async () => {
    await sell([{ name: 'Rice', quantity: 2, unitPrice: 6200 }], 12400);

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'How much did I sell this week?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);
    expect(result.grounded).toBe(true);
    expect(result.answer).toContain('₹124');
  });

  it('respects a time window', async () => {
    await sell([{ name: 'Rice', quantity: 2, unitPrice: 6200 }], 12400);

    // The sale is today, so "last month" must find nothing.
    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'What did Ramesh buy last month?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);
    expect(result.grounded).toBe(false);
  });

  it('names the engine that produced the answer', async () => {
    await sell([{ name: 'Rice', quantity: 1, unitPrice: 6200 }], 6200);

    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: 'What did Ramesh buy?' },
    });

    const result = MemoryAnswerSchema.parse(response.body.result);
    expect(result.engine).toBe('local-retrieval');
  });

  it('rejects an empty question', async () => {
    const response = await request('POST', '/search', {
      token: shop.token,
      body: { question: '' },
    });

    expect(response.status).toBe(422);
  });

  it('offers starter prompts', async () => {
    const response = await request('GET', '/search/suggestions', { token: shop.token });
    expect(response.status).toBe(200);
    expect((response.body.suggestions as string[]).length).toBeGreaterThan(3);
  });
});
