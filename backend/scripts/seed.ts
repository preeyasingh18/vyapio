/**
 * Seeds the demo shop: Sharma Stores.
 *
 *   npm run seed             populate (skips if already seeded)
 *   npm run seed -- --reset  wipe the local store first
 *   npm run seed -- --empty  the shop and its login, with nothing in it
 *
 * `--empty` is the one to reach for when you want to work in the demo shop
 * yourself. Deleting the store file instead takes the demo account with it, and
 * any session already issued then points at a shop that is gone.
 *
 * The data is generated, not hand-written, but it is generated to be
 * *plausible* — purchases cluster on weekends and evenings, regulars buy the
 * same staples repeatedly, credit accumulates on a handful of customers rather
 * than spreading evenly, and stock levels reflect the sales history rather than
 * being picked at random. A demo that looks synthetic undermines the product it
 * is demonstrating.
 *
 * Deterministic: a fixed PRNG seed means the same shop every run, so the scripted
 * demo (docs/DEMO.md) says the same numbers every time.
 */

import { config } from '../src/config/index';
import { authService } from '../src/services/auth';
import { getStore, keys, setStore } from '../src/services/dynamodb';
import { LocalStore } from '../src/services/localStore';
import {
  customerItem,
  commitmentItem,
  inventoryEventItem,
  orderItem,
  paymentItem,
  productItem,
  transactionItem,
  vendorItem,
  vendors as vendorRepo,
} from '../src/services/repository';
import { refreshSalesVelocity } from '../src/services/inventory';
import { rupeesToPaise } from '../src/utils/money';
import { isoDaysAgo, isoDaysAhead, nowIso } from '../src/utils/dates';
import {
  newCommitmentId,
  newCustomerId,
  newInventoryEventId,
  newOrderId,
  newPaymentId,
  newProductId,
  newQrId,
  newTransactionId,
  newVendorId,
} from '../src/utils/ids';
import type {
  Commitment,
  Customer,
  InventoryEvent,
  LineItem,
  Order,
  Payment,
  Product,
  Transaction,
  Vendor,
} from '../src/schemas/entities';
import type { PaymentMethod } from '../src/schemas/common';

/* --------------------------------------------------------- Deterministic RNG */

