import { beforeEach, describe, expect, it } from 'vitest';
import { createShop, request, resetWorld } from './helpers';

/**
 * Authentication and authorization.
 *
 * Covers the guard rails rather than the happy path alone: anonymous access,
 * forged tokens, role separation, and the account-enumeration surface of the
 * login and password-reset forms.
 */

describe('public endpoints', () => {
  beforeEach(() => {
    resetWorld();
  });

  it('serves health without a session', async () => {
    const response = await request('GET', '/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('reports which subsystems are local, so the UI can say so', async () => {
    const response = await request('GET', '/health');
    const runtime = response.body.runtime as {
      fullyProvisioned: boolean;
      localSubsystems: string[];
    };

    expect(runtime.fullyProvisioned).toBe(false);
    expect(runtime.localSubsystems).toContain('database');
  });
});

describe('protected endpoints', () => {
  beforeEach(() => {
    resetWorld();
  });

  const guarded: Array<[string, string]> = [
    ['GET', '/customers'],
    ['POST', '/customers'],
    ['GET', '/transactions'],
    ['POST', '/transactions'],
    ['GET', '/inventory'],
    ['GET', '/orders'],
    ['GET', '/ai/pulse'],
    ['POST', '/search'],
    ['POST', '/agent/run'],
    ['POST', '/voice/parse'],
    ['GET', '/payments'],
    ['POST', '/sync'],
  ];

  it.each(guarded)('rejects anonymous %s %s', async (method, path) => {
    const response = await request(method, path, { body: {} });
    expect(response.status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const response = await request('GET', '/customers', {
      token: 'eyJzdWIiOiJoYWNrZXIifQ.not-a-real-signature',
    });
    expect(response.status).toBe(401);
  });

  it('rejects a token with a tampered payload', async () => {
    const shop = await createShop({ email: 'tamper@test.app', shopName: 'Sharma Stores' });
    const [payload, signature] = shop.token.split('.');

    // Re-encode the payload with a different subject, keeping the old signature.
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    decoded.sub = 'usr_someone_else';
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    const response = await request('GET', '/customers', { token: forged });
    expect(response.status).toBe(401);
  });

  it('accepts a valid token', async () => {
    const shop = await createShop({ email: 'valid@test.app', shopName: 'Sharma Stores' });
    const response = await request('GET', '/customers', { token: shop.token });
    expect(response.status).toBe(200);
  });
});

describe('signup and login', () => {
  beforeEach(() => {
    resetWorld();
  });

  it('creates an account and a shop together', async () => {
    const signup = await request('POST', '/auth/signup', {
      body: {
        ownerName: 'Anil Sharma',
        email: 'new@test.app',
        phone: '9810012345',
        password: 'Passw0rd!',
        shopName: 'New Stores',
        category: 'kirana',
        city: 'Patna',
        language: 'en',
      },
    });

    expect(signup.status).toBe(201);

    const login = await request('POST', '/auth/login', {
      body: { email: 'new@test.app', password: 'Passw0rd!' },
    });

    expect(login.status).toBe(200);
    const vendor = login.body.vendor as { shopName: string };
    expect(vendor.shopName).toBe('New Stores');
  });

  it('requires a shop name for shopkeepers', async () => {
    const response = await request('POST', '/auth/signup', {
      body: {
        ownerName: 'No Shop',
        email: 'noshop@test.app',
        phone: '9810012399',
        password: 'Passw0rd!',
      },
    });

    expect(response.status).toBe(400);
  });

  it('rejects a weak password', async () => {
    const response = await request('POST', '/auth/signup', {
      body: {
        ownerName: 'Weak',
        email: 'weak@test.app',
        phone: '9810012388',
        password: 'password',
        shopName: 'Weak Stores',
      },
    });

    expect(response.status).toBe(422);
    const issues = (response.body.error as { issues: Array<{ path: string }> }).issues;
    expect(issues.some((issue) => issue.path === 'password')).toBe(true);
  });

  it('rejects a malformed phone number', async () => {
    const response = await request('POST', '/auth/signup', {
      body: {
        ownerName: 'Bad Phone',
        email: 'badphone@test.app',
        phone: '12345',
        password: 'Passw0rd!',
        shopName: 'Shop',
      },
    });

    expect(response.status).toBe(422);
  });

  it('refuses a duplicate email', async () => {
    const body = {
      ownerName: 'First',
      email: 'dupe@test.app',
      phone: '9810012377',
      password: 'Passw0rd!',
      shopName: 'First Stores',
    };

    await request('POST', '/auth/signup', { body });
    const second = await request('POST', '/auth/signup', { body });

    expect(second.status).toBe(409);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await createShop({ email: 'known@test.app', shopName: 'Known Stores' });

    const wrongPassword = await request('POST', '/auth/login', {
      body: { email: 'known@test.app', password: 'WrongPass1!' },
    });
    const unknownAccount = await request('POST', '/auth/login', {
      body: { email: 'nobody@test.app', password: 'WrongPass1!' },
    });

    // Differing responses would turn the login form into an account oracle.
    expect(wrongPassword.status).toBe(unknownAccount.status);
    expect((wrongPassword.body.error as { message: string }).message).toBe(
      (unknownAccount.body.error as { message: string }).message,
    );
  });

  it('does not reveal whether an email is registered on password reset', async () => {
    await createShop({ email: 'reset@test.app', shopName: 'Reset Stores' });

    const registered = await request('POST', '/auth/forgot-password', {
      body: { email: 'reset@test.app' },
    });
    const unknown = await request('POST', '/auth/forgot-password', {
      body: { email: 'nobody@test.app' },
    });

    expect(registered.status).toBe(unknown.status);
    expect(registered.body.message).toBe(unknown.body.message);
  });
});

describe('error responses', () => {
  beforeEach(() => {
    resetWorld();
  });

  it('never leaks internal detail in the user-facing message', async () => {
    const shop = await createShop({ email: 'errors@test.app', shopName: 'Sharma Stores' });
    const response = await request('GET', '/customers/cus_does_not_exist', {
      token: shop.token,
    });

    expect(response.status).toBe(404);
    const error = response.body.error as { code: string; message: string };
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).not.toMatch(/pk|sk|dynamo|vendor#/i);
  });

  it('returns field-level issues a form can render', async () => {
    const shop = await createShop({ email: 'issues@test.app', shopName: 'Sharma Stores' });
    const response = await request('POST', '/customers', {
      token: shop.token,
      body: { name: '', phone: 'abc' },
    });

    expect(response.status).toBe(422);
    const issues = (response.body.error as { issues: Array<{ path: string; message: string }> })
      .issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toHaveProperty('message');
  });

  it('answers 404 for an unknown route', async () => {
    const response = await request('GET', '/not-a-real-route');
    expect(response.status).toBe(404);
  });

  it('answers 405 when the path exists under another method', async () => {
    const response = await request('DELETE', '/health');
    expect(response.status).toBe(405);
  });
});

/**
 * Sessions that outlive what they point at.
 *
 * A local token is verified by signature alone, so it keeps working after the
 * data store behind it is gone — a reset, a restored backup, a signup that
 * failed halfway. The holder then looks signed in while the account or the shop
 * underneath has vanished. Both of these were real dead ends: the app routed
 * such a user to /onboarding and the only screen that could fix it answered
 * "we couldn't find that shop" for ever.
 */
describe('a session whose records are gone', () => {
  beforeEach(() => {
    resetWorld();
  });

  it('is refused at boot once the account no longer exists', async () => {
    const shop = await createShop({ email: 'ghost@test.app', shopName: 'Ghost Stores' });

    const before = await request('GET', '/auth/me', { token: shop.token });
    expect(before.status).toBe(200);

    // Everything the token refers to disappears; the token itself does not.
    resetWorld();

    const after = await request('GET', '/auth/me', { token: shop.token });
    expect(after.status).toBe(401);
  });

  it('lets onboarding rebuild a shop instead of dead-ending', async () => {
    const shop = await createShop({ email: 'rebuild@test.app', shopName: 'Old Name' });

    // The account survives; only the shop is missing. This is what /auth/me
    // reports as needsOnboarding, so onboarding has to be able to answer it.
    const { vendors } = await import('../src/services/repository');
    const { getStore, keys } = await import('../src/services/dynamodb');
    const { pk, sk } = keys.vendor(shop.vendor.vendorId);
    await getStore().delete(pk, sk);
    expect(await vendors.findByUserId(shop.userId)).toBeNull();

    const session = await request('GET', '/auth/me', { token: shop.token });
    expect(session.status).toBe(200);
    expect(session.body.needsOnboarding).toBe(true);

    const response = await request('POST', '/auth/onboarding', {
      token: shop.token,
      body: {
        shopName: 'Rebuilt Stores',
        category: 'kirana',
        city: 'Pune',
        language: 'en',
        voiceLanguage: 'hi',
      },
    });

    expect(response.status).toBe(200);
    const vendor = response.body.vendor as Record<string, unknown>;
    expect(vendor.shopName).toBe('Rebuilt Stores');
    expect(vendor.onboardingComplete).toBe(true);

    // And the user is now out of the loop that sent them there.
    const after = await request('GET', '/auth/me', { token: shop.token });
    expect(after.body.needsOnboarding).toBe(false);
  });
});

/**
 * Re-seeding keeps the email and changes the userId.
 *
 * This is the case an email-only liveness check misses, and it is not
 * hypothetical: `npm run seed -- --reset` rebuilds demo@vyapio.app under a new
 * userId every time. A browser still holding the previous token presents a
 * valid signature and a familiar address, but an id nothing is keyed to — so
 * the session is accepted, no shop resolves, and onboarding cheerfully builds a
 * second shop belonging to nobody.
 */
describe('a session for a rebuilt account', () => {
  beforeEach(() => {
    resetWorld();
  });

  it('is refused even though the email still exists', async () => {
    const first = await createShop({ email: 'rebuilt@test.app', shopName: 'First Run' });

    // Same address, fresh store — exactly what --reset produces.
    resetWorld();
    const second = await createShop({ email: 'rebuilt@test.app', shopName: 'Second Run' });
    expect(second.userId).not.toBe(first.userId);

    const stale = await request('GET', '/auth/me', { token: first.token });
    expect(stale.status).toBe(401);

    // The account that does exist is unaffected.
    const live = await request('GET', '/auth/me', { token: second.token });
    expect(live.status).toBe(200);
  });

  it('cannot use onboarding to strand a second shop on a dead userId', async () => {
    const first = await createShop({ email: 'strand@test.app', shopName: 'First Run' });
    resetWorld();
    await createShop({ email: 'strand@test.app', shopName: 'Second Run' });

    const response = await request('POST', '/auth/onboarding', {
      token: first.token,
      body: {
        shopName: 'Orphan Store',
        category: 'kirana',
        city: 'Pune',
        language: 'en',
        voiceLanguage: 'hi',
      },
    });

    expect(response.status).toBe(401);

    const { vendors } = await import('../src/services/repository');
    expect(await vendors.findByUserId(first.userId)).toBeNull();
  });
});
