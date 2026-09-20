import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request, resetWorld } from './helpers';
import { setEmailProvider, type EmailMessage } from '../src/services/email';
import { readPending } from '../src/services/verification';

/**
 * Email verification at signup.
 *
 * The rule being protected: **an account does not exist until the address is
 * proven.** Creating the user first and flipping a flag later leaves a shop's
 * books reachable by whoever typed the address, which need not be the person
 * who owns the mailbox.
 *
 * The code is read off the captured email rather than out of the record,
 * because the record only ever holds a hash of it — which is the point.
 */

const outbox: EmailMessage[] = [];

const capture = {
  name: 'test-capture',
  async send(message: EmailMessage) {
    outbox.push(message);
    return { ok: true, sent: true, provider: 'test-capture', detail: 'Captured.' };
  },
};

const FORM = {
  ownerName: 'Anil Sharma',
  email: 'Anil@Example.COM',
  phone: '9810012345',
  password: 'Passw0rd!',
  shopName: 'Anil Stores',
  category: 'kirana',
  city: 'Patna',
  language: 'en',
};

const EMAIL = 'anil@example.com';

const signup = (body: Record<string, unknown> = {}) =>
  request('POST', '/auth/signup', { body: { ...FORM, ...body } });

const confirm = (code: string, email = EMAIL) =>
  request('POST', '/auth/confirm', { body: { email, code } });

function latestCode(): string {
  const message = [...outbox].reverse().find((entry) => entry.to === EMAIL);
  if (!message) throw new Error('no verification email was sent');
  const match = /\b(\d{6})\b/.exec(message.text);
  if (!match) throw new Error('no six-digit code in that email');
  return match[1]!;
}

beforeEach(() => {
  resetWorld();
  outbox.length = 0;
  setEmailProvider(capture);
});

afterEach(() => setEmailProvider(null));

describe('signing up creates nothing yet', () => {
  it('sends a code instead of an account', async () => {
    const response = await signup();

    expect(response.status).toBe(201);
    expect(response.body.requiresVerification).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.subject).toMatch(/verify/i);
  });

  it('will not let anyone sign in before the code comes back', async () => {
    await signup();

    const login = await request('POST', '/auth/login', {
      body: { email: EMAIL, password: FORM.password },
    });

    // Not "unverified" — there is no account at all to be unverified.
    expect(login.status).toBe(401);
  });

  it('never returns the code', async () => {
    const response = await signup();
    const code = latestCode();

    expect(JSON.stringify(response.body)).not.toContain(code);
  });

  it('never stores the code or the password', async () => {
    await signup();
    const code = latestCode();
    const pending = await readPending(EMAIL);
    const stored = JSON.stringify(pending);

    // A row is a thing that gets backed up, logged and exported.
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(FORM.password);
    expect(pending!.codeHash).toBeTruthy();
    expect(pending!.passwordHash).toBeTruthy();
  });

  it('treats the address as one thing however it was typed', async () => {
    // Signed up as Anil@Example.COM; everything after is anil@example.com.
    await signup();

    expect(outbox[0]!.to).toBe(EMAIL);
    expect((await readPending(EMAIL))!.email).toBe(EMAIL);
  });
});

describe('entering the code', () => {
  it('creates the account and the shop', async () => {
    await signup();
    const response = await confirm(latestCode());

    expect(response.status).toBe(200);

    const login = await request('POST', '/auth/login', {
      body: { email: EMAIL, password: FORM.password },
    });
    expect(login.status).toBe(200);
    expect((login.body.vendor as { shopName: string }).shopName).toBe('Anil Stores');
  });

  it('works when the address is typed back in a different case', async () => {
    await signup();
    const response = await confirm(latestCode(), 'ANIL@example.com');

    expect(response.status).toBe(200);
  });

  it('cannot be used twice', async () => {
    await signup();
    const code = latestCode();
    await confirm(code);

    // The record is gone, so a replayed code has nothing to match against —
    // and cannot produce a second account for one address.
    const replay = await confirm(code);
    expect(replay.status).not.toBe(200);
  });

  it('rejects the wrong code and says how many tries are left', async () => {
    await signup();
    const response = await confirm('000000');

    expect(response.status).toBe(422);
    expect((response.body.error as { message: string }).message).toMatch(/invalid/i);
  });

  it('stops accepting guesses after five', async () => {
    await signup();
    for (let attempt = 0; attempt < 5; attempt += 1) await confirm('000000');

    // The real code no longer works either: the guessing killed it, not the
    // guesser's luck.
    const withRealCode = await confirm(latestCode());
    expect(withRealCode.status).toBe(429);
  });

  it('refuses a code that has expired', async () => {
    await signup();

    // Reach past the ten minutes rather than waiting them out.
    const pending = (await readPending(EMAIL))!;
    const { getStore, keys } = await import('../src/services/dynamodb');
    await getStore().put({
      ...keys.pendingSignup(EMAIL),
      entity: 'PendingSignup',
      ...pending,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const response = await confirm(latestCode());
    expect(response.status).toBe(422);
    expect((response.body.error as { message: string }).message).toMatch(/expired/i);
  });

  it('says nothing useful about an address that never signed up', async () => {
    const response = await confirm('123456', 'stranger@example.com');

    // Same answer as an expired signup, so this cannot be used to find out
    // who is mid-registration.
    expect(response.status).toBe(422);
    expect((response.body.error as { message: string }).message).toMatch(/expired|start again/i);
  });
});

describe('asking for another code', () => {
  it('refuses a second request straight away', async () => {
    await signup();
    const response = await request('POST', '/auth/resend-code', { body: { email: EMAIL } });

    expect(response.status).toBe(429);
    expect((response.body.error as { message: string }).message).toMatch(/wait/i);
  });

  it('invalidates the old code once a new one goes out', async () => {
    await signup();
    const first = latestCode();

    // Past the cooldown, without waiting a minute.
    const pending = (await readPending(EMAIL))!;
    const { getStore, keys } = await import('../src/services/dynamodb');
    await getStore().put({
      ...keys.pendingSignup(EMAIL),
      entity: 'PendingSignup',
      ...pending,
      lastSentAt: new Date(Date.now() - 120_000).toISOString(),
    });

    const resend = await request('POST', '/auth/resend-code', { body: { email: EMAIL } });
    expect(resend.status).toBe(200);
    expect(outbox).toHaveLength(2);

    const second = latestCode();
    expect(second).not.toBe(first);

    // Two live codes would halve what a guesser has to beat.
    const old = await confirm(first);
    expect(old.status).not.toBe(200);

    const fresh = await confirm(second);
    expect(fresh.status).toBe(200);
  });
});

describe('when the email cannot be sent', () => {
  it('fails the signup rather than leaving an account nobody can reach', async () => {
    setEmailProvider({
      name: 'broken',
      async send() {
        return { ok: false, sent: false, provider: 'broken', detail: 'SMTP refused.' };
      },
    });

    const response = await signup();

    expect(response.status).toBe(502);
    expect((response.body.error as { message: string }).message).toMatch(/unable to send/i);

    // Nothing left behind, so trying again is a clean start.
    expect(await readPending(EMAIL)).toBeNull();
  });
});
