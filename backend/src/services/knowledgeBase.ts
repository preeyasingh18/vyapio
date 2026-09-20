import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { formatMoney } from '../utils/money';
import { lastMonthRange, monthRange, lastNDaysRange, withinRange } from '../utils/dates';
import { answerFromRecords } from './bedrock';
import {
  commitments as commitmentRepo,
  customers as customerRepo,
  orders as orderRepo,
  payments as paymentRepo,
  products as productRepo,
  transactions as transactionRepo,
} from './repository';
import { currentlyPending, settlementByTransaction, type Settlement } from './ledger';
import { MemoryAnswerSchema, type Citation, type MemoryAnswer } from '../schemas/ai';
import type { Commitment, Customer, Order, Payment, Product, Transaction } from '../schemas/entities';

/**
 * Shop Memory — grounded question answering.
 *
 * The rule that shapes this whole file: **retrieval decides what is true, the
 * model only decides how to say it.** Records are selected here, by code. They
 * become the citations rendered under the answer. The model is handed exactly
 * those records and is forbidden to add to them; if retrieval comes back empty,
 * there is no model call at all and the user is told plainly that the records
 * do not contain an answer.
 *
 * That ordering is why "What did Ramesh buy last month?" cannot invent a
 * purchase: the purchase either appears in the citation list or the answer says
 * it was not found.
 *
 * With BEDROCK_KNOWLEDGE_BASE_ID set, the Knowledge Base contributes additional
 * semantic matches over exported shop documents. It augments retrieval; it
 * never replaces the citation requirement.
 */

let client: BedrockAgentRuntimeClient | null = null;

function agentRuntime(): BedrockAgentRuntimeClient {
  client ??= new BedrockAgentRuntimeClient({ region: config.ai.region });
  return client;
}

export function isKnowledgeBaseEnabled(): boolean {
  return Boolean(config.ai.knowledgeBaseId);
}

/* ------------------------------------------------------- Question analysis */

type Intent = {
  /** Time window mentioned in the question, if any. */
  range: { from: string; to: string } | null;
  rangeLabel: string;
  /** Product words mentioned, normalised. */
  productTerms: string[];
  /** Customer name mentioned, if any. */
  customerTerm: string | null;
  wantsOutstanding: boolean;
  wantsSales: boolean;
  wantsReturns: boolean;
  wantsOrders: boolean;
  /** "who bought X and Y together" — needs co-occurrence in one basket. */
  wantsTogether: boolean;
};

