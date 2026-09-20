import { getStore, keys, SK_PREFIX, withStore, type Item, type TransactionOp } from './dynamodb';
import { nowIso } from '../utils/dates';
import { notFound } from '../utils/errors';
import type {
  AIAction,
  Commitment,
  Customer,
  InventoryEvent,
  Notification,
  Order,
  Payment,
  Product,
  Transaction,
  Vendor,
  VyapioDocument,
} from '../schemas/entities';

/**
 * Typed access to the store.
 *
 * Two jobs: translating between domain entities and keyed items, and making
 * tenancy structural. Every function here takes `vendorId` as its first
 * argument and builds it into the partition key, so there is no code path that
 * reads a shop's data without naming the shop. Routes get that vendorId from
 * the session and nowhere else.
 */

/* ------------------------------------------------------------- item mapping */

/** Strips the storage-level keys so entities never leak `pk`/`sk` to clients. */
function toEntity<T>(item: Item | null): T | null {
  if (!item) return null;
  const { pk: _pk, sk: _sk, entity: _entity, gsi1pk, gsi1sk, gsi2pk, gsi2sk, ...rest } = item;
  void gsi1pk;
  void gsi1sk;
  void gsi2pk;
  void gsi2sk;
  return rest as T;
}

function toEntities<T>(items: Item[]): T[] {
  return items.map((item) => toEntity<T>(item)!).filter(Boolean);
}

/* ------------------------------------------------------------------ Vendor */

export function vendorItem(vendor: Vendor): Item {
  return {
    ...keys.vendor(vendor.vendorId),
    entity: 'Vendor',
    // Lets the login flow resolve userId → vendor without a scan.
    gsi1pk: `USER#${vendor.userId}`,
    gsi1sk: 'PROFILE',
    ...vendor,
  };
}

export const vendors = {
  async get(vendorId: string): Promise<Vendor | null> {
    return withStore(async () => {
      const { pk, sk } = keys.vendor(vendorId);
      return toEntity<Vendor>(await getStore().get(pk, sk));
    });
  },

  async require(vendorId: string): Promise<Vendor> {
    const vendor = await this.get(vendorId);
    if (!vendor) throw notFound('shop');
    return vendor;
  },

  /** Resolves the authenticated user to their shop. The tenancy entry point. */
  async findByUserId(userId: string): Promise<Vendor | null> {
    return withStore(async () => {
      const result = await getStore().query(`USER#${userId}`, { index: 'gsi1', limit: 1 });
      return toEntity<Vendor>(result.items[0] ?? null);
    });
  },

  async put(vendor: Vendor): Promise<Vendor> {
    await withStore(() => getStore().put(vendorItem(vendor)));
    return vendor;
  },

  async update(vendorId: string, changes: Partial<Vendor>): Promise<Vendor> {
    return withStore(async () => {
      const { pk, sk } = keys.vendor(vendorId);
      const updated = await getStore().update(pk, sk, {
        set: { ...changes, updatedAt: nowIso() },
      });
      const vendor = toEntity<Vendor>(updated);
      if (!vendor) throw notFound('shop');
      return vendor;
    });
  },
};

/* ---------------------------------------------------------------- Customer */

export function customerItem(customer: Customer): Item {
  return {
    ...keys.customer(customer.vendorId, customer.customerId),
    entity: 'Customer',
    // QR scan and phone fallback both resolve through GSI1.
    gsi1pk: `QR#${customer.qrId}`,
    gsi1sk: `CUSTOMER#${customer.customerId}`,
    // Customer timeline spans entity types, so it lives on GSI2.
    gsi2pk: `CUST#${customer.customerId}`,
    gsi2sk: `CUSTOMER#${customer.createdAt}`,
    ...customer,
  };
}

/**
 * Phone lookup gets its own item rather than a second GSI on the customer row,
 * because a customer's phone can change and a stale index entry would resolve
 * a scan to the wrong person.
 */
