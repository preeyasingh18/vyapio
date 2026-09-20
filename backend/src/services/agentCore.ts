import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolInputSchema,
} from '@aws-sdk/client-bedrock-runtime';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { randomId } from '../utils/ids';
import { formatMoney } from '../utils/money';
import { isBedrockEnabled } from './bedrock';
import { answerQuestion } from './knowledgeBase';
import { runTool, TOOL_DEFINITIONS, type ToolContext, type ToolResult } from './agentTools';
import type { AgentStep, AgentToolName, Citation } from '../schemas/ai';

/**
 * The agent runtime.
 *
 * Three planners, one contract. Whichever runs, it can only reach the shop
 * through `runTool`, it produces the same step list for the transparency panel,
 * and it cannot perform a side effect — side effects live behind the
 * confirmation gate in routes/agent.ts.
 *
 *   AgentCore       AGENTCORE_RUNTIME_ARN set. The deployed agent runtime
 *                   plans; tool calls come back here to execute against this
 *                   vendor's data, so authorization stays on our side of the
 *                   boundary.
 *   Bedrock tools   BEDROCK_ENABLED=true. A Converse tool-use loop in this
 *                   process, bounded to MAX_TURNS.
 *   Local planner   Neither configured. Rule-based intent matching over the
 *                   same tools, so the agent demo works offline.
 *
 * Swapping planners changes how well instructions are understood. It never
 * changes what the agent is permitted to do.
 */

/** Hard bound on the tool-use loop, so a confused model cannot spin. */
const MAX_TURNS = 6;

let bedrockClient: BedrockRuntimeClient | null = null;
let agentCoreClient: BedrockAgentCoreClient | null = null;

function bedrock(): BedrockRuntimeClient {
  bedrockClient ??= new BedrockRuntimeClient({ region: config.ai.region, maxAttempts: 3 });
  return bedrockClient;
}

function agentCore(): BedrockAgentCoreClient {
  agentCoreClient ??= new BedrockAgentCoreClient({ region: config.ai.region, maxAttempts: 2 });
  return agentCoreClient;
}

export type PlannerEngine = 'agentcore' | 'bedrock-tools' | 'local-planner';

export function selectEngine(): PlannerEngine {
  if (config.ai.agentRuntimeArn) return 'agentcore';
  if (isBedrockEnabled()) return 'bedrock-tools';
  return 'local-planner';
}

export type PlanResult = {
  engine: PlannerEngine;
  understood: string;
  steps: AgentStep[];
  message: string;
  citations: Citation[];
  /** Results keyed by tool, used to build the confirmation proposal. */
  toolResults: Partial<Record<AgentToolName, ToolResult>>;
  toolCalls: AgentToolName[];
};

const AGENT_SYSTEM = `You are Vyapio's assistant for an Indian neighbourhood shopkeeper.

You help by calling the tools provided. Rules:
- Use tools to get facts. Never state a number you did not get from a tool.
- Amounts from tools are already formatted in rupees. Repeat them exactly.
- createReminder only DRAFTS messages. It never sends. Say "prepared", not "sent".
- When you have what you need, reply in 1-3 short sentences. Lead with the answer.
- If no tool returns anything useful, say so plainly.
- Never mention tools, JSON or internal mechanics. Speak like a helpful colleague.`;

/* ------------------------------------------------------------ Step helpers */

function step(label: string, status: AgentStep['status'], extra: Partial<AgentStep> = {}): AgentStep {
  return { id: `stp_${randomId(8)}`, label, status, detail: '', ...extra };
}

/* --------------------------------------------------------- Bedrock planner */

function toBedrockTools(): Tool[] {
  return TOOL_DEFINITIONS.map((definition) => ({
    toolSpec: {
      name: definition.name,
      description: definition.description,
      inputSchema: { json: definition.parameters } as ToolInputSchema,
    },
  }));
}

