import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld, type TestShop } from './helpers';
import { runTool, SHOPKEEPER_TOOLS, CUSTOMER_TOOLS, TOOL_DEFINITIONS } from '../src/services/agentTools';
import { setProvider, type NotificationProvider } from '../src/services/notifications';
import { aiActions, commitmentItem, customers, notifications } from '../src/services/repository';
import { getStore, keys } from '../src/services/dynamodb';
import { isoDaysAgo, nowIso } from '../src/utils/dates';
import { newCommitmentId } from '../src/utils/ids';
import { AppError } from '../src/utils/errors';
import type { Commitment } from '../src/schemas/entities';

/**
 * The agent.
 *
 * Three properties matter more than answer quality, and all three are things a
 * clever model must not be able to talk its way past:
 *
 *   1. It can only call tools it was granted.
 *   2. It cannot cause a side effect without a human confirming.
 *   3. It cannot claim a delivery that did not happen.
 */

/**
 * Creates a debt that is genuinely past its due date.
 *
 * Written through the repository rather than the API because the API's
 * `dueInDays` is `min(0)` — "due today" is correctly *not* overdue, so asking
 * for zero days would make every assertion below a race against the clock.
 */
async function createOverdueDebt(shop: TestShop, amountPaise: number): Promise<void> {
  const dueDate = isoDaysAgo(5);
  const commitment: Commitment = {
    commitmentId: newCommitmentId(),
    vendorId: shop.vendor.vendorId,
    customerId: shop.customer.customerId,
    customerName: shop.customer.name,
    amount: amountPaise,
    settledAmount: 0,
    description: 'Groceries',
    dueDate,
    status: 'open',
    reminderStatus: 'none',
    reminderCount: 0,
    createdAt: isoDaysAgo(12),
    updatedAt: nowIso(),
  };

  await getStore().transactWrite([
    { kind: 'put', item: commitmentItem(commitment) },
    {
      kind: 'update',
      ...keys.customer(shop.vendor.vendorId, shop.customer.customerId),
      add: { outstanding: amountPaise },
      set: { updatedAt: nowIso() },
    },
  ]);
}

describe('tool authorization', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'agent@test.app', shopName: 'Sharma Stores' });
  });

  it('refuses a tool that was not granted', async () => {
    await expect(
      runTool(
        'createReminder',
        {},
        // A caller granted only read tools.
        { vendorId: shop.vendor.vendorId, userId: shop.userId, allowed: new Set(['getInventory']) },
      ),
    ).rejects.toThrow(AppError);
  });

  it('grants customer sessions no tools at all', () => {
    expect(CUSTOMER_TOOLS.size).toBe(0);
  });

  it('exposes no tool that writes directly', () => {
    // Every tool is read-only or drafts-for-approval. Nothing in the agent's
    // reach mutates the ledger.
    const writable = TOOL_DEFINITIONS.filter(
      (definition) => definition.permission !== 'read' && definition.permission !== 'prepare-write',
    );
    expect(writable).toHaveLength(0);
  });

  it('scopes every tool to the caller own shop', async () => {
    const other = await createShop({ email: 'other@test.app', shopName: 'Gupta Hardware' });
    await createOverdueDebt(other, 90000);

    const result = await runTool(
      'getOutstandingPayments',
      {},
      { vendorId: shop.vendor.vendorId, userId: shop.userId, allowed: SHOPKEEPER_TOOLS },
    );

    expect(result.data.count).toBe(0);
  });

  // A khata is many small entries. "Customers who owe more than ₹500" is a
  // claim about a person's running balance, so four ₹200 bills must qualify
  // even though no single one reaches the threshold. Filtering per bill
  // answers "nobody owes you anything", which is both wrong and unrecoverable
  // — the shopkeeper simply never chases the debt.
  it('applies an amount threshold to the customer balance, not to each bill', async () => {
    await createOverdueDebt(shop, 20000);
    await createOverdueDebt(shop, 20000);
    await createOverdueDebt(shop, 20000);
    await createOverdueDebt(shop, 20000);

    const result = await runTool(
      'getOutstandingPayments',
      { minAmountRupees: 500 },
      { vendorId: shop.vendor.vendorId, userId: shop.userId, allowed: SHOPKEEPER_TOOLS },
    );

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(4);
    expect(result.data.totalOutstanding).toBe(80000);
  });

  it('still excludes a customer whose whole balance is under the threshold', async () => {
    await createOverdueDebt(shop, 20000);

    const result = await runTool(
      'getOutstandingPayments',
      { minAmountRupees: 500 },
      { vendorId: shop.vendor.vendorId, userId: shop.userId, allowed: SHOPKEEPER_TOOLS },
    );

    expect(result.ok).toBe(true);
    expect(result.data.count).toBe(0);
  });

  it('createReminder drafts without sending', async () => {
    await createOverdueDebt(shop, 60000);

    const result = await runTool(
      'createReminder',
      { minAmountRupees: 500, overdueOnly: true },
      { vendorId: shop.vendor.vendorId, userId: shop.userId, allowed: SHOPKEEPER_TOOLS },
    );

    expect(result.data.count).toBe(1);
    expect(result.summary).toContain('Prepared');

    // Nothing was recorded as a notification, because nothing was attempted.
    const sent = await notifications.list(shop.vendor.vendorId);
    expect(sent).toHaveLength(0);
  });
});

