import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HttpApi, CorsHttpMethod, HttpMethod, ThrottleSettings } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';

/**
 * API Gateway.
 *
 * HTTP API rather than REST API: roughly a third of the cost, lower latency,
 * and native support for a catch-all proxy route — which is what this needs,
 * since routing happens inside the Lambda.
 *
 * Authorisation is deliberately *not* delegated to a JWT authorizer here. The
 * API verifies tokens itself (backend/src/middleware/auth.ts) because it also
 * has to resolve the token's subject to a vendor, and splitting that across two
 * layers would mean two places to get tenancy wrong.
 */
export class ApiStack extends Stack {
  readonly api: HttpApi;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      stage: string;
      handler: IFunction;
      allowedOrigins: string[];
    },
  ) {
    super(scope, id, props);

    const throttle: ThrottleSettings = {
      // A shop's real traffic is a handful of requests a minute. These limits
      // are high enough never to be felt and low enough to bound a runaway
      // client or a bad retry loop.
      rateLimit: 100,
      burstLimit: 200,
    };

    this.api = new HttpApi(this, 'VyapioApi', {
      apiName: `vyapio-${props.stage}`,
      description: 'Vyapio API',

      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
        allowCredentials: true,
        maxAge: Duration.days(1),
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', props.handler);

    // Catch-all: the Lambda's own router owns the path space.
    this.api.addRoutes({
      path: '/{proxy+}',
      methods: [
        HttpMethod.GET,
        HttpMethod.POST,
        HttpMethod.PUT,
        HttpMethod.PATCH,
        HttpMethod.DELETE,
        HttpMethod.OPTIONS,
      ],
      integration,
    });

    this.api.addRoutes({ path: '/', methods: [HttpMethod.GET], integration });

    // Default stage throttling, applied to the auto-deployed $default stage.
    const defaultStage = this.api.defaultStage?.node.defaultChild as
      | { throttleSettings?: ThrottleSettings }
      | undefined;
    if (defaultStage) defaultStage.throttleSettings = throttle;

    new LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/vyapio-${props.stage}`,
      retention: props.stage === 'dev' ? RetentionDays.ONE_WEEK : RetentionDays.ONE_MONTH,
    });

    new CfnOutput(this, 'ApiUrl', {
      value: this.api.apiEndpoint,
      description: 'Set this as VITE_API_URL when building the frontend',
      exportName: `Vyapio-${props.stage}-ApiUrl`,
    });
  }
}
