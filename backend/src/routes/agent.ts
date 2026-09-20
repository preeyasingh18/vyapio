import { Router, ok } from '../utils/router';
import { parseBody } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { plan } from '../services/agentCore';
import { SHOPKEEPER_TOOLS } from '../services/agentTools';
import { aiActions, commitments as commitmentRepo, customers as customerRepo } from '../services/repository';
import { notify, templates, getProvider } from '../services/notifications';
import { publish } from '../services/events';
import { badRequest, conflict, notFound } from '../utils/errors';
import { formatMoney } from '../utils/money';
import { nowIso } from '../utils/dates';
import { newActionId, randomId } from '../utils/ids';
import { AgentConfirmRequestSchema, AgentRunRequestSchema } from '../schemas/requests';
import {
  AgentExecutionSchema,
  AgentRunSchema,
  type AgentExecution,
  type AgentProposal,
  type AgentRun,
} from '../schemas/ai';
import type { AgentToolName } from '../schemas/ai';
import type { AIAction } from '../schemas/entities';

/**
 * The agent.
 *
 * Two endpoints, and the split between them is the whole safety model:
 *
 *   POST /agent/run      Plans and reads. Writes exactly one thing — an
 *                        AIAction audit row. Sends nothing.
 *   POST /agent/confirm  Executes a previously proposed action, identified by
 *                        actionId, authenticated as the same vendor, and only
 *                        if that action is still awaiting confirmation.
 *
 * A model cannot reach the second endpoint. Only a person tapping a button can.
 */

export const agentRoutes = new Router();

const SUGGESTIONS = [
  'Find everyone who owes more than ₹500 and is overdue',
  'Check which products are running low',
  'Prepare a restock list',
  "Show today's sales",
  'Prepare payment reminders',
];

agentRoutes.get('/suggestions', async (ctx) => {
  await requireVendor(ctx);
  return ok({ suggestions: SUGGESTIONS });
});

/** Audit trail, so every AI action stays inspectable after the fact. */
agentRoutes.get('/actions', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const actions = await aiActions.list(vendorId, 50);
  return ok({ actions });
});

/**
 * What to offer next, once something has been answered.
 *
 * Keyed off the tools that actually ran, so the suggestions follow from what
 * the shopkeeper just saw rather than being the same five prompts every time.
 * A shopkeeper mid-queue will not type a follow-up; if the answer ends with
 * nothing to tap, that is where the conversation ends.
 *
 * Everything offered here is something the assistant can genuinely answer from
 * the shop's own records — suggesting a question it would refuse is worse than
 * suggesting nothing.
 */
const FOLLOW_UPS: Partial<Record<AgentToolName, string[]>> = {
  getOutstandingPayments: ['Prepare payment reminders', 'Who owes me the most?'],
  getCustomer: ['What did they buy last?', 'How much do they still owe?'],
  searchCustomers: ['Who owes me money?', 'What did they buy last?'],
  getInventory: ['Prepare a restock list', 'Which products are out of stock?'],
  prepareRestockList: ['Check which products are running low', "Show today's sales"],
  getSalesSummary: ['Who bought the most this week?', 'Who owes me money?'],
  getTransactions: ['How much did I sell this week?', 'Who owes me money?'],
};

/** Offered when nothing more specific fits — never an empty row of chips. */
const GENERAL_FOLLOW_UPS = [
  'Who owes me money?',
  "Show today's sales",
  'Check which products are running low',
];

function followUpsFor(
  toolCalls: AgentToolName[],
  hasProposal: boolean,
  asked: string,
): string[] {
  const suggested = toolCalls.flatMap((tool) => FOLLOW_UPS[tool] ?? []);

  // A proposal already has its own confirm button; pushing other questions
  // beside it competes with the one thing the shopkeeper should decide.
  const pool = hasProposal ? suggested : [...suggested, ...GENERAL_FOLLOW_UPS];

  // Offering back the question just asked is the one suggestion guaranteed to
  // be useless — the answer to it is already on screen.
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const justAsked = normalise(asked);

  return [...new Set(pool)].filter((entry) => normalise(entry) !== justAsked).slice(0, 3);
}

/* -------------------------------------------------------------------- Run */

