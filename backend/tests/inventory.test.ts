import { beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld, type TestShop } from './helpers';
import {
  buildInsight,
  computeVelocity,
  matchProduct,
  stockStatusOf,
  stockValueOf,
} from '../src/services/inventory';
import { isoDaysAgo, nowIso } from '../src/utils/dates';
import { newInventoryEventId, newProductId } from '../src/utils/ids';
import type { InventoryEvent, Product } from '../src/schemas/entities';

/**
 * Inventory intelligence.
 *
 * These are arithmetic tests, deliberately. The whole design premise is that
 * "days of stock remaining" is a division and not a model output, so it is
 * pinned here with exact expected values.
 */

function product(overrides: Partial<Product> = {}): Product {
  return {
    productId: newProductId(),
    vendorId: 'ven_test',
    name: 'Cooking Oil',
    sku: 'OIL',
    category: 'staples',
    unit: 'litre',
    costPrice: 12800,
    sellingPrice: 15200,
    stock: 12,
    reorderLevel: 10,
    supplier: 'FreshMart Suppliers',
    purchaseDate: '',
    salesVelocity: 0,
    aliases: ['tel'],
    createdAt: isoDaysAgo(60),
    updatedAt: nowIso(),
    ...overrides,
  };
}

function saleEvent(productId: string, quantity: number, daysAgo: number): InventoryEvent {
  return {
    inventoryEventId: newInventoryEventId(),
    vendorId: 'ven_test',
    productId,
    productName: 'Cooking Oil',
    type: 'sale',
    quantityDelta: -quantity,
    stockAfter: 0,
    unitPrice: 15200,
    note: '',
    timestamp: isoDaysAgo(daysAgo),
    source: 'seed',
  };
}

describe('sales velocity', () => {
  it('averages units sold over the window', () => {
    const oil = product();
    // 70 units over the 14-day window.
    const events = Array.from({ length: 14 }, (_, day) => saleEvent(oil.productId, 5, day));

    const { unitsSold, velocity } = computeVelocity(events, oil.productId);

    expect(unitsSold).toBe(70);
    expect(velocity).toBeCloseTo(5, 5);
  });

  it('ignores sales older than the window', () => {
    const oil = product();
    const events = [saleEvent(oil.productId, 100, 30), saleEvent(oil.productId, 14, 1)];

    const { unitsSold } = computeVelocity(events, oil.productId);
    expect(unitsSold).toBe(14);
  });

  it('subtracts returns, so goods that come back are not demand', () => {
    const oil = product();
    const events: InventoryEvent[] = [
      saleEvent(oil.productId, 20, 2),
      { ...saleEvent(oil.productId, 5, 1), type: 'return', quantityDelta: 5 },
    ];

    const { unitsSold } = computeVelocity(events, oil.productId);
    expect(unitsSold).toBe(15);
  });

  it('ignores restocks, which are supply and not demand', () => {
    const oil = product();
    const events: InventoryEvent[] = [
      saleEvent(oil.productId, 10, 2),
      { ...saleEvent(oil.productId, 200, 1), type: 'stock_in', quantityDelta: 200 },
    ];

    expect(computeVelocity(events, oil.productId).unitsSold).toBe(10);
  });

  it('ignores other products entirely', () => {
    const oil = product();
    const rice = product({ name: 'Rice' });
    const events = [saleEvent(rice.productId, 50, 1)];

    expect(computeVelocity(events, oil.productId).unitsSold).toBe(0);
  });
});

