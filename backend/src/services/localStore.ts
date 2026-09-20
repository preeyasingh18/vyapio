import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError } from '../utils/errors';
import type { Item, QueryOptions, QueryResult, StoreAdapter, TransactionOp } from './dynamodb';

/**
 * File-backed implementation of StoreAdapter.
 *
 * This exists so the entire product — auth, transactions, inventory, the agent,
 * tenant-isolation tests — runs on a laptop with no AWS account. It mirrors
 * DynamoDB's semantics closely enough that the layers above cannot tell which
 * one they are talking to:
 *
 *   • same composite key and GSI shapes
 *   • same `begins_with` / `BETWEEN` sort-key queries
 *   • same atomic ADD semantics for counters
 *   • same all-or-nothing transactWrite
 *   • same ConditionalCheckFailedException on a duplicate conditional put
 *
 * It is NOT a DynamoDB emulator and makes no attempt to be one: it is
 * single-process, loads the table into memory, and writes the whole file on
 * every mutation. That is fine for one shop's data on one machine, and the UI
 * always shows a "Local mode" badge so nobody mistakes it for the cloud.
 */

type Table = Record<string, Item>;

/**
 * Composite key for the in-memory map.
 *
 * JSON-encoding the pair keeps it unambiguous: no separator character can
 * collide, so `pk="A#B", sk="C"` and `pk="A", sk="B#C"` stay distinct. A
 * printable key also keeps the source and any dumps plain text.
 */
const rowKey = (pk: string, sk: string) => JSON.stringify([pk, sk]);

export class LocalStore implements StoreAdapter {
  private readonly file: string;
  private table: Table | null = null;

  constructor(directory: string) {
    this.file = resolve(process.cwd(), directory, 'table.json');
  }

  /* ------------------------------------------------------------ persistence */

  private load(): Table {
    if (this.table) return this.table;

    if (!existsSync(this.file)) {
      this.table = {};
      return this.table;
    }
    try {
      const raw = readFileSync(this.file, 'utf8');
      this.table = raw.trim().length > 0 ? (JSON.parse(raw) as Table) : {};
    } catch (error) {
      throw new AppError('DATABASE_UNAVAILABLE', `Local store is corrupt: ${String(error)}`, {
        userMessage:
          'The local data file could not be read. Delete .vyapio-data and re-run `npm run seed`.',
        cause: error,
      });
    }
    return this.table;
  }

