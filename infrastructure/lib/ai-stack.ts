import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Role, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import type { Bucket } from 'aws-cdk-lib/aws-s3';

/**
 * AI support resources.
 *
 * Deliberately small, and the comment explaining *why* matters more than the
 * code:
 *
 * A Bedrock Knowledge Base needs a vector store. The managed options —
 * OpenSearch Serverless, Aurora Serverless v2, Pinecone — all carry a standing
 * hourly cost whether or not anybody asks a question. OpenSearch Serverless
 * alone is roughly $300/month at its minimum capacity. Provisioning that from
 * a hackathon template would hand somebody an unpleasant bill for a feature
 * they may never switch on.
 *
 * So this stack creates the IAM role the Knowledge Base will assume and the S3
 * prefix it will ingest from, and stops there. `docs/AWS_SETUP.md` walks
 * through creating the Knowledge Base itself, and setting
 * `BEDROCK_KNOWLEDGE_BASE_ID` activates it. Until then, Shop Memory runs on
 * deterministic retrieval — which is still fully grounded, because grounding
 * comes from citing real rows, not from the vector store.
 *
 * The same reasoning applies to AgentCore: the agent's tools, permission model,
 * confirmation gate and audit trail are all implemented, and setting
 * `AGENTCORE_RUNTIME_ARN` points the planner at a deployed runtime.
 */
export class AiStack extends Stack {
  readonly knowledgeBaseRole: Role;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { stage: string; bucket: Bucket; bedrockRegion: string },
  ) {
    super(scope, id, props);

    this.knowledgeBaseRole = new Role(this, 'KnowledgeBaseRole', {
      roleName: `vyapio-${props.stage}-knowledge-base`,
      assumedBy: new ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Assumed by a Bedrock Knowledge Base to ingest Vyapio shop exports',
    });

    // Read-only, and confined to the knowledge-base prefix — the ingestion job
    // has no business reading voice recordings or uploaded invoices.
    props.bucket.grantRead(this.knowledgeBaseRole, 'knowledge-base/*');

    this.knowledgeBaseRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          // Embeddings for ingestion. Titan Embed is the default the console
          // offers and the cheapest option for this volume.
          `arn:aws:bedrock:${props.bedrockRegion}::foundation-model/amazon.titan-embed-text-v2:0`,
          `arn:aws:bedrock:${props.bedrockRegion}::foundation-model/cohere.embed-multilingual-v3`,
        ],
      }),
    );

    new CfnOutput(this, 'KnowledgeBaseRoleArn', {
      value: this.knowledgeBaseRole.roleArn,
      description: 'Use this role when creating the Knowledge Base — see docs/AWS_SETUP.md',
      exportName: `Vyapio-${props.stage}-KnowledgeBaseRoleArn`,
    });

    new CfnOutput(this, 'KnowledgeBaseSourcePrefix', {
      value: `s3://${props.bucket.bucketName}/knowledge-base/`,
      description: 'Data source prefix for the Knowledge Base',
    });
  }
}
