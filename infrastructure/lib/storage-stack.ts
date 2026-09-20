import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
} from 'aws-cdk-lib/aws-s3';

/**
 * S3.
 *
 * One private bucket, keyed by tenant:
 *
 *   vendors/{vendorId}/voice/
 *   vendors/{vendorId}/documents/
 *   vendors/{vendorId}/receipts/
 *   vendors/{vendorId}/products/
 *
 * Isolation is enforced in the application layer (`assertKeyBelongsTo` in
 * backend/src/services/s3.ts), because a presigned URL is minted per request
 * and the bucket policy cannot know which vendor is asking. The bucket blocks
 * all public access, so a leaked key is useless without a signature.
 */
export class StorageStack extends Stack {
  readonly bucket: Bucket;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { stage: string; allowedOrigins: string[] },
  ) {
    super(scope, id, props);

    this.bucket = new Bucket(this, 'VyapioBucket', {
      bucketName: `vyapio-${props.stage}-${this.account}-${this.region}`,

      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: props.stage !== 'dev',

      /**
       * The browser PUTs directly to S3 with a presigned URL, so the bucket
       * needs CORS. ETag is exposed because the upload response carries it and
       * the client uses it to confirm the object landed.
       */
      cors: [
        {
          allowedMethods: [HttpMethods.PUT, HttpMethods.POST, HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: props.allowedOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],

      lifecycleRules: [
        {
          // Voice recordings are raw material for a transcript that is already
          // stored on the transaction. Keeping the audio beyond a quarter is
          // storage cost and privacy exposure with no matching benefit.
          id: 'expire-voice-recordings',
          prefix: 'vendors/',
          tagFilters: { kind: 'voice' },
          expiration: Duration.days(90),
        },
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: Duration.days(3),
        },
      ],

      removalPolicy: props.stage === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: props.stage === 'dev',
    });

    new CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'Set this as S3_BUCKET_NAME',
      exportName: `Vyapio-${props.stage}-BucketName`,
    });
  }
}