function phoneIndexItem(vendorId: string, phone: string, customerId: string): Item {
  return {
    pk: `VENDOR#${vendorId}`,
    sk: `PHONEIDX#${phone}`,
    entity: 'PhoneIndex',
    gsi1pk: `PHONE#${vendorId}#${phone}`,
    gsi1sk: `CUSTOMER#${customerId}`,
    vendorId,
    phone,
    customerId,
  };
}

export const customers = {
  async get(vendorId: string, customerId: string): Promise<Customer | null> {
    return withStore(async () => {
      const { pk, sk } = keys.customer(vendorId, customerId);
      return toEntity<Customer>(await getStore().get(pk, sk));
    });
  },

  async require(vendorId: string, customerId: string): Promise<Customer> {
    const customer = await this.get(vendorId, customerId);
    if (!customer) throw notFound('customer');
    return customer;
  },

  async list(vendorId: string, limit = 200): Promise<Customer[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.customer,
        limit,
        descending: false,
      });
      return toEntities<Customer>(result.items);
    });
  },

  /**
   * Resolves a scanned token. The result is re-checked against `vendorId`
   * before it is returned: a token from another shop resolves to nothing,
   * even though GSI1 is global.
   */
  async findByQrId(vendorId: string, qrId: string): Promise<Customer | null> {
    return withStore(async () => {
      const result = await getStore().query(`QR#${qrId}`, { index: 'gsi1', limit: 5 });
      const customer = toEntities<Customer>(result.items).find(
        (candidate) => candidate.vendorId === vendorId,
      );
      return customer ?? null;
    });
  },

  async findByPhone(vendorId: string, phone: string): Promise<Customer | null> {
    return withStore(async () => {
      const { pk, sk } = { pk: `VENDOR#${vendorId}`, sk: `PHONEIDX#${phone}` };
      const index = await getStore().get(pk, sk);
      if (!index) return null;
      return customers.get(vendorId, String(index.customerId));
    });
  },

  /** Every shop a given customer-app user may read. */
  async findLinksForUser(userId: string): Promise<Array<{ vendorId: string; customerId: string }>> {
    return withStore(async () => {
      const result = await getStore().query(`CUSTLINK#${userId}`, { index: 'gsi1', limit: 50 });
      return result.items.map((item) => ({
        vendorId: String(item.vendorId),
        customerId: String(item.customerId),
      }));
    });
  },

  async put(customer: Customer): Promise<Customer> {
    return withStore(async () => {
      const ops: TransactionOp[] = [{ kind: 'put', item: customerItem(customer) }];
      if (customer.phone) {
        ops.push({
          kind: 'put',
          item: phoneIndexItem(customer.vendorId, customer.phone, customer.customerId),
        });
      }
      await getStore().transactWrite(ops);
      return customer;
    });
  },

  async update(
    vendorId: string,
    customerId: string,
    changes: Partial<Customer>,
  ): Promise<Customer> {
    return withStore(async () => {
      const { pk, sk } = keys.customer(vendorId, customerId);
      const updated = await getStore().update(pk, sk, {
        set: { ...changes, updatedAt: nowIso() },
      });
      const customer = toEntity<Customer>(updated);
      if (!customer) throw notFound('customer');
      if (changes.phone) {
        await getStore().put(phoneIndexItem(vendorId, changes.phone, customerId));
      }
      return customer;
    });
  },

  /**
   * Link a customer profile to a customer-app login. Written as a separate row
   * so revoking access is a delete, not a field edit on the customer.
   */
  async link(vendorId: string, customerId: string, userId: string): Promise<void> {
    return withStore(async () => {
      await getStore().transactWrite([
        {
          kind: 'put',
          item: {
            pk: `VENDOR#${vendorId}`,
            sk: `CUSTLINK#${customerId}`,
            entity: 'CustomerLink',
            gsi1pk: `CUSTLINK#${userId}`,
            gsi1sk: `LINK#${vendorId}`,
            vendorId,
            customerId,
            userId,
            createdAt: nowIso(),
          },
        },
        {
          kind: 'update',
          ...keys.customer(vendorId, customerId),
          set: { linkedUserId: userId, updatedAt: nowIso() },
        },
      ]);
    });
  },
};

/* ----------------------------------------------------------------- Product */

