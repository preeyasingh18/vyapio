import { Router, ok } from '../utils/router';
import { parseBody } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { createTransaction, recordPayment } from '../services/ledger';
import { customers as customerRepo } from '../services/repository';
import { publish } from '../services/events';
import { toAppError } from '../utils/errors';
import { nowIso } from '../utils/dates';
import { newCustomerId, newQrId } from '../utils/ids';
import {
  CreateCustomerRequestSchema,
  CreateTransactionRequestSchema,
  RecordPaymentRequestSchema,
  SyncRequestSchema,
} from '../schemas/requests';
import { CustomerSchema, type Customer } from '../schemas/entities';

/**
 * Offline replay.
 *
 * The client queues actions while offline and posts the batch on reconnect.
 * Two properties matter:
 *
 *   Idempotent — every action carries a key claimed inside the same
 *     transactional write that creates the record, so a retried batch cannot
 *     double-charge.
 *   Partial — each action succeeds or fails independently. One bad row does not
 *     block the rest, and the response says per-action what happened, so the
 *     client can keep only the genuine failures in its queue.
 *
 * Until an action appears in `succeeded` here, the client must keep describing
 * it as "waiting to sync" — never as saved.
 */

export const syncRoutes = new Router();

type SyncOutcome = {
  id: string;
  kind: string;
  status: 'synced' | 'duplicate' | 'failed';
  recordId?: string;
  error?: string;
};

syncRoutes.post('/', async (ctx) => {
  const { vendorId, auth } = await requireVendor(ctx);
  const input = parseBody(ctx, SyncRequestSchema);

  const outcomes: SyncOutcome[] = [];

  // Sequential on purpose: queued actions are usually causally ordered — create
  // the customer, then their sale — and parallel replay would break that.
  for (const action of input.actions) {
    try {
      switch (action.kind) {
        case 'customer': {
          const parsed = CreateCustomerRequestSchema.safeParse(action.payload);
          if (!parsed.success) {
            outcomes.push({
              id: action.id,
              kind: action.kind,
              status: 'failed',
              error: 'This saved customer had missing details.',
            });
            break;
          }

          // Phone is the natural key; a queued duplicate resolves to the
          // existing row rather than creating a second profile.
          if (parsed.data.phone) {
            const existing = await customerRepo.findByPhone(vendorId, parsed.data.phone);
            if (existing) {
              outcomes.push({
                id: action.id,
                kind: action.kind,
                status: 'duplicate',
                recordId: existing.customerId,
              });
              break;
            }
          }

          const customer: Customer = CustomerSchema.parse({
            customerId: newCustomerId(),
            vendorId,
            name: parsed.data.name,
            phone: parsed.data.phone,
            whatsappPhone: '',
            whatsappOptIn: false,
            email: parsed.data.email,
            qrId: newQrId(),
            outstanding: 0,
            totalSpent: 0,
            transactionCount: 0,
            notes: parsed.data.notes,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          } satisfies Customer);

          await customerRepo.put(customer);
          await publish(
            'CustomerCreated',
            vendorId,
            { customerId: customer.customerId, name: customer.name },
            `CustomerCreated:${customer.customerId}`,
          );

          outcomes.push({
            id: action.id,
            kind: action.kind,
            status: 'synced',
            recordId: customer.customerId,
          });
          break;
        }

        case 'transaction': {
          const parsed = CreateTransactionRequestSchema.safeParse(action.payload);
          if (!parsed.success) {
            outcomes.push({
              id: action.id,
              kind: action.kind,
              status: 'failed',
              error: 'This saved sale had missing details.',
            });
            break;
          }

          const result = await createTransaction({
            vendorId,
            customerId: parsed.data.customerId,
            createdBy: auth.userId,
            items: parsed.data.items,
            discount: parsed.data.discount,
            paid: parsed.data.paid,
            paymentMethod: parsed.data.paymentMethod,
            note: parsed.data.note,
            source: parsed.data.source,
            createCommitment: parsed.data.createCommitment,
            dueInDays: parsed.data.dueInDays,
            // The queued key is what makes a retried batch safe.
            idempotencyKey: action.idempotencyKey,
            // Preserve when it actually happened, not when it synced.
            timestamp: action.queuedAt,
          });

          outcomes.push({
            id: action.id,
            kind: action.kind,
            status: result.duplicate ? 'duplicate' : 'synced',
            recordId: result.transaction.transactionId,
          });
          break;
        }

        case 'payment': {
          const parsed = RecordPaymentRequestSchema.safeParse(action.payload);
          if (!parsed.success) {
            outcomes.push({
              id: action.id,
              kind: action.kind,
              status: 'failed',
              error: 'This saved payment had missing details.',
            });
            break;
          }

          const result = await recordPayment({
            vendorId,
            customerId: parsed.data.customerId,
            createdBy: auth.userId,
            amount: parsed.data.amount,
            method: parsed.data.method,
            note: parsed.data.note,
            ...(parsed.data.commitmentId ? { commitmentId: parsed.data.commitmentId } : {}),
            source: 'manual',
            idempotencyKey: action.idempotencyKey,
            timestamp: action.queuedAt,
          });

          outcomes.push({
            id: action.id,
            kind: action.kind,
            status: 'synced',
            recordId: result.payment.paymentId,
          });
          break;
        }

        default:
          outcomes.push({
            id: action.id,
            kind: action.kind,
            status: 'failed',
            error: 'Unknown action type.',
          });
      }
    } catch (error) {
      const appError = toAppError(error);

      // A duplicate is a success from the client's perspective — the record is
      // safely stored, so the action must leave the queue.
      if (appError.code === 'CONFLICT') {
        outcomes.push({ id: action.id, kind: action.kind, status: 'duplicate' });
      } else {
        ctx.logger.warn('sync action failed', {
          operation: 'sync.replay',
          vendorId,
          actionKind: action.kind,
          errorCode: appError.code,
        });
        outcomes.push({
          id: action.id,
          kind: action.kind,
          status: 'failed',
          error: appError.userMessage,
        });
      }
    }
  }

  const synced = outcomes.filter((outcome) => outcome.status !== 'failed');
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');

  ctx.logger.info('offline queue synced', {
    operation: 'sync.replay',
    vendorId,
    userId: auth.userId,
    total: outcomes.length,
    synced: synced.length,
    failed: failed.length,
  });

  return ok({
    outcomes,
    summary: {
      total: outcomes.length,
      synced: synced.length,
      failed: failed.length,
    },
    message:
      failed.length === 0
        ? `${synced.length} action${synced.length === 1 ? '' : 's'} synced`
        : `${synced.length} synced, ${failed.length} could not be saved`,
  });
});
