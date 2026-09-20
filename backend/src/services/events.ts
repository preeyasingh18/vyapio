import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { nowIso } from '../utils/dates';
import { randomId } from '../utils/ids';

/**
 * Business events.
 *
 * Recording a sale is one fact; the consequences — stock moves, velocity is
 * recalculated, a reminder becomes due, the pulse changes — are separate
 * concerns that should not make the shopkeeper wait. Publishing an event
 * decouples them.
 *
 * With EVENT_BUS_NAME set, events go to EventBridge and CDK rules route them
 * back to this same Lambda. Without it, the identical handlers run in-process
 * immediately after the write. Same handlers, same payloads, same idempotency —
 * only the transport differs.
 */

export type VyapioEventType =
  | 'CustomerCreated'
  | 'TransactionCreated'
  | 'PaymentRecorded'
  | 'InventoryChanged'
  | 'CommitmentCreated'
  | 'OrderReady'
  | 'AgentActionExecuted';

export type VyapioEvent<T = Record<string, unknown>> = {
  eventId: string;
  type: VyapioEventType;
  vendorId: string;
  occurredAt: string;
  /**
   * Stable key derived from the source record. Handlers use it to skip work
   * they have already done, because EventBridge delivers at-least-once.
   */
  idempotencyKey: string;
  detail: T;
};

export type EventHandler = (event: VyapioEvent) => Promise<void>;

const handlers = new Map<VyapioEventType, EventHandler[]>();

/** Registers an in-process handler. Called once at module load by handlers.ts. */
export function onEvent(type: VyapioEventType, handler: EventHandler): void {
  const existing = handlers.get(type) ?? [];
  existing.push(handler);
  handlers.set(type, existing);
}

let client: EventBridgeClient | null = null;
function eventBridge(): EventBridgeClient {
  client ??= new EventBridgeClient({ region: config.region });
  return client;
}

/**
 * Tracks keys this container has already processed, so a redelivery inside the
 * same warm Lambda is a no-op. Durable idempotency for cross-invocation
 * redelivery lives in the handlers themselves, which are written to converge:
 * recomputing sales velocity twice produces the same number.
 */
const processed = new Set<string>();
const PROCESSED_LIMIT = 5_000;

function markProcessed(key: string): boolean {
  if (processed.has(key)) return false;
  if (processed.size >= PROCESSED_LIMIT) processed.clear();
  processed.add(key);
  return true;
}

export async function publish<T extends Record<string, unknown>>(
  type: VyapioEventType,
  vendorId: string,
  detail: T,
  idempotencyKey?: string,
): Promise<VyapioEvent<T>> {
  const event: VyapioEvent<T> = {
    eventId: `evt_${randomId(16)}`,
    type,
    vendorId,
    occurredAt: nowIso(),
    idempotencyKey: idempotencyKey ?? `${type}:${randomId(16)}`,
    detail,
  };

  if (config.events.mode === 'aws') {
    try {
      await eventBridge().send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: config.events.busName,
              Source: config.events.source,
              DetailType: type,
              Detail: JSON.stringify(event),
              Time: new Date(event.occurredAt),
            },
          ],
        }),
      );
      logger.debug('event published', { operation: 'events.publish', vendorId, eventType: type });
    } catch (error) {
      // A dropped event must never fail the write that caused it — the
      // shopkeeper's sale is recorded either way, and the derived numbers are
      // recomputed on next read.
      logger.error('event publish failed', {
        operation: 'events.publish',
        vendorId,
        eventType: type,
        error,
      });
    }
    return event;
  }

  await dispatch(event);
  return event;
}

/**
 * Runs the registered handlers. Invoked directly in local mode, and by the
 * Lambda's EventBridge entry point in AWS mode.
 */
export async function dispatch(event: VyapioEvent): Promise<void> {
  if (!markProcessed(event.idempotencyKey)) {
    logger.debug('event already processed', {
      operation: 'events.dispatch',
      vendorId: event.vendorId,
      eventType: event.type,
    });
    return;
  }

  const registered = handlers.get(event.type) ?? [];
  for (const handler of registered) {
    const startedAt = Date.now();
    try {
      await handler(event);
      logger.debug('event handled', {
        operation: 'events.dispatch',
        vendorId: event.vendorId,
        eventType: event.type,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.error('event handler failed', {
        operation: 'events.dispatch',
        vendorId: event.vendorId,
        eventType: event.type,
        error,
      });
    }
  }
}

/** Test seam. */
export function resetEventState(): void {
  processed.clear();
}