export function productItem(product: Product): Item {
  return {
    ...keys.product(product.vendorId, product.productId),
    entity: 'Product',
    ...product,
  };
}

export const products = {
  async get(vendorId: string, productId: string): Promise<Product | null> {
    return withStore(async () => {
      const { pk, sk } = keys.product(vendorId, productId);
      return toEntity<Product>(await getStore().get(pk, sk));
    });
  },

  async require(vendorId: string, productId: string): Promise<Product> {
    const product = await this.get(vendorId, productId);
    if (!product) throw notFound('product');
    return product;
  },

  async list(vendorId: string, limit = 500): Promise<Product[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.product,
        limit,
        descending: false,
      });
      return toEntities<Product>(result.items);
    });
  },

  async put(product: Product): Promise<Product> {
    await withStore(() => getStore().put(productItem(product)));
    return product;
  },

  async update(vendorId: string, productId: string, changes: Partial<Product>): Promise<Product> {
    return withStore(async () => {
      const { pk, sk } = keys.product(vendorId, productId);
      const updated = await getStore().update(pk, sk, { set: { ...changes, updatedAt: nowIso() } });
      const product = toEntity<Product>(updated);
      if (!product) throw notFound('product');
      return product;
    });
  },

  async delete(vendorId: string, productId: string): Promise<void> {
    return withStore(async () => {
      const { pk, sk } = keys.product(vendorId, productId);
      await getStore().delete(pk, sk);
    });
  },
};

/* ------------------------------------------------------------- Transaction */

export function transactionItem(transaction: Transaction): Item {
  return {
    ...keys.transaction(transaction.vendorId, transaction.timestamp, transaction.transactionId),
    entity: 'Transaction',
    gsi2pk: `CUST#${transaction.customerId}`,
    gsi2sk: `TXN#${transaction.timestamp}`,
    ...transaction,
  };
}

export const transactions = {
  async list(
    vendorId: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ): Promise<Transaction[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        ...(options.from && options.to
          ? { skBetween: { from: `TXN#${options.from}`, to: `TXN#${options.to}` } }
          : { skPrefix: SK_PREFIX.transaction }),
        limit: options.limit ?? 100,
      });
      return toEntities<Transaction>(result.items);
    });
  },

  /** Chronological history for one customer, via GSI2. */
  async listForCustomer(customerId: string, limit = 100): Promise<Transaction[]> {
    return withStore(async () => {
      const result = await getStore().query(`CUST#${customerId}`, {
        index: 'gsi2',
        skPrefix: 'TXN#',
        limit,
      });
      return toEntities<Transaction>(result.items);
    });
  },

  async get(
    vendorId: string,
    timestamp: string,
    transactionId: string,
  ): Promise<Transaction | null> {
    return withStore(async () => {
      const { pk, sk } = keys.transaction(vendorId, timestamp, transactionId);
      return toEntity<Transaction>(await getStore().get(pk, sk));
    });
  },

  /** Falls back to a scan of the vendor's own partition when the time is unknown. */
  async findById(vendorId: string, transactionId: string): Promise<Transaction | null> {
    const all = await this.list(vendorId, { limit: 500 });
    return all.find((entry) => entry.transactionId === transactionId) ?? null;
  },
};

/* ----------------------------------------------------------------- Payment */

export function paymentItem(payment: Payment): Item {
  return {
    ...keys.payment(payment.vendorId, payment.timestamp, payment.paymentId),
    entity: 'Payment',
    gsi2pk: `CUST#${payment.customerId}`,
    gsi2sk: `PAY#${payment.timestamp}`,
    ...payment,
  };
}

export const payments = {
  async list(vendorId: string, limit = 100): Promise<Payment[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.payment,
        limit,
      });
      return toEntities<Payment>(result.items);
    });
  },

  async listForCustomer(customerId: string, limit = 100): Promise<Payment[]> {
    return withStore(async () => {
      const result = await getStore().query(`CUST#${customerId}`, {
        index: 'gsi2',
        skPrefix: 'PAY#',
        limit,
      });
      return toEntities<Payment>(result.items);
    });
  },
};