describe('product insight', () => {
  it('computes days remaining as stock divided by velocity', () => {
    const oil = product({ stock: 12 });
    // 5.4 units a day, matching the worked example in the product spec.
    const events = Array.from({ length: 14 }, (_, day) => saleEvent(oil.productId, 5.4, day));

    const insight = buildInsight(oil, events);

    expect(insight.salesVelocity).toBeCloseTo(5.4, 1);
    expect(insight.daysRemaining).toBeCloseTo(2.2, 1);
    expect(insight.lowStock).toBe(true);
  });

  it('returns null days remaining rather than Infinity when nothing sells', () => {
    // "Never runs out" is a different statement from "runs out in a very long
    // time", and rendering Infinity as a number of days would be nonsense.
    const insight = buildInsight(product({ stock: 50, reorderLevel: 0 }), []);

    expect(insight.daysRemaining).toBeNull();
    expect(insight.lowStock).toBe(false);
  });

  it('flags a product below its reorder level even when cover is long', () => {
    const oil = product({ stock: 8, reorderLevel: 10 });
    const events = [saleEvent(oil.productId, 1, 1)];

    const insight = buildInsight(oil, events);

    expect(insight.belowReorderLevel).toBe(true);
    expect(insight.lowStock).toBe(true);
    // But it is not about to run out, which is what the pulse card must reflect.
    expect(insight.daysRemaining!).toBeGreaterThan(3);
  });

  it('flags out of stock', () => {
    const insight = buildInsight(product({ stock: 0 }), []);
    expect(insight.outOfStock).toBe(true);
    expect(insight.lowStock).toBe(true);
  });

  it('computes margin from cost and selling price', () => {
    const insight = buildInsight(product({ costPrice: 10000, sellingPrice: 20000 }), []);
    expect(insight.marginPercent).toBe(50);
  });

  it('suggests a restock quantity that restores two weeks of cover', () => {
    const oil = product({ stock: 10, reorderLevel: 0 });
    const events = Array.from({ length: 14 }, (_, day) => saleEvent(oil.productId, 5, day));

    const insight = buildInsight(oil, events);

    // 5/day over 14 days is 70 units of target cover, less 10 in stock.
    expect(insight.suggestedRestockQuantity).toBe(60);
  });
});

describe('product matching', () => {
  const catalogue = [
    product({ name: 'Rice', aliases: ['chawal', 'basmati'] }),
    product({ name: 'Cooking Oil', aliases: ['tel'] }),
    product({ name: 'Detergent', aliases: ['surf'] }),
  ];

  it('matches an exact name with full confidence', () => {
    const match = matchProduct('Rice', catalogue);
    expect(match!.product.name).toBe('Rice');
    expect(match!.confidence).toBe(1);
  });

  it('matches case-insensitively', () => {
    expect(matchProduct('rice', catalogue)!.product.name).toBe('Rice');
  });

  it('matches a Hindi alias', () => {
    expect(matchProduct('chawal', catalogue)!.product.name).toBe('Rice');
    expect(matchProduct('tel', catalogue)!.product.name).toBe('Cooking Oil');
  });

  it('matches a partial phrase by token overlap', () => {
    expect(matchProduct('cooking', catalogue)!.product.name).toBe('Cooking Oil');
  });

  it('returns null rather than a bad guess', () => {
    expect(matchProduct('helicopter', catalogue)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(matchProduct('', catalogue)).toBeNull();
  });

  /**
   * A name the voice parser could not canonicalise.
   *
   * `normalise` keeps only Latin letters, so a name dictated in Devanagari
   * arrives here as an empty string and every pass above it is skipped — which
   * is how a shop holding forty kilos of साल्ट was told salt was not on its
   * product list.
   */
  describe('a name still in Devanagari', () => {
    const shelf = [
      product({ name: 'Rice', aliases: ['chawal'] }),
      product({ name: 'Salt', aliases: ['namak'] }),
      product({ name: 'Milk', aliases: ['doodh'] }),
      product({ name: 'Toor Dal', aliases: ['dal'] }),
    ];

    it('matches the product it sounds like', () => {
      expect(matchProduct('साल्ट', shelf)!.product.name).toBe('Salt');
      expect(matchProduct('मिल्क', shelf)!.product.name).toBe('Milk');
    });

    it('is confident enough to link, but not certain', () => {
      const match = matchProduct('साल्ट', shelf)!;
      expect(match.confidence).toBeGreaterThan(0.5);
      expect(match.confidence).toBeLessThan(1);
    });

    it('still refuses a word the shop stocks nothing like', () => {
      expect(matchProduct('हेलीकॉप्टर', shelf)).toBeNull();
    });

    it('does not reach for a Latin word that merely sounds close', () => {
      // "there" shares a skeleton with "toor". Sound matching answers the
      // script the parser could not read; it is not a spellchecker for English,
      // and a wrong answer here moves the wrong product's stock.
      expect(matchProduct('there', shelf)).toBeNull();
    });
  });
});

describe('stock adjustments', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'inventory@test.app', shopName: 'Sharma Stores' });
  });

  it('records a restock and raises stock', async () => {
    const response = await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId: shop.product.productId, type: 'stock_in', quantityDelta: 25, note: 'Supplier' },
    });

    expect(response.status).toBe(200);
    const product = response.body.product as { stock: number };
    expect(product.stock).toBe(125);
  });

  it('records a return and lowers stock', async () => {
    const response = await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId: shop.product.productId, type: 'adjustment', quantityDelta: -5 },
    });

    const product = response.body.product as { stock: number };
    expect(product.stock).toBe(95);
  });

  it('rejects a zero adjustment', async () => {
    const response = await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId: shop.product.productId, type: 'adjustment', quantityDelta: 0 },
    });

    expect(response.status).toBe(422);
  });

  it('suggests restocking only for products that need it', async () => {
    const response = await request('GET', '/inventory/restock/suggestions', {
      token: shop.token,
    });

    expect(response.status).toBe(200);
    // 100 units in stock and nothing sold, so nothing to buy.
    expect(response.body.lines).toHaveLength(0);
    expect(response.body.summary).toContain('Nothing needs restocking');
  });
});

