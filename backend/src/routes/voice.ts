import { Router, ok } from '../utils/router';
import { parseBody } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { customers as customerRepo, products as productRepo } from '../services/repository';
import { matchProduct, resolveAvailability } from '../services/inventory';
import { matchCustomersByName } from '../services/customerMatch';
import { parseTransaction } from '../services/bedrock';
import { capabilities } from '../services/transcribe';
import { createUploadUrl, isStorageEnabled } from '../services/s3';
import { config } from '../config/index';
import { rupeesToPaise } from '../utils/money';
import { randomId } from '../utils/ids';
import { VoiceParseRequestSchema, VoiceStreamTokenRequestSchema } from '../schemas/requests';
import {
  TransactionDraftSchema,
  type DraftLineItem,
  type TransactionDraft,
} from '../schemas/ai';

import type { PaymentMethod } from '../schemas/common';

/**
 * Voice.
 *
 * This route implements the middle of the pipeline:
 *
 *   mic → transcript → **extract → validate → resolve → price → draft** → confirm → save
 *
 * It deliberately ends at a draft. There is no endpoint here that writes a
 * transaction; confirming posts the (possibly edited) draft to
 * POST /transactions like any other sale. That is what guarantees a model
 * cannot move money — not a policy, but the absence of a code path.
 */

export const voiceRoutes = new Router();

/** Tells the client which capture engine to use, and says so in the UI. */
voiceRoutes.post('/capabilities', async (ctx) => {
  const { vendor } = await requireVendor(ctx);
  const input = parseBody(ctx, VoiceStreamTokenRequestSchema);
  const language = input.language ?? vendor.voiceLanguage;

  return ok({
    ...capabilities(language),
    language,
    // Recording upload is optional; the pipeline works without it.
    canStoreRecording: isStorageEnabled(),
    aiEngine: config.ai.mode === 'aws' ? 'bedrock' : 'local-parser',
  });
});

/** Presigned URL for keeping the audio, when a bucket is configured. */
voiceRoutes.post('/recording-url', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const result = await createUploadUrl({
    vendorId,
    folder: 'voice',
    fileName: `recording-${randomId(8)}.webm`,
    contentType: 'audio/webm',
  });
  return ok(result);
});

/**
 * Transcript → draft.
 *
 * Extraction is only the first step. What makes the preview trustworthy is
 * everything after it: names resolved against real customers, products matched
 * to the real catalogue, prices taken from the catalogue rather than from
 * speech, and the arithmetic recomputed in integer paise.
 */
