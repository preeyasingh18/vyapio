import { z } from 'zod';
import { LanguageSchema, PaymentMethodSchema } from './common';
import { LineItemSchema } from './entities';

/**
 * Schemas for everything a model produces.
 *
 * Nothing a model emits is trusted. Model output is parsed by these schemas
 * before it touches any domain function, and even after parsing it only ever
 * becomes a *draft* that a human confirms. The pipeline is:
 *
 *   speech → transcript → extraction → schema validation → draft
 *     → human confirmation → domain logic → database → event → insight
 *
 * There is no path from a model to a write that skips the confirmation step.
 */

/* ------------------------------------------------ Voice transaction parsing */

export const ExtractedItemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  quantity: z.number().positive().max(100_000).default(1),
  unit: z.string().trim().max(16).default('unit'),
  /**
   * Rupees, not paise — this is what a person says out loud. Converted to
   * integer paise the moment it crosses into the domain layer.
   */
  unitPriceRupees: z.number().min(0).max(10_000_000).nullable().default(null),
});
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

export const ExtractedTransactionSchema = z.object({
  customer: z.string().trim().max(80).nullable().default(null),
  items: z.array(ExtractedItemSchema).max(40).default([]),
  totalRupees: z.number().min(0).max(10_000_000).nullable().default(null),
  paidRupees: z.number().min(0).max(10_000_000).nullable().default(null),
  outstandingRupees: z.number().min(0).max(10_000_000).nullable().default(null),
  paymentMethod: PaymentMethodSchema.nullable().default(null),
  /**
   * Model self-reported confidence. Used only to decide whether to *ask* a
   * clarifying question, never to decide whether to write.
   */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Things the model was unsure about, surfaced verbatim in the preview. */
  ambiguities: z.array(z.string().max(300)).max(10).default([]),
});
export type ExtractedTransaction = z.infer<typeof ExtractedTransactionSchema>;

/**
 * A JSON-schema document.
 *
 * Structurally identical to the AWS SDK's `DocumentType`, redeclared here so
 * this directory stays importable by the browser — pulling an AWS type into a
 * shared schema file would drag the SDK into the frontend bundle.
 */
export type JsonSchemaDocument =
  | null
  | boolean
  | number
  | string
  | JsonSchemaDocument[]
  | { [key: string]: JsonSchemaDocument };

/**
 * Tool schema handed to Bedrock so the model returns structured output.
 *
 * Deliberately not `as const`: the Converse API needs mutable arrays and a
 * readonly tuple will not satisfy it.
 */
export const EXTRACTED_TRANSACTION_TOOL_SCHEMA: Record<string, JsonSchemaDocument> = {
  type: 'object',
  properties: {
    customer: {
      type: ['string', 'null'],
      description: 'Customer name exactly as spoken, or null if not mentioned',
    },
    items: {
      type: 'array',
      description:
        'EVERY product mentioned in the sentence, in the order spoken. A transaction may contain any number of products — never return only the first one. Items are separated by "aur", "and", commas, or a new quantity.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product name translated to English' },
          quantity: { type: 'number' },
          unit: { type: 'string', description: 'kg, litre, packet, piece, unit' },
          unitPriceRupees: { type: ['number', 'null'] },
        },
        required: ['name', 'quantity', 'unit'],
      },
    },
    totalRupees: { type: ['number', 'null'] },
    paidRupees: { type: ['number', 'null'] },
    outstandingRupees: { type: ['number', 'null'] },
    paymentMethod: {
      type: ['string', 'null'],
      enum: ['cash', 'upi', 'card', 'credit', 'other', null],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ambiguities: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'confidence'],
};

/* -------------------------------------------------------- Transaction draft */

/**
 * One line of a draft: what was asked for, and what can be supplied.
 *
 * A superset of LineItem rather than a replacement for it. LineItem is the
 * persisted shape and describes a sale that happened; these extra fields
 * describe a request that has not been agreed to yet, and stop existing at the
 * moment the shopkeeper confirms.
 */