/**
 * Stock status is derived, never stored.
 *
 * The status a shopkeeper acts on has to agree with the quantity printed
 * beside it. Deriving it on read is what guarantees that: there is no second
 * copy to update from the five different paths that move stock, and so no path
 * that can forget.
 */
describe('stock status', () => {
  it('follows quantity against the reorder level', () => {
    const cases: Array<[number, number, string]> = [
      [50, 10, 'in_stock'],
      [11, 10, 'in_stock'],
      [1, 10, 'low_stock'],
      [0, 10, 'out_of_stock'],
      [0, 0, 'out_of_stock'],
      [-3, 10, 'out_of_stock'], // sold from the sack before recording a restock

      // One threshold for the whole shop, whatever the item's own level says.
      [6, 0, 'in_stock'],
      [5, 0, 'low_stock'],
      [3, 0, 'low_stock'],
      [1, 0, 'low_stock'],
      [6, 20, 'in_stock'], // a high reorder level does not make this low
      [5, 2, 'low_stock'],
    ];

    for (const [stock, reorderLevel, expected] of cases) {
      expect(stockStatusOf({ stock, reorderLevel })).toBe(expected);
    }
  });

  it('values stock at cost, and never negatively', () => {
    expect(stockValueOf({ stock: 50, costPrice: 6000 })).toBe(300_000);
    expect(stockValueOf({ stock: 0, costPrice: 6000 })).toBe(0);
    expect(stockValueOf({ stock: -4, costPrice: 6000 })).toBe(0);
  });

  it('changes as soon as the quantity does', async () => {
    resetWorld();
    const shop = await createShop({ email: 'status@test.app', shopName: 'Sharma Stores' });

    const created = await request('POST', '/inventory', {
      token: shop.token,
      body: {
        name: 'Rice',
        supplier: 'Shree Traders',
        unit: 'kg',
        costPrice: 6000,
        sellingPrice: 7500,
        stock: 50,
        reorderLevel: 10,
        purchaseDate: '2026-09-10',
      },
    });
    expect(created.status).toBe(201);
    const productId = (created.body.product as { productId: string }).productId;

    const statusNow = async () => {
      const list = await request('GET', '/inventory', { token: shop.token });
      const rows = list.body.products as Array<Record<string, unknown>>;
      const row = rows.find((entry) => entry.productId === productId)!;
      return { status: row.stockStatus, value: row.stockValue, stock: row.stock };
    };

    expect(await statusNow()).toEqual({ status: 'in_stock', value: 300_000, stock: 50 });

    // Still comfortable at ten, which is above the shop-wide threshold.
    await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId, type: 'adjustment', quantityDelta: -40 },
    });
    expect(await statusNow()).toEqual({ status: 'in_stock', value: 60_000, stock: 10 });

    // Down to five: time to buy.
    await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId, type: 'adjustment', quantityDelta: -5 },
    });
    expect(await statusNow()).toEqual({ status: 'low_stock', value: 30_000, stock: 5 });

    // And empty.
    await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId, type: 'adjustment', quantityDelta: -5 },
    });
    expect(await statusNow()).toEqual({ status: 'out_of_stock', value: 0, stock: 0 });
  });
});

