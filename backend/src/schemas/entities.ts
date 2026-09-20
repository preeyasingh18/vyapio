import { z } from 'zod';
import {
  BusinessCategorySchema,
  IsoDateTimeSchema,
  LanguageSchema,
  NonEmptyString,
  OptionalDateOnlySchema,
  PaiseSchema,
  PaymentMethodSchema,
  QuantitySchema,
  RecordSourceSchema,
  SignedPaiseSchema,
} from './common';

/**
 * The domain model.
 *
 * Every shop-owned record carries `vendorId`. That field is always written from
 * the authenticated session and never from the request body — see
 * middleware/auth.ts and docs/SECURITY.md.
 */

/* ------------------------------------------------------------------ Vendor */

export const VendorSchema = z.object({
  vendorId: NonEmptyString,
  /** Cognito `sub` of the shop owner. One vendor per owner account. */
  userId: NonEmptyString,
  shopName: NonEmptyString.max(80),
  ownerName: NonEmptyString.max(80),
  phone: z.string().default(''),
  email: z.string().default(''),
  category: BusinessCategorySchema,
  city: NonEmptyString.max(60),
  /** Interface language. */
  language: LanguageSchema,
  /** Spoken language for Transcribe. Independent of `language` by design. */
  voiceLanguage: LanguageSchema,
  onboardingComplete: z.boolean().default(false),
  /** Marks the seeded Sharma Stores tenant so the UI can label it. */
  isDemo: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Vendor = z.infer<typeof VendorSchema>;

/* ---------------------------------------------------------------- Customer */

export const CustomerSchema = z.object({
  customerId: NonEmptyString,
  vendorId: NonEmptyString,
  name: NonEmptyString.max(80),
  phone: z.string().default(''),
  /**
   * Where to reach them on WhatsApp, when that differs from `phone`.
   *
   * Usually it does not, so this is empty and the reminder falls back to
   * `phone`. It exists for the shop whose customer gives one number for calls
   * and another for WhatsApp, which is common enough that guessing wrong means
   * messaging a stranger about someone else's debt.
   */
  whatsappPhone: z.string().default(''),
  /**
   * Whether this customer agreed to be messaged.
   *
   * Recorded whether or not it is enforced — WHATSAPP_REQUIRE_OPT_IN decides
   * that — because consent is a fact about the customer, not a setting.
   */
  whatsappOptIn: z.boolean().default(false),
  email: z.string().default(''),
  /** Opaque scan token. Contains no personal data. See utils/ids.ts. */
  qrId: NonEmptyString,
  /**
   * Denormalised running balance in paise, maintained transactionally by the
   * domain layer. Positive means the customer owes the shop.
   */
  outstanding: SignedPaiseSchema.default(0),
  totalSpent: PaiseSchema.default(0),
  transactionCount: z.number().int().min(0).default(0),
  notes: z.string().max(1000).default(''),
  /** Cognito `sub`, set once the customer claims this profile in the customer app. */
  linkedUserId: z.string().optional(),
  lastInteractionAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Customer = z.infer<typeof CustomerSchema>;

/* ----------------------------------------------------------------- Product */

export const ProductSchema = z.object({
  productId: NonEmptyString,
  vendorId: NonEmptyString,
  name: NonEmptyString.max(80),
  sku: z.string().max(40).default(''),
  category: z.string().max(40).default('general'),
  unit: z.string().max(16).default('unit'),
  costPrice: PaiseSchema,
  sellingPrice: PaiseSchema,
  /** Can go negative: a shop sells from a sack before recording the restock. */
  stock: z.number().min(-100_000).max(1_000_000),
  reorderLevel: z.number().min(0).max(1_000_000).default(0),
  /** Who this stock is bought from. '' until the shop records one. */
  supplier: z.string().max(80).default(''),
  /**
   * When this stock was last bought in. Updated by a restock, not by a sale.
   *
   * Deliberately NOT a stock *status* field: status is derived from `stock` and
   * `reorderLevel` on read (see services/inventory.ts), so it cannot drift out
   * of step with the quantity the way a stored copy would.
   */
  purchaseDate: OptionalDateOnlySchema,
  /**
   * Units sold per day. Recomputed deterministically from InventoryEvents by
   * services/inventory.ts — never estimated by a model.
   */
  salesVelocity: z.number().min(0).default(0),
  /** Lets "chawal", "rice" and "basmati" all resolve to one product by voice. */
  aliases: z.array(z.string().max(40)).max(20).default([]),
  imageKey: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Product = z.infer<typeof ProductSchema>;

/* ------------------------------------------------------------- Transaction */

export const LineItemSchema = z.object({
  productId: z.string().optional(),
  name: NonEmptyString.max(80),
  quantity: QuantitySchema,
  unit: z.string().max(16).default('unit'),
  unitPrice: PaiseSchema,
  lineTotal: PaiseSchema,
});
export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * The arithmetic refinements below are the reason a malformed AI extraction can
 * never become a transaction: a row where paid + outstanding ≠ total simply
 * cannot be constructed.
 */
export const TransactionSchema = z
  .object({
    transactionId: NonEmptyString,
    vendorId: NonEmptyString,
    customerId: NonEmptyString,
    customerName: z.string().default(''),
    items: z.array(LineItemSchema).min(1),
    subtotal: PaiseSchema,
    discount: PaiseSchema.default(0),
    total: PaiseSchema,
    paid: PaiseSchema,
    outstanding: PaiseSchema,
    paymentMethod: PaymentMethodSchema,
    note: z.string().max(500).default(''),
    timestamp: IsoDateTimeSchema,
    source: RecordSourceSchema,
    createdBy: NonEmptyString,
    /** Retained for voice/agent rows so the original words stay auditable. */
    transcript: z.string().max(4000).optional(),
    reversedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .refine((t) => t.subtotal === t.items.reduce((sum, item) => sum + item.lineTotal, 0), {
    message: 'subtotal must equal the sum of line totals',
    path: ['subtotal'],
  })
  .refine((t) => t.total === t.subtotal - t.discount, {
    message: 'total must equal subtotal minus discount',
    path: ['total'],
  })
  .refine((t) => t.paid + t.outstanding === t.total, {
    message: 'paid plus outstanding must equal total',
    path: ['outstanding'],
  });
export type Transaction = z.infer<typeof TransactionSchema>;

/**
 * What is still owed on a sale, and when money last came in against it.
 *
 * `Transaction.outstanding` is frozen at the moment of sale and is never
 * rewritten, so the day's books keep adding up to what happened at the counter.
 * This is the live answer, resolved from the Commitments, and it is what any
 * screen showing a balance must display. It lives with the schemas because the
 * frontend renders it and must not re-derive it.
 */
export type Settlement = {
  /** Unpaid right now, in paise. */
  pending: number;
  /** ISO timestamp of the last payment received, or null if none ever was. */
  paidAt: string | null;
};

/** A sale as the API returns it: what was recorded, plus where it stands now. */
export type SettledTransaction = Transaction & Settlement;

/* ----------------------------------------------------------------- Payment */

export const PaymentSchema = z.object({
  paymentId: NonEmptyString,
  vendorId: NonEmptyString,
  customerId: NonEmptyString,
  customerName: z.string().default(''),
  transactionId: z.string().optional(),
  commitmentId: z.string().optional(),
  amount: PaiseSchema,
  method: PaymentMethodSchema,
  note: z.string().max(500).default(''),
  timestamp: IsoDateTimeSchema,
  source: RecordSourceSchema,
  createdBy: NonEmptyString,
});
export type Payment = z.infer<typeof PaymentSchema>;

/* -------------------------------------------------------------- Commitment */

export const COMMITMENT_STATUSES = ['open', 'partly_paid', 'settled', 'written_off'] as const;
export const CommitmentStatusSchema = z.enum(COMMITMENT_STATUSES);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export const REMINDER_STATUSES = ['none', 'queued', 'sent', 'failed'] as const;
export const ReminderStatusSchema = z.enum(REMINDER_STATUSES);
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;

export const CommitmentSchema = z.object({
  commitmentId: NonEmptyString,
  vendorId: NonEmptyString,
  customerId: NonEmptyString,
  customerName: z.string().default(''),
  transactionId: z.string().optional(),
  amount: PaiseSchema,
  settledAmount: PaiseSchema.default(0),
  /**
   * When money was last put against this debt.
   *
   * Separate from `updatedAt`, which a reminder also moves — dating a payment
   * to the day the shopkeeper chased it would be a lie told in the one
   * direction that matters.
   */
  lastPaymentAt: IsoDateTimeSchema.optional(),
  description: z.string().max(300).default(''),
  dueDate: IsoDateTimeSchema,
  status: CommitmentStatusSchema.default('open'),
  reminderStatus: ReminderStatusSchema.default('none'),
  lastReminderAt: IsoDateTimeSchema.optional(),
  reminderCount: z.number().int().min(0).default(0),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Commitment = z.infer<typeof CommitmentSchema>;

/* ------------------------------------------------------------------- Order */

export const ORDER_STATUSES = ['placed', 'preparing', 'ready', 'collected', 'cancelled'] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.object({
  orderId: NonEmptyString,
  vendorId: NonEmptyString,
  customerId: NonEmptyString,
  customerName: z.string().default(''),
  items: z.array(LineItemSchema).min(1),
  total: PaiseSchema,
  status: OrderStatusSchema.default('placed'),
  note: z.string().max(500).default(''),
  readyAt: IsoDateTimeSchema.optional(),
  collectedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Order = z.infer<typeof OrderSchema>;

/* ---------------------------------------------------------- InventoryEvent */

export const INVENTORY_EVENT_TYPES = [
  'stock_in',
  'stock_out',
  'sale',
  'return',
  'adjustment',
] as const;
export const InventoryEventTypeSchema = z.enum(INVENTORY_EVENT_TYPES);
export type InventoryEventType = z.infer<typeof InventoryEventTypeSchema>;

export const InventoryEventSchema = z.object({
  inventoryEventId: NonEmptyString,
  vendorId: NonEmptyString,
  productId: NonEmptyString,
  productName: z.string().default(''),
  type: InventoryEventTypeSchema,
  /** Signed change in units: negative for a sale, positive for a restock. */
  quantityDelta: z.number(),
  stockAfter: z.number(),
  unitPrice: PaiseSchema.default(0),
  transactionId: z.string().optional(),
  note: z.string().max(300).default(''),
  timestamp: IsoDateTimeSchema,
  source: RecordSourceSchema,
});
export type InventoryEvent = z.infer<typeof InventoryEventSchema>;

/* ---------------------------------------------------------------- AIAction */

export const AI_ACTION_STATUSES = [
  'proposed',
  'awaiting_confirmation',
  'confirmed',
  'executed',
  'cancelled',
  'failed',
] as const;
export const AIActionStatusSchema = z.enum(AI_ACTION_STATUSES);
export type AIActionStatus = z.infer<typeof AIActionStatusSchema>;

/**
 * Audit row for everything the AI proposes or performs.
 *
 * Written *before* execution and updated after, so a crash mid-flight still
 * leaves a trace of what was about to happen. This is the record that makes an
 * agent trustworthy enough to give tools to.
 */
export const AIActionSchema = z.object({
  actionId: NonEmptyString,
  vendorId: NonEmptyString,
  agentId: NonEmptyString,
  actionType: NonEmptyString,
  input: z.record(z.string(), z.unknown()).default({}),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
  status: AIActionStatusSchema,
  requiresConfirmation: z.boolean(),
  /** Cognito `sub` of the human who approved it. */
  confirmedBy: z.string().optional(),
  confirmedAt: IsoDateTimeSchema.optional(),
  errorCode: z.string().optional(),
  /** Tool calls made during the run, for the transparency panel. */
  toolCalls: z.array(z.string()).default([]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AIAction = z.infer<typeof AIActionSchema>;

/* ------------------------------------------------------------ Notification */

export const NOTIFICATION_TYPES = [
  'payment_reminder',
  'order_ready',
  'stock_alert',
  'system',
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/**
 * `not_delivered` is a first-class outcome, not a failure. The mock provider
 * returns it, and the UI reports it honestly rather than claiming a send.
 */
/**
 * What became of a message.
 *
 * `not_delivered` and `failed` were not enough once a real provider was wired
 * up: "no phone number saved" and "WhatsApp rejected the template" are both
 * failures, but only one of them is something the shopkeeper can fix, and the
 * reminder log is where they would look to find out.
 */
export const NOTIFICATION_STATUSES = [
  'queued',
  'sent',
  /** Recorded, but nothing left the machine — the mock provider's outcome. */
  'not_delivered',
  'failed',
  /** No number on file. The shopkeeper adds one and tries again. */
  'no_phone',
  /** A number is saved but is not a number we can send to. */
  'invalid_phone',
  /** Consent is required and this customer has not given it. */
  'opt_in_required',
  /** An identical reminder already went out; this one was not sent again. */
  'duplicate',
] as const;
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

export const NotificationSchema = z.object({
  notificationId: NonEmptyString,
  vendorId: NonEmptyString,
  customerId: z.string().optional(),
  type: NotificationTypeSchema,
  /** Which provider actually handled it: sns | whatsapp | mock. */
  provider: z.string(),
  channel: z.string().default(''),
  to: z.string(),
  body: z.string().max(2000),
  status: NotificationStatusSchema,
  /** The provider's own id, for matching a message up with their dashboard. */
  providerMessageId: z.string().optional(),
  /** When it actually left, set only on a real delivery. */
  sentAt: IsoDateTimeSchema.optional(),
  /**
   * The provider's own error, kept for diagnosis.
   *
   * Never shown to the shopkeeper — `detail` is written for them. This is what
   * Meta said, which is useful to whoever is fixing the template and useless
   * to everyone else.
   */
  failureReason: z.string().max(500).optional(),
  /** Why it was not delivered, in plain language, shown to the shopkeeper. */
  detail: z.string().max(500).default(''),
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

/* ----------------------------------------------------------- DocumentUpload */

export const DOCUMENT_STATUSES = ['uploaded', 'extracting', 'extracted', 'failed'] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentSchema = z.object({
  documentId: NonEmptyString,
  vendorId: NonEmptyString,
  kind: z.enum(['invoice', 'receipt', 'other']).default('invoice'),
  /** S3 key, always under vendors/{vendorId}/ — enforced server-side. */
  objectKey: NonEmptyString,
  fileName: z.string().default(''),
  contentType: z.string().default(''),
  status: DocumentStatusSchema,
  detail: z.string().max(500).default(''),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type VyapioDocument = z.infer<typeof DocumentSchema>;
