import {
  setStore,
  type Item,
  type QueryOptions,
  type QueryResult,
  type StoreAdapter,
  type TransactionOp,
} from '../src/services/dynamodb';
import { resetEventState } from '../src/services/events';
import { resetRateLimits } from '../src/middleware/errorHandler';
import { setProvider } from '../src/services/notifications';
import { handleRequest, type RawRequest } from '../src/app';
import { nowIso } from '../src/utils/dates';
import { newQrId, newVendorId, newCustomerId, newProductId } from '../src/utils/ids';
import { authService } from '../src/services/auth';
import { customers, products, vendors } from '../src/services/repository';
import type { Customer, Product, Vendor } from '../src/schemas/entities';

/**
 * In-memory StoreAdapter.
 *
 * LocalStore's logic without the file I/O, so each test starts from a clean
 * table instantly. It keeps the same key semantics, conditional-write failures
 * and all-or-nothing transactions — which is the part the tests depend on.
 */
export class MemoryStore implements StoreAdapter {
  private table = new Map<string, Item>();

  /** Matches LocalStore's composite key exactly. See services/localStore.ts. */
  private key(pk: string, sk: string): string {
    return JSON.stringify([pk, sk]);
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    return structuredClone(this.table.get(this.key(pk, sk)) ?? null);
  }

  async put(item: Item, condition?: 'not-exists'): Promise<void> {
    const key = this.key(item.pk, item.sk);
    if (condition === 'not-exists' && this.table.has(key)) throw conditionalFailure();
    this.table.set(key, structuredClone(item));
  }

  async update(
    pk: string,
    sk: string,
    changes: { add?: Record<string, number>; set?: Record<string, unknown> },
  ): Promise<Item | null> {
    const existing = this.table.get(this.key(pk, sk));
    if (!existing) throw conditionalFailure();
    apply(existing, changes);
    return structuredClone(existing);
  }

  async delete(pk: string, sk: string): Promise<void> {
    this.table.delete(this.key(pk, sk));
  }

  async query(pk: string, options: QueryOptions = {}): Promise<QueryResult> {
    const pkField =
      options.index === 'gsi1' ? 'gsi1pk' : options.index === 'gsi2' ? 'gsi2pk' : 'pk';
    const skField =
      options.index === 'gsi1' ? 'gsi1sk' : options.index === 'gsi2' ? 'gsi2sk' : 'sk';

    let rows = [...this.table.values()].filter((item) => item[pkField] === pk);

    if (options.skBetween) {
      rows = rows.filter((item) => {
        const value = String(item[skField] ?? '');
        return value >= options.skBetween!.from && value <= options.skBetween!.to;
      });
    } else if (options.skPrefix) {
      rows = rows.filter((item) => String(item[skField] ?? '').startsWith(options.skPrefix!));
    }

    rows.sort((a, b) => String(a[skField] ?? '').localeCompare(String(b[skField] ?? '')));
    if (options.descending !== false) rows.reverse();

    const limited = options.limit ? rows.slice(0, options.limit) : rows;
    return { items: structuredClone(limited), cursor: null };
  }

  async transactWrite(ops: TransactionOp[]): Promise<void> {
    // Staged against a clone, so a mid-batch failure leaves nothing behind.
    const staged = new Map(structuredClone([...this.table.entries()]));
    for (const op of ops) {
      if (op.kind === 'put') {
        const key = this.key(op.item.pk, op.item.sk);
        if (op.condition === 'not-exists' && staged.has(key)) throw conditionalFailure();
        staged.set(key, structuredClone(op.item));
      } else if (op.kind === 'delete') {
        staged.delete(this.key(op.pk, op.sk));
      } else {
        const target = staged.get(this.key(op.pk, op.sk));
        if (!target) throw conditionalFailure();
        apply(target, op);
      }
    }
    this.table = staged;
  }

  size(): number {
    return this.table.size;
  }
}

function apply(
  target: Item,
  changes: { add?: Record<string, number>; set?: Record<string, unknown> },
): void {
  for (const [field, amount] of Object.entries(changes.add ?? {})) {
    const current = typeof target[field] === 'number' ? (target[field]) : 0;
    target[field] = current + amount;
  }
  for (const [field, value] of Object.entries(changes.set ?? {})) {
    if (value !== undefined) target[field] = value;
  }
}

function conditionalFailure(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

/** Fresh store and clean middleware state between tests. */
export function resetWorld(): MemoryStore {
  const store = new MemoryStore();
  setStore(store);
  resetEventState();
  resetRateLimits();
  setProvider(null);
  return store;
}

/* ------------------------------------------------------------ HTTP helper */

export type TestResponse = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Drives a request through the real pipeline — routing, auth, validation,
 * error shaping — exactly as Lambda would. Tests therefore cover the middleware
 * as well as the handler.
 */
export async function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<TestResponse> {
  const raw: RawRequest = {
    method,
    path,
    query: options.query ?? {},
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    rawBody: options.body === undefined ? '' : JSON.stringify(options.body),
    sourceIp: '127.0.0.1',
  };
  const result = await handleRequest(raw);
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

/* ---------------------------------------------------------------- Fixtures */

export type TestShop = {
  vendor: Vendor;
  token: string;
  userId: string;
  customer: Customer;
  product: Product;
};

/** Counter behind the distinct phone numbers below. */
let shopCounter = 0;

/**
 * Creates an isolated shop with one customer and one product.
 *
 * Phone numbers are unique per shop. Sharing them across fixtures would make
 * cross-tenant lookup tests pass for the wrong reason — a shop resolving its
 * *own* customer who happens to have the same number.
 */
export async function createShop(options: {
  email: string;
  shopName: string;
  customerName?: string;
}): Promise<TestShop> {
  shopCounter += 1;
  const ownerPhone = `98000000${String(shopCounter).padStart(2, '0')}`;
  const customerPhone = `98111111${String(shopCounter).padStart(2, '0')}`;

  const userId = await authService.ensureLocalUser({
    email: options.email,
    password: 'Passw0rd!',
    name: 'Owner',
    phone: ownerPhone,
    role: 'SHOPKEEPER',
  });

  const vendor: Vendor = {
    vendorId: newVendorId(),
    userId,
    shopName: options.shopName,
    ownerName: 'Owner',
    phone: ownerPhone,
    email: options.email,
    category: 'kirana',
    city: 'Patna',
    language: 'en',
    voiceLanguage: 'hi',
    onboardingComplete: true,
    isDemo: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await vendors.put(vendor);

  const customer: Customer = {
    customerId: newCustomerId(),
    vendorId: vendor.vendorId,
    name: options.customerName ?? 'Ramesh Kumar',
    phone: customerPhone,
    email: '',
    qrId: newQrId(),
    outstanding: 0,
    totalSpent: 0,
    transactionCount: 0,
    notes: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await customers.put(customer);

  const product: Product = {
    productId: newProductId(),
    vendorId: vendor.vendorId,
    name: 'Rice',
    sku: 'RICE',
    category: 'staples',
    unit: 'kg',
    costPrice: 4800,
    sellingPrice: 6200,
    stock: 100,
    reorderLevel: 10,
    supplier: 'Shree Traders',
    purchaseDate: '',
    salesVelocity: 0,
    aliases: ['chawal'],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await products.put(product);

  const tokens = await authService.login(options.email, 'Passw0rd!');
  return { vendor, token: tokens.accessToken, userId, customer, product };
}
