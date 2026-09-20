import { onEvent } from './services/events';
import { refreshSalesVelocity } from './services/inventory';
import { logger } from './utils/logger';

/**
 * Event handlers.
 *
 * Registered once at module load, and imported for side effect by app.ts.
 * These run in-process in local mode and are invoked by EventBridge rules in
 * AWS mode — same functions either way.
 *
 * Every handler here is written to converge rather than to increment, so
 * at-least-once delivery is harmless: running one twice produces the same
 * result as running it once.
 */

/**
 * Keep the denormalised `salesVelocity` on products current.
 *
 * Recomputed from the InventoryEvent log rather than adjusted, so a redelivered
 * event cannot drift the number.
 */
onEvent('InventoryChanged', async (event) => {
  const productIds = (event.detail.productIds as string[] | undefined) ?? [];
  if (productIds.length === 0) return;
  await refreshSalesVelocity(event.vendorId, productIds);
});

/**
 * Sales also move stock, so velocity is refreshed on this event too. The
 * idempotency key differs between the two events, so both fire — and because
 * the recomputation is convergent, doing the work twice is merely redundant,
 * never wrong.
 */
onEvent('TransactionCreated', async (event) => {
  const productIds = (event.detail.productIds as string[] | undefined) ?? [];
  if (productIds.length === 0) return;
  await refreshSalesVelocity(event.vendorId, productIds);
});

/**
 * Observability hooks.
 *
 * These deliberately only log. Notifying a customer is a decision a person
 * makes on a confirmation screen — wiring it to an event would turn "mark order
 * ready" into "message the customer", which is precisely the kind of silent
 * side effect this product does not do.
 */
onEvent('OrderReady', async (event) => {
  logger.info('order marked ready', {
    operation: 'events.orderReady',
    vendorId: event.vendorId,
    orderId: String(event.detail.orderId),
  });
});

onEvent('CommitmentCreated', async (event) => {
  logger.info('commitment created', {
    operation: 'events.commitmentCreated',
    vendorId: event.vendorId,
    amount: Number(event.detail.amount),
  });
});

onEvent('PaymentRecorded', async (event) => {
  logger.info('payment recorded', {
    operation: 'events.paymentRecorded',
    vendorId: event.vendorId,
    amount: Number(event.detail.amount),
  });
});

onEvent('CustomerCreated', async (event) => {
  logger.info('customer created', {
    operation: 'events.customerCreated',
    vendorId: event.vendorId,
  });
});

onEvent('AgentActionExecuted', async (event) => {
  logger.info('agent action executed', {
    operation: 'events.agentActionExecuted',
    vendorId: event.vendorId,
    actionType: String(event.detail.actionType),
    delivered: Number(event.detail.delivered ?? 0),
  });
});