voiceRoutes.post('/parse', async (ctx) => {
  const { vendorId, vendor } = await requireVendor(ctx);
  const input = parseBody(ctx, VoiceParseRequestSchema);
  const language = input.language ?? vendor.voiceLanguage;

  const [allCustomers, catalogue] = await Promise.all([
    customerRepo.list(vendorId, 2000),
    productRepo.list(vendorId),
  ]);

  const { extracted, engine } = await parseTransaction(input.transcript, {
    language,
    customerNames: allCustomers.map((customer) => customer.name),
    productNames: catalogue.flatMap((product) => [product.name, ...product.aliases]),
  });

  const warnings = [...extracted.ambiguities];

  /* ── Resolve the customer ──────────────────────────────────────────────── */

  let customerId: string | null = null;
  let customerName = extracted.customer ?? '';
  let customerIsNew = false;
  let candidates: Array<{ customerId: string; name: string; phone: string }> = [];

  if (extracted.customer) {
    // Same matcher the confirm step uses, so the preview and the save can never
    // disagree about whether this person is already on the books.
    const match = matchCustomersByName(extracted.customer, allCustomers);

    if (match.kind === 'one') {
      customerId = match.customer.customerId;
      customerName = match.customer.name;
    } else if (match.kind === 'many') {
      // Never pick for them: two Rameshes is exactly when a wrong guess puts
      // money on the wrong khata.
      candidates = match.candidates.map((customer) => ({
        customerId: customer.customerId,
        name: customer.name,
        phone: customer.phone,
      }));
      customerName = extracted.customer;
      warnings.push(`More than one customer is called ${extracted.customer}. Choose which one.`);
    } else {
      customerIsNew = true;
      warnings.push(`${extracted.customer} is not saved yet — we'll create them on confirm.`);
    }
  } else {
    warnings.push('No customer name was heard. Pick one before saving.');
  }

  /* ── Resolve and price the items ───────────────────────────────────────── */

  /**
   * Every spoken item becomes a line, whether or not the shop can supply it.
   *
   * The quantity that reaches `quantity`/`lineTotal` is the fulfillable one, so
   * the money on this draft is money the shop can actually take. What was asked
   * for survives alongside it in `requestedQuantity`, because a request the shop
   * cannot meet is the shopkeeper's to resolve with the customer — not
   * something to quietly round down, and not something to drop.
   */
  const items: DraftLineItem[] = extracted.items.map((raw) => {
    const match = matchProduct(raw.name, catalogue);
    const product = match && match.confidence >= 0.8 ? match.product : null;
    const spokenPrice = raw.unitPriceRupees !== null ? rupeesToPaise(raw.unitPriceRupees) : null;

    // A price the shopkeeper said wins; otherwise the catalogue price. Never a
    // guessed one.
    const unitPrice = spokenPrice ?? match?.product.sellingPrice ?? 0;

    const availability = resolveAvailability(raw.quantity, product);

    if (!match) {
      warnings.push(`"${raw.name}" is not in your product list.`);
    } else if (match.confidence < 0.8) {
      warnings.push(`We matched "${raw.name}" to ${match.product.name}. Is that right?`);
    } else if (availability.status === 'unavailable') {
      warnings.push(`${match.product.name} is out of stock.`);
    } else if (availability.status === 'insufficient') {
      warnings.push(
        `Only ${availability.availableQuantity} ${match.product.unit} of ${match.product.name} left — ${availability.requestedQuantity} was asked for.`,
      );
    }
    if (unitPrice === 0 && availability.fulfilledQuantity > 0) {
      warnings.push(`No price found for ${match?.product.name ?? raw.name}. Enter it below.`);
    }

    return {
      ...(product ? { productId: product.productId } : {}),
      name: match?.product.name ?? raw.name,
      // `quantity` is what would be sold; the ledger reads this field.
      quantity: availability.fulfilledQuantity,
      unit: raw.unit || match?.product.unit || 'unit',
      unitPrice,
      lineTotal: Math.round(unitPrice * availability.fulfilledQuantity),
      requestedQuantity: availability.requestedQuantity,
      availableQuantity: availability.availableQuantity,
      fulfilledQuantity: availability.fulfilledQuantity,
      availability: availability.status,
      inCatalogue: product !== null,
    };
  });

  const unfulfilledCount = items.filter((item) => item.availability !== 'available').length;

  /* ── Recompute the arithmetic ──────────────────────────────────────────── */

  const lineSubtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const spokenTotal = extracted.totalRupees !== null ? rupeesToPaise(extracted.totalRupees) : null;

  // The spoken total is authoritative when it disagrees — the shopkeeper knows
  // what they charged — but the disagreement is surfaced, not buried.
  let subtotal = lineSubtotal;
  if (spokenTotal !== null && lineSubtotal > 0 && Math.abs(spokenTotal - lineSubtotal) > 100) {
    warnings.push(
      `The items add up to ₹${Math.round(lineSubtotal / 100)} but we heard ₹${Math.round(spokenTotal / 100)}. Check the prices.`,
    );
    subtotal = spokenTotal;
  } else if (spokenTotal !== null && lineSubtotal === 0) {
    subtotal = spokenTotal;
  }

  const paidSpoken = extracted.paidRupees !== null ? rupeesToPaise(extracted.paidRupees) : null;
  const outstandingSpoken =
    extracted.outstandingRupees !== null ? rupeesToPaise(extracted.outstandingRupees) : null;

  // Derive whichever of paid/outstanding was not said, so the pair is always
  // consistent with the total.
  let paid: number;
  let outstanding: number;

  if (paidSpoken !== null && outstandingSpoken !== null) {
    // Both halves were spoken, so their sum is what the shopkeeper actually
    // charged. That beats the catalogue: prices drift, bulk rates differ, and
    // the person standing at the till knows the real figure. The discrepancy is
    // surfaced rather than swallowed, and needsReview stays set.
    const impliedTotal = paidSpoken + outstandingSpoken;

    if (lineSubtotal > 0 && Math.abs(impliedTotal - lineSubtotal) > 100) {
      warnings.push(
        `You said ₹${Math.round(paidSpoken / 100)} paid and ₹${Math.round(outstandingSpoken / 100)} pending, which is ₹${Math.round(impliedTotal / 100)}. The listed prices come to ₹${Math.round(lineSubtotal / 100)}.`,
      );
    }

    subtotal = impliedTotal;
    paid = paidSpoken;
    outstanding = outstandingSpoken;
  } else if (paidSpoken !== null) {
    // Not clamped to the total. If the customer handed over more than the bill,
    // that is change owed back, and clamping here would erase it before anyone
    // could see it — the shopkeeper would be told ₹0 change on a ₹2,000 note.
    paid = paidSpoken;
    outstanding = Math.max(0, subtotal - paid);
  } else if (outstandingSpoken !== null) {
    if (subtotal === 0) subtotal = outstandingSpoken;
    outstanding = Math.min(outstandingSpoken, subtotal);
    paid = Math.max(0, subtotal - outstanding);
  } else if (extracted.paymentMethod === 'credit') {
    // "udhaar" / "उधार" is a statement about money, not a silent omission.
    // This branch must come before the assume-paid-in-full default: the word
    // is the whole point of a khata, and defaulting a credit sale to settled
    // is the one error a shopkeeper would never catch by eye.
    paid = 0;
    outstanding = subtotal;
  } else {
    // Nothing said about money: assume paid in full, and flag it.
    paid = subtotal;
    outstanding = 0;
    if (subtotal > 0) warnings.push('No payment was mentioned — we assumed it was paid in full.');
  }

  /**
   * An overpayment is money owed back, not a negative debt.
   *
   * Clamping outstanding at zero and naming the remainder `change` keeps the
   * two readable as what they are. A "-₹60 pending" on a khata screen would be
   * read as a balance, and balances on that screen mean the customer owes.
   */
  const change = Math.max(0, paid - subtotal);
  outstanding = Math.max(0, outstanding);

  const paymentMethod: PaymentMethod =
    extracted.paymentMethod ?? (outstanding > 0 && paid === 0 ? 'credit' : 'cash');

  const needsReview =
    extracted.confidence < config.ai.lowConfidenceThreshold ||
    warnings.length > 0 ||
    customerId === null ||
    unfulfilledCount > 0 ||
    items.length === 0;

  const draft: TransactionDraft = TransactionDraftSchema.parse({
    draftId: `drf_${randomId(12)}`,
    transcript: input.transcript,
    language,
    customerId,
    customerName,
    customerIsNew,
    customerCandidates: candidates,
    items,
    subtotal,
    discount: 0,
    total: subtotal,
    paid,
    outstanding,
    change,
    unfulfilledCount,
    paymentMethod,
    confidence: extracted.confidence,
    needsReview,
    warnings: [...new Set(warnings)].slice(0, 6),
    engine,
  } satisfies TransactionDraft);

  ctx.logger.info('voice draft prepared', {
    operation: 'voice.parse',
    vendorId,
    engine,
    confidence: extracted.confidence,
    needsReview,
    itemCount: items.length,
  });

  return ok({
    draft,
    // The raw extraction is returned for the "what I heard" panel, so the
    // shopkeeper can see the model's reading next to the resolved draft.
    extracted,
  });
});