const STOP_WORDS = new Set([
  'what','which','who','when','how','much','many','did','do','does','my','me','i','the','a','an',
  'from','to','of','in','on','at','for','and','or','is','are','was','were','buy','bought','sell',
  'sold','still','owe','owes','money','last','this','week','month','year','today','yesterday',
  'together','most','shop','customers','customer','products','product','show','tell','give','list',
  'get','find','all','any','been','being','with','that','have','has','had','it','they','them',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function analyse(question: string, catalogue: readonly Product[], people: readonly Customer[]): Intent {
  const lower = question.toLowerCase();
  const now = new Date();

  let range: { from: string; to: string } | null = null;
  let rangeLabel = '';

  if (/\blast month\b|\bpichhle mahine\b/.test(lower)) {
    range = lastMonthRange(now);
    rangeLabel = 'last month';
  } else if (/\bthis month\b|\bis mahine\b/.test(lower)) {
    range = monthRange(now);
    rangeLabel = 'this month';
  } else if (/\bthis week\b|\blast week\b|\bis hafte\b/.test(lower)) {
    range = lastNDaysRange(7, now);
    rangeLabel = 'in the last 7 days';
  } else if (/\btoday\b|\baaj\b/.test(lower)) {
    range = lastNDaysRange(1, now);
    rangeLabel = 'today';
  } else if (/\byesterday\b|\bkal\b/.test(lower)) {
    range = lastNDaysRange(2, now);
    rangeLabel = 'in the last two days';
  }

  // Product terms come from the shop's own catalogue, so "rice" matches the row
  // actually called "Rice (Basmati)". Individual words of a multi-word name are
  // matched too — people ask about "oil", not "cooking oil" — but only as whole
  // words, so "salt" does not match inside "asphalt".
  const productTerms: string[] = [];
  for (const product of catalogue) {
    const phrases = [product.name, ...product.aliases].map((entry) => entry.toLowerCase());
    const words = phrases
      .flatMap((phrase) => phrase.split(/\s+/))
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

    const matched =
      phrases.some((phrase) => phrase.length > 2 && lower.includes(phrase)) ||
      words.some((word) => new RegExp(`\\b${escapeRegex(word)}\\b`).test(lower));

    if (matched) productTerms.push(product.name);
  }

  let customerTerm: string | null = null;
  for (const person of people) {
    const first = person.name.toLowerCase().split(/\s+/)[0] ?? '';
    if (person.name.length > 2 && lower.includes(person.name.toLowerCase())) {
      customerTerm = person.name;
      break;
    }
    if (first.length > 2 && new RegExp(`\\b${first}\\b`).test(lower)) {
      customerTerm = person.name;
      break;
    }
  }

  return {
    range,
    rangeLabel,
    productTerms,
    customerTerm,
    wantsOutstanding: /\bowe|owes|pending|outstanding|udhaar|udhar|baaki|due\b/.test(lower),
    wantsSales: /\bsell|sold|sale|sales|revenue|earn|kamaya|business\b/.test(lower),
    wantsReturns: /\breturn|returned|wapas\b/.test(lower),
    wantsOrders: /\border|orders\b/.test(lower),
    wantsTogether: /\btogether|both|along with|saath\b/.test(lower),
  };
}

/* ---------------------------------------------------------------- Retrieval */

type Evidence = {
  transactions: Transaction[];
  payments: Payment[];
  commitments: Commitment[];
  orders: Order[];
  customers: Customer[];
  products: Product[];
  /**
   * Totals over EVERY matching balance, not just the sample in `commitments`.
   *
   * Retrieval is capped so the context stays small, but a money figure must
   * describe the whole book. Summing the sample and calling it "in total"
   * understates what the shop is owed — the one direction a shopkeeper must
   * never be misled in.
   */
  outstandingTotals: { customerCount: number; remaining: number } | null;
  /**
   * Current settlement state per sale, derived from Commitments. A
   * Transaction's own `outstanding` is frozen at the time of sale, so it must
   * never be shown as a live balance. See `settlementByTransaction`.
   */
  pending: Map<string, Settlement>;
};

function scoreTransaction(
  transaction: Transaction,
  intent: Intent,
  question: string,
  settlements: Map<string, Settlement>,
): number {
  let score = 0;

  if (intent.range && !withinRange(transaction.timestamp, intent.range)) return 0;
  if (intent.range) score += 2;

  if (intent.customerTerm) {
    if (transaction.customerName.toLowerCase() === intent.customerTerm.toLowerCase()) score += 5;
    else return 0; // A named customer is a hard filter, not a preference.
  }

  if (intent.productTerms.length > 0) {
    const names = transaction.items.map((item) => item.name.toLowerCase());
    const matched = intent.productTerms.filter((term) =>
      names.some((name) => name.includes(term.toLowerCase())),
    );
    if (intent.wantsTogether && intent.productTerms.length > 1) {
      // "rice and oil together" means one basket containing both.
      if (matched.length < intent.productTerms.length) return 0;
      score += 6;
    } else {
      if (matched.length === 0) return 0;
      score += 3 * matched.length;
    }
  }

  /**
   * Asked about money owed, a sale the customer has since cleared is not
   * evidence. Ranking on the frozen figure surfaced settled bills as though
   * they were still open — the assistant would have read them back as debts.
   */
  if (intent.wantsOutstanding && currentlyPending(transaction, settlements) > 0) score += 2;

  // Generic keyword overlap as a last resort for free-form questions.
  if (score === 0) {
    const words = question
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
    const haystack = `${transaction.customerName} ${transaction.items.map((i) => i.name).join(' ')} ${transaction.note}`.toLowerCase();
    score += words.filter((word) => haystack.includes(word)).length;
  }

  return score;
}

async function retrieve(vendorId: string, question: string, scopedCustomerId?: string): Promise<{
  evidence: Evidence;
  intent: Intent;
}> {
  const [allCustomers, catalogue] = await Promise.all([
    customerRepo.list(vendorId),
    productRepo.list(vendorId),
  ]);

  const intent = analyse(question, catalogue, allCustomers);

  const [allTransactions, allPayments, allCommitments, allOrders] = await Promise.all([
    scopedCustomerId
      ? transactionRepo.listForCustomer(scopedCustomerId, 200)
      : transactionRepo.list(vendorId, { limit: 400 }),
    scopedCustomerId
      ? paymentRepo.listForCustomer(scopedCustomerId, 100)
      : paymentRepo.list(vendorId, 200),
    scopedCustomerId
      ? commitmentRepo.listForCustomer(scopedCustomerId, 100)
      : commitmentRepo.list(vendorId, 300),
    scopedCustomerId
      ? orderRepo.listForCustomer(scopedCustomerId, 50)
      : orderRepo.list(vendorId, 100),
  ]);

  // Built from EVERY commitment, not just the matching ones: a sale shown as
  // evidence needs its true balance even when the question was not about money.
  const pending = settlementByTransaction(allCommitments);

  const scored = allTransactions
    .map((transaction) => ({
      transaction,
      score: scoreTransaction(transaction, intent, question, pending),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.transaction.timestamp.localeCompare(a.transaction.timestamp))
    .slice(0, 25)
    .map((entry) => entry.transaction);

  const matchingCommitments = intent.wantsOutstanding
    ? allCommitments
        .filter((commitment) => commitment.status === 'open' || commitment.status === 'partly_paid')
        .filter(
          (commitment) =>
            !intent.customerTerm ||
            commitment.customerName.toLowerCase() === intent.customerTerm.toLowerCase(),
        )
        .sort((a, b) => b.amount - a.amount)
    : [];

  // Totals come from the full match; only the evidence list below is capped.
  const outstandingTotals = intent.wantsOutstanding
    ? {
        customerCount: new Set(matchingCommitments.map((entry) => entry.customerName)).size,
        remaining: matchingCommitments.reduce(
          (sum, entry) => sum + (entry.amount - entry.settledAmount),
          0,
        ),
      }
    : null;

  const relevantCommitments = matchingCommitments.slice(0, 20);

  const relevantOrders = intent.wantsOrders
    ? allOrders.filter((order) => order.status !== 'cancelled').slice(0, 20)
    : [];

  const relevantPayments = intent.customerTerm
    ? allPayments
        .filter(
          (payment) => payment.customerName.toLowerCase() === intent.customerTerm!.toLowerCase(),
        )
        .slice(0, 20)
    : intent.wantsOutstanding
      ? allPayments.slice(0, 10)
      : [];

  const relevantCustomers = intent.wantsOutstanding
    ? allCustomers.filter((customer) => customer.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 20)
    : intent.customerTerm
      ? allCustomers.filter((customer) => customer.name === intent.customerTerm)
      : [];

  return {
    intent,
    evidence: {
      transactions: scored,
      payments: relevantPayments,
      commitments: relevantCommitments,
      orders: relevantOrders,
      customers: relevantCustomers,
      products: intent.productTerms.length
        ? catalogue.filter((product) => intent.productTerms.includes(product.name))
        : [],
      outstandingTotals,
      pending,
    },
  };
}

/* --------------------------------------------------------------- Citations */

function toCitations(evidence: Evidence): Citation[] {
  const citations: Citation[] = [];

  for (const transaction of evidence.transactions.slice(0, 12)) {
    const stillPending = currentlyPending(transaction, evidence.pending);
    citations.push({
      kind: 'transaction',
      id: transaction.transactionId,
      label: `${transaction.customerName || 'Walk-in'} — ${transaction.items.map((item) => item.name).join(', ')}`,
      detail:
        stillPending > 0
          ? `${formatMoney(transaction.total)} · ${formatMoney(stillPending)} pending`
          : `${formatMoney(transaction.total)} · paid`,
      amount: transaction.total,
      timestamp: transaction.timestamp,
      href: `/app/customers/${transaction.customerId}`,
    });
  }

  for (const commitment of evidence.commitments.slice(0, 10)) {
    citations.push({
      kind: 'commitment',
      id: commitment.commitmentId,
      label: `${commitment.customerName} owes ${formatMoney(commitment.amount - commitment.settledAmount)}`,
      detail: commitment.description || `Due ${commitment.dueDate.slice(0, 10)}`,
      amount: commitment.amount - commitment.settledAmount,
      timestamp: commitment.dueDate,
      href: `/app/customers/${commitment.customerId}`,
    });
  }

  for (const order of evidence.orders.slice(0, 8)) {
    citations.push({
      kind: 'order',
      id: order.orderId,
      label: `${order.customerName} — ${order.items.length} item${order.items.length === 1 ? '' : 's'}`,
      detail: `${order.status} · ${formatMoney(order.total)}`,
      amount: order.total,
      timestamp: order.createdAt,
      href: '/app/orders',
    });
  }

  for (const payment of evidence.payments.slice(0, 6)) {
    citations.push({
      kind: 'payment',
      id: payment.paymentId,
      label: `${payment.customerName} paid ${formatMoney(payment.amount)}`,
      detail: payment.method.toUpperCase(),
      amount: payment.amount,
      timestamp: payment.timestamp,
      href: `/app/customers/${payment.customerId}`,
    });
  }

  return citations;
}

/** The exact text handed to the model. Nothing else is in scope for it. */
function renderEvidence(evidence: Evidence): string {
  const blocks: string[] = [];

  if (evidence.transactions.length > 0) {
    blocks.push(
      'SALES:\n' +
        evidence.transactions
          .map((transaction) => {
            // Settled to date, not "paid at the counter that day" — the two
            // diverge once a Commitment has been paid off, and a question about
            // the shop right now always means the former.
            const stillPending = currentlyPending(transaction, evidence.pending);
            return (
              `- ${transaction.timestamp.slice(0, 10)} | ${transaction.customerName || 'Walk-in'} | ` +
              `${transaction.items.map((item) => `${item.quantity}${item.unit === 'unit' ? '' : ' ' + item.unit} ${item.name}`).join(', ')} | ` +
              `total ${formatMoney(transaction.total)} | ` +
              `paid ${formatMoney(transaction.total - stillPending)} | ` +
              `pending ${formatMoney(stillPending)}`
            );
          })
          .join('\n'),
    );
  }

  if (evidence.commitments.length > 0) {
    const totals = evidence.outstandingTotals;
    if (totals) {
      blocks.push(
        'UNPAID BALANCES - TOTALS (authoritative, use these figures):' + '\n' +
          `- ${totals.customerCount} customers owe ${formatMoney(totals.remaining)} in total` + '\n' +
          `- the list below shows only the largest ${evidence.commitments.length}; do not re-add it`,
      );
    }
    blocks.push(
      'UNPAID BALANCES:\n' +
        evidence.commitments
          .map(
            (commitment) =>
              `- ${commitment.customerName} owes ${formatMoney(commitment.amount - commitment.settledAmount)}, due ${commitment.dueDate.slice(0, 10)} (${commitment.status})`,
          )
          .join('\n'),
    );
  }

  if (evidence.payments.length > 0) {
    blocks.push(
      'PAYMENTS RECEIVED:\n' +
        evidence.payments
          .map(
            (payment) =>
              `- ${payment.timestamp.slice(0, 10)} | ${payment.customerName} paid ${formatMoney(payment.amount)} by ${payment.method}`,
          )
          .join('\n'),
    );
  }

  if (evidence.orders.length > 0) {
    blocks.push(
      'ORDERS:\n' +
        evidence.orders
          .map(
            (order) =>
              `- ${order.customerName} | ${order.items.map((item) => item.name).join(', ')} | ${order.status} | ${formatMoney(order.total)}`,
          )
          .join('\n'),
    );
  }

  if (evidence.products.length > 0) {
    blocks.push(
      'PRODUCTS:\n' +
        evidence.products
          .map(
            (product) =>
              `- ${product.name} | ${product.stock} ${product.unit} in stock | sells at ${formatMoney(product.sellingPrice)}`,
          )
          .join('\n'),
    );
  }

  return blocks.join('\n\n');
}

/* --------------------------------------------- Deterministic fallback answer */

/**
 * Summarises the retrieved records without a model.
 *
 * Used when Bedrock is unavailable. Less fluent, equally true — and it keeps
 * Shop Memory working in local mode, which is most of the point.
 */
function summariseDeterministically(intent: Intent, evidence: Evidence): string {
  const parts: string[] = [];
  const when = intent.rangeLabel ? ` ${intent.rangeLabel}` : '';

  if (intent.wantsOutstanding && evidence.commitments.length > 0) {
    const totals = evidence.outstandingTotals;
    const total =
      totals?.remaining ??
      evidence.commitments.reduce(
        (sum, commitment) => sum + (commitment.amount - commitment.settledAmount),
        0,
      );
    const names = [...new Set(evidence.commitments.map((commitment) => commitment.customerName))];
    const count = totals?.customerCount ?? names.length;
    const shown = names.slice(0, 5);
    const rest = count - shown.length;
    parts.push(
      `${count} customer${count === 1 ? '' : 's'} owe${count === 1 ? 's' : ''} ${formatMoney(total)} in total: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`,
    );
  }

  // When the question was about money owed and the balances answered it, the
  // generic "found N sales" sentence adds nothing and reads like padding.
  const answeredByBalances = intent.wantsOutstanding && parts.length > 0;

  if (evidence.transactions.length > 0 && !answeredByBalances) {
    const total = evidence.transactions.reduce((sum, transaction) => sum + transaction.total, 0);
    const itemNames = [
      ...new Set(evidence.transactions.flatMap((transaction) => transaction.items.map((item) => item.name))),
    ];

    if (intent.customerTerm) {
      parts.push(
        `${intent.customerTerm} bought ${itemNames.slice(0, 6).join(', ')} across ${evidence.transactions.length} purchase${evidence.transactions.length === 1 ? '' : 's'}${when}, worth ${formatMoney(total)}.`,
      );
    } else if (intent.wantsTogether && intent.productTerms.length > 1) {
      const names = [...new Set(evidence.transactions.map((transaction) => transaction.customerName))].filter(Boolean);
      parts.push(
        `${names.length} customer${names.length === 1 ? '' : 's'} bought ${intent.productTerms.join(' and ')} in the same purchase: ${names.slice(0, 6).join(', ')}.`,
      );
    } else if (intent.wantsSales) {
      parts.push(
        `${evidence.transactions.length} sale${evidence.transactions.length === 1 ? '' : 's'}${when} totalling ${formatMoney(total)}.`,
      );
    } else {
      parts.push(
        `Found ${evidence.transactions.length} matching sale${evidence.transactions.length === 1 ? '' : 's'}${when}, worth ${formatMoney(total)}.`,
      );
    }
  }

  if (evidence.orders.length > 0) {
    const ready = evidence.orders.filter((order) => order.status === 'ready');
    if (ready.length > 0) {
      parts.push(`${ready.length} order${ready.length === 1 ? ' is' : 's are'} ready for pickup.`);
    }
  }

  return parts.join(' ');
}

/* ----------------------------------------------------- Knowledge Base hook */

/**
 * Optional semantic recall over documents exported to the Knowledge Base.
 *
 * Retrieve (not RetrieveAndGenerate) is used deliberately: passages come back
 * as evidence to be filtered and cited here, rather than as an answer produced
 * somewhere we cannot inspect.
 */
async function retrieveFromKnowledgeBase(
  vendorId: string,
  question: string,
): Promise<string[]> {
  if (!isKnowledgeBaseEnabled()) return [];
  try {
    const response = await agentRuntime().send(
      new RetrieveCommand({
        knowledgeBaseId: config.ai.knowledgeBaseId!,
        retrievalQuery: { text: question },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 8,
            // Tenant isolation inside the shared vector index.
            filter: { equals: { key: 'vendorId', value: vendorId } },
          },
        },
      }),
    );
    return (response.retrievalResults ?? [])
      .map((result) => result.content?.text ?? '')
      .filter((text) => text.length > 0);
  } catch (error) {
    logger.warn('knowledge base retrieval failed', {
      operation: 'knowledgeBase.retrieve',
      vendorId,
      error,
    });
    return [];
  }
}

/* ------------------------------------------------------------------ Answer */

export const NOT_ENOUGH_INFORMATION = "I couldn't find enough information in your shop records.";

export async function answerQuestion(input: {
  vendorId: string;
  question: string;
  /** Restricts retrieval to one customer — used by the customer app. */
  scopedCustomerId?: string;
}): Promise<MemoryAnswer> {
  const startedAt = Date.now();
  const { evidence, intent } = await retrieve(
    input.vendorId,
    input.question,
    input.scopedCustomerId,
  );

  const citations = toCitations(evidence);
  const kbPassages = await retrieveFromKnowledgeBase(input.vendorId, input.question);

  // No evidence means no answer. The model is not consulted at all, so there is
  // nothing for it to fill the silence with.
  if (citations.length === 0 && kbPassages.length === 0) {
    logger.info('memory question unanswered', {
      operation: 'knowledgeBase.answerQuestion',
      vendorId: input.vendorId,
      durationMs: Date.now() - startedAt,
    });
    return MemoryAnswerSchema.parse({
      question: input.question,
      answer: NOT_ENOUGH_INFORMATION,
      grounded: false,
      citations: [],
      engine: isKnowledgeBaseEnabled() ? 'knowledge-base' : 'local-retrieval',
    });
  }

  const records = [renderEvidence(evidence), ...kbPassages].filter(Boolean).join('\n\n');
  const generated = await answerFromRecords({
    question: input.question,
    records,
    operation: 'knowledgeBase.answerQuestion',
  });

  const deterministic = summariseDeterministically(intent, evidence);

  // If the model declined, or produced nothing, use the deterministic summary
  // rather than showing an empty answer next to a list of real records.
  const modelDeclined =
    !generated || generated.toLowerCase().includes("couldn't find enough information");
  const answer = modelDeclined ? deterministic || NOT_ENOUGH_INFORMATION : generated;

  logger.info('memory question answered', {
    operation: 'knowledgeBase.answerQuestion',
    vendorId: input.vendorId,
    durationMs: Date.now() - startedAt,
    citationCount: citations.length,
    engine: generated ? 'bedrock' : 'local-retrieval',
  });

  return MemoryAnswerSchema.parse({
    question: input.question,
    answer,
    grounded: answer !== NOT_ENOUGH_INFORMATION,
    citations,
    engine: generated
      ? 'bedrock'
      : isKnowledgeBaseEnabled()
        ? 'knowledge-base'
        : 'local-retrieval',
  });
}

/** Test seam. */
export function setAgentRuntimeClient(next: BedrockAgentRuntimeClient | null): void {
  client = next;
}