  /**
   * Write to a temp file, then rename over the target. Rename is atomic on the
   * same filesystem, so an interrupted write cannot leave a half-written table.
   *
   * Windows complicates this: rename fails with EPERM or EBUSY if anything —
   * another Node process, an editor, a virus scanner — has the destination open
   * even momentarily. Retrying briefly clears the transient cases; a direct
   * write is the last resort, trading the atomicity guarantee for actually
   * saving the data, which is the right trade for a local dev store.
   */
  private flush(): void {
    const table = this.table ?? {};
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true });

    const payload = JSON.stringify(table, null, 0);
    const temp = join(directory, `.table.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, payload, 'utf8');

    const RETRIES = 5;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        renameSync(temp, this.file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
          rmSync(temp, { force: true });
          throw error;
        }
        // Short synchronous back-off: this runs inside a synchronous write
        // path, and the contention it is waiting out lasts milliseconds.
        const until = Date.now() + 20 * (attempt + 1);
        while (Date.now() < until) {
          /* spin */
        }
      }
    }

    try {
      writeFileSync(this.file, payload, 'utf8');
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /* --------------------------------------------------------------- reads */

  async get(pk: string, sk: string): Promise<Item | null> {
    return structuredClone(this.load()[rowKey(pk, sk)] ?? null);
  }

  async query(pk: string, options: QueryOptions = {}): Promise<QueryResult> {
    const table = this.load();
    const index = options.index;
    const pkField = index === 'gsi1' ? 'gsi1pk' : index === 'gsi2' ? 'gsi2pk' : 'pk';
    const skField = index === 'gsi1' ? 'gsi1sk' : index === 'gsi2' ? 'gsi2sk' : 'sk';

    let rows = Object.values(table).filter((item) => item[pkField] === pk);

    if (options.skBetween) {
      const { from, to } = options.skBetween;
      rows = rows.filter((item) => {
        const value = String(item[skField] ?? '');
        return value >= from && value <= to;
      });
    } else if (options.skPrefix) {
      rows = rows.filter((item) => String(item[skField] ?? '').startsWith(options.skPrefix!));
    }

    // Lexicographic sort on the range key, exactly as DynamoDB orders it.
    rows.sort((a, b) => {
      const left = String(a[skField] ?? '');
      const right = String(b[skField] ?? '');
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (options.descending !== false) rows.reverse();

    const start = options.cursor ? Number(Buffer.from(options.cursor, 'base64url').toString()) : 0;
    const limit = options.limit ?? rows.length;
    const page = rows.slice(start, start + limit);
    const nextIndex = start + limit;

    return {
      items: structuredClone(page),
      cursor:
        nextIndex < rows.length ? Buffer.from(String(nextIndex)).toString('base64url') : null,
    };
  }

  /* -------------------------------------------------------------- writes */

  async put(item: Item, condition?: 'not-exists'): Promise<void> {
    const table = this.load();
    const key = rowKey(item.pk, item.sk);
    if (condition === 'not-exists' && table[key]) {
      throw conditionalCheckFailed();
    }
    table[key] = structuredClone(item);
    this.flush();
  }

  async update(
    pk: string,
    sk: string,
    changes: { add?: Record<string, number>; set?: Record<string, unknown> },
  ): Promise<Item | null> {
    const table = this.load();
    const key = rowKey(pk, sk);
    const existing = table[key];
    if (!existing) throw conditionalCheckFailed();

    applyChanges(existing, changes);
    this.flush();
    return structuredClone(existing);
  }

  async delete(pk: string, sk: string): Promise<void> {
    const table = this.load();
    delete table[rowKey(pk, sk)];
    this.flush();
  }

  /**
   * All-or-nothing, like TransactWriteItems. Mutations are staged against a
   * clone and only swapped in once every operation has succeeded, so a failed
   * condition in the middle leaves the table untouched.
   */
  async transactWrite(ops: TransactionOp[]): Promise<void> {
    const table = this.load();
    const staged: Table = structuredClone(table);

    for (const op of ops) {
      if (op.kind === 'put') {
        const key = rowKey(op.item.pk, op.item.sk);
        if (op.condition === 'not-exists' && staged[key]) throw conditionalCheckFailed();
        staged[key] = structuredClone(op.item);
      } else if (op.kind === 'delete') {
        delete staged[rowKey(op.pk, op.sk)];
      } else {
        const key = rowKey(op.pk, op.sk);
        const target = staged[key];
        if (!target) throw conditionalCheckFailed();
        applyChanges(target, op);
      }
    }

    this.table = staged;
    this.flush();
  }

  /* ------------------------------------------------------------- test aid */

  /** Drops everything. Used by tests and by `npm run seed -- --reset`. */
  reset(): void {
    this.table = {};
    this.flush();
  }
}

function applyChanges(
  target: Item,
  changes: { add?: Record<string, number>; set?: Record<string, unknown> },
): void {
  for (const [field, amount] of Object.entries(changes.add ?? {})) {
    const current = typeof target[field] === 'number' ? (target[field]) : 0;
    target[field] = current + amount;
  }
  for (const [field, value] of Object.entries(changes.set ?? {})) {
    if (value === undefined) continue;
    target[field] = value;
  }
}

/**
 * Mirrors the AWS SDK error shape so `toAppError` maps it to the same CONFLICT
 * response in both modes — tests written against local behaviour stay true
 * against DynamoDB.
 */
function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}
