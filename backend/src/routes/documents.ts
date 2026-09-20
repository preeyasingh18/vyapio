import { z } from 'zod';
import { Router, ok, created } from '../utils/router';
import { parseBody, parseParams } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { documents as documentRepo } from '../services/repository';
import { createUploadUrl, isStorageEnabled, objectExists } from '../services/s3';
import { extractDocument, isTextractEnabled } from '../services/textract';
import { notConfigured, notFound } from '../utils/errors';
import { nowIso } from '../utils/dates';
import { newDocumentId } from '../utils/ids';
import { DocumentUploadUrlRequestSchema, ExtractDocumentRequestSchema } from '../schemas/requests';
import type { VyapioDocument } from '../schemas/entities';

/**
 * Documents.
 *
 *   upload → S3 → Textract → extracted draft → review → confirm → records
 *
 * The draft stops at review, exactly like the voice flow. Nothing extracted
 * from a photograph changes stock or money until a person has looked at it.
 *
 * Scope is stated openly in `capabilities`: printed invoices and receipts.
 * Handwritten khata pages are not supported, and the UI says so rather than
 * returning confident nonsense.
 */

export const documentRoutes = new Router();

documentRoutes.get('/capabilities', async (ctx) => {
  await requireVendor(ctx);
  return ok({
    uploadEnabled: isStorageEnabled(),
    extractionEnabled: isTextractEnabled(),
    supported: ['Printed supplier invoices', 'Printed receipts', 'Typed bills (PDF or photo)'],
    notSupported: [
      'Handwritten khata pages — recognition is not reliable enough to trust with your records',
    ],
    note: isTextractEnabled()
      ? 'Documents are read with Amazon Textract. Always check the figures before saving.'
      : 'Document reading is not configured on this environment. You can still upload and enter details manually.',
  });
});

documentRoutes.get('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const list = await documentRepo.list(vendorId, 50);
  return ok({ documents: list });
});

/**
 * Step 1: a presigned URL. The browser uploads straight to S3 under a key this
 * server built from the session's vendorId.
 */
documentRoutes.post('/upload-url', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  if (!isStorageEnabled()) throw notConfigured('Document upload');

  const input = parseBody(ctx, DocumentUploadUrlRequestSchema);
  const { uploadUrl, objectKey, expiresIn } = await createUploadUrl({
    vendorId,
    folder: input.kind === 'receipt' ? 'receipts' : 'documents',
    fileName: input.fileName,
    contentType: input.contentType,
  });

  const document: VyapioDocument = {
    documentId: newDocumentId(),
    vendorId,
    kind: input.kind,
    objectKey,
    fileName: input.fileName,
    contentType: input.contentType,
    status: 'uploaded',
    detail: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await documentRepo.put(document);

  return created({ document, uploadUrl, expiresIn });
});

/**
 * Step 2: extraction. Returns a reviewable draft; writes nothing to the ledger.
 */
documentRoutes.post('/extract', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, ExtractDocumentRequestSchema);

  const document = await documentRepo.get(vendorId, input.documentId);
  if (!document) throw notFound('document');

  const uploaded = await objectExists(vendorId, document.objectKey);
  if (!uploaded) {
    await documentRepo.update(document, {
      status: 'failed',
      detail: 'The file was not uploaded.',
    });
    return ok({
      document: { ...document, status: 'failed' },
      extracted: null,
      message: 'That file did not finish uploading. Try again.',
    });
  }

  await documentRepo.update(document, { status: 'extracting', detail: '' });

  const extracted = await extractDocument({
    vendorId,
    documentId: document.documentId,
    objectKey: document.objectKey,
  });

  const updated = await documentRepo.update(document, {
    status: extracted.engine === 'textract' ? 'extracted' : 'failed',
    detail: extracted.warnings.join(' '),
  });

  ctx.logger.info('document extraction complete', {
    operation: 'documents.extract',
    vendorId,
    engine: extracted.engine,
    lineCount: extracted.lines.length,
  });

  return ok({
    document: updated,
    extracted,
    // Never implied to be final — the client renders this as a review form.
    message: 'Check these details before saving anything.',
  });
});

documentRoutes.get('/:documentId', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const { documentId } = parseParams(ctx, z.object({ documentId: z.string().min(1) }));
  const document = await documentRepo.get(vendorId, documentId);
  if (!document) throw notFound('document');
  return ok({ document });
});
