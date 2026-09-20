import { z } from 'zod';
import { Router, ok } from '../utils/router';
import { parseQuery } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { notifications as notificationRepo, payments as paymentRepo } from '../services/repository';
import { checkWhatsAppTemplate, describeProvider } from '../services/notifications';
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
  const status = describeProvider();

  return ok({
    reminders,
    /**
     * Safe by construction: `describeProvider` returns whether messaging works
     * and what to fix, never the credentials. The access token is read only
     * inside services/notifications.ts and is returned by no route.
     */
    provider: { name: status.provider, ...status },
    totals: {
      count: reminders.length,
      delivered: reminders.filter((entry) => entry.status === 'sent').length,
      notDelivered: reminders.filter((entry) => entry.status === 'not_delivered').length,
      failed: reminders.filter((entry) => entry.status === 'failed').length,
      /** Things the shopkeeper can act on, as opposed to things that broke. */
      needsPhone: reminders.filter(
        (entry) => entry.status === 'no_phone' || entry.status === 'invalid_phone',
      ).length,
    },
  });
});

/**
 * Whether messaging is wired up, for the banner on the Payments screen.
 *
 * Separate from the reminder log because the UI asks this before there is
 * anything to show, and because a shopkeeper setting WhatsApp up wants to know
 * it worked without having to send a reminder to a real customer to find out.
 */
paymentRoutes.get('/whatsapp/status', async (ctx) => {
  await requireVendor(ctx);
  const status = describeProvider();

  // Credentials being present is not the same as messages getting through.
  if (status.provider === 'whatsapp' && status.canDeliver) {
    const template = await checkWhatsAppTemplate();
    if (!template.ok) {
      return ok({ ...status, canDeliver: false, status: 'incomplete', note: template.detail });
    }
  }

  return ok(status);
});