describe('agent run and confirm', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'agentrun@test.app', shopName: 'Sharma Stores' });
  });

  it('finds overdue customers and proposes reminders without sending', async () => {
    await createOverdueDebt(shop, 60000);

    const response = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'Find everyone who owes more than 500 and is overdue, and prepare payment reminders' },
    });

    expect(response.status).toBe(200);
    const run = response.body.run as {
      steps: Array<{ status: string }>;
      proposal: { actionId: string; effects: string[]; deliveryNote: string } | null;
    };

    expect(run.steps.length).toBeGreaterThan(1);
    expect(run.proposal).not.toBeNull();
    expect(run.proposal!.effects.length).toBe(1);

    // The delivery note is written before the user decides.
    expect(run.proposal!.deliveryNote).toContain('NOT sent');

    const sent = await notifications.list(shop.vendor.vendorId);
    expect(sent).toHaveLength(0);
  });

  it('records the proposal as an auditable action awaiting confirmation', async () => {
    await createOverdueDebt(shop, 60000);

    const response = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });

    const actionId = (response.body.run as { proposal: { actionId: string } }).proposal.actionId;
    const action = await aiActions.get(shop.vendor.vendorId, actionId);

    expect(action).not.toBeNull();
    expect(action!.status).toBe('awaiting_confirmation');
    expect(action!.requiresConfirmation).toBe(true);
    expect(action!.toolCalls).toContain('createReminder');
  });

  it('reports honestly that the mock provider delivered nothing', async () => {
    await createOverdueDebt(shop, 60000);

    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });
    const actionId = (run.body.run as { proposal: { actionId: string } }).proposal.actionId;

    const confirm = await request('POST', '/agent/confirm', {
      token: shop.token,
      body: { actionId },
    });

    expect(confirm.status).toBe(200);
    const execution = confirm.body.execution as {
      message: string;
      results: Array<{ ok: boolean; detail: string }>;
    };

    // The decisive assertion: the summary must not say "sent".
    expect(execution.message).toContain('Nothing was sent');
    expect(execution.results.every((result) => result.ok === false)).toBe(true);

    const recorded = await notifications.list(shop.vendor.vendorId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.status).toBe('not_delivered');
  });

  it('reports a real send when a provider does deliver', async () => {
    const delivering: NotificationProvider = {
      name: 'test-sms',
      channel: 'sms',
      async send() {
        return {
          ok: true,
          delivered: true,
          provider: 'test-sms',
          channel: 'sms',
          messageId: 'msg-1',
          detail: 'Accepted for delivery.',
        };
      },
    };
    setProvider(delivering);

    await createOverdueDebt(shop, 60000);
    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });
    const actionId = (run.body.run as { proposal: { actionId: string } }).proposal.actionId;

    const confirm = await request('POST', '/agent/confirm', {
      token: shop.token,
      body: { actionId },
    });

    const execution = confirm.body.execution as { message: string };
    expect(execution.message).toContain('1 reminder sent');
  });

  it('refuses to execute the same action twice', async () => {
    await createOverdueDebt(shop, 60000);

    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });
    const actionId = (run.body.run as { proposal: { actionId: string } }).proposal.actionId;

    await request('POST', '/agent/confirm', { token: shop.token, body: { actionId } });
    const replay = await request('POST', '/agent/confirm', { token: shop.token, body: { actionId } });

    expect(replay.status).toBe(409);
  });

  it('does not let one shop confirm another shop action', async () => {
    const attacker = await createShop({ email: 'attacker@test.app', shopName: 'Gupta Hardware' });
    await createOverdueDebt(shop, 60000);

    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });
    const actionId = (run.body.run as { proposal: { actionId: string } }).proposal.actionId;

    const response = await request('POST', '/agent/confirm', {
      token: attacker.token,
      body: { actionId },
    });

    expect(response.status).toBe(404);

    const sent = await notifications.list(shop.vendor.vendorId);
    expect(sent).toHaveLength(0);
  });

  it('cancelling sends nothing and records the decision', async () => {
    await createOverdueDebt(shop, 60000);

    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });
    const actionId = (run.body.run as { proposal: { actionId: string } }).proposal.actionId;

    const cancel = await request('POST', '/agent/cancel', {
      token: shop.token,
      body: { actionId },
    });

    expect(cancel.status).toBe(200);

    const action = await aiActions.get(shop.vendor.vendorId, actionId);
    expect(action!.status).toBe('cancelled');

    const sent = await notifications.list(shop.vendor.vendorId);
    expect(sent).toHaveLength(0);
  });

  it('logs read-only runs to the audit trail too', async () => {
    await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: "show today's sales" },
    });

    const actions = await aiActions.list(shop.vendor.vendorId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actionType).toBe('query');
    expect(actions[0]!.requiresConfirmation).toBe(false);
  });

  it('answers plainly when it cannot help', async () => {
    const response = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'book me a flight to Mumbai' },
    });

    const run = response.body.run as { message: string; proposal: unknown };
    expect(run.proposal).toBeNull();
    // It no longer complains about the wording — it looks through the shop's
    // records and reports that there is nothing there, which is a fact about
    // the data rather than an instruction to rephrase.
    expect(run.message).toMatch(/could not find|couldn't find/i);
    expect(run.message).not.toMatch(/mumbai|flight/i);
  });
});