/** mulberry32 — small, fast, and stable across Node versions. */
function createRandom(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createRandom(20240919);

const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (min: number, max: number) => min + random() * (max - min);
const intBetween = (min: number, max: number) => Math.floor(between(min, max + 1));
const chance = (probability: number) => random() < probability;

/* ---------------------------------------------------------------- Catalogue */

type ProductSeed = {
  name: string;
  supplier: string;
  category: string;
  unit: string;
  cost: number;
  price: number;
  aliases: string[];
  /** Relative purchase frequency. Rice and oil move; soap does not. */
  weight: number;
  /** Typical quantity per purchase. */
  qty: [number, number];
};

const PRODUCTS: ProductSeed[] = [
  { name: 'Rice', supplier: 'Shree Traders', category: 'staples', unit: 'kg', cost: 48, price: 62, aliases: ['chawal', 'basmati'], weight: 10, qty: [1, 5] },
  { name: 'Cooking Oil', supplier: 'FreshMart Suppliers', category: 'staples', unit: 'litre', cost: 128, price: 152, aliases: ['tel', 'refined oil'], weight: 8, qty: [1, 2] },
  { name: 'Atta', supplier: 'Gupta Wholesale', category: 'staples', unit: 'kg', cost: 38, price: 48, aliases: ['aata', 'flour', 'gehu'], weight: 7, qty: [1, 5] },
  { name: 'Sugar', supplier: 'Shree Traders', category: 'staples', unit: 'kg', cost: 40, price: 50, aliases: ['cheeni', 'chini'], weight: 6, qty: [1, 3] },
  { name: 'Dal', supplier: 'FreshMart Suppliers', category: 'staples', unit: 'kg', cost: 95, price: 118, aliases: ['daal', 'toor', 'arhar'], weight: 6, qty: [1, 2] },
  { name: 'Tea', supplier: 'Assam Tea Suppliers', category: 'pantry', unit: 'packet', cost: 115, price: 145, aliases: ['chai', 'chai patti'], weight: 5, qty: [1, 2] },
  { name: 'Detergent', supplier: 'Gupta Wholesale', category: 'household', unit: 'packet', cost: 142, price: 178, aliases: ['surf', 'washing powder'], weight: 4, qty: [1, 2] },
  { name: 'Soap', supplier: 'Gupta Wholesale', category: 'household', unit: 'piece', cost: 26, price: 35, aliases: ['sabun', 'nahane ka sabun'], weight: 4, qty: [1, 4] },
  { name: 'Biscuits', supplier: 'Gupta Wholesale', category: 'pantry', unit: 'packet', cost: 18, price: 25, aliases: ['biscuit', 'parle'], weight: 5, qty: [1, 6] },
  { name: 'Salt', supplier: 'Shree Traders', category: 'staples', unit: 'kg', cost: 18, price: 24, aliases: ['namak'], weight: 3, qty: [1, 2] },
];

/* ---------------------------------------------------------------- Customers */

/**
 * Named regulars appear in the scripted demo, so they come first.
 *
 * Ramesh leads the list because the voice examples throughout the product say
 * his name — a demo that parses "Ramesh ko 2 kilo chawal diya" and then cannot
 * find him reads as broken.
 */
const FEATURED_CUSTOMERS = [
  'Ramesh Kumar',
  'Priya Singh',
  'Amit Shaw',
  'Neha Kumari',
  'Suman Das',
];

/** The long tail. Empty keeps the demo shop to its named regulars. */
const MORE_CUSTOMERS: string[] = [];

const ALL_NAMES = [...FEATURED_CUSTOMERS, ...MORE_CUSTOMERS];

/** Distinct 10-digit numbers in the valid Indian mobile range. */
function phoneFor(index: number): string {
  const prefix = [9, 8, 7, 6][index % 4]!;
  return `${prefix}${String(800000000 + index * 7919).slice(0, 9)}`;
}

/* ------------------------------------------------------------------- Timing */

/**
 * Picks a purchase moment inside a day, weighted towards the evening rush —
 * shops are busiest after work, and flat-random timestamps look wrong on a
 * timeline.
 */
function timestampFor(daysAgo: number): string {
  const hour = chance(0.55) ? intBetween(17, 21) : chance(0.5) ? intBetween(9, 12) : intBetween(13, 16);
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  date.setHours(hour, intBetween(0, 59), intBetween(0, 59), 0);
  return date.toISOString();
}

/* -------------------------------------------------------------------- Seed */

type SeedResult = {
  vendorId: string;
  counts: Record<string, number>;
  demoLogin: { email: string; password: string } | null;
};

export async function seedDemoShop(
  options: { reset?: boolean; empty?: boolean } = {},
): Promise<SeedResult> {
  const store = getStore();

  if (options.reset && store instanceof LocalStore) {
    store.reset();
    console.log('  Local store cleared.');
  }

  /* ── Auth account ──────────────────────────────────────────────────────── */

  let userId: string;
  if (config.auth.mode === 'local') {
    userId = await authService.ensureLocalUser({
      email: config.demo.email,
      password: config.demo.password,
      name: 'Anil Sharma',
      phone: '9810012345',
      role: 'SHOPKEEPER',
    });
    console.log(`  Demo login ready: ${config.demo.email}`);
  } else {
    // With Cognito configured the account must exist in the user pool; creating
    // one here would need admin credentials the API deliberately does not hold.
    const existing = await vendorRepo.findByUserId(process.env.DEMO_USER_ID ?? '');
    userId = existing?.userId ?? process.env.DEMO_USER_ID ?? '';
    if (!userId) {
      throw new Error(
        'Cognito is configured, so the demo user must exist in the user pool.\n' +
          '  Sign up through the app, then re-run with DEMO_USER_ID=<cognito-sub> npm run seed',
      );
    }
  }

  /* ── Vendor ────────────────────────────────────────────────────────────── */

  const existingVendor = await vendorRepo.findByUserId(userId);
  if (existingVendor && !options.reset) {
    console.log(`  Sharma Stores already seeded (${existingVendor.vendorId}). Use --reset to rebuild.`);
    return {
      vendorId: existingVendor.vendorId,
      counts: {},
      demoLogin: config.auth.mode === 'local'
        ? { email: config.demo.email, password: config.demo.password }
        : null,
    };
  }

  const vendorId = existingVendor?.vendorId ?? newVendorId();
  const vendor: Vendor = {
    vendorId,
    userId,
    shopName: 'Sharma Stores',
    ownerName: 'Anil Sharma',
    phone: '9810012345',
    email: config.demo.email,
    category: 'kirana',
    city: 'Patna',
    language: 'en',
    voiceLanguage: 'hi',
    onboardingComplete: true,
    isDemo: true,
    createdAt: isoDaysAgo(420),
    updatedAt: nowIso(),
  };
  await store.put(vendorItem(vendor));

  /**
   * `--empty` stops here: the shop and its login exist, nothing is in it.
   *
   * This is the difference between an empty shop and no shop at all. Deleting
   * the store file removes the demo account too, which leaves any browser
   * still holding a session pointing at something that is gone. Signing in
   * and finding your own shop empty is a state the app is built for; signing
   * in to a shop that no longer exists is not.
   */
  if (options.empty) {
    return {
      vendorId,
      counts: {},
      demoLogin: config.auth.mode === 'local'
        ? { email: config.demo.email, password: config.demo.password }
        : null,
    };
  }

  /* ── Products ──────────────────────────────────────────────────────────── */

  const products: Product[] = PRODUCTS.map((seed) => ({
    productId: newProductId(),
    vendorId,
    name: seed.name,
    sku: seed.name.toUpperCase().replace(/\s+/g, '-').slice(0, 12),
    category: seed.category,
    unit: seed.unit,
    costPrice: rupeesToPaise(seed.cost),
    sellingPrice: rupeesToPaise(seed.price),
    // Set after the sales history is generated, so stock reflects what sold.
    stock: 0,
    // Both derived from the generated sales history below, once it exists.
    reorderLevel: 0,
    supplier: seed.supplier,
    // Last bought in recently; the restock history below is what actually
    // moves stock, this is just the date the Stock screen shows.
    purchaseDate: isoDaysAgo(intBetween(1, 14)).slice(0, 10),
    salesVelocity: 0,
    aliases: seed.aliases,
    createdAt: isoDaysAgo(400),
    updatedAt: nowIso(),
  }));

  const productByName = new Map(products.map((product) => [product.name, product]));
  const seedByName = new Map(PRODUCTS.map((seed) => [seed.name, seed]));

  // Weighted pool so frequent staples really are frequent.
  const pool: string[] = [];
  for (const seed of PRODUCTS) {
    for (let i = 0; i < seed.weight; i += 1) pool.push(seed.name);
  }

  /* ── Customers ─────────────────────────────────────────────────────────── */

  const customers: Customer[] = ALL_NAMES.map((name, index) => ({
    customerId: newCustomerId(),
    vendorId,
    name,
    phone: phoneFor(index),
    whatsappPhone: '',
    whatsappOptIn: false,
    email: '',
    qrId: newQrId(),
    outstanding: 0,
    totalSpent: 0,
    transactionCount: 0,
    notes: '',
    createdAt: isoDaysAgo(intBetween(60, 380)),
    updatedAt: nowIso(),
  }));

  /**
   * Visits per week.
   *
   * A neighbourhood kirana is busy: a handful of households come almost daily,
   * a middle tier comes a couple of times a week, and a long tail drops in
   * occasionally. The tiers are proportions of the list rather than fixed
   * cut-offs, so a shorter customer list still gets the same shape — with
   * absolute indexes, a five-name list would make every customer a daily
   * regular and flatten the spread the demo is meant to show.
   */
  const regulars = Math.max(1, Math.round(customers.length * 0.4));
  const middle = regulars + Math.max(1, Math.round(customers.length * 0.3));

  const visitsPerWeek = new Map<string, number>();
  customers.forEach((customer, index) => {
    if (index < regulars) visitsPerWeek.set(customer.customerId, between(4, 6));
    else if (index < middle) visitsPerWeek.set(customer.customerId, between(2, 3.5));
    else visitsPerWeek.set(customer.customerId, between(0.5, 1.8));
  });

  /* ── Sales history ─────────────────────────────────────────────────────── */

  const transactions: Transaction[] = [];
  const payments: Payment[] = [];
  const commitments: Commitment[] = [];
  const inventoryEvents: InventoryEvent[] = [];

  const unitsSold = new Map<string, number>();
  const balances = new Map<string, number>();
  const spend = new Map<string, number>();
  const visits = new Map<string, number>();
  const lastSeen = new Map<string, string>();

  const HISTORY_DAYS = 45;

  for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo -= 1) {
    const date = new Date(Date.now() - daysAgo * 86_400_000);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const dayBusyness = isWeekend ? 1.5 : 1;

    for (const customer of customers) {
      const base = visitsPerWeek.get(customer.customerId)! / 7;
      if (!chance(base * dayBusyness)) continue;

      /* Basket */
      const itemCount = chance(0.45) ? 1 : chance(0.7) ? 2 : 3;
      const chosen = new Set<string>();
      while (chosen.size < itemCount) chosen.add(pick(pool));

      const items: LineItem[] = [...chosen].map((name) => {
        const product = productByName.get(name)!;
        const seed = seedByName.get(name)!;
        const quantity = intBetween(seed.qty[0], seed.qty[1]);
        return {
          productId: product.productId,
          name: product.name,
          quantity,
          unit: product.unit,
          unitPrice: product.sellingPrice,
          lineTotal: product.sellingPrice * quantity,
        };
      });

      const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const total = subtotal;
      const timestamp = timestampFor(daysAgo);

      /* Payment behaviour — credit concentrates on a minority of customers. */
      // Credit goes to the regulars the shopkeeper knows, not to passers-by.
      const takesCredit = visitsPerWeek.get(customer.customerId)! > 2 && chance(0.22);
      let paid = total;
      let method: PaymentMethod = chance(0.45) ? 'upi' : chance(0.8) ? 'cash' : 'card';

      if (takesCredit) {
        // Usually a part payment, occasionally nothing at all.
        paid = chance(0.65) ? Math.round(total * between(0.4, 0.8) / 100) * 100 : 0;
        if (paid === 0) method = 'credit';
      }
      const outstanding = total - paid;

      const transactionId = newTransactionId();
      transactions.push({
        transactionId,
        vendorId,
        customerId: customer.customerId,
        customerName: customer.name,
        items,
        subtotal,
        discount: 0,
        total,
        paid,
        outstanding,
        paymentMethod: method,
        note: '',
        timestamp,
        source: 'seed',
        createdBy: userId,
        createdAt: timestamp,
      });

      if (paid > 0) {
        payments.push({
          paymentId: newPaymentId(),
          vendorId,
          customerId: customer.customerId,
          customerName: customer.name,
          transactionId,
          amount: paid,
          method,
          note: '',
          timestamp,
          source: 'seed',
          createdBy: userId,
        });
      }

      if (outstanding > 0) {
        // Due dates spread across the recent past and near future, so the
        // overdue list is genuinely mixed.
        const dueInDays = intBetween(-12, 10);
        commitments.push({
          commitmentId: newCommitmentId(),
          vendorId,
          customerId: customer.customerId,
          customerName: customer.name,
          transactionId,
          amount: outstanding,
          settledAmount: 0,
          description: items.map((item) => item.name).join(', '),
          dueDate: dueInDays >= 0 ? isoDaysAhead(dueInDays) : isoDaysAgo(-dueInDays),
          status: 'open',
          reminderStatus: 'none',
          reminderCount: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }

      for (const item of items) {
        unitsSold.set(item.name, (unitsSold.get(item.name) ?? 0) + item.quantity);
        inventoryEvents.push({
          inventoryEventId: newInventoryEventId(),
          vendorId,
          productId: item.productId!,
          productName: item.name,
          type: 'sale',
          quantityDelta: -item.quantity,
          stockAfter: 0, // Backfilled below, once closing stock is known.
          unitPrice: item.unitPrice,
          transactionId,
          note: '',
          timestamp,
          source: 'seed',
        });
      }

      balances.set(customer.customerId, (balances.get(customer.customerId) ?? 0) + outstanding);
      spend.set(customer.customerId, (spend.get(customer.customerId) ?? 0) + total);
      visits.set(customer.customerId, (visits.get(customer.customerId) ?? 0) + 1);
      lastSeen.set(customer.customerId, timestamp);
    }
  }

  /* ── Closing stock ─────────────────────────────────────────────────────── */

  /**
   * Stock is derived from what sold, not invented: each product is left with a
   * realistic number of days of cover. Cooking Oil is deliberately pushed down
   * to ~2 days so the Shop Pulse demo has a genuine "running out" card rather
   * than a staged one.
   */
  for (const product of products) {
    const sold = unitsSold.get(product.name) ?? 0;
    const velocity = sold / HISTORY_DAYS;

    const daysOfCover =
      product.name === 'Cooking Oil' ? 2.2 :
      product.name === 'Sugar' ? 3.0 :
      between(8, 22);

    product.stock = Math.max(0, Math.round(velocity * daysOfCover));
    product.salesVelocity = Number(velocity.toFixed(2));
    // A shop's usual rule of thumb: reorder when about five days of cover is
    // left. Deriving it from velocity keeps the threshold meaningful instead of
    // arbitrary.
    product.reorderLevel = Math.max(1, Math.ceil(velocity * 5));

    // Opening stock event, so the ledger accounts for every unit that sold.
    inventoryEvents.push({
      inventoryEventId: newInventoryEventId(),
      vendorId,
      productId: product.productId,
      productName: product.name,
      type: 'stock_in',
      quantityDelta: sold + product.stock,
      stockAfter: sold + product.stock,
      unitPrice: product.costPrice,
      note: 'Opening stock',
      timestamp: isoDaysAgo(HISTORY_DAYS + 1),
      source: 'seed',
    });
  }

  // Backfill running stock on each sale event, oldest first.
  const running = new Map<string, number>();
  for (const product of products) {
    running.set(product.productId, (unitsSold.get(product.name) ?? 0) + product.stock);
  }
  const saleEvents = inventoryEvents
    .filter((event) => event.type === 'sale')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const event of saleEvents) {
    const next = (running.get(event.productId) ?? 0) + event.quantityDelta;
    running.set(event.productId, next);
    event.stockAfter = next;
  }

  /* ── Customer roll-ups ─────────────────────────────────────────────────── */

  for (const customer of customers) {
    customer.outstanding = balances.get(customer.customerId) ?? 0;
    customer.totalSpent = spend.get(customer.customerId) ?? 0;
    customer.transactionCount = visits.get(customer.customerId) ?? 0;
    const seen = lastSeen.get(customer.customerId);
    if (seen) customer.lastInteractionAt = seen;
  }

  /* ── Orders ────────────────────────────────────────────────────────────── */

  const orders: Order[] = [];
  const orderCustomers = customers.slice(0, 8);
  for (let i = 0; i < 6; i += 1) {
    const customer = orderCustomers[i % orderCustomers.length]!;
    const product = productByName.get(pick(pool))!;
    const quantity = intBetween(1, 4);
    const createdAt = timestampFor(intBetween(0, 2));

    // Four ready, so the pulse card reads "4 orders are ready".
    const status = i < 4 ? 'ready' : i === 4 ? 'preparing' : 'placed';

    orders.push({
      orderId: newOrderId(),
      vendorId,
      customerId: customer.customerId,
      customerName: customer.name,
      items: [
        {
          productId: product.productId,
          name: product.name,
          quantity,
          unit: product.unit,
          unitPrice: product.sellingPrice,
          lineTotal: product.sellingPrice * quantity,
        },
      ],
      total: product.sellingPrice * quantity,
      status,
      note: '',
      ...(status === 'ready' ? { readyAt: createdAt } : {}),
      createdAt,
      updatedAt: createdAt,
    });
  }

  /* ── Write ─────────────────────────────────────────────────────────────── */

  const items = [
    ...customers.map(customerItem),
    ...products.map(productItem),
    ...transactions.map(transactionItem),
    ...payments.map(paymentItem),
    ...commitments.map(commitmentItem),
    ...orders.map(orderItem),
    ...inventoryEvents.map(inventoryEventItem),
  ];

  // Phone index rows, so the scanner's phone fallback works on seeded data.
  for (const customer of customers) {
    items.push({
      pk: `VENDOR#${vendorId}`,
      sk: `PHONEIDX#${customer.phone}`,
      entity: 'PhoneIndex',
      gsi1pk: `PHONE#${vendorId}#${customer.phone}`,
      gsi1sk: `CUSTOMER#${customer.customerId}`,
      vendorId,
      phone: customer.phone,
      customerId: customer.customerId,
    });
  }

  // DynamoDB caps a transaction at 100 items, so write in chunks. Batching
  // through transactWrite rather than individual puts matters more than it
  // looks: the local adapter persists the whole table on every write, so ~2,300
  // individual puts would rewrite the file 2,300 times.
  const CHUNK = 100;
  for (let i = 0; i < items.length; i += CHUNK) {
    await store.transactWrite(
      items.slice(i, i + CHUNK).map((item) => ({ kind: 'put' as const, item })),
    );
  }

  await refreshSalesVelocity(vendorId);

  const counts = {
    customers: customers.length,
    products: products.length,
    transactions: transactions.length,
    payments: payments.length,
    commitments: commitments.length,
    orders: orders.length,
    inventoryEvents: inventoryEvents.length,
  };

  return {
    vendorId,
    counts,
    demoLogin:
      config.auth.mode === 'local'
        ? { email: config.demo.email, password: config.demo.password }
        : null,
  };
}

/* --------------------------------------------------------------------- CLI */

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const empty = process.argv.includes('--empty');

  console.log('\n  Seeding Sharma Stores…\n');

  if (config.database.mode === 'local') {
    setStore(new LocalStore(config.database.localDir));
    console.log(`  Store: local file (${config.database.localDir}/table.json)`);
  } else {
    console.log(`  Store: DynamoDB table "${config.database.tableName}" in ${config.region}`);
  }

  const result = await seedDemoShop({ reset, empty });

  console.log('');
  for (const [name, count] of Object.entries(result.counts)) {
    if (count > 0) console.log(`    ${String(count).padStart(4)}  ${name}`);
  }

  const outstanding = await import('../src/services/repository').then(({ commitments }) =>
    commitments.list(result.vendorId),
  );
  const owed = outstanding
    .filter((entry) => entry.status === 'open')
    .reduce((sum, entry) => sum + entry.amount - entry.settledAmount, 0);

  console.log(`\n  Shop: Sharma Stores (${result.vendorId})`);
  if (empty) {
    console.log('  No customers, products or sales - the shop starts blank.');
  } else {
    console.log(`  Outstanding across customers: ₹${Math.round(owed / 100).toLocaleString('en-IN')}`);
  }

  if (result.demoLogin) {
    console.log(`\n  Sign in with:`);
    console.log(`    ${result.demoLogin.email}`);
    console.log(`    ${result.demoLogin.password}`);
  }
  console.log('');
}

// Only run when invoked directly, so the seeder can also be imported by tests.
const invokedDirectly = process.argv[1]?.includes('seed');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('\n  Seeding failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

// Silence the unused import warning for keys, which documents the key shapes
// used by the raw phone-index rows above.
void keys;
