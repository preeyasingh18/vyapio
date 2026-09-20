import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from '../config/index';
import { AppError, toAppError } from '../utils/errors';
import { LocalStore } from './localStore';

/**
 * The data layer.
 *
 * ── Single-table design ──────────────────────────────────────────────────────
 *
 * One table, `pk` / `sk`, plus two global secondary indexes. Every shop-owned
 * item has `pk = VENDOR#<vendorId>`, which makes tenant isolation a property of
 * the key schema rather than of remembering to add a filter: a query for one
 * vendor physically cannot return another vendor's rows.
 *
 *   ENTITY            pk                      sk
 *   ─────────────────────────────────────────────────────────────────────────
 *   Vendor            VENDOR#<id>             PROFILE
 *   Customer          VENDOR#<id>             CUSTOMER#<customerId>
 *   Product           VENDOR#<id>             PRODUCT#<productId>
 *   Transaction       VENDOR#<id>             TXN#<timestamp>#<txnId>
 *   Payment           VENDOR#<id>             PAY#<timestamp>#<payId>
 *   Commitment        VENDOR#<id>             CMT#<dueDate>#<cmtId>
 *   Order             VENDOR#<id>             ORD#<createdAt>#<orderId>
 *   InventoryEvent    VENDOR#<id>             IVE#<timestamp>#<eventId>
 *   AIAction          VENDOR#<id>             ACT#<createdAt>#<actionId>
 *   Notification      VENDOR#<id>             NTF#<createdAt>#<notifId>
 *   Document          VENDOR#<id>             DOC#<createdAt>#<docId>
 *   Idempotency       VENDOR#<id>             IDEM#<key>
 *
 * Sort keys embed an ISO timestamp, which sorts lexicographically — so "the
 * last 20 transactions" is a single backwards Query with no filter and no sort.
 *
 *   GSI1 (gsi1pk / gsi1sk) — lookups that cut across the partition:
 *     USER#<userId>            → PROFILE            (login → vendor)
 *     QR#<qrId>                → CUSTOMER#<id>      (scan → customer)
 *     PHONE#<vendorId>#<phone> → CUSTOMER#<id>      (phone fallback)
 *     CUSTLINK#<userId>        → LINK#<vendorId>    (customer app → shops)
 *
 *   GSI2 (gsi2pk / gsi2sk) — the customer timeline, which spans entity types:
 *     CUST#<customerId>        → <type>#<timestamp>
 *
 * ── Local mode ───────────────────────────────────────────────────────────────
 *
 * When DYNAMODB_TABLE_NAME is unset, LocalStore implements the same six
 * primitives over a JSON file. Identical key shapes, identical query semantics,
 * so the code above this layer cannot tell the difference — and neither can the
 * tests, which is what makes tenant-isolation tests meaningful offline.
 */

export type Item = Record<string, unknown> & {
  pk: string;
  sk: string;
  entity: string;
  gsi1pk?: string;
  gsi1sk?: string;
  gsi2pk?: string;
  gsi2sk?: string;
};

export type QueryOptions = {
  /** Restricts to sort keys starting with this prefix. */
  skPrefix?: string;
  /** Inclusive lower / exclusive upper bound on the sort key. */
  skBetween?: { from: string; to: string };
  limit?: number;
  /** Newest first. Default true, because every screen wants recent rows. */
  descending?: boolean;
  cursor?: string;
  index?: 'gsi1' | 'gsi2';
};

export type QueryResult = {
  items: Item[];
  cursor: string | null;
};

export type TransactionOp =
  | { kind: 'put'; item: Item; condition?: 'not-exists' }
  | { kind: 'delete'; pk: string; sk: string }
  | {
      kind: 'update';
      pk: string;
      sk: string;
      /** Numeric fields to add to (negative subtracts). */
      add?: Record<string, number>;
      /** Fields to overwrite. */
      set?: Record<string, unknown>;
    };

/* -------------------------------------------------------------- Key helpers */

