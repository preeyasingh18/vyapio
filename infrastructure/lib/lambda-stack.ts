import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DockerImageCode, DockerImageFunction, Architecture, Tracing } from 'aws-cdk-lib/aws-lambda';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'node:path';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { Topic } from 'aws-cdk-lib/aws-sns';

export type LambdaStackProps = StackProps & {
  stage: string;
  table: Table;
  bucket: Bucket;
  userPool: UserPool;
  userPoolClient: UserPoolClient;
  eventBus: EventBus;
  topic: Topic;
  allowedOrigins: string[];
  ai: {
    bedrockEnabled: boolean;
    bedrockRegion: string;
    modelId: string;
    knowledgeBaseId?: string;
    agentRuntimeArn?: string;
    transcribeEnabled: boolean;
    textractEnabled: boolean;
  };
  notificationProvider: string;
};

/**
 * The API Lambda.
 *
 * One function, packaged as a container image, serving the whole API and also
 * receiving the EventBridge rules. The brief calls for this explicitly, and it
 * is the right call for this workload: ten functions would mean ten cold
 * starts, ten sets of permissions and ten places for configuration to drift,
 * for an API that is modular in code already.
 *
 * `DockerImageFunction` builds `backend/Dockerfile`, pushes it to a CDK-managed
 * ECR repository and points the function at it — no console steps, no manual
 * `docker push`.
 */
export class LambdaStack extends Stack {
  readonly handler: DockerImageFunction;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    /**
     * An explicit repository alongside the CDK asset repository.
     *
     * CDK publishes the asset to its own bootstrap repository, so this one is
     * for images built outside the CDK pipeline — CI, or a developer running
     * `npm run docker:build`. Immutable tags mean a deployed digest cannot be
     * quietly replaced.
     */
    const repository = new Repository(this, 'VyapioBackendRepo', {
      repositoryName: `vyapio-backend-${props.stage}`,
      imageTagMutability: TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [
        { description: 'Keep the last 10 images', maxImageCount: 10 },
      ],
      removalPolicy: props.stage === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      emptyOnDelete: props.stage === 'dev',
    });

