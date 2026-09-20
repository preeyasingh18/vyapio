import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput, Names } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  AccountRecovery,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  StringAttribute,
  UserPoolDomain,
  VerificationEmailStyle,
} from 'aws-cdk-lib/aws-cognito';

/**
 * Cognito.
 *
 * One pool for both roles. `custom:role` distinguishes a SHOPKEEPER from a
 * CUSTOMER, which keeps a single sign-in flow and lets one person be both —
 * a shopkeeper is somebody else's customer too.
 *
 * The app client is public (no secret) and enables USER_PASSWORD_AUTH, which
 * the API drives server-side. That is deliberate: the browser never holds AWS
 * credentials, and if the pool is later switched to a confidential client the
 * secret is read from `USER_POOL_CLIENT_SECRET` on the server only.
 */
export class CognitoStack extends Stack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: StackProps & { stage: string }) {
    super(scope, id, props);

    this.userPool = new UserPool(this, 'VyapioUserPool', {
      userPoolName: `vyapio-${props.stage}`,

      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },

      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: true, mutable: true },
        phoneNumber: { required: false, mutable: true },
      },

      customAttributes: {
        // Read by the API from the verified token; never trusted from a body.
        role: new StringAttribute({ minLen: 1, maxLen: 20, mutable: true }),
      },

      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        // Deliberately not requiring symbols: it is the rule that most often
        // pushes people towards writing the password down, and length plus
        // mixed case carries more real entropy.
        requireSymbols: false,
        tempPasswordValidity: Duration.days(3),
      },

      accountRecovery: AccountRecovery.EMAIL_ONLY,

      userVerification: {
        emailSubject: 'Your Vyapio verification code',
        emailBody: 'Welcome to Vyapio. Your verification code is {####}',
        emailStyle: VerificationEmailStyle.CODE,
      },

      removalPolicy: props.stage === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('VyapioWebClient', {
      userPoolClientName: `vyapio-web-${props.stage}`,

      // A public client, so no secret reaches the browser bundle.
      generateSecret: false,

      authFlows: {
        // Driven server-side by the API; see backend/src/services/auth.ts.
        userPassword: true,
        userSrp: true,
      },

      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.EMAIL, OAuthScope.OPENID, OAuthScope.PROFILE],
      },

      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],

      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),

      // Uniform failures, so the sign-in form cannot be used to discover which
      // email addresses have accounts.
      preventUserExistenceErrors: true,
    });

    /**
     * Hosted UI domain — not used by the app, but it makes password reset and
     * federated sign-in available later without extra work.
     *
     * The prefix must be globally unique and may contain only lowercase
     * letters, digits and hyphens. `this.account` cannot be used: it is an
     * unresolved token at synth time when the stack is environment-agnostic.
     * `Names.uniqueId` resolves during synthesis and is derived from the
     * construct path, so it is stable across deploys of the same stack.
     */
    const domainSuffix = Names.uniqueId(this).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8);

    new UserPoolDomain(this, 'VyapioUserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: `vyapio-${props.stage}-${domainSuffix}` },
    });

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Set as USER_POOL_ID (server) and VITE_COGNITO_USER_POOL_ID (browser)',
      exportName: `Vyapio-${props.stage}-UserPoolId`,
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Set as USER_POOL_CLIENT_ID (server) and VITE_COGNITO_CLIENT_ID (browser)',
      exportName: `Vyapio-${props.stage}-UserPoolClientId`,
    });
  }
}