export const keys = {
  vendor: (vendorId: string) => ({ pk: `VENDOR#${vendorId}`, sk: 'PROFILE' }),
  customer: (vendorId: string, customerId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `CUSTOMER#${customerId}`,
  }),
  product: (vendorId: string, productId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `PRODUCT#${productId}`,
  }),
  transaction: (vendorId: string, timestamp: string, transactionId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `TXN#${timestamp}#${transactionId}`,
  }),
  payment: (vendorId: string, timestamp: string, paymentId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `PAY#${timestamp}#${paymentId}`,
  }),
  commitment: (vendorId: string, dueDate: string, commitmentId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `CMT#${dueDate}#${commitmentId}`,
  }),
  order: (vendorId: string, createdAt: string, orderId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `ORD#${createdAt}#${orderId}`,
  }),
  inventoryEvent: (vendorId: string, timestamp: string, eventId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `IVE#${timestamp}#${eventId}`,
  }),
  aiAction: (vendorId: string, createdAt: string, actionId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `ACT#${createdAt}#${actionId}`,
  }),
  notification: (vendorId: string, createdAt: string, notificationId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `NTF#${createdAt}#${notificationId}`,
  }),
  document: (vendorId: string, createdAt: string, documentId: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `DOC#${createdAt}#${documentId}`,
  }),
  idempotency: (vendorId: string, key: string) => ({
    pk: `VENDOR#${vendorId}`,
    sk: `IDEM#${key}`,
  }),
  /** Local-auth user records live in their own partition, outside any tenant. */
  localUser: (email: string) => ({ pk: `AUTHUSER#${email.toLowerCase()}`, sk: 'PROFILE' }),
  /**
   * A signup waiting on its verification code.
   *
   * Beside the user record rather than in a table of its own: same single-table
   * design, same partition per address, and the two can never disagree about
   * whether an account exists because only one of them is ever written.
   */
  pendingSignup: (email: string) => ({
    pk: `AUTHUSER#${email.toLowerCase()}`,
    sk: 'PENDING_SIGNUP',
  }),
} as const;

export const SK_PREFIX = {
  customer: 'CUSTOMER#',
  product: 'PRODUCT#',
  transaction: 'TXN#',
  payment: 'PAY#',
  commitment: 'CMT#',
  order: 'ORD#',
  inventoryEvent: 'IVE#',
  aiAction: 'ACT#',
  notification: 'NTF#',
  document: 'DOC#',
} as const;

/* ----------------------------------------------------------------- Adapters */

export interface StoreAdapter {
  get(pk: string, sk: string): Promise<Item | null>;
  put(item: Item, condition?: 'not-exists'): Promise<void>;
  update(
    pk: string,
    sk: string,
    changes: { add?: Record<string, number>; set?: Record<string, unknown> },
  ): Promise<Item | null>;
  delete(pk: string, sk: string): Promise<void>;
  query(pk: string, options?: QueryOptions): Promise<QueryResult>;
  transactWrite(ops: TransactionOp[]): Promise<void>;
}

const INDEX_KEYS = {
  gsi1: { pk: 'gsi1pk', sk: 'gsi1sk' },
  gsi2: { pk: 'gsi2pk', sk: 'gsi2sk' },
} as const;

class DynamoAdapter implements StoreAdapter {
  private readonly doc: DynamoDBDocumentClient;

