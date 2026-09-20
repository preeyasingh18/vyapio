#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/database-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { StorageStack } from '../lib/storage-stack';
import { EventsStack } from '../lib/events-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { ApiStack } from '../lib/api-stack';
import { AiStack } from '../lib/ai-stack';
import { FrontendStack } from '../lib/frontend-stack';

/**
 * Vyapio infrastructure.
 *
 *   npx cdk synth                    render the templates
 *   npx cdk diff                     compare against what is deployed
 *   npx cdk deploy --all             deploy everything
 *
 * Context values (`-c key=value`, or `cdk.context.json`):
 *
 *   stage             dev | staging | prod            (default: dev)
 *   bedrockEnabled    true once model access is granted
 *   bedrockRegion     where the model actually lives   (default: the stack region)
 *   modelId           inference profile id
 *   knowledgeBaseId   set after creating a Knowledge Base
 *   agentRuntimeArn   set after deploying an AgentCore runtime
 *   transcribeEnabled true to use Amazon Transcribe for voice
 *   textractEnabled   true to read printed invoices
 *   appOrigin         the CloudFront URL, added to CORS on the second deploy
 *
 * Stacks are split by lifecycle rather than by service: the database and user
 * pool outlive everything and are the things you least want replaced, while the
 * Lambda and API are redeployed constantly.
 */

const app = new App();

const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  // ap-south-1 (Mumbai) is the default: it is nearest to the users, and it
  // keeps a shop's customer data in-country.
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
};

/**
 * Bedrock is not available in every region that hosts the data plane, and model
 * availability varies within the regions that do have it. Keeping the inference
 * region separate means the data plane can stay in Mumbai regardless.
 *
 * Verify availability before enabling — see docs/AWS_SETUP.md.
 */
const bedrockRegion =
  (app.node.tryGetContext('bedrockRegion') as string | undefined) ?? env.region;

const ai = {
  bedrockEnabled: app.node.tryGetContext('bedrockEnabled') === 'true',
  bedrockRegion,
  modelId:
    (app.node.tryGetContext('modelId') as string | undefined) ??
    'apac.anthropic.claude-sonnet-4-5-20250929-v1:0',
  knowledgeBaseId: app.node.tryGetContext('knowledgeBaseId') as string | undefined,
  agentRuntimeArn: app.node.tryGetContext('agentRuntimeArn') as string | undefined,
  transcribeEnabled: app.node.tryGetContext('transcribeEnabled') === 'true',
  textractEnabled: app.node.tryGetContext('textractEnabled') === 'true',
};

/**
 * CORS and S3 both need the app's origin, but the CloudFront domain does not
 * exist until the frontend stack is deployed. So the first deploy allows
 * localhost only; afterwards, pass the real origin:
 *
 *   npx cdk deploy --all -c appOrigin=https://d1234.cloudfront.net
 */
const appOrigin = app.node.tryGetContext('appOrigin') as string | undefined;
const allowedOrigins = appOrigin
  ? [appOrigin]
  : ['http://localhost:5173', 'http://localhost:4173'];

const notificationProvider =
  (app.node.tryGetContext('notificationProvider') as string | undefined) ?? 'mock';

const common = { env, stage };

/* ── Long-lived state ──────────────────────────────────────────────────── */

const database = new DatabaseStack(app, `Vyapio-${stage}-Database`, {
  ...common,
  description: 'Vyapio: DynamoDB single table',
});

const cognito = new CognitoStack(app, `Vyapio-${stage}-Cognito`, {
  ...common,
  description: 'Vyapio: Cognito user pool',
});

const storage = new StorageStack(app, `Vyapio-${stage}-Storage`, {
  ...common,
  allowedOrigins,
  description: 'Vyapio: S3 for voice, documents and receipts',
});

const events = new EventsStack(app, `Vyapio-${stage}-Events`, {
  ...common,
  description: 'Vyapio: EventBridge bus and SNS topic',
});

const ai_ = new AiStack(app, `Vyapio-${stage}-Ai`, {
  ...common,
  bucket: storage.bucket,
  bedrockRegion,
  description: 'Vyapio: IAM for Bedrock Knowledge Bases',
});

/* ── Compute ───────────────────────────────────────────────────────────── */

const lambda = new LambdaStack(app, `Vyapio-${stage}-Lambda`, {
  ...common,
  table: database.table,
  bucket: storage.bucket,
  userPool: cognito.userPool,
  userPoolClient: cognito.userPoolClient,
  eventBus: events.eventBus,
  topic: events.topic,
  allowedOrigins,
  ai,
  notificationProvider,
  description: 'Vyapio: the API Lambda, as a Docker image',
});

const api = new ApiStack(app, `Vyapio-${stage}-Api`, {
  ...common,
  handler: lambda.handler,
  allowedOrigins,
  description: 'Vyapio: HTTP API',
});

/* ── Delivery ──────────────────────────────────────────────────────────── */

const frontend = new FrontendStack(app, `Vyapio-${stage}-Frontend`, {
  ...common,
  description: 'Vyapio: S3 and CloudFront for the PWA',
});

/* ── Ordering ──────────────────────────────────────────────────────────── */

lambda.addStackDependency(database);
lambda.addStackDependency(cognito);
lambda.addStackDependency(storage);
lambda.addStackDependency(events);
api.addStackDependency(lambda);
ai_.addStackDependency(storage);

/* ── Tags ──────────────────────────────────────────────────────────────── */

Tags.of(app).add('Application', 'Vyapio');
Tags.of(app).add('Stage', stage);
Tags.of(app).add('ManagedBy', 'CDK');

void frontend;