async function planWithBedrock(
  instruction: string,
  context: ToolContext,
): Promise<Omit<PlanResult, 'engine' | 'citations'>> {
  const steps: AgentStep[] = [step('Understanding your request', 'done')];
  const toolResults: Partial<Record<AgentToolName, ToolResult>> = {};
  const toolCalls: AgentToolName[] = [];
  const messages: Message[] = [{ role: 'user', content: [{ text: instruction }] }];

  let message = '';

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await bedrock().send(
      new ConverseCommand({
        modelId: config.ai.modelId,
        system: [{ text: AGENT_SYSTEM }],
        messages,
        toolConfig: { tools: toBedrockTools() },
        inferenceConfig: { maxTokens: config.ai.maxTokens, temperature: 0 },
      }),
    );

    const blocks: ContentBlock[] = response.output?.message?.content ?? [];
    const text = blocks
      .map((block) => ('text' in block && block.text ? block.text : ''))
      .join('')
      .trim();
    if (text) message = text;

    const toolUses = blocks
      .map((block) => ('toolUse' in block ? block.toolUse : undefined))
      .filter((use): use is NonNullable<typeof use> => Boolean(use));

    if (toolUses.length === 0 || response.stopReason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: blocks });

    const toolResultBlocks: ContentBlock[] = [];
    for (const use of toolUses) {
      const name = use.name as AgentToolName;
      const args = (use.input ?? {}) as Record<string, unknown>;
      const running = step(labelForTool(name), 'running', { tool: name });
      steps.push(running);

      try {
        const result = await runTool(name, args, context);
        toolResults[name] = result;
        toolCalls.push(name);
        running.status = 'done';
        running.detail = result.summary;
        toolResultBlocks.push({
          toolResult: {
            toolUseId: use.toolUseId!,
            content: [{ text: JSON.stringify({ summary: result.summary, ...result.data }) }],
            status: result.ok ? 'success' : 'error',
          },
        });
      } catch (error) {
        running.status = 'failed';
        running.detail = error instanceof Error ? error.message : 'Tool failed';
        toolResultBlocks.push({
          toolResult: {
            toolUseId: use.toolUseId!,
            content: [{ text: 'That tool is not permitted or failed.' }],
            status: 'error',
          },
        });
      }
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  return {
    understood: instruction,
    steps,
    message: message || 'I looked into that but could not find anything to report.',
    toolResults,
    toolCalls,
  };
}

/* -------------------------------------------------------- AgentCore planner */

/**
 * Invokes a deployed AgentCore runtime.
 *
 * Tool *execution* deliberately stays here rather than inside the runtime: the
 * vendorId comes from this request's session, so authorization cannot be
 * influenced by anything the agent decides.
 */
async function planWithAgentCore(
  instruction: string,
  context: ToolContext,
): Promise<Omit<PlanResult, 'engine' | 'citations'>> {
  const steps: AgentStep[] = [step('Understanding your request', 'done')];

  try {
    const response = await agentCore().send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: config.ai.agentRuntimeArn!,
        // Session scoping keeps one shop's conversation out of another's.
        runtimeSessionId: `${context.vendorId}-${randomId(12)}`,
        payload: new TextEncoder().encode(
          JSON.stringify({
            instruction,
            availableTools: TOOL_DEFINITIONS.map((definition) => ({
              name: definition.name,
              description: definition.description,
              parameters: definition.parameters,
            })),
          }),
        ),
      }),
    );

    const raw = response.response ? await collectBody(response.response) : '';
    const parsed = JSON.parse(raw) as {
      message?: string;
      toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
    };

    const toolResults: Partial<Record<AgentToolName, ToolResult>> = {};
    const toolCalls: AgentToolName[] = [];

    for (const call of parsed.toolCalls ?? []) {
      const name = call.name as AgentToolName;
      const running = step(labelForTool(name), 'running', { tool: name });
      steps.push(running);
      try {
        const result = await runTool(name, call.arguments ?? {}, context);
        toolResults[name] = result;
        toolCalls.push(name);
        running.status = 'done';
        running.detail = result.summary;
      } catch (error) {
        running.status = 'failed';
        running.detail = error instanceof Error ? error.message : 'Tool failed';
      }
    }

    return {
      understood: instruction,
      steps,
      message: parsed.message ?? 'Done.',
      toolResults,
      toolCalls,
    };
  } catch (error) {
    logger.warn('agentcore invoke failed, falling back', {
      operation: 'agentCore.plan',
      vendorId: context.vendorId,
      error,
    });
    return planLocally(instruction, context);
  }
}

