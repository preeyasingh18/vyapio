import { beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld, type TestShop } from './helpers';

/**
 * Tenant isolation.
 *
 * The highest-stakes property in the system: one shop must never be able to
 * read or write another shop's records. These tests attack it from every angle
 * a client actually controls — path parameters, request bodies, query strings
 * and scan tokens.
 */

describe('tenant isolation', () => {
  let sharma: TestShop;
  let gupta: TestShop;

  beforeEach(async () => {
    resetWorld();
    sharma = await createShop({ email: 'sharma@test.app', shopName: 'Sharma Stores' });
    gupta = await createShop({ email: 'gupta@test.app', shopName: 'Gupta Hardware' });
  });

  it('does not expose another shop customer by id', async () => {
    const response = await request('GET', `/customers/${gupta.customer.customerId}`, {
      token: sharma.token,
    });

    // 404, not 403: confirming the id exists elsewhere would itself leak.
    expect(response.status).toBe(404);
  });

  it('lists only the caller own customers', async () => {
    const response = await request('GET', '/customers', { token: sharma.token });

    expect(response.status).toBe(200);
    const customers = response.body.customers as Array<{ customerId: string; vendorId: string }>;
    expect(customers).toHaveLength(1);
    expect(customers[0]!.customerId).toBe(sharma.customer.customerId);
    expect(customers.every((customer) => customer.vendorId === sharma.vendor.vendorId)).toBe(true);
  });

  it('refuses to bill another shop customer', async () => {
    const response = await request('POST', '/transactions', {
      token: sharma.token,
      body: {
        customerId: gupta.customer.customerId,
        items: [{ name: 'Rice', quantity: 1, unit: 'kg', unitPrice: 6200 }],
        paid: 6200,
        paymentMethod: 'cash',
      },
    });

    expect(response.status).toBe(404);
  });

  it('ignores a vendorId supplied in the request body', async () => {
    // A client claiming to be another tenant must be silently overruled by the
    // session, not trusted.
    const response = await request('POST', '/customers', {
      token: sharma.token,
      body: {
        name: 'Injected Customer',
        phone: '9899999999',
        vendorId: gupta.vendor.vendorId,
      },
    });

    expect(response.status).toBe(201);
    const customer = response.body.customer as { vendorId: string };
    expect(customer.vendorId).toBe(sharma.vendor.vendorId);
    expect(customer.vendorId).not.toBe(gupta.vendor.vendorId);

    const guptaList = await request('GET', '/customers', { token: gupta.token });
    const names = (guptaList.body.customers as Array<{ name: string }>).map((c) => c.name);
    expect(names).not.toContain('Injected Customer');
  });

  it('does not resolve another shop QR token', async () => {
    // The token is real and valid — just not for this tenant.
    const response = await request('POST', '/customers/resolve', {
      token: sharma.token,
      body: { qrId: gupta.customer.qrId },
    });

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.customer).toBeUndefined();
  });

  it('does not resolve another shop customer by phone', async () => {
    const response = await request('POST', '/customers/resolve', {
      token: sharma.token,
      body: { phone: gupta.customer.phone },
    });

    expect(response.body.found).toBe(false);
  });

  it('does not leak another shop transactions through the customerId filter', async () => {
    await request('POST', '/transactions', {
      token: gupta.token,
      body: {
        customerId: gupta.customer.customerId,
        items: [{ name: 'Rice', quantity: 2, unit: 'kg', unitPrice: 6200 }],
        paid: 12400,
        paymentMethod: 'cash',
      },
    });

    // customerId reaches a GSI that is not partitioned by vendor, so this is
    // the exact query that would leak without the re-scoping filter.
    const response = await request('GET', '/transactions', {
      token: sharma.token,
      query: { customerId: gupta.customer.customerId },
    });

    expect(response.status).toBe(200);
    expect(response.body.transactions).toHaveLength(0);
  });

  it('does not expose another shop khata timeline', async () => {
    const response = await request('GET', `/khata/${gupta.customer.customerId}`, {
      token: sharma.token,
    });

    expect(response.status).toBe(404);
  });

  it('does not let one shop edit another shop product', async () => {
    const response = await request('PATCH', `/inventory/${gupta.product.productId}`, {
      token: sharma.token,
      body: { sellingPrice: 1 },
    });

    expect(response.status).toBe(404);

    const guptaProducts = await request('GET', '/inventory', { token: gupta.token });
    const product = (guptaProducts.body.products as Array<{ sellingPrice: number }>)[0]!;
    expect(product.sellingPrice).toBe(6200);
  });

  it('keeps shop pulse figures separate', async () => {
    await request('POST', '/transactions', {
      token: gupta.token,
      body: {
        customerId: gupta.customer.customerId,
        items: [{ name: 'Rice', quantity: 10, unit: 'kg', unitPrice: 6200 }],
        paid: 0,
        paymentMethod: 'credit',
      },
    });

    const sharmaPulse = await request('GET', '/ai/pulse', { token: sharma.token });
    const today = sharmaPulse.body.today as { revenue: number; pending: number };

    expect(today.revenue).toBe(0);
    expect(today.pending).toBe(0);
  });
});