describe('restocking', () => {
  it('adds stock, and records what it cost and when', async () => {
    resetWorld();
    const shop = await createShop({ email: 'restock@test.app', shopName: 'Sharma Stores' });

    const created = await request('POST', '/inventory', {
      token: shop.token,
      body: {
        name: 'Tea',
        supplier: 'Assam Tea Suppliers',
        unit: 'kg',
        costPrice: 28_000,
        sellingPrice: 34_000,
        stock: 2,
        reorderLevel: 5,
        purchaseDate: '2026-09-05',
      },
    });
    const productId = (created.body.product as { productId: string }).productId;

    const response = await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: {
        productId,
        type: 'stock_in',
        quantityDelta: 13,
        unitPrice: 30_000,
        purchaseDate: '2026-09-20',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.stockStatus).toBe('in_stock');

    const product = response.body.product as Record<string, unknown>;
    expect(product.stock).toBe(15);
    // The new batch cost more, and that is what the shelf is now valued at.
    expect(product.costPrice).toBe(30_000);
    expect(product.purchaseDate).toBe('2026-09-20');
    expect(response.body.stockValue).toBe(450_000);
  });

  it('leaves cost and purchase date alone when stock goes out', async () => {
    resetWorld();
    const shop = await createShop({ email: 'outward@test.app', shopName: 'Sharma Stores' });

    const created = await request('POST', '/inventory', {
      token: shop.token,
      body: {
        name: 'Salt',
        supplier: 'Shree Traders',
        unit: 'kg',
        costPrice: 2500,
        sellingPrice: 3100,
        stock: 40,
        reorderLevel: 10,
        purchaseDate: '2026-09-06',
      },
    });
    const productId = (created.body.product as { productId: string }).productId;

    const response = await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId, type: 'stock_out', quantityDelta: -5 },
    });

    const product = response.body.product as Record<string, unknown>;
    expect(product.stock).toBe(35);
    expect(product.costPrice).toBe(2500);
    expect(product.purchaseDate).toBe('2026-09-06');
  });
});

describe('product validation', () => {
  it('refuses the things a stock row cannot be missing', async () => {
    resetWorld();
    const shop = await createShop({ email: 'validate@test.app', shopName: 'Sharma Stores' });

    const base = {
      name: 'Rice',
      supplier: 'Shree Traders',
      unit: 'kg',
      costPrice: 6000,
      sellingPrice: 7500,
      stock: 10,
      reorderLevel: 2,
    };

    const rejected: Array<[string, Record<string, unknown>]> = [
      ['empty name', { ...base, name: '   ' }],
      ['empty supplier', { ...base, supplier: '' }],
      ['negative price', { ...base, costPrice: -1 }],
      ['negative quantity', { ...base, stock: -5 }],
      ['negative reorder level', { ...base, reorderLevel: -1 }],
      ['impossible date', { ...base, purchaseDate: '2026-02-31' }],
      ['malformed date', { ...base, purchaseDate: '10-09-2026' }],
      ['price as a string', { ...base, costPrice: '6000' }],
      ['quantity as a string', { ...base, stock: '10' }],
    ];

    for (const [label, body] of rejected) {
      const response = await request('POST', '/inventory', { token: shop.token, body });
      expect(`${label}: ${response.status}`).toBe(`${label}: 422`);
    }

    // And the valid one still goes through.
    const ok = await request('POST', '/inventory', {
      token: shop.token,
      body: { ...base, purchaseDate: '2026-09-10' },
    });
    expect(ok.status).toBe(201);
  });
});

/**
 * A partial update must be partial.
 *
 * This is the bug that made the whole derived-status idea unsafe: an edit that
 * only changed the quantity was also resetting the reorder level to zero, so an
 * item with three units left and a reorder level of four came back reading
 * IN STOCK. The status arithmetic was right; it was being handed a wiped input.
 */
