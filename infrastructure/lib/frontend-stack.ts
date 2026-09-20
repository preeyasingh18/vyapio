import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import {
  Distribution,
  ViewerProtocolPolicy,
  CachePolicy,
  AllowedMethods,
  ResponseHeadersPolicy,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  PriceClass,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';

/**
 * Frontend hosting.
 *
 * A private S3 bucket behind CloudFront with origin access control — the bucket
 * itself stays closed to the internet, and only the distribution can read it.
 *
 * Two details matter for a single-page PWA:
 *
 *   404 and 403 both rewrite to /index.html with a 200, so a deep link like
 *   /app/customers/cus_123 is served the app rather than an S3 error.
 *
 *   sw.js and index.html are served with no-cache. Without that, CloudFront
 *   would happily serve a month-old service worker that refuses to update, and
 *   the PWA would be frozen on an old build with no way to recover.
 */
export class FrontendStack extends Stack {
  readonly bucket: Bucket;
  readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: StackProps & { stage: string }) {
    super(scope, id, props);

    this.bucket = new Bucket(this, 'VyapioWebBucket', {
      bucketName: `vyapio-web-${props.stage}-${this.account}-${this.region}`,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: props.stage === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: props.stage === 'dev',
    });

    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `vyapio-${props.stage}-security`,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          // The scanner needs the camera and voice needs the microphone; nothing
          // else is allowed.
          {
            header: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=()',
            override: true,
          },
        ],
      },
    });

    this.distribution = new Distribution(this, 'VyapioDistribution', {
      comment: `Vyapio ${props.stage}`,
      defaultRootObject: 'index.html',

      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // Hashed asset filenames make long caching safe.
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: securityHeaders,
      },

      additionalBehaviors: {
        // An outdated service worker cannot be evicted by a deploy, so it must
        // never be cached in the first place.
        '/sw.js': {
          origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
        },
        '/index.html': {
          origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
        },
      },

      // Client-side routing: any unknown path is the app's to resolve.
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],

      // India, Europe and North America. The full edge network costs more for
      // an audience that is overwhelmingly in one country.
      priceClass: PriceClass.PRICE_CLASS_200,
      enableLogging: false,
    });

    new CfnOutput(this, 'WebBucketName', {
      value: this.bucket.bucketName,
      description: 'Upload the frontend build here: aws s3 sync frontend/dist s3://<bucket>',
      exportName: `Vyapio-${props.stage}-WebBucketName`,
    });

    new CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'For cache invalidation after a deploy',
      exportName: `Vyapio-${props.stage}-DistributionId`,
    });

    new CfnOutput(this, 'AppUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'The Vyapio app. Add this to CORS_ALLOWED_ORIGINS and redeploy the API.',
      exportName: `Vyapio-${props.stage}-AppUrl`,
    });
  }
}
