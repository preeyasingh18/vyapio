import { z } from 'zod';
import {
  BusinessCategorySchema,
  EmailSchema,
  LanguageSchema,
  DateOnlySchema,
  NonEmptyString,
  OptionalDateOnlySchema,
  OptionalEmailSchema,
  OptionalPhoneSchema,
  PaiseSchema,
  PaymentMethodSchema,
  PhoneSchema,
  QuantitySchema,
  RecordSourceSchema,
  RoleSchema,
} from './common';
import {
  CommitmentStatusSchema,
  InventoryEventTypeSchema,
  OrderStatusSchema,
} from './entities';

/**
 * Request contracts.
 *
 * Note what is absent from every one of these: `vendorId`. The authenticated
 * session is the only source of tenancy — accepting a vendorId from the browser
 * would make cross-tenant access a typo away. See middleware/auth.ts.
 */

/* -------------------------------------------------------------------- Auth */

export const PasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128)
  .refine((value) => /[a-z]/.test(value), 'Include a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Include an uppercase letter')
  .refine((value) => /\d/.test(value), 'Include a number');

export const SignupRequestSchema = z.object({
  role: RoleSchema.default('SHOPKEEPER'),
  ownerName: NonEmptyString.max(80),
  email: EmailSchema,
  phone: PhoneSchema,
  password: PasswordSchema,
  /** Required for SHOPKEEPER; ignored for CUSTOMER. Checked in the route. */
  shopName: z.string().trim().max(80).optional(),
  category: BusinessCategorySchema.optional(),
  city: z.string().trim().max(60).optional(),
  language: LanguageSchema.default('en'),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'Enter your password'),
});

export const ConfirmSignupRequestSchema = z.object({
  email: EmailSchema,
  code: z.string().trim().min(4).max(10),
});

export const ResendCodeRequestSchema = z.object({ email: EmailSchema });

export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema });

export const ResetPasswordRequestSchema = z.object({
  email: EmailSchema,
  code: z.string().trim().min(4).max(10),
  password: PasswordSchema,
});

export const RefreshRequestSchema = z.object({ refreshToken: NonEmptyString });

/* --------------------------------------------------------------- Onboarding */

export const CompleteOnboardingRequestSchema = z.object({
  shopName: NonEmptyString.max(80),
  category: BusinessCategorySchema,
  city: NonEmptyString.max(60),
  language: LanguageSchema,
  voiceLanguage: LanguageSchema,
  /** Free-text answer to "how do you track your business today?" */
  currentMethod: z.string().max(80).optional(),
  /** Seeds the shop with the demo dataset so a new account is not empty. */
  seedDemoData: z.boolean().default(false),
});

export const UpdateVendorRequestSchema = z.object({
  shopName: NonEmptyString.max(80).optional(),
  ownerName: NonEmptyString.max(80).optional(),
  category: BusinessCategorySchema.optional(),
  city: NonEmptyString.max(60).optional(),
  language: LanguageSchema.optional(),
  voiceLanguage: LanguageSchema.optional(),
  phone: OptionalPhoneSchema.optional(),
});

/* ---------------------------------------------------------------- Customers */

export const CreateCustomerRequestSchema = z.object({
  name: NonEmptyString.max(80),
  phone: OptionalPhoneSchema,
  email: OptionalEmailSchema,
  notes: z.string().max(1000).default(''),
  /** Reuse a token produced by the scanner when creating from an unknown QR. */
  qrId: z.string().trim().max(40).optional(),
});

export const UpdateCustomerRequestSchema = z.object({
  name: NonEmptyString.max(80).optional(),
  phone: OptionalPhoneSchema.optional(),
  email: OptionalEmailSchema.optional(),
  notes: z.string().max(1000).optional(),
});

