import { formatMoney } from '../utils/money';
import { daysBetween, lastNDaysRange, nowIso, withinRange } from '../utils/dates';
import { forbidden } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  commitments as commitmentRepo,
  customers as customerRepo,
  transactions as transactionRepo,
} from './repository';
import { getInventoryInsights } from './inventory';
import { currentlyPending, settlementByTransaction } from './ledger';
import type { AgentToolName } from '../schemas/ai';
import type { Commitment } from '../schemas/entities';

/**
 * The agent's tools.
 *
 * This file is the agent's entire reach. There is no "run a query" tool, no
 * passthrough to the repository, no way to name a table. Every tool:
 *
 *   • takes `vendorId` from the caller's session, never from the model;
 *   • is declared read-only or write, and write tools cannot execute here at
 *     all — `createReminder` *prepares* messages and returns them for approval;
 *   • validates its own arguments, because the arguments come from a model.
 *
 * An agent that can only read, count and draft is one whose worst failure is an
 * unhelpful answer rather than a wrongly emptied khata.
 */

export type ToolPermission = 'read' | 'prepare-write';

export type ToolDefinition = {
  name: AgentToolName;
  description: string;
  permission: ToolPermission;
  /** JSON schema for the model's arguments. */
  parameters: Record<string, unknown>;
};

export type ToolContext = {
  vendorId: string;
  userId: string;
  /** Tools the caller's role is allowed to invoke. */
  allowed: ReadonlySet<AgentToolName>;
};

export type ToolResult = {
  ok: boolean;
  /** Compact text handed back to the planner or model. */
  summary: string;
  /** Structured payload used to build proposals and citations. */
  data: Record<string, unknown>;
};

