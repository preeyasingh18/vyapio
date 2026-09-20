import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  GlobalSignOutCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from '../config/index';
import { AppError, unauthenticated } from '../utils/errors';
import { nowIso } from '../utils/dates';
import { newUserId, safeEqual } from '../utils/ids';
import { getStore, keys } from './dynamodb';
import type { AuthContext } from '../utils/router';
import type { Role } from '../schemas/common';

/**
 * Authentication.
 *
 * Two implementations behind one interface:
 *
 *   Cognito  — real user pool. Sign-up, email verification, password reset and
 *              token refresh all happen in Cognito; the API only ever sees
 *              JWTs and verifies them against the pool's JWKS.
 *   Local    — the backend issues its own HMAC-signed tokens against a
 *              password record in the store, so the full auth journey works
 *              with no AWS account. Refused outright when STAGE=prod.
 *
 * The client never holds AWS credentials in either mode. USER_PASSWORD_AUTH is
 * driven server-side precisely so the app client secret — if the pool uses one —
 * stays out of the browser.
 */

export type AuthTokens = {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
};

export type AuthUser = {
  userId: string;
  email: string;
  role: Role;
  name: string;
  phone: string;
  emailVerified: boolean;
};

export type SignupInput = {
  email: string;
  password: string;
  name: string;
  phone: string;
  role: Role;
};

/* ------------------------------------------------------------------ Cognito */

let cognitoClient: CognitoIdentityProviderClient | null = null;
function cognito(): CognitoIdentityProviderClient {
  cognitoClient ??= new CognitoIdentityProviderClient({ region: config.region });
  return cognitoClient;
}

/**
 * Cognito requires this HMAC when the app client has a secret. Computing it
 * here is what allows a *confidential* client — the client secret never has to
 * be shipped to the browser.
 */
function secretHash(username: string): string | undefined {
  const secret = config.auth.userPoolClientSecret;
  if (!secret) return undefined;
  return createHmac('sha256', secret)
    .update(username + config.auth.userPoolClientId)
    .digest('base64');
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
function jwtVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.auth.userPoolId!,
      clientId: config.auth.userPoolClientId!,
      tokenUse: 'access',
    });
  }
  return verifier;
}

function toTokens(result: AuthenticationResultType | undefined): AuthTokens {
  if (!result?.AccessToken || !result.IdToken) {
    throw new AppError('UNAUTHENTICATED', 'Cognito returned no tokens');
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken ?? '',
    expiresIn: result.ExpiresIn ?? 3600,
    tokenType: 'Bearer',
  };
}

/* -------------------------------------------------------------- Local mode */

type LocalUserRecord = {
  userId: string;
  email: string;
  name: string;
  phone: string;
  role: Role;
  passwordSalt: string;
  passwordHash: string;
  emailVerified: boolean;
  /** Six-digit code for the local verification and reset journeys. */
  pendingCode?: string;
  createdAt: string;
};

function hashPassword(password: string, salt: string): string {
  return pbkdf2Sync(password, salt, 120_000, 64, 'sha512').toString('base64');
}

function verifyPassword(password: string, salt: string, expected: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

/**
 * Token claims are typed `unknown`. Anything that is not already a string is
 * dropped rather than coerced — `String({})` would quietly produce
 * "[object Object]" and put it in a userId.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * Minimal signed token for local mode: `payload.signature`, HS256 over the
 * local secret. Deliberately not a full JWT library — it only has to be good
 * enough for a development session, and `assertProductionSafety()` prevents it
 * from ever running in production.
 */
function signLocalToken(payload: Record<string, unknown>): string {
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', config.auth.localSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyLocalToken(token: string): Record<string, unknown> {
  const [body, signature] = token.split('.');
  if (!body || !signature) throw unauthenticated('Malformed local token');

  const expected = createHmac('sha256', config.auth.localSecret).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) throw unauthenticated('Bad local token signature');

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
    throw unauthenticated('Local token expired');
  }
  return payload;
}

async function readLocalUser(email: string): Promise<LocalUserRecord | null> {
  const { pk, sk } = keys.localUser(email);
  const item = await getStore().get(pk, sk);
  return item ? (item as unknown as LocalUserRecord) : null;
}

async function writeLocalUser(record: LocalUserRecord): Promise<void> {
  await getStore().put({
    ...keys.localUser(record.email),
    entity: 'LocalAuthUser',
    ...record,
  });
}