agentRoutes.post('/run', async (ctx) => {
  const { vendorId, auth } = await requireVendor(ctx);
  const input = parseBody(ctx, AgentRunRequestSchema);

  const result = await plan(input.instruction, {
    vendorId,
    userId: auth.userId,
    allowed: SHOPKEEPER_TOOLS,
  });

  // A reminder draft is the one outcome that implies a side effect, so it
  // becomes a proposal rather than just an answer.
  let proposal: AgentProposal | null = null;
  const reminderResult = result.toolResults.createReminder;

  if (reminderResult?.ok) {
    const drafts = (reminderResult.data.drafts ?? []) as Array<{
      customerId: string;
      customerName: string;
      phone: string;
      amount: number;
      daysOverdue: number;
      missingPhone: boolean;
    }>;

    if (drafts.length > 0) {
      const provider = getProvider();
      const sendable = drafts.filter((draft) => !draft.missingPhone);
      const total = drafts.reduce((sum, draft) => sum + draft.amount, 0);

      const actionId = newActionId();

      const effects = drafts.map((draft) =>
        draft.missingPhone
          ? `${draft.customerName} — ${formatMoney(draft.amount)} — no phone number saved, cannot send`
          : `${draft.customerName} — ${formatMoney(draft.amount)}${draft.daysOverdue > 0 ? ` (${draft.daysOverdue} days overdue)` : ''}`,
      );

      // The delivery note is written from the *configured provider*, before the
      // user decides — so nobody taps "Send" expecting an SMS that cannot go.
      const deliveryNote =
        provider.name === 'mock'
          ? 'No messaging provider is configured, so these will be recorded in the reminder log but NOT sent to customers.'
          : `These will be sent through ${provider.name}.`;

      proposal = {
        actionId,
        actionType: 'send_payment_reminders',
        summary: `Send ${sendable.length} payment reminder${sendable.length === 1 ? '' : 's'} for ${formatMoney(total)}`,
        effects,
        confirmLabel:
          sendable.length > 0
            ? `Send ${sendable.length} reminder${sendable.length === 1 ? '' : 's'}`
            : 'Nothing to send',
        cancelLabel: 'Cancel',
        deliveryNote,
      };

      // Persisted before it is shown, so a confirm can be validated against it
      // and so the attempt is auditable even if the user walks away.
      const action: AIAction = {
        actionId,
        vendorId,
        agentId: result.engine,
        actionType: 'send_payment_reminders',
        input: { instruction: input.instruction },
        result: { drafts, totalOutstanding: total },
        status: 'awaiting_confirmation',
        requiresConfirmation: true,
        toolCalls: result.toolCalls,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await aiActions.put(action);
    }
  }

  // Read-only runs are logged too — knowing what was asked matters as much as
  // knowing what was done.
  if (!proposal) {
    await aiActions.put({
      actionId: newActionId(),
      vendorId,
      agentId: result.engine,
      actionType: 'query',
      input: { instruction: input.instruction },
      result: { message: result.message },
      status: 'executed',
      requiresConfirmation: false,
      toolCalls: result.toolCalls,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  const run: AgentRun = AgentRunSchema.parse({
    runId: `run_${randomId(12)}`,
    instruction: input.instruction,
    understood: result.understood,
    steps: result.steps,
    message: result.message,
    citations: result.citations,
    proposal,
    followUps: followUpsFor(result.toolCalls, proposal !== null, input.instruction),
    engine: result.engine,
  } satisfies AgentRun);

  ctx.logger.info('agent run', {
    operation: 'agent.run',
    vendorId,
    userId: auth.userId,
    engine: result.engine,
    toolCount: result.toolCalls.length,
    hasProposal: proposal !== null,
  });

  return ok({ run });
});

/* ---------------------------------------------------------------- Confirm */

agentRoutes.post('/confirm', async (ctx) => {
  const { vendorId, vendor, auth } = await requireVendor(ctx);
  const input = parseBody(ctx, AgentConfirmRequestSchema);

  // Scoped to this vendor: an actionId from another shop is simply not found.
  const action = await aiActions.get(vendorId, input.actionId);
  if (!action) throw notFound('action');

  if (action.status !== 'awaiting_confirmation') {
    // Prevents a double-tap or a replayed request from sending twice.
    throw conflict(
      `Action ${action.actionId} is ${action.status}`,
      action.status === 'executed'
        ? 'This was already done.'
        : 'This action is no longer waiting for confirmation.',
    );
  }

  if (action.actionType !== 'send_payment_reminders') {
    throw badRequest(`Unsupported action type ${action.actionType}`);
  }

  const drafts = ((action.result?.drafts ?? []) as Array<{
    customerId: string;
    customerName: string;
    phone: string;
    amount: number;
    daysOverdue: number;
    missingPhone: boolean;
  }>) ?? [];

  const results: AgentExecution['results'] = [];
  let deliveredCount = 0;

  for (const draft of drafts) {
    if (draft.missingPhone || !draft.phone) {
      results.push({
        label: draft.customerName,
        ok: false,
        detail: 'No phone number saved for this customer.',
      });
      continue;
    }

    const body = templates.paymentReminder({
      shopName: vendor.shopName,
      customerName: draft.customerName,
      amount: draft.amount,
      daysOverdue: draft.daysOverdue,
    });

    const { result } = await notify({
      vendorId,
      customerId: draft.customerId,
      type: 'payment_reminder',
      to: draft.phone,
      body,
    });

    if (result.delivered) deliveredCount += 1;

    // `ok` reflects delivery, not merely "the call did not throw" — so the
    // summary below cannot overstate what happened.
    results.push({
      label: draft.customerName,
      ok: result.delivered,
      detail: result.detail,
    });

    // Record the attempt against the customer's open balances.
    const openForCustomer = (await commitmentRepo.list(vendorId)).filter(
      (commitment) =>
        commitment.customerId === draft.customerId &&
        (commitment.status === 'open' || commitment.status === 'partly_paid'),
    );
    for (const commitment of openForCustomer) {
      await commitmentRepo.update(commitment, {
        reminderStatus: result.delivered ? 'sent' : 'failed',
        lastReminderAt: nowIso(),
        reminderCount: commitment.reminderCount + 1,
      });
    }
  }

  const attempted = results.length;
  const recorded = attempted - deliveredCount;

  // The message states exactly what happened. When nothing could be delivered
  // it says so plainly rather than reporting a count of "sent".
  const message =
    deliveredCount > 0
      ? recorded > 0
        ? `${deliveredCount} reminder${deliveredCount === 1 ? '' : 's'} sent. ${recorded} could not be delivered.`
        : `Done. ${deliveredCount} reminder${deliveredCount === 1 ? '' : 's'} sent.`
      : attempted > 0
        ? `Nothing was sent. ${attempted} reminder${attempted === 1 ? ' was' : 's were'} recorded in your reminder log — configure a messaging provider to deliver them.`
        : 'There was nothing to send.';

  await aiActions.update(action, {
    status: deliveredCount > 0 || attempted > 0 ? 'executed' : 'failed',
    confirmedBy: auth.userId,
    confirmedAt: nowIso(),
    result: {
      ...action.result,
      delivered: deliveredCount,
      attempted,
      results,
    },
  });

  await publish(
    'AgentActionExecuted',
    vendorId,
    { actionId: action.actionId, actionType: action.actionType, delivered: deliveredCount },
    `AgentActionExecuted:${action.actionId}`,
  );

  ctx.logger.info('agent action confirmed', {
    operation: 'agent.confirm',
    vendorId,
    userId: auth.userId,
    actionType: action.actionType,
    attempted,
    delivered: deliveredCount,
  });

  const execution: AgentExecution = AgentExecutionSchema.parse({
    actionId: action.actionId,
    status: 'executed',
    message,
    results,
  } satisfies AgentExecution);

  return ok({ execution });
});

/** Explicit cancel, so a declined proposal is recorded rather than abandoned. */
agentRoutes.post('/cancel', async (ctx) => {
  const { vendorId, auth } = await requireVendor(ctx);
  const input = parseBody(ctx, AgentConfirmRequestSchema);

  const action = await aiActions.get(vendorId, input.actionId);
  if (!action) throw notFound('action');
  if (action.status !== 'awaiting_confirmation') {
    return ok({ execution: { actionId: action.actionId, status: action.status, message: 'Nothing to cancel.', results: [] } });
  }

  await aiActions.update(action, {
    status: 'cancelled',
    confirmedBy: auth.userId,
    confirmedAt: nowIso(),
  });

  return ok({
    execution: AgentExecutionSchema.parse({
      actionId: action.actionId,
      status: 'cancelled',
      message: 'Cancelled. Nothing was sent.',
      results: [],
    }),
  });
});

/**
 * Order-ready notification. Separate from the agent, same rule: it reports what
 * the provider actually did.
 */
agentRoutes.post('/notify-order-ready', async (ctx) => {
  const { vendorId, vendor } = await requireVendor(ctx);
  const body = ctx.body as { orderId?: string } | undefined;
  if (!body?.orderId) throw badRequest('orderId is required');

  const { orders } = await import('../services/repository');
  const order = await orders.get(vendorId, body.orderId);
  if (!order) throw notFound('order');

  const customer = await customerRepo.get(vendorId, order.customerId);
  if (!customer?.phone) {
    return ok({
      sent: false,
      message: `${order.customerName} has no phone number saved, so nothing was sent.`,
    });
  }

  const { result } = await notify({
    vendorId,
    customerId: order.customerId,
    type: 'order_ready',
    to: customer.phone,
    body: templates.orderReady({
      shopName: vendor.shopName,
      customerName: order.customerName,
      itemCount: order.items.length,
    }),
  });

  return ok({
    sent: result.delivered,
    message: result.delivered
      ? `Told ${order.customerName} their order is ready.`
      : `Recorded, but not sent: ${result.detail}`,
    detail: result.detail,
  });
});