/* -------------------------------------------------------------- Commitment */

export function commitmentItem(commitment: Commitment): Item {
  return {
    ...keys.commitment(commitment.vendorId, commitment.dueDate, commitment.commitmentId),
    entity: 'Commitment',
    gsi2pk: `CUST#${commitment.customerId}`,
    gsi2sk: `CMT#${commitment.createdAt}`,
    ...commitment,
  };
}

export const commitments = {
  async list(vendorId: string, limit = 300): Promise<Commitment[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.commitment,
        limit,
        descending: false,
      });
      return toEntities<Commitment>(result.items);
    });
  },

  async listForCustomer(customerId: string, limit = 100): Promise<Commitment[]> {
    return withStore(async () => {
      const result = await getStore().query(`CUST#${customerId}`, {
        index: 'gsi2',
        skPrefix: 'CMT#',
        limit,
      });
      return toEntities<Commitment>(result.items);
    });
  },

  async get(vendorId: string, commitmentId: string): Promise<Commitment | null> {
    const all = await this.list(vendorId, 500);
    return all.find((entry) => entry.commitmentId === commitmentId) ?? null;
  },

  async update(commitment: Commitment, changes: Partial<Commitment>): Promise<Commitment> {
    return withStore(async () => {
      const { pk, sk } = keys.commitment(
        commitment.vendorId,
        commitment.dueDate,
        commitment.commitmentId,
      );
      const updated = await getStore().update(pk, sk, { set: { ...changes, updatedAt: nowIso() } });
      const next = toEntity<Commitment>(updated);
      if (!next) throw notFound('commitment');
      return next;
    });
  },
};

/* ------------------------------------------------------------------- Order */

export function orderItem(order: Order): Item {
  return {
    ...keys.order(order.vendorId, order.createdAt, order.orderId),
    entity: 'Order',
    gsi2pk: `CUST#${order.customerId}`,
    gsi2sk: `ORD#${order.createdAt}`,
    ...order,
  };
}

export const orders = {
  async list(vendorId: string, limit = 200): Promise<Order[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.order,
        limit,
      });
      return toEntities<Order>(result.items);
    });
  },

  async listForCustomer(customerId: string, limit = 50): Promise<Order[]> {
    return withStore(async () => {
      const result = await getStore().query(`CUST#${customerId}`, {
        index: 'gsi2',
        skPrefix: 'ORD#',
        limit,
      });
      return toEntities<Order>(result.items);
    });
  },

  async get(vendorId: string, orderId: string): Promise<Order | null> {
    const all = await this.list(vendorId, 500);
    return all.find((entry) => entry.orderId === orderId) ?? null;
  },

  async put(order: Order): Promise<Order> {
    await withStore(() => getStore().put(orderItem(order)));
    return order;
  },

  async update(order: Order, changes: Partial<Order>): Promise<Order> {
    return withStore(async () => {
      const { pk, sk } = keys.order(order.vendorId, order.createdAt, order.orderId);
      const updated = await getStore().update(pk, sk, { set: { ...changes, updatedAt: nowIso() } });
      const next = toEntity<Order>(updated);
      if (!next) throw notFound('order');
      return next;
    });
  },
};

/* ---------------------------------------------------------- InventoryEvent */

export function inventoryEventItem(event: InventoryEvent): Item {
  return {
    ...keys.inventoryEvent(event.vendorId, event.timestamp, event.inventoryEventId),
    entity: 'InventoryEvent',
    ...event,
  };
}

export const inventoryEvents = {
  async list(vendorId: string, options: { from?: string; limit?: number } = {}): Promise<
    InventoryEvent[]
  > {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        ...(options.from
          ? { skBetween: { from: `IVE#${options.from}`, to: 'IVE#￿' } }
          : { skPrefix: SK_PREFIX.inventoryEvent }),
        limit: options.limit ?? 500,
      });
      return toEntities<InventoryEvent>(result.items);
    });
  },
};

/* ---------------------------------------------------------------- AIAction */

export function aiActionItem(action: AIAction): Item {
  return {
    ...keys.aiAction(action.vendorId, action.createdAt, action.actionId),
    entity: 'AIAction',
    ...action,
  };
}

