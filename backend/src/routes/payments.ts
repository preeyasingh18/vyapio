import { z } from 'zod';
import { Router, ok } from '../utils/router';
import { parseQuery } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { notifications as notificationRepo, payments as paymentRepo } from '../services/repository';
import { getProvider } from '../services/notifications';
import { lastNDaysRange, withinRange } from '../utils/dates';

/**
 * Payments — the money-in view.
 *
 * Recording a payment happens on /khata/payment, where it belongs alongside the
 * balance it settles. This route is read-only reporting over what was received,
 * plus the delivery log for reminders so the shopkeeper can see which messages
 * genuinely went out.
 */

export const paymentRoutes = new Router();

paymentRoutes.get('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const query = parseQuery(
    ctx,
    z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      method: z.enum(['cash', 'upi', 'card', 'credit', 'other']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  );

  const range = lastNDaysRange(query.days);
  let list = (await paymentRepo.list(vendorId, query.limit)).filter((payment) =>
    withinRange(payment.timestamp, range),
  );
  if (query.method) list = list.filter((payment) => payment.method === query.method);

  // Method mix drives the breakdown chart on the Payments screen.
  const byMethod: Record<string, number> = {};
  for (const payment of list) {
    byMethod[payment.method] = (byMethod[payment.method] ?? 0) + payment.amount;
  }

  return ok({
    payments: list,
    totals: {
      count: list.length,
      collected: list.reduce((sum, payment) => sum + payment.amount, 0),
      byMethod,
    },
    days: query.days,
  });
});

/**
 * Reminder delivery log.
 *
 * `status` here is the real outcome, including `not_delivered` when the mock
 * provider handled it. The UI renders that distinctly so "reminder sent" is
 * never shown for a message that never left the machine.
 */
paymentRoutes.get('/reminders', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const list = await notificationRepo.list(vendorId, 100);
  const reminders = list.filter((entry) => entry.type === 'payment_reminder');
  const provider = getProvider();

  return ok({
    reminders,
    provider: {
      name: provider.name,
      channel: provider.channel,
      /** False for the mock provider — surfaced as a banner in the UI. */
      canDeliver: provider.name !== 'mock',
      note:
        provider.name === 'mock'
          ? 'No messaging provider is configured, so reminders are recorded but not sent. Set NOTIFICATION_PROVIDER to sns or whatsapp to deliver them.'
          : `Reminders are delivered through ${provider.name}.`,
    },
    totals: {
      count: reminders.length,
      delivered: reminders.filter((entry) => entry.status === 'sent').length,
      notDelivered: reminders.filter((entry) => entry.status === 'not_delivered').length,
      failed: reminders.filter((entry) => entry.status === 'failed').length,
    },
  });
});
