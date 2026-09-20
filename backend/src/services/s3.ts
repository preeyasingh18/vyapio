import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/index';
import { AppError, forbidden, notConfigured } from '../utils/errors';
import { logger } from '../utils/logger';
import { randomId } from '../utils/ids';

/**
 * Object storage.
 *
 * Every key is built here from an authenticated vendorId — callers pass what
 * they are storing, never where it goes. `assertKeyBelongsTo` is then applied
 * on the way back out, so a tampered key in a request body cannot reach another
 * shop's objects even if a route forgets to check.
 *
 *   vendors/{vendorId}/voice/...
 *   vendors/{vendorId}/documents/...
 *   vendors/{vendorId}/receipts/...
 *   vendors/{vendorId}/products/...
 */

export type ObjectFolder = 'voice' | 'documents' | 'receipts' | 'products';

let client: S3Client | null = null;

function s3(): S3Client {
  if (!config.storage.bucketName) throw notConfigured('File storage');
  client ??= new S3Client({ region: config.region });
  return client;
}

export function isStorageEnabled(): boolean {
  return config.storage.mode === 'aws';
}

/** Builds a tenant-scoped key. The only way keys are created. */
export function buildKey(
  vendorId: string,
  folder: ObjectFolder,
  fileName: string,
): string {
  // Strip any path traversal before it can matter.
  const safeName = fileName
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(-120);
  return `vendors/${vendorId}/${folder}/${Date.now()}-${randomId(8)}-${safeName}`;
}

/**
 * The tenancy check. Called before any read or write of a key that arrived from
 * a client, so a crafted key is rejected rather than followed.
 */
export function assertKeyBelongsTo(vendorId: string, key: string): void {
  const prefix = `vendors/${vendorId}/`;
  if (!key.startsWith(prefix) || key.includes('..')) {
    logger.warn('rejected cross-tenant object key', {
      operation: 's3.assertKeyBelongsTo',
      vendorId,
    });
    throw forbidden('Object key does not belong to this vendor', { key });
  }
}

/**
 * Presigned PUT so the browser uploads straight to S3.
 *
 * The file never passes through Lambda — which keeps a 10 MB invoice photo out
 * of a 6 MB payload limit — and the browser still never holds AWS credentials.
 */
export async function createUploadUrl(input: {
  vendorId: string;
  folder: ObjectFolder;
  fileName: string;
  contentType: string;
}): Promise<{ uploadUrl: string; objectKey: string; expiresIn: number }> {
  const objectKey = buildKey(input.vendorId, input.folder, input.fileName);

  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: config.storage.bucketName!,
      Key: objectKey,
      ContentType: input.contentType,
      // Server-side encryption is enforced by the bucket policy too; setting it
      // here means a presigned upload cannot be made without it.
      ServerSideEncryption: 'AES256',
    }),
    { expiresIn: config.storage.presignExpirySeconds },
  );

  logger.debug('created upload url', {
    operation: 's3.createUploadUrl',
    vendorId: input.vendorId,
    folder: input.folder,
  });

  return { uploadUrl, objectKey, expiresIn: config.storage.presignExpirySeconds };
}

/** Short-lived presigned GET, scoped to the caller's own tenant. */
export async function createDownloadUrl(vendorId: string, objectKey: string): Promise<string> {
  assertKeyBelongsTo(vendorId, objectKey);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: config.storage.bucketName!, Key: objectKey }),
    { expiresIn: config.storage.presignExpirySeconds },
  );
}

export async function objectExists(vendorId: string, objectKey: string): Promise<boolean> {
  assertKeyBelongsTo(vendorId, objectKey);
  try {
    await s3().send(
      new HeadObjectCommand({ Bucket: config.storage.bucketName!, Key: objectKey }),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) {
      return false;
    }
    throw error;
  }
}

/** Direct upload, used by server-side flows such as knowledge-base exports. */
export async function putObject(input: {
  vendorId: string;
  objectKey: string;
  body: Uint8Array | string;
  contentType: string;
}): Promise<void> {
  assertKeyBelongsTo(input.vendorId, input.objectKey);
  await s3().send(
    new PutObjectCommand({
      Bucket: config.storage.bucketName!,
      Key: input.objectKey,
      Body: input.body,
      ContentType: input.contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
}

export function bucketName(): string {
  if (!config.storage.bucketName) throw new AppError('NOT_CONFIGURED', 'S3 bucket is not set');
  return config.storage.bucketName;
}

/** Test seam. */
export function setS3Client(next: S3Client | null): void {
  client = next;
}