function localTokens(user: LocalUserRecord): AuthTokens {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.userId,
    email: user.email,
    name: user.name,
    'custom:role': user.role,
    token_use: 'local',
    iat: issuedAt,
    exp: issuedAt + config.auth.sessionTtlSeconds,
  };
  const token = signLocalToken(payload);
  return {
    accessToken: token,
    idToken: token,
    // Long-lived so a dev session survives a restart; rotated on every refresh.
    refreshToken: signLocalToken({ sub: user.userId, email: user.email, typ: 'refresh' }),
    expiresIn: config.auth.sessionTtlSeconds,
    tokenType: 'Bearer',
  };
}

/* ------------------------------------------------------------------- Facade */

/**
 * Creates or repairs the demo user in Cognito.
 *
 * `AdminCreateUser` suppresses the invitation email — nobody is being invited,
 * and there is no mailbox behind demo@vyapio.app to receive it. The password
 * is then set as permanent, because a user created this way otherwise lands in
 * FORCE_CHANGE_PASSWORD and cannot sign in with it.
 *
 * Idempotent: an account that already exists has its password reset to the
 * configured one rather than being refused, so re-running the seed fixes a
 * demo login instead of failing on it.
 */
async function ensureCognitoUser(input: SignupInput & { userId?: string }): Promise<string> {
  const UserPoolId = config.auth.userPoolId!;

  try {
    await cognito().send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: input.email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: input.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: input.name },
          { Name: 'phone_number', Value: `+91${input.phone}` },
          { Name: 'custom:role', Value: input.role },
        ],
      }),
    );
  } catch (error) {
    // Already there. The password below still runs, so a forgotten or expired
    // demo password is repaired by re-seeding.
    if (!(error instanceof Error && error.name === 'UsernameExistsException')) throw error;
  }

  await cognito().send(
    new AdminSetUserPasswordCommand({
      UserPoolId,
      Username: input.email,
      Password: input.password,
      Permanent: true,
    }),
  );

  // Cognito's own `sub` is the user id everything else keys off.
  const account = await cognito().send(
    new AdminGetUserCommand({ UserPoolId, Username: input.email }),
  );
  const sub = account.UserAttributes?.find((entry) => entry.Name === 'sub')?.Value;
  if (!sub) throw new AppError('INTERNAL', 'Cognito returned a user with no sub');

  return sub;
}