async function collectBody(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  // Streaming response body.
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/* ------------------------------------------------------------ Local planner */

type Rule = {
  test: RegExp;
  tools: Array<{ name: AgentToolName; args: (instruction: string) => Record<string, unknown> }>;
  understood: string;
};

/** Pulls the first rupee amount out of an instruction: "more than ₹500" → 500. */
function amountFrom(instruction: string): number | null {
  const match = /(?:₹|rs\.?|rupees?\s*)?(\d[\d,]*)/i.exec(instruction.replace(/,/g, ''));
  return match?.[1] ? Number(match[1]) : null;
}

function daysFrom(instruction: string): number {
  const lower = instruction.toLowerCase();
  if (/\btoday\b|\baaj\b/.test(lower)) return 1;
  if (/\bweek\b|\bhafte\b/.test(lower)) return 7;
  if (/\bmonth\b|\bmahine\b/.test(lower)) return 30;
  const match = /(\d+)\s*days?/.exec(lower);
  return match?.[1] ? Number(match[1]) : 1;
}

const RULES: Rule[] = [
  {
    // The headline flow: overdue customers plus drafted reminders.
    test: /\b(remind|reminder|reminders|chase|follow up)\b/i,
    understood: 'Find customers who owe money and prepare payment reminders',
    tools: [
      {
        name: 'getOutstandingPayments',
        args: (instruction) => ({
          minAmountRupees: amountFrom(instruction) ?? 0,
          overdueOnly: /\boverdue|late|past due\b/i.test(instruction),
        }),
      },
      {
        name: 'createReminder',
        args: (instruction) => ({
          minAmountRupees: amountFrom(instruction) ?? 0,
          overdueOnly: /\boverdue|late|past due\b/i.test(instruction),
        }),
      },
    ],
  },
  {
    test: /\b(owe|owes|owing|overdue|outstanding|pending|udhaar|udhar|baaki|due)\b/i,
    understood: 'Find customers with unpaid balances',
    tools: [
      {
        name: 'getOutstandingPayments',
        args: (instruction) => ({
          minAmountRupees: amountFrom(instruction) ?? 0,
          overdueOnly: /\boverdue|late|past due\b/i.test(instruction),
        }),
      },
    ],
  },
  {
    test: /\b(restock|reorder|order more|purchase list|buy more)\b/i,
    understood: 'Prepare a restock list',
    tools: [{ name: 'prepareRestockList', args: () => ({ daysOfCover: 14 }) }],
  },
  {
    test: /\b(stock|inventory|running low|low stock|khatam)\b/i,
    understood: 'Check stock levels',
    tools: [
      {
        name: 'getInventory',
        args: (instruction) => ({ lowStockOnly: /\blow|running out|khatam\b/i.test(instruction) }),
      },
    ],
  },
  {
    test: /\b(sales|sold|revenue|business|earning|today.s sales|kamaya)\b/i,
    understood: "Summarise sales",
    tools: [{ name: 'getSalesSummary', args: (instruction) => ({ days: daysFrom(instruction) }) }],
  },
  {
    test: /\b(bought|purchase|purchases|history|last buy|kharida)\b/i,
    understood: 'Look up purchase history',
    tools: [
      {
        name: 'getTransactions',
        args: (instruction) => ({ days: daysFrom(instruction) === 1 ? 60 : daysFrom(instruction) }),
      },
    ],
  },
];

async function planLocally(
  instruction: string,
  context: ToolContext,
): Promise<Omit<PlanResult, 'engine' | 'citations'>> {
  const steps: AgentStep[] = [step('Understanding your request', 'done')];
  const toolResults: Partial<Record<AgentToolName, ToolResult>> = {};
  const toolCalls: AgentToolName[] = [];

  // A name in the instruction is worth resolving before anything else.
  const rule = RULES.find((candidate) => candidate.test.test(instruction));

  /**
   * Nothing to *do* — so answer instead of giving up.
   *
   * The rules above cover the handful of things the assistant can act on.
   * Anything else used to come back as "no matching action", which is true and
   * useless: the shopkeeper asked a real question about their own shop and was
   * told to rephrase it.
   *
   * Shop Memory already answers free-form questions from the shop's own
   * records, and refuses when it has no evidence rather than inventing one.
   * Routing here reuses that instead of teaching the assistant to guess.
   */
  if (!rule) {
    const looking = step('Looking through your shop records', 'running');
    steps.push(looking);
    const startedAt = Date.now();

    const answer = await answerQuestion({
      vendorId: context.vendorId,
      question: instruction,
    });
    looking.durationMs = Date.now() - startedAt;

    if (answer.grounded) {
      looking.status = 'done';
      looking.detail = `${answer.citations.length} record(s) from your shop`;
      return {
        understood: instruction,
        steps,
        message: answer.answer,
        toolResults,
        toolCalls,
      };
    }

    // Still nothing — but say so as "your shop has no record of this", which is
    // a fact about the data, not a complaint about the wording.
    looking.status = 'skipped';
    looking.detail = 'Nothing in your shop records matches this.';
    return {
      understood: instruction,
      steps,
      message:
        answer.answer ||
        "I could not find anything about that in your shop's records. I only answer from your own sales, customers and stock.",
      toolResults,
      toolCalls,
    };
  }

  const summaries: string[] = [];
  for (const toolSpec of rule.tools) {
    const running = step(labelForTool(toolSpec.name), 'running', { tool: toolSpec.name });
    steps.push(running);
    const startedAt = Date.now();
    try {
      const result = await runTool(toolSpec.name, toolSpec.args(instruction), context);
      toolResults[toolSpec.name] = result;
      toolCalls.push(toolSpec.name);
      running.status = 'done';
      running.detail = result.summary;
      running.durationMs = Date.now() - startedAt;
      summaries.push(result.summary);
    } catch (error) {
      running.status = 'failed';
      running.detail = error instanceof Error ? error.message : 'Tool failed';
      running.durationMs = Date.now() - startedAt;
    }
  }

  return {
    understood: rule.understood,
    steps,
    message: summaries.join(' ') || 'I could not find anything for that.',
    toolResults,
    toolCalls,
  };
}

/* ----------------------------------------------------------------- Labels */

function labelForTool(name: AgentToolName): string {
  const labels: Record<AgentToolName, string> = {
    getCustomer: 'Looking up the customer',
    searchCustomers: 'Searching customers',
    getTransactions: 'Reading recent sales',
    getOutstandingPayments: 'Checking outstanding balances',
    getInventory: 'Checking stock',
    getSalesSummary: 'Adding up sales',
    prepareRestockList: 'Preparing a restock list',
    createReminder: 'Preparing reminders',
  };
  return labels[name] ?? name;
}

/* -------------------------------------------------------------- Citations */

/** Turns tool output into the evidence list shown beneath the agent's answer. */
export function citationsFrom(toolResults: Partial<Record<AgentToolName, ToolResult>>): Citation[] {
  const citations: Citation[] = [];

  const outstanding = toolResults.getOutstandingPayments?.data.commitments;
  if (Array.isArray(outstanding)) {
    /**
     * One row per customer, not per bill.
     *
     * The threshold is applied to a customer's running balance, so asking for
     * "everyone who owes more than ₹500" keeps every bill belonging to those
     * customers — including a ₹32 one. Listing those bills individually makes
     * the answer look like it ignored the threshold it just applied. The
     * evidence has to be stated at the same grain as the question.
     */
    const byCustomer = new Map<
      string,
      { name: string; total: number; bills: number; worstOverdue: number; dueDate: string }
    >();

    for (const entry of outstanding as Array<Record<string, unknown>>) {
      const customerId = String(entry.customerId);
      const remaining = Number(entry.remaining);
      const daysOverdue = Number(entry.daysOverdue);
      const existing = byCustomer.get(customerId);

      if (existing) {
        existing.total += remaining;
        existing.bills += 1;
        if (daysOverdue > existing.worstOverdue) {
          existing.worstOverdue = daysOverdue;
          existing.dueDate = String(entry.dueDate);
        }
      } else {
        byCustomer.set(customerId, {
          name: String(entry.customerName),
          total: remaining,
          bills: 1,
          worstOverdue: daysOverdue,
          dueDate: String(entry.dueDate),
        });
      }
    }

    const ranked = [...byCustomer.entries()].sort((a, b) => b[1].total - a[1].total);

    for (const [customerId, summary] of ranked.slice(0, 10)) {
      const billsNote = summary.bills > 1 ? ` · ${summary.bills} bills` : '';
      citations.push({
        kind: 'commitment',
        id: customerId,
        label: `${summary.name} owes ${formatMoney(summary.total)}`,
        detail:
          summary.worstOverdue > 0
            ? `${summary.worstOverdue} days overdue${billsNote}`
            : `Due ${summary.dueDate.slice(0, 10)}${billsNote}`,
        amount: summary.total,
        timestamp: summary.dueDate,
        href: `/app/customers/${customerId}`,
      });
    }
  }

  const restock = toolResults.prepareRestockList?.data.lines;
  if (Array.isArray(restock)) {
    for (const entry of restock.slice(0, 10) as Array<Record<string, unknown>>) {
      citations.push({
        kind: 'product',
        id: String(entry.productId),
        label: `${String(entry.name)} — buy ${Number(entry.suggestedQuantity)} ${String(entry.unit)}`,
        detail: `${Number(entry.currentStock)} left · about ${formatMoney(Number(entry.estimatedCost))}`,
        amount: Number(entry.estimatedCost),
        href: '/app/inventory',
      });
    }
  }

  const transactions = toolResults.getTransactions?.data.transactions;
  if (Array.isArray(transactions)) {
    for (const entry of transactions.slice(0, 8) as Array<Record<string, unknown>>) {
      const items = entry.items as Array<{ name: string }> | undefined;
      citations.push({
        kind: 'transaction',
        id: String(entry.transactionId),
        label: `${String(entry.customerName)} — ${(items ?? []).map((item) => item.name).join(', ')}`,
        detail: formatMoney(Number(entry.total)),
        amount: Number(entry.total),
        timestamp: String(entry.timestamp),
        href: `/app/customers/${String(entry.customerId)}`,
      });
    }
  }

  return citations;
}

/* ------------------------------------------------------------------ Facade */

export async function plan(instruction: string, context: ToolContext): Promise<PlanResult> {
  const engine = selectEngine();
  const startedAt = Date.now();

  let result: Omit<PlanResult, 'engine' | 'citations'>;
  try {
    if (engine === 'agentcore') result = await planWithAgentCore(instruction, context);
    else if (engine === 'bedrock-tools') result = await planWithBedrock(instruction, context);
    else result = await planLocally(instruction, context);
  } catch (error) {
    // Planning must degrade, not fail: the shopkeeper still gets an answer.
    logger.warn('planner failed, falling back to local planner', {
      operation: 'agentCore.plan',
      vendorId: context.vendorId,
      engine,
      error,
    });
    result = await planLocally(instruction, context);
    return { ...result, engine: 'local-planner', citations: citationsFrom(result.toolResults) };
  }

  logger.info('agent run complete', {
    operation: 'agentCore.plan',
    vendorId: context.vendorId,
    userId: context.userId,
    engine,
    durationMs: Date.now() - startedAt,
    toolCount: result.toolCalls.length,
  });

  return { ...result, engine, citations: citationsFrom(result.toolResults) };
}

/** Test seams. */
export function setAgentClients(
  next: { bedrock?: BedrockRuntimeClient | null; agentCore?: BedrockAgentCoreClient | null } = {},
): void {
  if (next.bedrock !== undefined) bedrockClient = next.bedrock;
  if (next.agentCore !== undefined) agentCoreClient = next.agentCore;
}