export const DraftLineItemSchema = LineItemSchema.extend({
  /**
   * Overridden to allow zero, which LineItem rightly forbids.
   *
   * A persisted sale of nothing is meaningless, so LineItem requires a positive
   * quantity. A *draft* line of zero is meaningful and necessary: it is how an
   * item the customer asked for and the shop cannot supply stays on the screen
   * with a NOT AVAILABLE badge instead of disappearing. Such a line is dropped
   * before the draft is confirmed, so nothing zero-quantity is ever written.
   */
  quantity: z.number().min(0).max(1_000_000),
  /** As spoken. Unchanged by what the shelf turns out to hold. */
  requestedQuantity: z.number().min(0),
  /** In stock right now. */
  availableQuantity: z.number(),
  /** What this sale would actually hand over. `quantity` mirrors this. */
  fulfilledQuantity: z.number().min(0),
  availability: z.enum(['available', 'insufficient', 'unavailable']),
  /** True when the spoken name matched nothing in the shop's catalogue. */
  inCatalogue: z.boolean().default(true),
});
export type DraftLineItem = z.infer<typeof DraftLineItemSchema>;

/**
 * A resolved, priced, arithmetic-checked proposal. This is what the preview
 * screen renders and what the confirm endpoint accepts — never raw model output.
 */
export const TransactionDraftSchema = z.object({
  draftId: z.string(),
  transcript: z.string().default(''),
  language: LanguageSchema.default('en'),

  /** Resolved against real customers; null means "we need to create one". */
  customerId: z.string().nullable(),
  customerName: z.string(),
  customerIsNew: z.boolean(),
  /** Other customers matching the spoken name, for the disambiguation picker. */
  customerCandidates: z
    .array(z.object({ customerId: z.string(), name: z.string(), phone: z.string() }))
    .default([]),

  /**
   * Every product heard, in the order it was said — including ones this shop
   * cannot supply. An item the customer asked for and the shop does not have is
   * information the shopkeeper needs, so it stays in the list with a status
   * rather than being filtered out before they see it.
   */
  items: z.array(DraftLineItemSchema),

  /** Sum of line totals, which count only what can actually be supplied. */
  subtotal: z.number().int(),
  discount: z.number().int().default(0),
  total: z.number().int(),
  paid: z.number().int(),
  /** Still owed. Never negative — an overpayment is `change`, not a negative debt. */
  outstanding: z.number().int(),
  /** Owed back to the customer when they paid more than the total. */
  change: z.number().int().default(0),
  /** How many lines could not be supplied in full. Drives the confirm warning. */
  unfulfilledCount: z.number().int().default(0),
  paymentMethod: PaymentMethodSchema,

  confidence: z.number().min(0).max(1),
  /** True when the UI should ask the shopkeeper to verify each number. */
  needsReview: z.boolean(),
  /** Plain-language notes: unmatched products, guessed prices, odd arithmetic. */
  warnings: z.array(z.string()).default([]),
  /** How the draft was produced, shown to the user verbatim. */
  engine: z.enum(['bedrock', 'local-parser']),
});
export type TransactionDraft = z.infer<typeof TransactionDraftSchema>;

/* ------------------------------------------------------- Shop memory search */

export const CITATION_KINDS = [
  'transaction',
  'payment',
  'commitment',
  'order',
  'customer',
  'product',
] as const;
export const CitationKindSchema = z.enum(CITATION_KINDS);

