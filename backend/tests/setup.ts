/**
 * Test environment.
 *
 * Every subsystem is pinned to local mode so the suite runs with no AWS account
 * and no network. That is not a compromise: the local store mirrors DynamoDB's
 * key shapes and conditional-write semantics, so a tenant-isolation test that
 * passes here exercises the same key construction that runs in production.
 */

process.env.STAGE = 'dev';
process.env.LOG_LEVEL = 'silent';
process.env.DYNAMODB_TABLE_NAME = '';
process.env.USER_POOL_ID = '';
process.env.USER_POOL_CLIENT_ID = '';
process.env.BEDROCK_ENABLED = 'false';
process.env.TRANSCRIBE_ENABLED = 'false';
process.env.TEXTRACT_ENABLED = 'false';
process.env.S3_BUCKET_NAME = '';
process.env.EVENT_BUS_NAME = '';
process.env.NOTIFICATION_PROVIDER = 'mock';
process.env.LOCAL_AUTH_SECRET = 'test-secret-not-used-anywhere-real';
process.env.DEMO_MODE = 'true';
