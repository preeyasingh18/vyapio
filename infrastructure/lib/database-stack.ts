import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';

/**
 * DynamoDB.
 *
 * One table with two global secondary indexes, matching the single-table design
 * documented in `backend/src/services/dynamodb.ts`. Keep the two in step — the
 * index names here (`gsi1`, `gsi2`) are referenced by name in query code.
 *
 * Tenant isolation is a property of the key schema: every shop-owned item has
 * `pk = VENDOR#<vendorId>`, so a Query for one vendor physically cannot return
 * another vendor's rows.
 */
export class DatabaseStack extends Stack {
  readonly table: Table;

  constructor(scope: Construct, id: string, props: StackProps & { stage: string }) {
    super(scope, id, props);

    this.table = new Table(this, 'VyapioTable', {
      tableName: `vyapio-${props.stage}`,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },

      // On-demand: a hackathon deployment and a real neighbourhood shop have
      // the same traffic shape — bursty and low. Provisioned capacity would
      // cost more and throttle at exactly the wrong moment.
      billingMode: BillingMode.PAY_PER_REQUEST,

      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },

      // Idempotency records carry a `ttl` and expire themselves after 24h.
      timeToLiveAttribute: 'ttl',

      // A shop's ledger is not something to lose to a `cdk destroy` typo.
      // Dev stacks are disposable; anything else is retained.
      removalPolicy: props.stage === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    /**
     * GSI1 — lookups that cut across the partition:
     *   USER#<userId>            → login resolves to a vendor
     *   QR#<qrId>                → a scan resolves to a customer
     *   PHONE#<vendorId>#<phone> → the scanner's phone fallback
     *   CUSTLINK#<userId>        → the customer app's linked shops
     */
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    /**
     * GSI2 — the customer timeline, which spans entity types:
     *   CUST#<customerId> → TXN#/PAY#/CMT#/ORD# sorted by time
     */
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'gsi2pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    new CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'Set this as DYNAMODB_TABLE_NAME',
      exportName: `Vyapio-${props.stage}-TableName`,
    });
  }
}