  constructor(private readonly tableName: string) {
    const client = new DynamoDBClient({
      region: config.region,
      maxAttempts: 4,
      /**
       * A local endpoint when one is configured, the real service otherwise.
       *
       * DynamoDB Local rejects anonymous calls, so dummy credentials are
       * supplied alongside it — it validates their shape, never their value.
       * Without this the SDK looks for real credentials and fails before it
       * ever reaches the container.
       */
      ...(config.database.endpoint
        ? {
            endpoint: config.database.endpoint,
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : {}),
    });
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk, sk } }),
    );
    return (result.Item as Item | undefined) ?? null;
  }

  async put(item: Item, condition?: 'not-exists'): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ...(condition === 'not-exists'
          ? { ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' }
          : {}),
      }),
    );
  }

  async update(
    pk: string,
    sk: string,
    changes: { add?: Record<string, number>; set?: Record<string, unknown> },
  ): Promise<Item | null> {
    const { expression, names, values } = buildUpdateExpression(changes);
    if (!expression) return this.get(pk, sk);

    const result = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (result.Attributes as Item | undefined) ?? null;
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { pk, sk } }));
  }

  async query(pk: string, options: QueryOptions = {}): Promise<QueryResult> {
    const index = options.index;
    const keyNames = index ? INDEX_KEYS[index] : { pk: 'pk', sk: 'sk' };

    const names: Record<string, string> = { '#pk': keyNames.pk };
    const values: Record<string, unknown> = { ':pk': pk };
    let condition = '#pk = :pk';

    if (options.skBetween) {
      names['#sk'] = keyNames.sk;
      values[':from'] = options.skBetween.from;
      values[':to'] = options.skBetween.to;
      condition += ' AND #sk BETWEEN :from AND :to';
    } else if (options.skPrefix) {
      names['#sk'] = keyNames.sk;
      values[':prefix'] = options.skPrefix;
      condition += ' AND begins_with(#sk, :prefix)';
    }

    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        ...(index ? { IndexName: index } : {}),
        KeyConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: options.descending === false,
        Limit: options.limit,
        ...(options.cursor ? { ExclusiveStartKey: decodeCursor(options.cursor) } : {}),
      }),
    );

    return {
      items: (result.Items as Item[] | undefined) ?? [],
      cursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : null,
    };
  }

  async transactWrite(ops: TransactionOp[]): Promise<void> {
    if (ops.length === 0) return;
    if (ops.length > 100) {
      throw new AppError('BAD_REQUEST', `Transaction too large: ${ops.length} operations`);
    }

    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: ops.map((op) => {
          if (op.kind === 'put') {
            return {
              Put: {
                TableName: this.tableName,
                Item: op.item,
                ...(op.condition === 'not-exists'
                  ? { ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' }
                  : {}),
              },
            };
          }
          if (op.kind === 'delete') {
            return { Delete: { TableName: this.tableName, Key: { pk: op.pk, sk: op.sk } } };
          }
          const { expression, names, values } = buildUpdateExpression(op);
          return {
            Update: {
              TableName: this.tableName,
              Key: { pk: op.pk, sk: op.sk },
              UpdateExpression: expression,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          };
        }),
      }),
    );
  }
}

/**
 * Builds an `ADD`/`SET` update expression.
 *
 * `add` compiles to DynamoDB's atomic ADD, which is what keeps a customer's
 * outstanding balance correct when two tills write at once — read-modify-write
 * in application code would lose one of them.
 */
function buildUpdateExpression(changes: {
  add?: Record<string, number>;
  set?: Record<string, unknown>;
}): { expression: string; names: Record<string, string>; values: Record<string, unknown> } {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setParts: string[] = [];
  const addParts: string[] = [];

  for (const [field, amount] of Object.entries(changes.add ?? {})) {
    const alias = `#a_${field.replace(/\W/g, '')}`;
    const valueAlias = `:a_${field.replace(/\W/g, '')}`;
    names[alias] = field;
    values[valueAlias] = amount;
    addParts.push(`${alias} ${valueAlias}`);
  }

  for (const [field, value] of Object.entries(changes.set ?? {})) {
    if (value === undefined) continue;
    const alias = `#s_${field.replace(/\W/g, '')}`;
    const valueAlias = `:s_${field.replace(/\W/g, '')}`;
    names[alias] = field;
    values[valueAlias] = value;
    setParts.push(`${alias} = ${valueAlias}`);
  }

  const clauses: string[] = [];
  if (setParts.length > 0) clauses.push(`SET ${setParts.join(', ')}`);
  if (addParts.length > 0) clauses.push(`ADD ${addParts.join(', ')}`);

  return { expression: clauses.join(' '), names, values };
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('BAD_REQUEST', 'Malformed pagination cursor');
  }
}

/* ------------------------------------------------------------------ Facade */

let adapter: StoreAdapter | null = null;

export function getStore(): StoreAdapter {
  if (adapter) return adapter;
  adapter =
    config.database.mode === 'aws'
      ? new DynamoAdapter(config.database.tableName)
      : new LocalStore(config.database.localDir);
  return adapter;
}

/** Test seam: swap in a fresh adapter between test cases. */
export function setStore(next: StoreAdapter | null): void {
  adapter = next;
}

/**
 * Wraps every store call so a raw AWS exception never escapes the data layer.
 * Callers see an AppError with a user-safe message; CloudWatch keeps the detail.
 */
export async function withStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') {
      throw new AppError('DATABASE_UNAVAILABLE', appError.message, { cause: error });
    }
    throw appError;
  }
}