export const ResolveScanRequestSchema = z
  .object({
    /** The raw string decoded from the QR image. */
    qrId: z.string().trim().max(200).optional(),
    /** Fallback path when the camera is unavailable or the code is damaged. */
    phone: z.string().trim().max(20).optional(),
    /**
     * A spoken name. Used before creating a customer from a voice sale, so an
     * existing person is found rather than saved a second time.
     */
    name: z.string().trim().max(80).optional(),
  })
  .refine((value) => Boolean(value.qrId || value.phone || value.name), {
    message: 'Provide a scanned code, a phone number or a name',
  });

/* ------------------------------------------------------------- Transactions */

export const LineItemInputSchema = z.object({
  productId: z.string().optional(),
  name: NonEmptyString.max(80),
  quantity: QuantitySchema,
  unit: z.string().max(16).default('unit'),
  unitPrice: PaiseSchema,
});

export const CreateTransactionRequestSchema = z
  .object({
    customerId: NonEmptyString,
    items: z.array(LineItemInputSchema).min(1, 'Add at least one item'),
    discount: PaiseSchema.default(0),
    paid: PaiseSchema,
    paymentMethod: PaymentMethodSchema,
    note: z.string().max(500).default(''),
    source: RecordSourceSchema.default('manual'),
    transcript: z.string().max(4000).optional(),
    /** Client-generated key so an offline replay cannot double-charge. */
    idempotencyKey: z.string().trim().max(80).optional(),
    /** Creates a Commitment for the unpaid remainder. Defaults to true. */
    createCommitment: z.boolean().default(true),
    /** Days until the commitment is due. */
    dueInDays: z.number().int().min(0).max(365).default(7),
  })
  .refine((value) => value.paid <= value.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0), {
    message: 'Paid amount cannot exceed the bill total',
    path: ['paid'],
  });
export type CreateTransactionRequest = z.infer<typeof CreateTransactionRequestSchema>;

