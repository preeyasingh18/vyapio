import {
  TextractClient,
  AnalyzeExpenseCommand,
  type ExpenseDocument,
  type ExpenseField,
} from '@aws-sdk/client-textract';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { ExtractedDocumentSchema, type ExtractedDocument } from '../schemas/ai';
import { assertKeyBelongsTo, bucketName } from './s3';

/**
 * Document extraction.
 *
 * Scope, stated plainly: Vyapio reads **printed** supplier invoices and
 * receipts. It does not claim to read handwritten khata pages. Handwriting
 * recognition on mixed-script Indian ledgers is unreliable enough that a
 * confident-looking wrong number would be worse than no feature at all, so the
 * UI says what this handles and what it does not.
 *
 * AnalyzeExpense is used rather than raw DetectDocumentText because it already
 * understands invoice semantics — vendor, total, line items — instead of
 * returning a bag of words for us to guess at.
 *
 * Nothing extracted here writes to the ledger. The result is a reviewable
 * draft; the shopkeeper confirms it, exactly like the voice flow.
 */

let client: TextractClient | null = null;

function textract(): TextractClient {
  client ??= new TextractClient({ region: config.textract.region });
  return client;
}

export function isTextractEnabled(): boolean {
  return config.textract.mode === 'aws';
}

/** Pulls a named field out of Textract's summary fields. */
function summaryField(document: ExpenseDocument, type: string): string | null {
  const fields: ExpenseField[] = document.SummaryFields ?? [];
  const match = fields.find((field) => field.Type?.Text === type);
  const value = match?.ValueDetection?.Text?.trim();
  return value && value.length > 0 ? value : null;
}

/** Parses "₹1,240.50" / "1240.50" / "Rs 1240" into a number. */
function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export async function extractDocument(input: {
  vendorId: string;
  documentId: string;
  objectKey: string;
}): Promise<ExtractedDocument> {
  // Guards against a crafted key pointing at another shop's uploads.
  assertKeyBelongsTo(input.vendorId, input.objectKey);

  if (!isTextractEnabled()) {
    return ExtractedDocumentSchema.parse({
      documentId: input.documentId,
      warnings: [
        'Amazon Textract is not enabled on this environment, so nothing was read from the document. Enter the details manually, or set TEXTRACT_ENABLED=true.',
      ],
      engine: 'unavailable',
    });
  }

  const startedAt = Date.now();
  try {
    const response = await textract().send(
      new AnalyzeExpenseCommand({
        Document: { S3Object: { Bucket: bucketName(), Name: input.objectKey } },
      }),
    );

    const document = response.ExpenseDocuments?.[0];
    if (!document) {
      return ExtractedDocumentSchema.parse({
        documentId: input.documentId,
        warnings: ['Nothing readable was found in this file.'],
        engine: 'textract',
      });
    }

    const lines = (document.LineItemGroups ?? [])
      .flatMap((group) => group.LineItems ?? [])
      .map((lineItem) => {
        const fields = lineItem.LineItemExpenseFields ?? [];
        const pick = (type: string) =>
          fields.find((field) => field.Type?.Text === type)?.ValueDetection?.Text ?? null;
        return {
          name: pick('ITEM') ?? pick('PRODUCT_CODE') ?? 'Unnamed item',
          quantity: parseAmount(pick('QUANTITY')),
          unitPriceRupees: parseAmount(pick('UNIT_PRICE')),
          amountRupees: parseAmount(pick('PRICE')),
        };
      })
      .filter((line) => line.name !== 'Unnamed item' || line.amountRupees !== null);

    // Textract reports per-field confidence; the lowest one governs, because a
    // total that was read poorly spoils the whole document.
    const confidences = (document.SummaryFields ?? [])
      .map((field) => field.ValueDetection?.Confidence)
      .filter((value): value is number => typeof value === 'number');
    const confidence =
      confidences.length > 0 ? Math.min(...confidences) / 100 : lines.length > 0 ? 0.6 : 0.2;

    const warnings: string[] = [];
    if (lines.length === 0) {
      warnings.push('No line items were found — check the figures before saving.');
    }
    if (confidence < 0.7) {
      warnings.push('Some values were hard to read. Please check each one.');
    }

    const extracted = ExtractedDocumentSchema.parse({
      documentId: input.documentId,
      supplierName: summaryField(document, 'VENDOR_NAME'),
      invoiceNumber: summaryField(document, 'INVOICE_RECEIPT_ID'),
      invoiceDate: summaryField(document, 'INVOICE_RECEIPT_DATE'),
      lines,
      totalRupees: parseAmount(summaryField(document, 'TOTAL')),
      confidence: Number(confidence.toFixed(2)),
      warnings,
      engine: 'textract',
    });

    logger.info('document extracted', {
      operation: 'textract.extractDocument',
      vendorId: input.vendorId,
      durationMs: Date.now() - startedAt,
      lineCount: lines.length,
    });

    return extracted;
  } catch (error) {
    logger.error('textract failed', {
      operation: 'textract.extractDocument',
      vendorId: input.vendorId,
      durationMs: Date.now() - startedAt,
      error,
    });
    return ExtractedDocumentSchema.parse({
      documentId: input.documentId,
      warnings: ["We couldn't read that document. Try a clearer photo, or enter it manually."],
      engine: 'unavailable',
    });
  }
}

/** Test seam. */
export function setTextractClient(next: TextractClient | null): void {
  client = next;
}
