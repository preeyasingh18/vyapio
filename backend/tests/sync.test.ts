import { beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld, type TestShop } from './helpers';
import { customers, products } from '../src/services/repository';
import { isoDaysAgo } from '../src/utils/dates';

/**
 * Offline replay.
 *
 * The queue exists because the network in a neighbourhood shop is unreliable,
 * which means this endpoint will be hit with duplicates, partial batches and
 * stale payloads. Each of those is tested, because the failure mode — charging
 * a customer twice for one bag of rice — is one they would notice and not
 * forgive.
 */

describe('offline sync', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'sync@test.app', shopName: 'Sharma Stores' });
  });

  it('replays a queued sale', async () => {
    const response = await request('POST', '/sync', {
      token: shop.token,
      body: {
        actions: [
          {
            id: 'local-1',
            kind: 'transaction',
            idempotencyKey: 'key-1',
            queuedAt: isoDaysAgo(0),
            payload: {
              customerId: shop.customer.customerId,
              items: [{ productId: shop.product.productId, name: 'Rice', quantity: 2, unit: 'kg', unitPrice: 6200 }],
              paid: 12400,
              paymentMethod: 'cash',
            },
          },
        ],
      },
    });

    expect(response.status).toBe(200);
    const summary = response.body.summary as { synced: number; failed: number };
    expect(summary.synced).toBe(1);
    expect(summary.failed).toBe(0);

    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.totalSpent).toBe(12400);
  });

  it('does not double-charge when the same batch is replayed', async () => {
    const body = {
      actions: [
        {
          id: 'local-1',
          kind: 'transaction',
          idempotencyKey: 'stable-key',
          queuedAt: isoDaysAgo(0),
          payload: {
            customerId: shop.customer.customerId,
            items: [{ productId: shop.product.productId, name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 }],
            paid: 6200,
            paymentMethod: 'cash',
          },
        },
      ],
    };

    await request('POST', '/sync', { token: shop.token, body });
    const second = await request('POST', '/sync', { token: shop.token, body });

    const outcomes = second.body.outcomes as Array<{ status: string }>;
    expect(outcomes[0]!.status).toBe('duplicate');

    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.totalSpent).toBe(6200);
    expect(customer.transactionCount).toBe(1);

    const product = await products.require(shop.vendor.vendorId, shop.product.productId);
    expect(product.stock).toBe(99);
  });

  it('keeps the original time, not the sync time', async () => {
    const queuedAt = isoDaysAgo(3);

    await request('POST', '/sync', {
      token: shop.token,
      body: {
        actions: [
          {
            id: 'local-1',
            kind: 'transaction',
            idempotencyKey: 'dated-key',
            queuedAt,
            payload: {
              customerId: shop.customer.customerId,
              items: [{ name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 }],
              paid: 6200,
              paymentMethod: 'cash',
            },
          },
        ],
      },
    });

    const list = await request('GET', '/transactions', { token: shop.token });
    const transactions = list.body.transactions as Array<{ timestamp: string }>;
    expect(transactions[0]!.timestamp).toBe(queuedAt);
  });

  it('lets one bad action fail without blocking the rest', async () => {
    const response = await request('POST', '/sync', {
      token: shop.token,
      body: {
        actions: [
          {
            id: 'bad',
            kind: 'transaction',
            idempotencyKey: 'bad-key',
            queuedAt: isoDaysAgo(0),
            payload: { customerId: shop.customer.customerId, items: [] },
          },
          {
            id: 'good',
            kind: 'transaction',
            idempotencyKey: 'good-key',
            queuedAt: isoDaysAgo(0),
            payload: {
              customerId: shop.customer.customerId,
              items: [{ name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 }],
              paid: 6200,
              paymentMethod: 'cash',
            },
          },
        ],
      },
    });

    const summary = response.body.summary as { synced: number; failed: number };
    expect(summary.synced).toBe(1);
    expect(summary.failed).toBe(1);

    // The client keeps only the genuine failure in its queue.
    const outcomes = response.body.outcomes as Array<{ id: string; status: string }>;
    expect(outcomes.find((o) => o.id === 'bad')!.status).toBe('failed');
    expect(outcomes.find((o) => o.id === 'good')!.status).toBe('synced');
  });

  it('resolves a queued customer who already exists by phone', async () => {
    const response = await request('POST', '/sync', {
      token: shop.token,
      body: {
        actions: [
          {
            id: 'local-customer',
            kind: 'customer',
            idempotencyKey: 'cust-key',
            queuedAt: isoDaysAgo(0),
            payload: { name: 'Ramesh Kumar', phone: shop.customer.phone },
          },
        ],
      },
    });

    const outcomes = response.body.outcomes as Array<{ status: string; recordId?: string }>;
    expect(outcomes[0]!.status).toBe('duplicate');
    // And it reports the existing id, so queued sales still attach correctly.
    expect(outcomes[0]!.recordId).toBe(shop.customer.customerId);
  });

  it('replays customers before the sales that reference them', async () => {
    const response = await request('POST', '/sync', {
      token: shop.token,
      body: {
        actions: [
          {
            id: 'new-customer',
            kind: 'customer',
            idempotencyKey: 'nc-key',
            queuedAt: isoDaysAgo(0),
            payload: { name: 'Sunil Verma', phone: '9812345678' },
          },
        ],
      },
    });

    const outcomes = response.body.outcomes as Array<{ status: string; recordId?: string }>;
    expect(outcomes[0]!.status).toBe('synced');

    const customerId = outcomes[0]!.recordId!;
    const sale = await request('POST', '/sync', {
      token: shop.token,
      body: {
        actions: [
          {
            id: 'their-sale',
            kind: 'transaction',
            idempotencyKey: 'ts-key',
            queuedAt: isoDaysAgo(0),
            payload: {
              customerId,
              items: [{ name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 }],
              paid: 0,
              paymentMethod: 'credit',
            },
          },
        ],
      },
    });

    expect((sale.body.summary as { synced: number }).synced).toBe(1);
  });

  it('caps the batch size', async () => {
    const actions = Array.from({ length: 101 }, (_, index) => ({
      id: `local-${index}`,
      kind: 'customer' as const,
      idempotencyKey: `key-${index}`,
      queuedAt: isoDaysAgo(0),
      payload: { name: `Customer ${index}` },
    }));

    const response = await request('POST', '/sync', { token: shop.token, body: { actions } });
    expect(response.status).toBe(422);
  });

  it('reports a queued payment as synced only once it is stored', async () => {
    const response = await request('POST', '/sync', {
      token: shop.token,
      body: {
        actions: [
          {
            id: 'local-payment',
            kind: 'payment',
            idempotencyKey: 'pay-key',
            queuedAt: isoDaysAgo(0),
            payload: { customerId: shop.customer.customerId, amount: 5000, method: 'cash' },
          },
        ],
      },
    });

    expect((response.body.summary as { synced: number }).synced).toBe(1);

    const customer = await customers.require(shop.vendor.vendorId, shop.customer.customerId);
    expect(customer.outstanding).toBe(-5000);
  });
});