/** A real row from the shop's own data, rendered under every AI answer. */
export const CitationSchema = z.object({
  kind: CitationKindSchema,
  id: z.string(),
  label: z.string(),
  detail: z.string().default(''),
  amount: z.number().int().optional(),
  timestamp: z.string().optional(),
  href: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const MemoryAnswerSchema = z.object({
  question: z.string(),
  answer: z.string().min(1).max(4000),
  /**
   * False when retrieval found nothing to stand on. The UI then shows
   * "I couldn't find enough information in your shop records." and the model's
   * prose is discarded rather than displayed.
   */
  grounded: z.boolean(),
  citations: z.array(CitationSchema).max(40).default([]),
  engine: z.enum(['bedrock', 'knowledge-base', 'local-retrieval']),
});
export type MemoryAnswer = z.infer<typeof MemoryAnswerSchema>;

/* -------------------------------------------------------------- Shop Pulse */

export const PULSE_KINDS = ['stock', 'payments', 'orders', 'opportunity', 'customer'] as const;
export const PulseKindSchema = z.enum(PULSE_KINDS);
export type PulseKind = z.infer<typeof PulseKindSchema>;

export const PULSE_SEVERITIES = ['critical', 'warning', 'info', 'positive'] as const;
export const PulseSeveritySchema = z.enum(PULSE_SEVERITIES);
export type PulseSeverity = z.infer<typeof PulseSeveritySchema>;

/**
 * A priority card. Every number in `metrics` is computed deterministically in
 * services/inventory.ts or routes/khata.ts; the model only ever supplies
 * `narration`, and the card renders correctly without it.
 */
export const PulseCardSchema = z.object({
  id: z.string(),
  kind: PulseKindSchema,
  severity: PulseSeveritySchema,
  title: z.string().max(200),
  body: z.string().max(600).default(''),
  narration: z.string().max(600).default(''),
  metrics: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  actionLabel: z.string().max(60).optional(),
  actionHref: z.string().max(300).optional(),
  /** Computed urgency, used for ordering. Higher is more urgent. */
  priority: z.number(),
});
export type PulseCard = z.infer<typeof PulseCardSchema>;

export const ShopPulseSchema = z.object({
  generatedAt: z.string(),
  cards: z.array(PulseCardSchema),
  /** Whether the narration came from Bedrock or from deterministic templates. */
  engine: z.enum(['bedrock', 'deterministic']),
});
export type ShopPulse = z.infer<typeof ShopPulseSchema>;

/* ------------------------------------------------------------------- Agent */

export const AGENT_TOOL_NAMES = [
  'getCustomer',
  'searchCustomers',
  'getTransactions',
  'getOutstandingPayments',
  'getInventory',
  'getSalesSummary',
  'prepareRestockList',
  'createReminder',
] as const;
export const AgentToolNameSchema = z.enum(AGENT_TOOL_NAMES);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

export const AgentStepSchema = z.object({
  id: z.string(),
  label: z.string().max(200),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  tool: AgentToolNameSchema.optional(),
  detail: z.string().max(600).default(''),
  durationMs: z.number().optional(),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

/**
 * A side-effecting operation the agent wants to perform.
 *
 * Proposals are always returned to the client first and persisted as an
 * AIAction with status 'awaiting_confirmation'. Execution requires a separate
 * call carrying the matching actionId, authenticated as the same vendor.
 */
export const AgentProposalSchema = z.object({
  actionId: z.string(),
  actionType: z.string(),
  summary: z.string().max(600),
  /** Exactly what will happen, one human-readable line per effect. */
  effects: z.array(z.string().max(400)).max(100),
  confirmLabel: z.string().max(60).default('Confirm'),
  cancelLabel: z.string().max(60).default('Cancel'),
  /** How the message will actually be delivered — or that it will not be. */
  deliveryNote: z.string().max(400).default(''),
});
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

export const AgentRunSchema = z.object({
  runId: z.string(),
  instruction: z.string(),
  understood: z.string().max(600),
  steps: z.array(AgentStepSchema),
  message: z.string().max(4000),
  citations: z.array(CitationSchema).max(40).default([]),
  proposal: AgentProposalSchema.nullable().default(null),
  /**
   * What to ask next, drawn from what this answer actually contained.
   *
   * A shopkeeper serving a customer will not type a follow-up question, so an
   * answer with no way onward is where the conversation stops.
   */
  followUps: z.array(z.string().max(120)).max(4).default([]),
  engine: z.enum(['agentcore', 'bedrock-tools', 'local-planner']),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentExecutionSchema = z.object({
  actionId: z.string(),
  status: z.enum(['executed', 'failed', 'cancelled']),
  message: z.string().max(2000),
  /** Per-effect outcome, so partial delivery is reported accurately. */
  results: z
    .array(
      z.object({
        label: z.string(),
        ok: z.boolean(),
        detail: z.string().default(''),
      }),
    )
    .default([]),
});
export type AgentExecution = z.infer<typeof AgentExecutionSchema>;

/* -------------------------------------------------- Document (Textract) --- */

/**
 * Textract output, always reviewable before it changes any business record.
 * Vyapio targets printed invoices and receipts; handwritten khata pages are out
 * of scope and the UI says so rather than quietly producing poor results.
 */
export const ExtractedDocumentSchema = z.object({
  documentId: z.string(),
  supplierName: z.string().nullable().default(null),
  invoiceNumber: z.string().nullable().default(null),
  invoiceDate: z.string().nullable().default(null),
  lines: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.number().nullable().default(null),
        unitPriceRupees: z.number().nullable().default(null),
        amountRupees: z.number().nullable().default(null),
      }),
    )
    .default([]),
  totalRupees: z.number().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  warnings: z.array(z.string()).default([]),
  engine: z.enum(['textract', 'unavailable']),
});
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;
