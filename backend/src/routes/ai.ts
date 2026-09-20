import { Router, ok } from '../utils/router';
import { requireVendor } from '../middleware/auth';
import { getInventoryInsights, LOW_STOCK_DAYS } from '../services/inventory';
import { narrate, isBedrockEnabled } from '../services/bedrock';
import {
  commitments as commitmentRepo,
  customers as customerRepo,
  orders as orderRepo,
  transactions as transactionRepo,
} from '../services/repository';
import { formatMoney, marginPercent } from '../utils/money';
import { daysBetween, lastNDaysRange, nowIso, withinRange } from '../utils/dates';
import { ShopPulseSchema, type PulseCard, type ShopPulse } from '../schemas/ai';

/**
 * Shop Pulse — "What should I pay attention to today?"
 *
 * Not a dashboard. A dashboard shows you everything and leaves the ranking to
 * you; this shows the handful of things that have changed and are worth acting
 * on, in the order they deserve attention.
 *
 * Every card is computed first and narrated second. `priority` is arithmetic,
 * `metrics` are arithmetic, and the card renders completely with `narration`
 * empty — which is exactly what happens when Bedrock is off or slow.
 */

export const aiRoutes = new Router();

aiRoutes.get('/pulse', async (ctx) => {
  const { vendorId, vendor } = await requireVendor(ctx);
  const now = nowIso();

  const [insights, openCommitments, activeOrders, recentSales, allCustomers] = await Promise.all([
    getInventoryInsights(vendorId),
    commitmentRepo.list(vendorId).then((list) =>
      list.filter((entry) => entry.status === 'open' || entry.status === 'partly_paid'),
    ),
    orderRepo.list(vendorId).then((list) =>
      list.filter((order) => order.status !== 'collected' && order.status !== 'cancelled'),
    ),
    transactionRepo.list(vendorId, { limit: 300 }),
    customerRepo.list(vendorId),
  ]);

  const cards: PulseCard[] = [];

  /* ── Stock running out ─────────────────────────────────────────────────── */

  const urgent = insights.filter((insight) => insight.lowStock).slice(0, 3);
  for (const insight of urgent) {
    const { product, daysRemaining } = insight;

    // A product can be "low" for two different reasons, and conflating them
    // produces the nonsense of "may run out in ~20 days" styled as urgent.
    // Running out soon is a deadline; sitting below the reorder level with
    // weeks of cover is just a note.
    const runningOutSoon = daysRemaining !== null && daysRemaining <= LOW_STOCK_DAYS;

    let severity: PulseCard['severity'];
    let title: string;
    let priority: number;

    if (insight.outOfStock) {
      severity = 'critical';
      title = `${product.name} is out of stock`;
      priority = 100;
    } else if (runningOutSoon) {
      const days = Math.max(1, Math.round(daysRemaining));
      severity = daysRemaining <= 1 ? 'critical' : 'warning';
      title = `${product.name} may run out in ~${days} day${days === 1 ? '' : 's'}`;
      priority = 95 - daysRemaining * 5;
    } else {
      severity = 'info';
      title = `${product.name} is below your reorder level`;
      priority = 35;
    }

    const body = insight.outOfStock
      ? `Selling about ${insight.salesVelocity} a day before it ran out.`
      : daysRemaining === null
        ? `${product.stock} ${product.unit} left · not selling right now`
        : `${product.stock} ${product.unit} left · selling ${insight.salesVelocity}/day`;

    cards.push({
      id: `stock-${product.productId}`,
      kind: 'stock',
      severity,
      title,
      body,
      narration: '',
      metrics: {
        stock: product.stock,
        unit: product.unit,
        salesVelocity: insight.salesVelocity,
        daysRemaining: daysRemaining ?? 0,
        suggestedQuantity: insight.suggestedRestockQuantity,
      },
      actionLabel: 'Add to restock',
      actionHref: `/app/inventory/${product.productId}`,
      priority,
    });
  }

  /* ── Money owed ────────────────────────────────────────────────────────── */

  if (openCommitments.length > 0) {
    const overdue = openCommitments.filter((entry) => entry.dueDate < now);
    const target = overdue.length > 0 ? overdue : openCommitments;
    const total = target.reduce((sum, entry) => sum + (entry.amount - entry.settledAmount), 0);
    const people = new Set(target.map((entry) => entry.customerId)).size;
    const worstDays = Math.max(
      0,
      ...target.map((entry) => daysBetween(entry.dueDate, now)),
    );

    cards.push({
      id: 'payments-outstanding',
      kind: 'payments',
      severity: overdue.length > 0 ? 'warning' : 'info',
      title: `${people} customer${people === 1 ? '' : 's'} owe${people === 1 ? 's' : ''} ${formatMoney(total)}`,
      body:
        overdue.length > 0
          ? `Oldest is ${worstDays} day${worstDays === 1 ? '' : 's'} past due.`
          : 'All within their due dates.',
      narration: '',
      metrics: {
        customerCount: people,
        totalOutstanding: total,
        overdueCount: overdue.length,
        oldestDaysOverdue: worstDays,
      },
      actionLabel: 'Review',
      actionHref: '/app/payments',
      priority: overdue.length > 0 ? 85 : 40,
    });
  }

  /* ── Orders waiting ────────────────────────────────────────────────────── */

  const ready = activeOrders.filter((order) => order.status === 'ready');
  if (ready.length > 0) {
    cards.push({
      id: 'orders-ready',
      kind: 'orders',
      severity: 'info',
      title: `${ready.length} order${ready.length === 1 ? ' is' : 's are'} ready`,
      body: ready
        .slice(0, 3)
        .map((order) => order.customerName)
        .join(', '),
      narration: '',
      metrics: {
        readyCount: ready.length,
        value: ready.reduce((sum, order) => sum + order.total, 0),
      },
      actionLabel: 'View orders',
      actionHref: '/app/orders',
      priority: 70,
    });
  }

  /* ── Margin opportunity ────────────────────────────────────────────────── */

  // Compares the fastest seller against the highest-margin product. Worth
  // surfacing only when they differ and the gap is material.
  const selling = insights.filter((insight) => insight.salesVelocity > 0);
  if (selling.length >= 2) {
    const fastest = [...selling].sort((a, b) => b.salesVelocity - a.salesVelocity)[0]!;
    const richest = [...selling].sort((a, b) => b.marginPercent - a.marginPercent)[0]!;

    if (
      fastest.product.productId !== richest.product.productId &&
      richest.marginPercent - fastest.marginPercent >= 8
    ) {
      cards.push({
        id: 'opportunity-margin',
        kind: 'opportunity',
        severity: 'positive',
        title: `${fastest.product.name} sells fastest, but ${richest.product.name} earns more per sale`,
        body: `${fastest.marginPercent}% margin vs ${richest.marginPercent}%. Worth keeping ${richest.product.name} in sight of customers.`,
        narration: '',
        metrics: {
          fastestProduct: fastest.product.name,
          fastestVelocity: fastest.salesVelocity,
          fastestMargin: fastest.marginPercent,
          richestProduct: richest.product.name,
          richestMargin: richest.marginPercent,
        },
        actionLabel: 'View insight',
        actionHref: `/app/inventory/${richest.product.productId}`,
        priority: 30,
      });
    }
  }

  /* ── A customer who has stopped coming ─────────────────────────────────── */

  const lapsed = allCustomers
    .filter((customer) => customer.transactionCount >= 3 && customer.lastInteractionAt)
    .map((customer) => ({
      customer,
      daysAway: daysBetween(customer.lastInteractionAt!, now),
    }))
    .filter((entry) => entry.daysAway >= 30)
    .sort((a, b) => b.customer.totalSpent - a.customer.totalSpent)[0];

  if (lapsed) {
    cards.push({
      id: `customer-lapsed-${lapsed.customer.customerId}`,
      kind: 'customer',
      severity: 'info',
      title: `${lapsed.customer.name} hasn't visited in ${lapsed.daysAway} days`,
      body: `One of your regulars — ${formatMoney(lapsed.customer.totalSpent)} spent over ${lapsed.customer.transactionCount} visits.`,
      narration: '',
      metrics: {
        daysAway: lapsed.daysAway,
        totalSpent: lapsed.customer.totalSpent,
        visits: lapsed.customer.transactionCount,
      },
      actionLabel: 'Open memory',
      actionHref: `/app/customers/${lapsed.customer.customerId}`,
      priority: 25,
    });
  }

  cards.sort((a, b) => b.priority - a.priority);
  const top = cards.slice(0, 6);

  /* ── Narration, last and optional ──────────────────────────────────────── */

  if (isBedrockEnabled() && top.length > 0) {
    // One call for all cards rather than one per card: cheaper, and it lets the
    // model avoid repeating itself across them.
    const facts = top
      .map(
        (card, index) =>
          `${index + 1}. [${card.kind}] ${card.title}. ${card.body} ` +
          `Figures: ${Object.entries(card.metrics)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`,
      )
      .join('\n');

    const narration = await narrate(
      `Shop: ${vendor.shopName} (${vendor.category}).\n` +
        `Write one short line of advice for EACH item below, in order, one per line, no numbering.\n\n${facts}`,
      'ai.pulse',
    );

    if (narration) {
      const lines = narration
        .split('\n')
        .map((line) => line.replace(/^\s*[-*\d.)\s]+/, '').trim())
        .filter(Boolean);
      top.forEach((card, index) => {
        const line = lines[index];
        if (line) card.narration = line.slice(0, 600);
      });
    }
  }

  /* ── Today's headline numbers ──────────────────────────────────────────── */

  const todayRange = lastNDaysRange(1);
  const today = recentSales.filter((transaction) => withinRange(transaction.timestamp, todayRange));
  const revenue = today.reduce((sum, transaction) => sum + transaction.total, 0);

  let estimatedProfit = 0;
  const costByProduct = new Map(
    insights.map((insight) => [insight.product.productId, insight.product.costPrice]),
  );
  for (const transaction of today) {
    for (const item of transaction.items) {
      const cost = item.productId ? costByProduct.get(item.productId) : undefined;
      if (cost === undefined) continue;
      estimatedProfit += (item.unitPrice - cost) * item.quantity;
    }
  }

  const pulse: ShopPulse = ShopPulseSchema.parse({
    generatedAt: now,
    cards: top,
    engine: isBedrockEnabled() && top.some((card) => card.narration) ? 'bedrock' : 'deterministic',
  } satisfies ShopPulse);

  return ok({
    pulse,
    today: {
      revenue,
      estimatedProfit: Math.round(estimatedProfit),
      saleCount: today.length,
      customerCount: new Set(today.map((transaction) => transaction.customerId)).size,
      pending: openCommitments.reduce(
        (sum, entry) => sum + (entry.amount - entry.settledAmount),
        0,
      ),
      totalCustomers: allCustomers.length,
    },
  });
});

/**
 * Margin explainer for one product, used by the opportunity card's detail view.
 * Deterministic figures with optional narration, same contract as the rest.
 */
aiRoutes.get('/insight/margin', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const insights = await getInventoryInsights(vendorId);

  const ranked = insights
    .filter((insight) => insight.salesVelocity > 0)
    .map((insight) => ({
      name: insight.product.name,
      salesVelocity: insight.salesVelocity,
      marginPercent: insight.marginPercent,
      profitPerUnit: insight.product.sellingPrice - insight.product.costPrice,
      // Velocity times unit margin: what the shelf actually earns per day.
      dailyProfit: Math.round(
        insight.salesVelocity * (insight.product.sellingPrice - insight.product.costPrice),
      ),
      marginPercentCheck: Number(
        marginPercent(insight.product.costPrice, insight.product.sellingPrice).toFixed(1),
      ),
    }))
    .sort((a, b) => b.dailyProfit - a.dailyProfit);

  return ok({ products: ranked.slice(0, 20) });
});
