/**
 * Runtime configuration for the Vyapio API.
 *
 * Every AWS-backed subsystem resolves to one of two modes:
 *
 *   'aws'   — the real service, configured through environment variables that
 *             CDK writes into the Lambda at deploy time.
 *   'local' — a functionally equivalent local adapter so the whole product runs
 *             on a laptop with no AWS account.
 *
 * The mode is derived from whether the required variables are actually present,
 * so a half-configured environment degrades one subsystem at a time rather than
 * failing wholesale. `describeRuntime()` is served to the client and rendered
 * as a visible badge: a local write must never be mistaken for a write that
 * reached AWS.
 */

export type AdapterMode = 'aws' | 'local';
export type Stage = 'dev' | 'staging' | 'prod';

function str(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function bool(name: string, fallback: boolean): boolean {
  const value = str(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

function int(name: string, fallback: number): number {
  const value = Number(str(name));
  return Number.isFinite(value) ? value : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const value = str(name);
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const stage = (str('STAGE') ?? 'dev') as Stage;
const region = str('AWS_REGION') ?? 'ap-south-1';

const tableName = str('DYNAMODB_TABLE_NAME');
const userPoolId = str('USER_POOL_ID');
const userPoolClientId = str('USER_POOL_CLIENT_ID');
const bucketName = str('S3_BUCKET_NAME');
const eventBusName = str('EVENT_BUS_NAME');

const bedrockEnabled = bool('BEDROCK_ENABLED', false);
const transcribeEnabled = bool('TRANSCRIBE_ENABLED', false);
const textractEnabled = bool('TEXTRACT_ENABLED', false);

export const config = {
  appName: 'Vyapio',
  stage,
  isProd: stage === 'prod',
  region,

  http: {
    /**
     * In dev an empty allow-list means "reflect the caller", which keeps local
     * tooling and LAN phone testing painless. In prod the list is mandatory and
     * unlisted origins get no CORS headers at all.
     */
    allowedOrigins: list('CORS_ALLOWED_ORIGINS', ['http://localhost:5173', 'http://localhost:4173']),
    /** Requests per minute per identity, enforced in-process per container. */
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 120),
    maxBodyBytes: int('MAX_BODY_BYTES', 1_000_000),
  },

  database: {
    mode: (tableName ? 'aws' : 'local'),
    tableName: tableName ?? 'vyapio-local',
    localDir: str('LOCAL_DATA_DIR') ?? '.vyapio-data',
    /**
     * Points the SDK somewhere other than the real service.
     *
     * Set to http://localhost:8000 to talk to DynamoDB Local in Docker: the
     * same code path, the same queries, the same single-table design — just a
     * different endpoint. That makes it a genuine rehearsal for the cloud,
     * unlike the file-backed store, which is a re-implementation.
     *
     * Empty in every deployed environment, where the SDK resolves the real
     * regional endpoint by itself.
     */
    endpoint: str('DYNAMODB_ENDPOINT'),
  },

  auth: {
    mode: (userPoolId && userPoolClientId ? 'aws' : 'local'),
    userPoolId,
    userPoolClientId,
    /** Never leaves the server: used only to compute the Cognito SECRET_HASH. */
    userPoolClientSecret: str('USER_POOL_CLIENT_SECRET'),
    localSecret: str('LOCAL_AUTH_SECRET') ?? 'vyapio-local-dev-secret-not-for-production',
    sessionTtlSeconds: int('SESSION_TTL_SECONDS', 60 * 60 * 12),
  },

  storage: {
    mode: (bucketName ? 'aws' : 'local'),
    bucketName,
    presignExpirySeconds: int('S3_PRESIGN_EXPIRY_SECONDS', 900),
  },

  ai: {
    mode: (bedrockEnabled ? 'aws' : 'local'),
    region: str('BEDROCK_REGION') ?? region,
    modelId: str('BEDROCK_MODEL_ID') ?? 'apac.anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: int('BEDROCK_MAX_TOKENS', 1600),
    knowledgeBaseId: str('BEDROCK_KNOWLEDGE_BASE_ID'),
    agentRuntimeArn: str('AGENTCORE_RUNTIME_ARN'),
    /**
     * Below this the voice preview stops presenting numbers as settled and asks
     * the shopkeeper to confirm each one. Confidence gates the *question*, never
     * the write — the write always needs a human tap.
     */
    lowConfidenceThreshold: 0.65,
  },

  transcribe: {
    mode: (transcribeEnabled ? 'aws' : 'local'),
    region: str('TRANSCRIBE_REGION') ?? region,
  },

  textract: {
    mode: (textractEnabled ? 'aws' : 'local'),
    region: str('TEXTRACT_REGION') ?? region,
  },

  events: {
    mode: (eventBusName ? 'aws' : 'local'),
    busName: eventBusName ?? 'vyapio-local-bus',
    source: 'vyapio.app',
  },

  notifications: {
    provider: (str('NOTIFICATION_PROVIDER') ?? 'mock') as 'mock' | 'sns' | 'whatsapp',
    snsTopicArn: str('SNS_TOPIC_ARN'),
    whatsappToken: str('WHATSAPP_TOKEN'),
    whatsappPhoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
  },

  demo: {
    enabled: bool('DEMO_MODE', true),
    email: str('DEMO_EMAIL') ?? 'demo@vyapio.app',
    password: str('DEMO_PASSWORD') ?? 'VyapioDemo#2024',
  },

  logging: {
    // 'silent' is used by the test suite, which asserts on behaviour rather
    // than on log output.
    level: (str('LOG_LEVEL') ?? (stage === 'dev' ? 'debug' : 'info')) as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error'
      | 'silent',
  },
} as const;

export type RuntimeDescription = {
  stage: Stage;
  region: string;
  demoMode: boolean;
  subsystems: {
    database: AdapterMode;
    auth: AdapterMode;
    ai: AdapterMode;
    transcribe: AdapterMode;
    textract: AdapterMode;
    storage: AdapterMode;
    events: AdapterMode;
  };
  notificationProvider: string;
  /** True only when every subsystem is talking to real AWS. */
  fullyProvisioned: boolean;
  /** Human-readable list of what is still running locally, for the UI badge. */
  localSubsystems: string[];
};

export function describeRuntime(): RuntimeDescription {
  const subsystems = {
    database: config.database.mode,
    auth: config.auth.mode,
    ai: config.ai.mode,
    transcribe: config.transcribe.mode,
    textract: config.textract.mode,
    storage: config.storage.mode,
    events: config.events.mode,
  };
  const localSubsystems = Object.entries(subsystems)
    .filter(([, mode]) => mode === 'local')
    .map(([name]) => name);

  return {
    stage: config.stage,
    region: config.region,
    demoMode: config.demo.enabled,
    subsystems,
    notificationProvider: config.notifications.provider,
    fullyProvisioned: localSubsystems.length === 0,
    localSubsystems,
  };
}

/**
 * Guards against the most dangerous misconfiguration: shipping to production
 * with the local development auth adapter, which would let anyone mint a
 * session. Called once at cold start.
 */
export function assertProductionSafety(): void {
  if (!config.isProd) return;

  const problems: string[] = [];
  if (config.auth.mode === 'local') {
    problems.push('USER_POOL_ID/USER_POOL_CLIENT_ID are required when STAGE=prod');
  }
  if (config.database.mode === 'local') {
    problems.push('DYNAMODB_TABLE_NAME is required when STAGE=prod');
  }
  if (config.http.allowedOrigins.some((origin) => origin.includes('localhost'))) {
    problems.push('CORS_ALLOWED_ORIGINS must not contain localhost when STAGE=prod');
  }
  if (problems.length > 0) {
    throw new Error(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
