import { z } from 'zod';
import { Router, ok, created } from '../utils/router';
import { parseBody, parseParams, parseQuery } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { customers as customerRepo, orders as orderRepo, products as productRepo } from '../services/repository';
import { matchProduct } from '../services/inventory';
import { publish } from '../services/events';
import { notFound } from '../utils/errors';
import { nowIso } from '../utils/dates';
import { newOrderId } from '../utils/ids';
import { CreateOrderRequestSchema, UpdateOrderStatusRequestSchema } from '../schemas/requests';
import { OrderSchema, type LineItem, type Order } from '../schemas/entities';

/**
 * Orders.
 *
 * An order is a promise, not a sale: no stock moves and no money is recorded
 * until it becomes a transaction. That separation is what lets "4 orders are
 * ready" be true without any of them having touched the khata yet.
 */

export const orderRoutes = new Router();

const OrderIdParams = z.object({ orderId: z.string().min(1) });

orderRoutes.get('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const query = parseQuery(
    ctx,
    z.object({
      status: z.enum(['placed', 'preparing', 'ready', 'collected', 'cancelled']).optional(),
      activeOnly: z.coerce.boolean().default(false),
    }),
  );

  let list = await orderRepo.list(vendorId);
  if (query.status) {
    list = list.filter((order) => order.status === query.status);
  } else if (query.activeOnly) {
    list = list.filter((order) => order.status !== 'collected' && order.status !== 'cancelled');
  }

  return ok({
    orders: list,
    totals: {
      count: list.length,
      readyCount: list.filter((order) => order.status === 'ready').length,
      value: list.reduce((sum, order) => sum + order.total, 0),
    },
  });
});

orderRoutes.post('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, CreateOrderRequestSchema);

  const customer = await customerRepo.require(vendorId, input.customerId);
  const catalogue = await productRepo.list(vendorId);

  const items: LineItem[] = input.items.map((raw) => {
    const match = raw.productId
      ? catalogue.find((product) => product.productId === raw.productId)
      : matchProduct(raw.name, catalogue)?.product;

    const unitPrice = raw.unitPrice > 0 ? raw.unitPrice : (match?.sellingPrice ?? 0);
    return {
      ...(match ? { productId: match.productId } : {}),
      name: match?.name ?? raw.name,
      quantity: raw.quantity,
      unit: raw.unit || match?.unit || 'unit',
      unitPrice,
      lineTotal: Math.round(unitPrice * raw.quantity),
    };
  });

  const order: Order = OrderSchema.parse({
    orderId: newOrderId(),
    vendorId,
    customerId: customer.customerId,
    customerName: customer.name,
    items,
    total: items.reduce((sum, item) => sum + item.lineTotal, 0),
    status: 'placed',
    note: input.note,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } satisfies Order);

  await orderRepo.put(order);

  ctx.logger.info('order created', { operation: 'orders.create', vendorId, total: order.total });
  return created({ order });
});

orderRoutes.get('/:orderId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { orderId } = parseParams(ctx, OrderIdParams);
  const order = await orderRepo.get(vendorId, orderId);
  if (!order) throw notFound('order');
  return ok({ order });
});

orderRoutes.patch('/:orderId/status', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { orderId } = parseParams(ctx, OrderIdParams);
  const input = parseBody(ctx, UpdateOrderStatusRequestSchema);

  const existing = await orderRepo.get(vendorId, orderId);
  if (!existing) throw notFound('order');

  const order = await orderRepo.update(existing, {
    status: input.status,
    ...(input.status === 'ready' ? { readyAt: nowIso() } : {}),
    ...(input.status === 'collected' ? { collectedAt: nowIso() } : {}),
  });

  // Only "ready" is worth telling anyone about, and even then the notification
  // itself is a separate, confirmed action — this just records the fact.
  if (input.status === 'ready') {
    await publish(
      'OrderReady',
      vendorId,
      { orderId, customerId: order.customerId, itemCount: order.items.length },
      `OrderReady:${orderId}`,
    );
  }

  ctx.logger.info('order status changed', {
    operation: 'orders.updateStatus',
    vendorId,
    orderStatus: input.status,
  });

  return ok({ order });
});