/**
 * Questions the assistant has no *action* for.
 *
 * The planner covers a handful of things it can do — find overdue customers,
 * check stock, summarise sales. Anything else came back as "no matching
 * action", which is true and useless: the shopkeeper asked a real question
 * about their own shop and was told to rephrase it.
 *
 * Shop Memory already answers from the shop's own records and refuses when it
 * has no evidence, so the assistant answers through that rather than guessing.
 */
describe('answering from the shop, not from the world', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'ask@test.app', shopName: 'Sharma Stores' });

    await request('POST', '/transactions', {
      token: shop.token,
      body: {
        customerId: shop.customer.customerId,
        items: [
          { productId: shop.product.productId, name: 'Rice', quantity: 2, unit: 'kg', unitPrice: 6200 },
        ],
        paid: 12400,
        paymentMethod: 'cash',
      },
    });
  });

  const ask = async (instruction: string) => {
    const response = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction },
    });
    expect(response.status).toBe(200);
    return response.body.run as Record<string, unknown>;
  };

  it('looks a question up instead of refusing to understand it', async () => {
    const run = await ask(`what did ${shop.customer.name} buy`);

    expect(run.message as string).toContain('Rice');
    const labels = (run.steps as Array<{ label: string }>).map((step) => step.label);
    expect(labels.join(' ')).not.toContain('No matching action');
  });

  it('answers only from this shop, and says so when it cannot', async () => {
    // The one thing it must never do is answer from general knowledge. A
    // shopkeeper acting on an invented figure is worse off than one told
    // nothing.
    const run = await ask('what is the capital of France');

    expect(run.message as string).toMatch(/could not find|couldn't find/i);
    expect(run.message as string).not.toMatch(/paris/i);
  });

  it('never leaks another shop into the answer', async () => {
    // A distinct name, because the shop fixture gives every shop its own
    // Ramesh — matching on a shared name would prove nothing either way.
    const other = await createShop({ email: 'other@test.app', shopName: 'Gupta Traders' });
    await request('POST', '/customers', {
      token: other.token,
      body: { name: 'Lakshmi Venkataraman' },
    });

    const run = await ask('what did Lakshmi Venkataraman buy');
    expect(run.message as string).not.toContain('Lakshmi');
  });
});

