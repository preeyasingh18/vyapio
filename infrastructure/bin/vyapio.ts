#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseStack } from '../lib/database-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { StorageStack } from '../lib/storage-stack';
import { EventsStack } from '../lib/events-stack';
import { LambdaStack, type WhatsAppConfig } from '../lib/lambda-stack';
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
 *   notificationProvider  mock | sns | whatsapp           (default: mock)
 *
 * `whatsapp` additionally needs WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 * and WHATSAPP_PAYMENT_REMINDER_TEMPLATE in the repository root `.env`; the
 * deploy reads them from there so the token is never typed at a prompt.
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

/**
 * Who may call the API from a browser.
 *
 * On dev the deployed origin is *added* to the local ones rather than
 * replacing them: a deploy that silently revokes localhost breaks the machine
 * the next change is written on, and the failure shows up as "you're offline"
 * in the browser rather than as anything about CORS.
 *
 * On any other stage only the deployed origin is allowed — localhost has no
 * business reaching a real shop's data.
 */
const LOCAL_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'];
const allowedOrigins = appOrigin
  ? stage === 'dev'
    ? [appOrigin, ...LOCAL_ORIGINS]
    : [appOrigin]
  : LOCAL_ORIGINS;

const notificationProvider =
  (app.node.tryGetContext('notificationProvider') as string | undefined) ?? 'mock';

/**
 * WhatsApp credentials, read from the repository's `.env` rather than taken on
 * the command line.
 *
 * The access token is a credential, and the two obvious places to put it are
 * both wrong: committing it to this file publishes it, and passing it as
 * `-c whatsappToken=...` writes it into shell history on every deploy. `.env`
 * is already the file that holds it locally and is already gitignored, so the
 * deploy reads it from there and it is typed nowhere.
 *
 * It does end up as a Lambda environment variable, readable by anyone with
 * console access to this account. That is the trade this makes: a shop's
 * reminders working on AWS, against a secret that a Secrets Manager lookup at
 * cold start would protect better. Worth revisiting before real shops use it.
 */
const whatsapp = readWhatsAppConfig();

/**
 * Refuse a deployment that would claim to send and then couldn't.
 *
 * Without this the deploy succeeds, the Lambda comes up with
 * NOTIFICATION_PROVIDER=whatsapp and no token, and the first shopkeeper to
 * press "Send reminder" is the one who finds out. Failing here costs a minute;
 * failing there costs a customer who was never chased.
 */
if (notificationProvider === 'whatsapp' && !whatsapp) {
  throw new Error(
    'notificationProvider=whatsapp, but .env has no usable WhatsApp credentials. ' +
      'WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and ' +
      'WHATSAPP_PAYMENT_REMINDER_TEMPLATE must all be set in the repository root .env.',
  );
}

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
  // Only attached when WhatsApp is the chosen provider; a mock deployment has
  // no reason to be carrying a live access token.
  ...(notificationProvider === 'whatsapp' && whatsapp ? { whatsapp } : {}),
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

/* ── Reading .env ────────────────────────────────────────────────────────── */

/**
 * The repository's `.env`, parsed just far enough.
 *
 * Deliberately not `dotenv`: this needs four lines of parsing and adding a
 * dependency to the infrastructure package to get them would be the larger
 * change. It also does not touch `process.env` — nothing else in this app
 * should start behaving differently because a deploy read a file.
 */
function readDotEnv(): Record<string, string> {
  const file = path.join(__dirname, '../../.env');
  if (!fs.existsSync(file)) return {};

  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const split = trimmed.indexOf('=');
    if (split < 1) continue;

    const key = trimmed.slice(0, split).trim();
    // Quotes are how a value containing spaces is written; they are not part
    // of the value, and a token shipped with its quotes still attached fails
    // at Meta with an error about the token rather than about the quotes.
    const value = trimmed.slice(split + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    values[key] = value;
  }
  return values;
}

/**
 * The WhatsApp settings, or undefined if this machine has none.
 *
 * The real environment wins over the file so CI can supply these without one.
 * The three required values are required together: a token with no template is
 * not a partial configuration, it is a configuration that cannot send, because
 * Meta refuses business-initiated messages that are not templates.
 */
function readWhatsAppConfig(): WhatsAppConfig | undefined {
  const file = readDotEnv();

  /**
   * The real environment wins over the file, including when it is set to
   * nothing — `WHATSAPP_ACCESS_TOKEN= npx cdk deploy` is how a deploy says
   * "not this time" without editing `.env`. An empty value is never treated as
   * an answer, so the guard above catches it rather than a blank token
   * reaching Meta.
   */
  const read = (key: string): string | undefined => {
    const value = key in process.env ? process.env[key] : file[key];
    return value && value.length > 0 ? value : undefined;
  };

  const accessToken = read('WHATSAPP_ACCESS_TOKEN') ?? read('WHATSAPP_TOKEN');
  const phoneNumberId = read('WHATSAPP_PHONE_NUMBER_ID');
  const template = read('WHATSAPP_PAYMENT_REMINDER_TEMPLATE');
  if (!accessToken || !phoneNumberId || !template) return undefined;

  const requireOptIn = read('WHATSAPP_REQUIRE_OPT_IN');

  return {
    accessToken,
    phoneNumberId,
    template,
    businessAccountId: read('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    apiVersion: read('WHATSAPP_API_VERSION'),
    templateLanguage: read('WHATSAPP_TEMPLATE_LANGUAGE_CODE'),
    templateParams: read('WHATSAPP_TEMPLATE_PARAMS'),
    ...(requireOptIn === undefined ? {} : { requireOptIn: requireOptIn === 'true' }),
  };
}