describe('editing one field', () => {
  it('leaves every field it does not name alone', async () => {
    resetWorld();
    const shop = await createShop({ email: 'partial@test.app', shopName: 'Sharma Stores' });

    const created = await request('POST', '/inventory', {
      token: shop.token,
      body: {
        name: 'Dal',
        supplier: 'FreshMart Suppliers',
        sku: 'DAL-1',
        category: 'staples',
        unit: 'kg',
        costPrice: 12_000,
        sellingPrice: 14_500,
        stock: 30,
        reorderLevel: 8,
        purchaseDate: '2026-09-11',
        aliases: ['daal', 'toor'],
      },
    });
    const before = created.body.product as Record<string, unknown>;

    const patched = await request('PATCH', `/inventory/${String(before.productId)}`, {
      token: shop.token,
      body: { stock: 5 },
    });
    expect(patched.status).toBe(200);
    const after = patched.body.product as Record<string, unknown>;

    expect(after.stock).toBe(5);
    for (const field of [
      'name',
      'supplier',
      'sku',
      'category',
      'unit',
      'costPrice',
      'sellingPrice',
      'reorderLevel',
      'purchaseDate',
    ]) {
      expect(`${field}=${JSON.stringify(after[field])}`).toBe(
        `${field}=${JSON.stringify(before[field])}`,
      );
    }
    expect(after.aliases).toEqual(before.aliases);

    // And the status follows the surviving reorder level, not a reset one.
    const list = await request('GET', '/inventory', { token: shop.token });
    const row = (list.body.products as Array<Record<string, unknown>>).find(
      (entry) => entry.productId === before.productId,
    )!;
    expect(row.stockStatus).toBe('low_stock');
  });
});

/**
 * The low-stock reminder's data.
 *
 * Derived from the current quantity on every request. There is deliberately no
 * "seen" or "dismissed" state anywhere in this path: an alert that can be
 * marked read is an alert that falls silent while the shelf is still empty.
 * Restocking is the only thing that clears an item from this list.
 */
describe('low stock alerts', () => {
  let shop: TestShop;

  const add = async (name: string, stock: number, reorderLevel: number) => {
    const response = await request('POST', '/inventory', {
      token: shop.token,
      body: {
        name,
        supplier: 'Shree Traders',
        unit: 'packet',
        costPrice: 3000,
        sellingPrice: 3800,
        stock,
        reorderLevel,
      },
    });
    expect(response.status).toBe(201);
    return (response.body.product as { productId: string }).productId;
  };

  const alerts = async () => {
    const response = await request('GET', '/inventory/alerts', { token: shop.token });
    expect(response.status).toBe(200);
    return response.body as unknown as {
      alerts: Array<{ name: string; stock: number; status: string; lowStockAt: number }>;
      counts: { lowStock: number; outOfStock: number };
      threshold: number;
    };
  };

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'alerts@test.app', shopName: 'Sharma Stores' });
  });

  it('names every item that needs buying, and nothing that does not', async () => {
    await add('Milk', 30, 0); // comfortable
    await add('Tea', 4, 0); // under the floor of five
    await add('Sugar', 0, 0); // gone
    await add('Rice', 3, 20); // low on the shop-wide threshold

    const result = await alerts();

    expect(result.threshold).toBe(5);
    expect(result.counts).toEqual({ lowStock: 2, outOfStock: 1 });

    // Empty shelves first, then the smallest quantity.
    expect(result.alerts.map((alert) => alert.name)).toEqual(['Sugar', 'Rice', 'Tea']);
    expect(result.alerts[0]!.status).toBe('out_of_stock');
    expect(result.alerts[1]).toMatchObject({ name: 'Rice', stock: 3, status: 'low_stock' });
    expect(result.alerts[2]).toMatchObject({ name: 'Tea', stock: 4, lowStockAt: 5 });

    expect(result.alerts.some((alert) => alert.name === 'Milk')).toBe(false);
  });

  it('keeps reporting the same item until it is actually restocked', async () => {
    const tea = await add('Tea', 4, 0);

    // Asked for again and again, as a fresh app open would.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await alerts();
      expect(result.alerts.map((alert) => alert.name)).toEqual(['Tea']);
    }

    // One short of clearing it: five is still low.
    await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId: tea, type: 'stock_in', quantityDelta: 1 },
    });
    expect((await alerts()).alerts[0]).toMatchObject({ name: 'Tea', stock: 5 });

    // One more takes it clear.
    await request('POST', '/inventory/adjust', {
      token: shop.token,
      body: { productId: tea, type: 'stock_in', quantityDelta: 1 },
    });
    expect((await alerts()).alerts).toHaveLength(0);
  });

  it('starts reporting an item the moment a sale takes it low', async () => {
    const tea = await add('Tea', 10, 0);
    expect((await alerts()).alerts).toHaveLength(0);

    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ productId: tea, name: 'Tea', quantity: 6, unit: 'packet', unitPrice: 3800 }],
        paid: 22800,
        paymentMethod: 'cash',
      },
    });

    const result = await alerts();
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({ name: 'Tea', stock: 4, status: 'low_stock' });
  });
});