/**
 * Where to go after an answer.
 *
 * A shopkeeper with a customer waiting will not type a follow-up question, so
 * an answer that ends with nothing to tap is where the conversation stops.
 */
describe('what to ask next', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'next@test.app', shopName: 'Sharma Stores' });
  });

  const ask = async (instruction: string) => {
    const response = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction },
    });
    return response.body.run as { followUps: string[]; proposal: unknown };
  };

  it('always offers somewhere to go', async () => {
    const run = await ask('who owes me money');
    expect(run.followUps.length).toBeGreaterThan(0);
  });

  it('follows from what was just looked up', async () => {
    const run = await ask('who owes me money');
    expect(run.followUps.join(' ').toLowerCase()).toContain('reminder');
  });

  it('does not offer back the question just asked', async () => {
    // Its answer is already on screen; suggesting it again is the one
    // suggestion guaranteed to be useless.
    const asked = "Show today's sales";
    const run = await ask(asked);

    expect(run.followUps.map((entry) => entry.toLowerCase())).not.toContain(asked.toLowerCase());
  });

  it('offers no distractions beside something awaiting a decision', async () => {
    const run = await ask('prepare payment reminders');
    if (run.proposal) expect(run.followUps).toEqual([]);
  });

  it('never repeats itself', async () => {
    const run = await ask('check which products are running low');
    expect(new Set(run.followUps).size).toBe(run.followUps.length);
  });
});

/**
 * Sending the same reminder twice.
 *
 * The action-status check stops one request being replayed, but not a
 * shopkeeper preparing a second batch a few minutes later over the same
 * customers — and a customer messaged twice about one debt reads as
 * harassment, not diligence.
 */
describe('not messaging the same customer twice', () => {
  let shop: TestShop;

  /** A provider that really "delivers", so the guard has something to see. */
  const delivering = {
    name: 'test-delivering',
    channel: 'whatsapp',
    async send() {
      return {
        ok: true,
        delivered: true,
        provider: 'test-delivering',
        channel: 'whatsapp',
        status: 'sent' as const,
        messageId: 'wamid.TEST',
        detail: 'Delivered to WhatsApp.',
      };
    },
  };

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'dupe@test.app', shopName: 'Sharma Stores' });
    setProvider(delivering);
  });

  afterEach(() => setProvider(null));

  const sendBatch = async () => {
    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });
    const proposal = (run.body.run as { proposal: { actionId: string } | null }).proposal;
    if (!proposal) return null;

    const confirm = await request('POST', '/agent/confirm', {
      token: shop.token,
      body: { actionId: proposal.actionId },
    });
    return confirm.body.execution as {
      results: Array<{ label: string; ok: boolean; detail: string }>;
    };
  };

  it('sends the first one', async () => {
    await createOverdueDebt(shop, 60000);
    const first = await sendBatch();

    expect(first!.results[0]!.ok).toBe(true);
  });

  it('does not send it again in the same afternoon', async () => {
    await createOverdueDebt(shop, 60000);
    await sendBatch();
    const second = await sendBatch();

    expect(second!.results[0]!.ok).toBe(false);
    expect(second!.results[0]!.detail).toMatch(/already sent/i);
  });

  it('records the second attempt rather than pretending it went', async () => {
    await createOverdueDebt(shop, 60000);
    await sendBatch();
    await sendBatch();

    // One delivery on the log, not two — the shopkeeper's record of what the
    // customer actually received has to match what they received.
    const log = await request('GET', '/payments/reminders', { token: shop.token });
    const sent = (log.body.reminders as Array<{ status: string }>).filter(
      (entry) => entry.status === 'sent',
    );
    expect(sent).toHaveLength(1);
  });
});