export const authService = {
  mode: () => config.auth.mode,

  /**
   * Hashes a password for a signup that has not been verified yet.
   *
   * Exposed so the pending-signup record can hold a hash rather than the
   * password — same function login verifies against, so there is exactly one
   * definition of what a stored password is.
   */
  hashNewPassword(password: string): { salt: string; hash: string } {
    const salt = randomBytes(16).toString('base64');
    return { salt, hash: hashPassword(password, salt) };
  },

  /** The account behind an address, or null. Used to refuse a duplicate signup. */
  async findByEmail(email: string): Promise<{ userId: string } | null> {
    if (config.auth.mode === 'aws') return null;
    const user = await readLocalUser(email);
    return user ? { userId: user.userId } : null;
  },

  /**
   * Writes the account, with the password already hashed.
   *
   * The only path that creates a locally-authenticated user outside the demo
   * seed — and it is reached only from /auth/confirm, which is what makes
   * "no account without a verified email" true rather than merely intended.
   */
  async createVerifiedUser(input: {
    email: string;
    ownerName: string;
    phone: string;
    role: Role;
    passwordSalt: string;
    passwordHash: string;
  }): Promise<string> {
    const record: LocalUserRecord = {
      userId: newUserId(),
      email: input.email.toLowerCase(),
      name: input.ownerName,
      phone: input.phone,
      role: input.role,
      passwordSalt: input.passwordSalt,
      passwordHash: input.passwordHash,
      emailVerified: true,
      createdAt: nowIso(),
    };
    await writeLocalUser(record);
    return record.userId;
  },

  async signup(input: SignupInput): Promise<{ userId: string; requiresVerification: boolean }> {
    if (config.auth.mode === 'aws') {
      const result = await cognito().send(
        new SignUpCommand({
          ClientId: config.auth.userPoolClientId!,
          Username: input.email,
          Password: input.password,
          SecretHash: secretHash(input.email),
          UserAttributes: [
            { Name: 'email', Value: input.email },
            { Name: 'name', Value: input.name },
            { Name: 'phone_number', Value: `+91${input.phone}` },
            { Name: 'custom:role', Value: input.role },
          ],
        }),
      );
      return {
        userId: result.UserSub ?? '',
        requiresVerification: result.UserConfirmed !== true,
      };
    }

    const existing = await readLocalUser(input.email);
    if (existing) {
      throw new AppError('CONFLICT', 'Email already registered', {
        userMessage: 'An account with that email already exists. Try signing in.',
      });
    }

    const salt = randomBytes(16).toString('base64');
    const record: LocalUserRecord = {
      userId: newUserId(),
      email: input.email.toLowerCase(),
      name: input.name,
      phone: input.phone,
      role: input.role,
      passwordSalt: salt,
      passwordHash: hashPassword(input.password, salt),
      // Local mode verifies immediately — there is no mailbox to check, and
      // pretending an email was sent would be a lie.
      emailVerified: true,
      createdAt: nowIso(),
    };
    await writeLocalUser(record);
    return { userId: record.userId, requiresVerification: false };
  },

  async login(email: string, password: string): Promise<AuthTokens> {
    if (config.auth.mode === 'aws') {
      try {
        const result = await cognito().send(
          new InitiateAuthCommand({
            ClientId: config.auth.userPoolClientId!,
            AuthFlow: 'USER_PASSWORD_AUTH',
            AuthParameters: {
              USERNAME: email,
              PASSWORD: password,
              ...(secretHash(email) ? { SECRET_HASH: secretHash(email)! } : {}),
            },
          }),
        );
        return toTokens(result.AuthenticationResult);
      } catch (error) {
        if (error instanceof Error && error.name === 'UserNotConfirmedException') {
          throw new AppError('FORBIDDEN', 'User not confirmed', {
            userMessage: 'Please verify your email first. We can send the code again.',
          });
        }
        if (error instanceof Error && error.name === 'NotAuthorizedException') {
          throw new AppError('UNAUTHENTICATED', 'Bad credentials', {
            userMessage: 'That email and password do not match.',
          });
        }
        throw error;
      }
    }

    const user = await readLocalUser(email);
    // Same message for "no such user" and "wrong password" — a different one
    // would turn the login form into an account-enumeration oracle.
    const invalid = new AppError('UNAUTHENTICATED', 'Bad credentials', {
      userMessage: 'That email and password do not match.',
    });
    if (!user) throw invalid;
    if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) throw invalid;
    return localTokens(user);
  },

  async confirmSignup(email: string, code: string): Promise<void> {
    if (config.auth.mode === 'aws') {
      await cognito().send(
        new ConfirmSignUpCommand({
          ClientId: config.auth.userPoolClientId!,
          Username: email,
          ConfirmationCode: code,
          SecretHash: secretHash(email),
        }),
      );
      return;
    }
    const user = await readLocalUser(email);
    if (!user) throw unauthenticated('Unknown account');
    await writeLocalUser({ ...user, emailVerified: true, pendingCode: undefined });
  },

  async resendCode(email: string): Promise<void> {
    if (config.auth.mode === 'aws') {
      await cognito().send(
        new ResendConfirmationCodeCommand({
          ClientId: config.auth.userPoolClientId!,
          Username: email,
          SecretHash: secretHash(email),
        }),
      );
      return;
    }
    throw new AppError('NOT_CONFIGURED', 'No mail provider in local auth mode', {
      userMessage:
        'Local accounts are verified automatically — no code is needed. Just sign in.',
    });
  },

  async forgotPassword(email: string): Promise<void> {
    if (config.auth.mode === 'aws') {
      await cognito().send(
        new ForgotPasswordCommand({
          ClientId: config.auth.userPoolClientId!,
          Username: email,
          SecretHash: secretHash(email),
        }),
      );
      return;
    }
    throw new AppError('NOT_CONFIGURED', 'No mail provider in local auth mode', {
      userMessage:
        'Password reset needs email, which is not configured locally. Configure Cognito, or create another local account.',
    });
  },

  async resetPassword(email: string, code: string, password: string): Promise<void> {
    if (config.auth.mode === 'aws') {
      await cognito().send(
        new ConfirmForgotPasswordCommand({
          ClientId: config.auth.userPoolClientId!,
          Username: email,
          ConfirmationCode: code,
          Password: password,
          SecretHash: secretHash(email),
        }),
      );
      return;
    }
    throw new AppError('NOT_CONFIGURED', 'Password reset requires Cognito');
  },

  async refresh(refreshToken: string, username: string): Promise<AuthTokens> {
    if (config.auth.mode === 'aws') {
      const result = await cognito().send(
        new InitiateAuthCommand({
          ClientId: config.auth.userPoolClientId!,
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: {
            REFRESH_TOKEN: refreshToken,
            ...(secretHash(username) ? { SECRET_HASH: secretHash(username)! } : {}),
          },
        }),
      );
      return { ...toTokens(result.AuthenticationResult), refreshToken };
    }

    const payload = verifyLocalToken(refreshToken);
    if (payload.typ !== 'refresh') throw unauthenticated('Not a refresh token');
    const user = await readLocalUser(asString(payload.email));
    if (!user) throw unauthenticated('Unknown account');
    return localTokens(user);
  },

  async logout(accessToken: string): Promise<void> {
    if (config.auth.mode === 'aws') {
      try {
        await cognito().send(new GlobalSignOutCommand({ AccessToken: accessToken }));
      } catch {
        // An already-invalid token is a successful logout from the user's view.
      }
    }
    // Local mode is stateless; the client discards the token.
  },

  /**
   * Verifies a bearer token and returns the caller's identity.
   *
   * This is the only place a userId enters the system. `vendorId` is
   * deliberately absent — it is resolved from the store in middleware/auth.ts,
   * never read from a token claim the client could influence.
   */
  async verify(token: string): Promise<AuthContext> {
    if (config.auth.mode === 'aws') {
      try {
        const payload = await jwtVerifier().verify(token);
        return {
          userId: asString(payload.sub),
          email: asString(payload.username) || asString(payload.email),
          name: asString(payload.name) || undefined,
          role: (payload['custom:role'] as Role | undefined) ?? 'SHOPKEEPER',
          tokenUse: 'access',
        };
      } catch (error) {
        throw unauthenticated(`JWT verification failed: ${String(error)}`);
      }
    }

    const payload = verifyLocalToken(token);
    if (payload.typ === 'refresh') throw unauthenticated('Refresh token used as access token');
    return {
      userId: asString(payload.sub),
      email: asString(payload.email),
      name: asString(payload.name) || undefined,
      role: (payload['custom:role'] as Role | undefined) ?? 'SHOPKEEPER',
      tokenUse: 'local',
    };
  },

  /**
   * Whether the account behind a local-mode session still exists.
   *
   * Local tokens are signed with LOCAL_AUTH_SECRET and verified by signature
   * alone — no lookup — so they stay valid across a wipe of the data store.
   * Without this check a session outlives its own account: the holder looks
   * signed in, is routed past the landing page, and then finds nothing behind
   * it. Cognito does its own revocation, so this only applies locally.
   */
  async localSessionIsLive(userId: string, email: string): Promise<boolean> {
    if (config.auth.mode === 'aws') return true;
    if (!userId || !email) return false;

    const record = await readLocalUser(email);
    // The userId has to match, not merely the email. Re-seeding rebuilds the
    // demo account under a fresh userId while keeping the same address, so an
    // email-only check passes for a token whose user is gone — and everything
    // downstream then resolves against an id nothing is keyed to.
    return record !== null && record.userId === userId;
  },

  /** Used by the seed script to provision the demo login in local mode. */
  /**
   * The demo account, made to exist and to have this password.
   *
   * Used by the seed, which is the one place allowed to mint an account
   * without a verification code — it is building a shop nobody owns, from a
   * fixed email and password that are in the configuration.
   *
   * In AWS mode the account has to live in Cognito, because that is where
   * `login` looks. Seeding a deployed environment used to throw here, so the
   * demo shop could be written to DynamoDB and then be impossible to sign in
   * to: the data was there and the door was not.
   */
  async ensureLocalUser(input: SignupInput & { userId?: string }): Promise<string> {
    if (config.auth.mode === 'aws') return ensureCognitoUser(input);
    const existing = await readLocalUser(input.email);
    const salt = existing?.passwordSalt ?? randomBytes(16).toString('base64');
    const record: LocalUserRecord = {
      userId: existing?.userId ?? input.userId ?? newUserId(),
      email: input.email.toLowerCase(),
      name: input.name,
      phone: input.phone,
      role: input.role,
      passwordSalt: salt,
      passwordHash: hashPassword(input.password, salt),
      emailVerified: true,
      createdAt: existing?.createdAt ?? nowIso(),
    };
    await writeLocalUser(record);
    return record.userId;
  },
};