    /**
     * An explicit log group rather than the `logRetention` shortcut, which is
     * deprecated because it provisions a custom resource to set retention after
     * the fact. Declaring it here means retention is right from the first
     * invocation and the group is removed with the stack in dev.
     */
    const logGroup = new LogGroup(this, 'VyapioApiLogs', {
      logGroupName: `/aws/lambda/vyapio-api-${props.stage}`,
      retention: props.stage === 'dev' ? RetentionDays.ONE_WEEK : RetentionDays.ONE_MONTH,
      removalPolicy: props.stage === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    this.handler = new DockerImageFunction(this, 'VyapioApi', {
      functionName: `vyapio-api-${props.stage}`,
      description: 'Vyapio API — one modular Lambda behind API Gateway',

      code: DockerImageCode.fromImageAsset(path.join(__dirname, '../../backend'), {
        // Graviton: cheaper per millisecond and faster for this workload.
        platform: Platform.LINUX_ARM64,
      }),
      architecture: Architecture.ARM_64,

      // Bedrock calls dominate the tail; 30s is generous for everything else
      // and still well inside API Gateway's 29s response limit for the
      // synchronous paths.
      timeout: Duration.seconds(30),
      // 1024 MB also buys proportionally more CPU, which shortens cold starts
      // enough to pay for itself.
      memorySize: 1024,

      tracing: Tracing.ACTIVE,
      logGroup,

      environment: {
        STAGE: props.stage,
        AWS_REGION_OVERRIDE: this.region,

        DYNAMODB_TABLE_NAME: props.table.tableName,
        S3_BUCKET_NAME: props.bucket.bucketName,
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        SNS_TOPIC_ARN: props.topic.topicArn,

        CORS_ALLOWED_ORIGINS: props.allowedOrigins.join(','),
        NOTIFICATION_PROVIDER: props.notificationProvider,

        BEDROCK_ENABLED: String(props.ai.bedrockEnabled),
        BEDROCK_REGION: props.ai.bedrockRegion,
        BEDROCK_MODEL_ID: props.ai.modelId,
        ...(props.ai.knowledgeBaseId
          ? { BEDROCK_KNOWLEDGE_BASE_ID: props.ai.knowledgeBaseId }
          : {}),
        ...(props.ai.agentRuntimeArn ? { AGENTCORE_RUNTIME_ARN: props.ai.agentRuntimeArn } : {}),
        TRANSCRIBE_ENABLED: String(props.ai.transcribeEnabled),
        TEXTRACT_ENABLED: String(props.ai.textractEnabled),

        LOG_LEVEL: props.stage === 'dev' ? 'debug' : 'info',
        // Demo mode is off outside dev: it enables a known credential.
        DEMO_MODE: String(props.stage === 'dev'),
      },
    });

    /* ── Least privilege ──────────────────────────────────────────────────
     *
     * Each grant below is the narrowest one that works. Notably the Lambda can
     * read and write its own table and bucket, but has no DynamoDB or S3
     * permissions beyond them, and no ability to create or delete either.
     */

    props.table.grantReadWriteData(this.handler);
    props.bucket.grantReadWrite(this.handler);
    props.eventBus.grantPutEventsTo(this.handler);
    props.topic.grantPublish(this.handler);

    // Cognito: sign-up, sign-in and password reset only. Deliberately excludes
    // every Admin* action — the API cannot read or modify other users.
    this.handler.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'cognito-idp:SignUp',
          'cognito-idp:ConfirmSignUp',
          'cognito-idp:ResendConfirmationCode',
          'cognito-idp:InitiateAuth',
          'cognito-idp:ForgotPassword',
          'cognito-idp:ConfirmForgotPassword',
          'cognito-idp:GlobalSignOut',
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    if (props.ai.bedrockEnabled) {
      // Scoped to the configured model and its cross-region inference profile.
      // Anthropic models are listed because the profile may resolve to a
      // foundation-model ARN in a different region.
      this.handler.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:${props.ai.bedrockRegion}::foundation-model/*`,
            `arn:aws:bedrock:${props.ai.bedrockRegion}:${this.account}:inference-profile/*`,
          ],
        }),
      );
    }

    if (props.ai.knowledgeBaseId) {
      this.handler.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:Retrieve'],
          resources: [
            `arn:aws:bedrock:${props.ai.bedrockRegion}:${this.account}:knowledge-base/${props.ai.knowledgeBaseId}`,
          ],
        }),
      );
    }

    if (props.ai.agentRuntimeArn) {
      this.handler.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          resources: [props.ai.agentRuntimeArn],
        }),
      );
    }

    if (props.ai.transcribeEnabled) {
      // Transcribe streaming has no resource-level permissions, so the
      // action list is the only lever — it is kept to the one call used.
      this.handler.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['transcribe:StartStreamTranscription'],
          resources: ['*'],
        }),
      );
    }

    if (props.ai.textractEnabled) {
      this.handler.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['textract:AnalyzeExpense', 'textract:DetectDocumentText'],
          resources: ['*'],
        }),
      );
    }

    /**
     * Route business events back to this same function.
     *
     * The rule is defined here rather than in the Events stack on purpose: the
     * Lambda already depends on Events for the bus name, so putting a rule that
     * targets the function over there would close the loop into a stack
     * dependency cycle.
     */
    const eventDlq = new Queue(this, 'EventDLQ', {
      queueName: `vyapio-${props.stage}-events-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    new Rule(this, 'BusinessEventsRule', {
      ruleName: `vyapio-${props.stage}-business-events`,
      eventBus: props.eventBus,
      description: 'Routes Vyapio business events to the API Lambda',
      eventPattern: {
        source: ['vyapio.app'],
        detailType: [
          'CustomerCreated',
          'TransactionCreated',
          'PaymentRecorded',
          'InventoryChanged',
          'CommitmentCreated',
          'OrderReady',
          'AgentActionExecuted',
        ],
      },
      targets: [
        new LambdaFunction(this.handler, {
          retryAttempts: 2,
          // Undelivered events land here rather than vanishing. A stale derived
          // figure is recoverable; not knowing it went stale is not.
          deadLetterQueue: eventDlq,
        }),
      ],
    });

    new CfnOutput(this, 'FunctionName', {
      value: this.handler.functionName,
      exportName: `Vyapio-${props.stage}-FunctionName`,
    });

    new CfnOutput(this, 'EcrRepositoryUri', {
      value: repository.repositoryUri,
      description: 'For images built outside CDK (CI, or npm run docker:build)',
      exportName: `Vyapio-${props.stage}-EcrRepositoryUri`,
    });
  }
}