export const TransactionQuerySchema = z.object({
  customerId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/* ------------------------------------------------------------------ Khata */

export const RecordPaymentRequestSchema = z.object({
  customerId: NonEmptyString,
  amount: PaiseSchema.refine((value) => value > 0, 'Enter an amount'),
  method: PaymentMethodSchema.default('cash'),
  note: z.string().max(500).default(''),
  commitmentId: z.string().optional(),
  idempotencyKey: z.string().trim().max(80).optional(),
});

export const CreateCommitmentRequestSchema = z.object({
  customerId: NonEmptyString,
  amount: PaiseSchema.refine((value) => value > 0, 'Enter an amount'),
  description: z.string().max(300).default(''),
  dueInDays: z.number().int().min(0).max(365).default(7),
});

export const CommitmentQuerySchema = z.object({
  status: CommitmentStatusSchema.optional(),
  overdueOnly: z.coerce.boolean().default(false),
  minAmount: z.coerce.number().int().min(0).optional(),
});

/* -------------------------------------------------------------- Inventory */

export const CreateProductRequestSchema = z.object({
  name: NonEmptyString.max(80),
  sku: z.string().max(40).default(''),
  category: z.string().max(40).default('general'),
  unit: z.string().max(16).default('unit'),
  /** What the shop pays per unit. Stock is valued at this, not at retail. */
  costPrice: PaiseSchema,
  sellingPrice: PaiseSchema,
  stock: z.number().min(0).max(1_000_000).default(0),
  reorderLevel: z.number().min(0).max(1_000_000).default(0),
  /**
   * Required: a stock item nobody can be reordered from is a dead end when the
   * shopkeeper is standing at an empty shelf. Existing rows may still be blank;
   * this only governs what is created from here on.
   */
  supplier: NonEmptyString.max(80),
  /** Defaults to today, because that is when an item is usually first bought. */
  purchaseDate: OptionalDateOnlySchema,
  aliases: z.array(z.string().max(40)).max(20).default([]),
});

/**
 * A partial update. Every field optional, and deliberately NOT
 * `CreateProductRequestSchema.partial()`.
 *
 * `.partial()` only makes the keys optional; the `.default(...)` on each field
 * still fires when the key is absent, so parsing `{ stock: 3 }` yields a full
 * object of defaults. Fed to an update that writes whatever it is given, a
 * change of quantity silently reset the unit, category, sku, aliases, purchase
 * date and — worst of all — the reorder level, which is half of what decides
 * whether an item reads as low stock.
 *
 * Optional-without-default leaves absent keys absent, so an update touches only
 * the fields it names.
 */
export const UpdateProductRequestSchema = z.object({
  name: NonEmptyString.max(80).optional(),
  sku: z.string().max(40).optional(),
  category: z.string().max(40).optional(),
  unit: z.string().max(16).optional(),
  costPrice: PaiseSchema.optional(),
  sellingPrice: PaiseSchema.optional(),
  stock: z.number().min(0).max(1_000_000).optional(),
  reorderLevel: z.number().min(0).max(1_000_000).optional(),
  supplier: NonEmptyString.max(80).optional(),
  purchaseDate: DateOnlySchema.optional(),
  aliases: z.array(z.string().max(40)).max(20).optional(),
});

export const AdjustStockRequestSchema = z.object({
  productId: NonEmptyString,
  type: InventoryEventTypeSchema,
  /** Signed: negative removes stock, positive adds it. */
  quantityDelta: z.number().refine((value) => value !== 0, 'Enter a quantity'),
  note: z.string().max(300).default(''),
  /**
   * What this batch cost per unit. Only meaningful when stock is coming in;
   * when given it becomes the product's cost price, because stock is valued at
   * what the shop most recently paid for it.
   */
  unitPrice: PaiseSchema.optional(),
  /** The day the stock was bought. Defaults to today on a stock-in. */
  purchaseDate: OptionalDateOnlySchema,
});

/* ----------------------------------------------------------------- Orders */

export const CreateOrderRequestSchema = z.object({
  customerId: NonEmptyString,
  items: z.array(LineItemInputSchema).min(1),
  note: z.string().max(500).default(''),
});

export const UpdateOrderStatusRequestSchema = z.object({
  status: OrderStatusSchema,
});

/* ------------------------------------------------------------------ Voice */

export const VoiceParseRequestSchema = z.object({
  transcript: z.string().trim().min(1, 'Nothing was heard').max(4000),
  language: LanguageSchema.default('en'),
});

export const VoiceStreamTokenRequestSchema = z.object({
  language: LanguageSchema.default('en'),
});

/* -------------------------------------------------------------- Documents */

export const DocumentUploadUrlRequestSchema = z.object({
  fileName: NonEmptyString.max(200),
  contentType: z
    .string()
    .refine(
      (value) => ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(value),
      'Upload a JPEG, PNG, WebP or PDF',
    ),
  kind: z.enum(['invoice', 'receipt', 'other']).default('invoice'),
});

export const ExtractDocumentRequestSchema = z.object({
  documentId: NonEmptyString,
});

/* ----------------------------------------------------------------- Search */

export const SearchRequestSchema = z.object({
  question: z.string().trim().min(1, 'Ask a question').max(500),
  customerId: z.string().optional(),
});

/* ------------------------------------------------------------------- Agent */

export const AgentRunRequestSchema = z.object({
  instruction: z.string().trim().min(1, 'Tell Vyapio what to do').max(500),
});

export const AgentConfirmRequestSchema = z.object({
  actionId: NonEmptyString,
});

/* --------------------------------------------------------------- Customer app */

export const ClaimProfileRequestSchema = z.object({
  /** Proves the customer holds the physical card. */
  qrId: NonEmptyString,
});

/* ------------------------------------------------------------ Offline sync */

/**
 * Batch replay of actions a client queued while offline. Each entry carries its
 * own idempotency key so a partial sync can be retried safely.
 */
export const SyncRequestSchema = z.object({
  actions: z
    .array(
      z.object({
        id: NonEmptyString,
        kind: z.enum(['transaction', 'payment', 'customer']),
        idempotencyKey: NonEmptyString,
        payload: z.record(z.string(), z.unknown()),
        queuedAt: z.string(),
      }),
    )
    .max(100),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;
