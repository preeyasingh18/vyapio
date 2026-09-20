/**
 * Creates the Vyapio table in whatever DynamoDB the environment points at.
 *
 *   npm run db:create              create it if it is not there
 *   npm run db:create -- --drop    delete and recreate it (wipes everything)
 *
 * Intended for DynamoDB Local, where nothing creates the table for you. In the
 * cloud, CDK owns the table — `infrastructure/lib/database-stack.ts` — and this
 * script refuses to touch a deployed environment, because two things defining
 * the same table is how a schema quietly drifts.
 *
 * The key schema below mirrors that stack exactly: same partition and sort
 * keys, same two indexes under the same names. Those names are referenced in
 * query code, so a mismatch here would fail only at run time, on whichever
 * screen happened to use the index first.
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { config } from '../src/config/index';

function client(): DynamoDBClient {
  return new DynamoDBClient({
    region: config.region,
    ...(config.database.endpoint
      ? {
          endpoint: config.database.endpoint,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {}),
  });
}

async function exists(db: DynamoDBClient, tableName: string): Promise<boolean> {
  try {
    await db.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const tableName = config.database.tableName;
  const endpoint = config.database.endpoint;

  if (!endpoint) {
    throw new Error(
      'DYNAMODB_ENDPOINT is not set, so this would run against real AWS.\n' +
        '  The deployed table belongs to CDK: npm run cdk:deploy\n' +
        '  For a local one:  docker compose up -d  (then re-run this)',
    );
  }

  if (config.database.mode !== 'aws') {
    throw new Error(
      'DYNAMODB_TABLE_NAME is empty, so the app is using the file-backed store\n' +
        '  and no table is needed. Set it in .env to switch to DynamoDB.',
    );
  }

  const db = client();
  const drop = process.argv.includes('--drop');

  console.log(`\n  Endpoint: ${endpoint}`);
  console.log(`  Table:    ${tableName}\n`);

  if (drop && (await exists(db, tableName))) {
    await db.send(new DeleteTableCommand({ TableName: tableName }));
    await waitUntilTableNotExists({ client: db, maxWaitTime: 60 }, { TableName: tableName });
    console.log('  Dropped the existing table.');
  }

  if (await exists(db, tableName)) {
    console.log('  Already there — nothing to do.');
    console.log('  Use --drop to rebuild it from scratch.\n');
    return;
  }

  await db.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
        { AttributeName: 'gsi2pk', AttributeType: 'S' },
        { AttributeName: 'gsi2sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'gsi2',
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  await waitUntilTableExists({ client: db, maxWaitTime: 60 }, { TableName: tableName });

  // Idempotency records carry a `ttl` and expire themselves after 24h. Local
  // does not actually sweep them, but enabling it keeps the two definitions
  // honest — and the records are harmless either way.
  try {
    await db.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      }),
    );
  } catch {
    // Some versions of DynamoDB Local decline this. Not worth failing over.
  }

  console.log('  Created, with indexes gsi1 and gsi2.\n');
  console.log('  Next:  npm run seed -- --reset --empty');
  console.log('         npm run seed:inventory');
  console.log('         npm run dev\n');
}

main().catch((error: unknown) => {
  console.error('\n  Could not create the table:', error instanceof Error ? error.message : error);
  console.error('\n  Is the container running?   docker compose ps\n');
  process.exitCode = 1;
});