/* ------------------------------------------------------------- Definitions */

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'getCustomer',
    description: "Look up one customer's balance and recent activity by name.",
    permission: 'read',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Customer name or first name' } },
      required: ['name'],
    },
  },
  {
    name: 'searchCustomers',
    description: 'Find customers, optionally filtered by how much they owe.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional name fragment' },
        minOutstandingRupees: { type: 'number', description: 'Only customers owing at least this' },
        overdueOnly: { type: 'boolean', description: 'Only customers past their due date' },
      },
    },
  },
  {
    name: 'getTransactions',
    description: 'List recent sales, optionally for one customer or a number of days.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string' },
        days: { type: 'number', description: 'How many days back to look' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'getOutstandingPayments',
    description: 'List unpaid balances with due dates and how overdue they are.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        minAmountRupees: { type: 'number' },
        overdueOnly: { type: 'boolean' },
      },
    },
  },
  {
    name: 'getInventory',
    description: 'Current stock with sales velocity and days of cover remaining.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: { lowStockOnly: { type: 'boolean' } },
    },
  },
  {
    name: 'getSalesSummary',
    description: 'Totals for a period: revenue, number of sales, amount still pending.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Defaults to 1 (today)' } },
    },
  },
  {
    name: 'prepareRestockList',
    description: 'Draft a restock list for products running low. Does not order anything.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: { daysOfCover: { type: 'number', description: 'Target days of stock' } },
    },
  },
  {
    name: 'createReminder',
    description:
      'Draft payment reminder messages for customers who owe money. Returns drafts for approval — sends nothing.',
    permission: 'prepare-write',
    parameters: {
      type: 'object',
      properties: {
        minAmountRupees: { type: 'number' },
        overdueOnly: { type: 'boolean' },
        customerNames: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];

/** Shopkeepers get every tool; customer-app sessions get none of them. */
export const SHOPKEEPER_TOOLS: ReadonlySet<AgentToolName> = new Set(
  TOOL_DEFINITIONS.map((definition) => definition.name),
);
export const CUSTOMER_TOOLS: ReadonlySet<AgentToolName> = new Set<AgentToolName>();

/* ------------------------------------------------------------ Arg coercion */

/** Model arguments are untyped input. Coerce defensively, never trust shapes. */
function num(value: unknown, fallback: number | null = null): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function flag(value: unknown): boolean {
  return value === true || value === 'true';
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/* -------------------------------------------------------------- Execution */

export async function runTool(
  name: AgentToolName,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  // The authorization gate. A model naming a tool it was not granted gets a
  // refusal, not the data.
  if (!context.allowed.has(name)) {
    logger.warn('agent tool denied', {
      operation: 'agent.runTool',
      vendorId: context.vendorId,
      userId: context.userId,
      tool: name,
    });
    throw forbidden(`Agent is not permitted to use ${name}`, { tool: name });
  }

  const startedAt = Date.now();
  const result = await dispatch(name, args, context);

  logger.info('agent tool executed', {
    operation: 'agent.runTool',
    vendorId: context.vendorId,
    userId: context.userId,
    tool: name,
    durationMs: Date.now() - startedAt,
    ok: result.ok,
  });

  return result;
}

/**
 * Keep every commitment belonging to customers whose RUNNING BALANCE reaches
 * `minAmountRupees`.
 *
 * "Customers who owe more than ₹1000" is a claim about a person, not about a
 * single bill. A khata is many small entries — filtering per commitment
 * answers "nobody" for a shop where nine customers are over the threshold.
 */
function withBalanceAtLeast(open: Commitment[], minAmountRupees: number): Commitment[] {
  if (minAmountRupees <= 0) return open;

  const owedPerCustomer = new Map<string, number>();
  for (const commitment of open) {
    const remaining = commitment.amount - commitment.settledAmount;
    owedPerCustomer.set(
      commitment.customerId,
      (owedPerCustomer.get(commitment.customerId) ?? 0) + remaining,
    );
  }

  const threshold = minAmountRupees * 100;
  return open.filter((commitment) => (owedPerCustomer.get(commitment.customerId) ?? 0) >= threshold);
}

async function dispatch(
  name: AgentToolName,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const { vendorId } = context;

  switch (name) {
    case 'getCustomer': {
      const query = str(args.name);
      if (!query) return { ok: false, summary: 'No customer name was given.', data: {} };

      const all = await customerRepo.list(vendorId);
      const lower = query.toLowerCase();
      const matches = all.filter(
        (customer) =>
          customer.name.toLowerCase() === lower ||
          customer.name.toLowerCase().startsWith(lower) ||
          customer.name.toLowerCase().split(/\s+/)[0] === lower,
      );

      if (matches.length === 0) {
        return { ok: false, summary: `No customer called ${query}.`, data: { matches: [] } };
      }
      if (matches.length > 1) {
        return {
          ok: true,
          summary: `${matches.length} customers match "${query}": ${matches.map((c) => c.name).join(', ')}.`,
          data: { matches: matches.map((c) => ({ customerId: c.customerId, name: c.name })) },
        };
      }

      const customer = matches[0]!;
      const history = await transactionRepo.listForCustomer(customer.customerId, 10);
      return {
        ok: true,
        summary:
          `${customer.name}: ${formatMoney(customer.totalSpent)} spent across ` +
          `${customer.transactionCount} purchases, ${formatMoney(customer.outstanding)} pending.`,
        data: {
          customer,
          recentTransactions: history.slice(0, 5),
        },
      };
    }

    case 'searchCustomers': {
      const query = str(args.query);
      const minOutstanding = num(args.minOutstandingRupees);
      const overdueOnly = flag(args.overdueOnly);

      let all = await customerRepo.list(vendorId);
      if (query) {
        const lower = query.toLowerCase();
        all = all.filter((customer) => customer.name.toLowerCase().includes(lower));
      }
      if (minOutstanding !== null) {
        all = all.filter((customer) => customer.outstanding >= minOutstanding * 100);
      }

      if (overdueOnly) {
        const open = await commitmentRepo.list(vendorId);
        const now = nowIso();
        const overdueIds = new Set(
          open
            .filter(
              (commitment) =>
                (commitment.status === 'open' || commitment.status === 'partly_paid') &&
                commitment.dueDate < now,
            )
            .map((commitment) => commitment.customerId),
        );
        all = all.filter((customer) => overdueIds.has(customer.customerId));
      }

      all.sort((a, b) => b.outstanding - a.outstanding);
      const total = all.reduce((sum, customer) => sum + customer.outstanding, 0);

      return {
        ok: true,
        summary: `${all.length} customer${all.length === 1 ? '' : 's'} found, owing ${formatMoney(total)} in total.`,
        data: { customers: all.slice(0, 50), totalOutstanding: total, count: all.length },
      };
    }

    case 'getTransactions': {
      const customerName = str(args.customerName);
      const days = num(args.days, 30)!;
      const limit = Math.min(num(args.limit, 25)!, 100);

      let list = await transactionRepo.list(vendorId, { limit: 300 });
      const range = lastNDaysRange(days);
      list = list.filter((transaction) => withinRange(transaction.timestamp, range));

      if (customerName) {
        const lower = customerName.toLowerCase();
        list = list.filter((transaction) => transaction.customerName.toLowerCase().includes(lower));
      }

      list = list.slice(0, limit);
      const revenue = list.reduce((sum, transaction) => sum + transaction.total, 0);

      return {
        ok: true,
        summary: `${list.length} sale${list.length === 1 ? '' : 's'} in the last ${days} day${days === 1 ? '' : 's'}, worth ${formatMoney(revenue)}.`,
        data: { transactions: list, revenue, count: list.length },
      };
    }

    case 'getOutstandingPayments': {
      const minAmount = num(args.minAmountRupees, 0)!;
      const overdueOnly = flag(args.overdueOnly);
      const now = nowIso();

      let open = (await commitmentRepo.list(vendorId)).filter(
        (commitment) => commitment.status === 'open' || commitment.status === 'partly_paid',
      );
      open = withBalanceAtLeast(open, minAmount);
      if (overdueOnly) {
        open = open.filter((commitment) => commitment.dueDate < now);
      }

      open.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const total = open.reduce(
        (sum, commitment) => sum + (commitment.amount - commitment.settledAmount),
        0,
      );

      return {
        ok: true,
        // Counted by customer, because that is the grain the threshold and
        // the reminders work at. "61 unpaid balances" alongside a filter for
        // customers owing over ₹500 reads as a contradiction.
        summary: (() => {
          const people = new Set(open.map((commitment) => commitment.customerId)).size;
          return `${people} customer${people === 1 ? '' : 's'} owe${people === 1 ? 's' : ''} ${formatMoney(total)} across ${open.length} unpaid bill${open.length === 1 ? '' : 's'}.`;
        })(),
        data: {
          commitments: open.map((commitment) => ({
            ...commitment,
            daysOverdue: Math.max(0, daysBetween(commitment.dueDate, now)),
            remaining: commitment.amount - commitment.settledAmount,
          })),
          totalOutstanding: total,
          count: open.length,
        },
      };
    }

    case 'getInventory': {
      const lowStockOnly = flag(args.lowStockOnly);
      const insights = await getInventoryInsights(vendorId);
      const selected = lowStockOnly ? insights.filter((insight) => insight.lowStock) : insights;

      return {
        ok: true,
        summary: lowStockOnly
          ? `${selected.length} product${selected.length === 1 ? '' : 's'} running low.`
          : `${selected.length} product${selected.length === 1 ? '' : 's'} in stock.`,
        data: {
          products: selected.slice(0, 40).map((insight) => ({
            name: insight.product.name,
            stock: insight.product.stock,
            unit: insight.product.unit,
            salesVelocity: insight.salesVelocity,
            daysRemaining: insight.daysRemaining,
            lowStock: insight.lowStock,
          })),
          count: selected.length,
        },
      };
    }

    case 'getSalesSummary': {
      const days = num(args.days, 1)!;
      const range = lastNDaysRange(days);
      const list = (await transactionRepo.list(vendorId, { limit: 400 })).filter((transaction) =>
        withinRange(transaction.timestamp, range),
      );

      const revenue = list.reduce((sum, transaction) => sum + transaction.total, 0);

      // "still pending" is a claim about now, so it comes from the Commitments.
      // A sale's own `outstanding` is frozen at the time of sale.
      const settlement = settlementByTransaction(await commitmentRepo.list(vendorId, 500));
      const pending = list.reduce(
        (sum, transaction) => sum + currentlyPending(transaction, settlement),
        0,
      );
      const collected = revenue - pending;
      const customers = new Set(list.map((transaction) => transaction.customerId)).size;

      return {
        ok: true,
        summary:
          `${list.length} sale${list.length === 1 ? '' : 's'} worth ${formatMoney(revenue)} ` +
          `from ${customers} customer${customers === 1 ? '' : 's'}; ${formatMoney(pending)} still pending.`,
        data: { revenue, collected, pending, saleCount: list.length, customerCount: customers, days },
      };
    }

    case 'prepareRestockList': {
      const daysOfCover = num(args.daysOfCover, 14)!;
      const insights = await getInventoryInsights(vendorId);
      const lines = insights
        .filter((insight) => insight.lowStock || insight.belowReorderLevel)
        .map((insight) => {
          const target = Math.max(
            Math.ceil(insight.salesVelocity * daysOfCover),
            insight.product.reorderLevel,
          );
          const quantity = Math.max(0, target - insight.product.stock);
          return {
            productId: insight.product.productId,
            name: insight.product.name,
            unit: insight.product.unit,
            currentStock: insight.product.stock,
            suggestedQuantity: quantity,
            estimatedCost: Math.round(quantity * insight.product.costPrice),
            daysRemaining: insight.daysRemaining,
          };
        })
        .filter((line) => line.suggestedQuantity > 0);

      const estimatedCost = lines.reduce((sum, line) => sum + line.estimatedCost, 0);

      return {
        ok: true,
        summary:
          lines.length === 0
            ? 'Nothing needs restocking right now.'
            : `${lines.length} product${lines.length === 1 ? '' : 's'} to restock, about ${formatMoney(estimatedCost)}.`,
        data: { lines, estimatedCost, daysOfCover },
      };
    }

    case 'createReminder': {
      // Note what this does NOT do: send. It assembles drafts and hands them
      // back. Delivery happens only in routes/agent.ts, after a human confirms.
      const minAmount = num(args.minAmountRupees, 0)!;
      const overdueOnly = flag(args.overdueOnly);
      const names = strList(args.customerNames).map((name) => name.toLowerCase());
      const now = nowIso();

      let open = (await commitmentRepo.list(vendorId)).filter(
        (commitment) => commitment.status === 'open' || commitment.status === 'partly_paid',
      );
      open = withBalanceAtLeast(open, minAmount);
      if (overdueOnly) open = open.filter((commitment) => commitment.dueDate < now);
      if (names.length > 0) {
        open = open.filter((commitment) =>
          names.some((name) => commitment.customerName.toLowerCase().includes(name)),
        );
      }

      // One reminder per customer, even when several bills are outstanding.
      const byCustomer = new Map<
        string,
        { customerId: string; customerName: string; amount: number; daysOverdue: number }
      >();
      for (const commitment of open) {
        const remaining = commitment.amount - commitment.settledAmount;
        const existing = byCustomer.get(commitment.customerId);
        const daysOverdue = Math.max(0, daysBetween(commitment.dueDate, now));
        if (existing) {
          existing.amount += remaining;
          existing.daysOverdue = Math.max(existing.daysOverdue, daysOverdue);
        } else {
          byCustomer.set(commitment.customerId, {
            customerId: commitment.customerId,
            customerName: commitment.customerName,
            amount: remaining,
            daysOverdue,
          });
        }
      }

      const allCustomers = await customerRepo.list(vendorId);
      const drafts = [...byCustomer.values()].map((entry) => {
        const customer = allCustomers.find((c) => c.customerId === entry.customerId);
        return {
          customerId: entry.customerId,
          customerName: entry.customerName,
          phone: customer?.phone ?? '',
          amount: entry.amount,
          daysOverdue: entry.daysOverdue,
          /** True when there is no number to send to. Surfaced before confirming. */
          missingPhone: !customer?.phone,
        };
      });

      const total = drafts.reduce((sum, draft) => sum + draft.amount, 0);

      return {
        ok: true,
        summary:
          drafts.length === 0
            ? 'No customers match those conditions, so no reminders were prepared.'
            : `Prepared ${drafts.length} reminder${drafts.length === 1 ? '' : 's'} for ${formatMoney(total)}.`,
        data: { drafts, totalOutstanding: total, count: drafts.length },
      };
    }

    default: {
      // Exhaustiveness: adding a tool name without a case is a compile error.
      const exhaustive: never = name;
      throw forbidden(`Unknown tool ${String(exhaustive)}`);
    }
  }
}