/**
 * Consent.
 *
 * Off by default, so a shop that has not turned it on is unaffected. Where it
 * is on, a reminder to someone who never agreed is not sent — and is still
 * recorded, because the shopkeeper needs to see that it was skipped and why.
 */
describe('only messaging customers who agreed', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'optin@test.app', shopName: 'Sharma Stores' });
  });

  it('sends without asking when opt-in is not required', async () => {
    // The default. A shop already using reminders must not find them stopped
    // the day it pulls this change.
    await createOverdueDebt(shop, 60000);

    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });
    const proposal = (run.body.run as { proposal: { actionId: string } | null }).proposal;
    expect(proposal).not.toBeNull();

    const confirm = await request('POST', '/agent/confirm', {
      token: shop.token,
      body: { actionId: proposal!.actionId },
    });
    const results = (confirm.body.execution as { results: Array<{ detail: string }> }).results;

    // The mock provider records rather than delivers, but nothing was skipped
    // for want of consent.
    expect(results[0]!.detail).not.toMatch(/opted in/i);
  });

  it('carries whether the customer agreed into the draft', async () => {
    await createOverdueDebt(shop, 60000);

    const run = await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });

    const action = (await aiActions.list(shop.vendor.vendorId, 10)).find(
      (entry) => entry.actionType === 'send_payment_reminders',
    );
    const drafts = (action!.result?.drafts ?? []) as Array<{ optedIn?: boolean }>;

    // Recorded whether or not it is enforced: consent is a fact about the
    // customer, not a setting.
    expect(drafts[0]).toHaveProperty('optedIn');
    void run;
  });
});

/**
 * Which number a reminder goes to.
 *
 * A shop whose customer gives one number for calls and another for WhatsApp
 * has both on file. Guessing that the calling number is the WhatsApp one is
 * how a stranger gets told about someone else's debt.
 */
describe('choosing the number', () => {
  let shop: TestShop;

  beforeEach(async () => {
    resetWorld();
    shop = await createShop({ email: 'number@test.app', shopName: 'Sharma Stores' });
  });

  it('prefers the WhatsApp number when the shop has recorded one', async () => {
    await customers.put({
      ...(await customers.require(shop.vendor.vendorId, shop.customer.customerId)),
      phone: '9812300022',
      whatsappPhone: '9998887770',
    });
    await createOverdueDebt(shop, 60000);

    await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });

    const action = (await aiActions.list(shop.vendor.vendorId, 10)).find(
      (entry) => entry.actionType === 'send_payment_reminders',
    );
    const drafts = (action!.result?.drafts ?? []) as Array<{ phone: string }>;
    expect(drafts[0]!.phone).toBe('9998887770');
  });

  it('falls back to the ordinary number, which is the usual case', async () => {
    await customers.put({
      ...(await customers.require(shop.vendor.vendorId, shop.customer.customerId)),
      phone: '9812300022',
      whatsappPhone: '',
    });
    await createOverdueDebt(shop, 60000);

    await request('POST', '/agent/run', {
      token: shop.token,
      body: { instruction: 'prepare payment reminders for overdue customers' },
    });

    const action = (await aiActions.list(shop.vendor.vendorId, 10)).find(
      (entry) => entry.actionType === 'send_payment_reminders',
    );
    const drafts = (action!.result?.drafts ?? []) as Array<{ phone: string }>;
    expect(drafts[0]!.phone).toBe('9812300022');
  });
});