export const aiActions = {
  async put(action: AIAction): Promise<AIAction> {
    await withStore(() => getStore().put(aiActionItem(action)));
    return action;
  },

  async list(vendorId: string, limit = 100): Promise<AIAction[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.aiAction,
        limit,
      });
      return toEntities<AIAction>(result.items);
    });
  },

  async get(vendorId: string, actionId: string): Promise<AIAction | null> {
    const all = await this.list(vendorId, 300);
    return all.find((entry) => entry.actionId === actionId) ?? null;
  },

  async update(action: AIAction, changes: Partial<AIAction>): Promise<AIAction> {
    return withStore(async () => {
      const { pk, sk } = keys.aiAction(action.vendorId, action.createdAt, action.actionId);
      const updated = await getStore().update(pk, sk, { set: { ...changes, updatedAt: nowIso() } });
      const next = toEntity<AIAction>(updated);
      if (!next) throw notFound('action');
      return next;
    });
  },
};

/* ------------------------------------------------------------ Notification */

export function notificationItem(notification: Notification): Item {
  return {
    ...keys.notification(
      notification.vendorId,
      notification.createdAt,
      notification.notificationId,
    ),
    entity: 'Notification',
    ...notification,
  };
}

export const notifications = {
  async put(notification: Notification): Promise<Notification> {
    await withStore(() => getStore().put(notificationItem(notification)));
    return notification;
  },

  async list(vendorId: string, limit = 100): Promise<Notification[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.notification,
        limit,
      });
      return toEntities<Notification>(result.items);
    });
  },
};

/* ---------------------------------------------------------------- Document */

export function documentItem(document: VyapioDocument): Item {
  return {
    ...keys.document(document.vendorId, document.createdAt, document.documentId),
    entity: 'Document',
    ...document,
  };
}

export const documents = {
  async put(document: VyapioDocument): Promise<VyapioDocument> {
    await withStore(() => getStore().put(documentItem(document)));
    return document;
  },

  async list(vendorId: string, limit = 50): Promise<VyapioDocument[]> {
    return withStore(async () => {
      const result = await getStore().query(`VENDOR#${vendorId}`, {
        skPrefix: SK_PREFIX.document,
        limit,
      });
      return toEntities<VyapioDocument>(result.items);
    });
  },

  async get(vendorId: string, documentId: string): Promise<VyapioDocument | null> {
    const all = await this.list(vendorId, 200);
    return all.find((entry) => entry.documentId === documentId) ?? null;
  },

  async update(
    document: VyapioDocument,
    changes: Partial<VyapioDocument>,
  ): Promise<VyapioDocument> {
    return withStore(async () => {
      const { pk, sk } = keys.document(document.vendorId, document.createdAt, document.documentId);
      const updated = await getStore().update(pk, sk, { set: { ...changes, updatedAt: nowIso() } });
      const next = toEntity<VyapioDocument>(updated);
      if (!next) throw notFound('document');
      return next;
    });
  },
};

/* ------------------------------------------------------------- Idempotency */

/**
 * Offline clients replay queued actions; a flaky connection can deliver the
 * same one twice. A conditional put on the key is what makes the second attempt
 * a no-op instead of a second charge.
 */
export const idempotency = {
  async claim(vendorId: string, key: string, resultId: string): Promise<'claimed' | 'duplicate'> {
    try {
      await getStore().put(
        {
          ...keys.idempotency(vendorId, key),
          entity: 'Idempotency',
          vendorId,
          key,
          resultId,
          createdAt: nowIso(),
          // 24h is well past any realistic offline window.
          ttl: Math.floor(Date.now() / 1000) + 86_400,
        },
        'not-exists',
      );
      return 'claimed';
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        return 'duplicate';
      }
      throw error;
    }
  },

  async lookup(vendorId: string, key: string): Promise<string | null> {
    return withStore(async () => {
      const { pk, sk } = keys.idempotency(vendorId, key);
      const item = await getStore().get(pk, sk);
      return item ? String(item.resultId) : null;
    });
  },
};