/**
 * Stock deduction, across the whole sale.
 *
 * Every line moves its own product, and the stock changes are written in the
 * same transactional write as the sale — so there is no state in which the sale
 * exists and the shelf disagrees with it.
 */
describe('a sale moves the stock', () => {
  let shop: TestShop;
  const ids: Record<string, string> = {};

  const stockOf = async (name: string) => {
    const list = await request('GET', '/inventory', { token: shop.token });
    const rows = list.body.products as Array<{ name: string; stock: number }>;
    return rows.find((row) => row.name === name)!.stock;
  };

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'deduct@test.app', shopName: 'Sharma Stores' });

    for (const [name, stock] of [
      ['Milk', 30],
      ['Tea', 10],
      ['Biscuits', 20],
    ] as const) {
      const response = await request('POST', '/inventory', {
        token: shop.token,
        body: {
          name,
          supplier: 'Shree Traders',
          unit: 'packet',
          costPrice: 3000,
          sellingPrice: 4000,
          stock,
          reorderLevel: 0,
        },
      });
      ids[name] = (response.body.product as { productId: string }).productId;
    }
  });

  it('deducts every line, not just the first', async () => {
    const response = await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [
          { productId: ids.Milk, name: 'Milk', quantity: 4, unit: 'packet', unitPrice: 4000 },
          { productId: ids.Tea, name: 'Tea', quantity: 6, unit: 'packet', unitPrice: 4000 },
          {
            productId: ids.Biscuits,
            name: 'Biscuits',
            quantity: 2,
            unit: 'packet',
            unitPrice: 4000,
          },
        ],
        paid: 0,
        paymentMethod: 'credit',
      },
    });
    expect(response.status).toBe(201);

    expect(await stockOf('Milk')).toBe(26);
    expect(await stockOf('Tea')).toBe(4);
    expect(await stockOf('Biscuits')).toBe(18);
  });

  it('deducts once when the same sale is submitted twice', async () => {
    const body = {
      customerId: shop.customer.customerId,
      items: [{ productId: ids.Milk, name: 'Milk', quantity: 4, unit: 'packet', unitPrice: 4000 }],
      paid: 0,
      paymentMethod: 'credit' as const,
      idempotencyKey: 'same-sale-twice',
    };

    const first = await request('POST', '/transactions', { token: shop.token, body });
    const second = await request('POST', '/transactions', { token: shop.token, body });

    expect(first.status).toBe(201);

    // The replay is recognised and answered with the sale that already exists,
    // rather than becoming a second one. Same transaction id, stock moved once.
    expect(second.status).toBe(201);
    expect(second.body.duplicate).toBe(true);
    expect((second.body.transaction as { transactionId: string }).transactionId).toBe(
      (first.body.transaction as { transactionId: string }).transactionId,
    );

    expect(await stockOf('Milk')).toBe(26);

    const list = await request('GET', '/transactions', { token: shop.token });
    expect(list.body.transactions as unknown[]).toHaveLength(1);
  });

  it('never takes a shelf below empty', async () => {
    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        // Only what is on the shelf is sold; the draft caps this upstream.
        items: [{ productId: ids.Tea, name: 'Tea', quantity: 10, unit: 'packet', unitPrice: 4000 }],
        paid: 0,
        paymentMethod: 'credit',
      },
    });

    expect(await stockOf('Tea')).toBe(0);
    const result = await request('GET', '/inventory/alerts', { token: shop.token });
    const rows = (result.body as unknown as { alerts: Array<{ name: string; status: string }> })
      .alerts;
    expect(rows.find((row) => row.name === 'Tea')!.status).toBe('out_of_stock');
  });

  it('leaves stock alone for a line that matches no product', async () => {
    const before = await stockOf('Milk');

    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [{ name: 'Imported Truffle Oil', quantity: 2, unit: 'bottle', unitPrice: 50000 }],
        paid: 0,
        paymentMethod: 'credit',
      },
    });

    expect(await stockOf('Milk')).toBe(before);
  });
});
