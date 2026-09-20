import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalisePhone, toWhatsAppNumber, formatE164 } from '../src/utils/phone';

/**
 * WhatsApp Business Cloud API.
 *
 * Two things are being protected here.
 *
 * The first is that a message goes to the right person. Numbers are stored as
 * ten digits because that is what a shopkeeper types, and adding +91 back on
 * is easy to get wrong in the direction that matters: prefixing a number that
 * already has a country code sends someone else's debt to a stranger.
 *
 * The second is that nothing claims a delivery that did not happen. Meta only
 * accepts a message the shop starts if it uses an approved template, so a
 * half-configured integration fails at Meta — after the shopkeeper has been
 * told the reminder went out.
 */

describe('turning a saved number into one WhatsApp accepts', () => {
  const e164 = (raw: string) => {
    const result = normalisePhone(raw);
    return result.ok ? result.e164 : `refused:${result.reason}`;
  };

  it('adds the country code to the ten digits a shopkeeper types', () => {
    expect(e164('9876543210')).toBe('+919876543210');
  });

  it('accepts the shapes the same number is written in', () => {
    for (const written of [
      '919876543210',
      '+919876543210',
      '+91 98765 43210',
      '09876543210',
      '98765 43210',
    ]) {
      expect(e164(written), written).toBe('+919876543210');
    }
  });

  it('leaves a number that already has another country code alone', () => {
    // The one mistake that sends a message to the wrong person: a shop with a
    // supplier abroad has a +971 number on file, and +91 in front of it
    // reaches a stranger.
    expect(e164('+971501234567')).toBe('+971501234567');
    expect(e164('+14155552671')).toBe('+14155552671');
  });

  it('trusts an explicit country code over the ten-digit rule', () => {
    /**
     * A ten-digit foreign number with a "+" in front of it.
     *
     * Length alone would send this down the Indian path, where it fails the
     * "starts with 6-9" check and is refused — a number the shopkeeper typed
     * correctly, rejected for not being Indian. The plus is the author saying
     * which country this is, and it is believed.
     */
    expect(e164('+1415555267')).toBe('+1415555267');
    expect(e164('+442079460958')).toBe('+442079460958');
  });

  it('refuses a number that is not one', () => {
    expect(e164('')).toBe('refused:missing');
    expect(e164('   ')).toBe('refused:missing');
    expect(e164('12345')).toBe('refused:invalid');
    expect(e164('not a number')).toBe('refused:invalid');
  });

  it('refuses an Indian number that cannot be a mobile', () => {
    // Indian mobiles start 6-9. Sending to a landline silently fails at Meta.
    expect(e164('1234567890')).toBe('refused:invalid');
  });

  it('says what is wrong in words the shopkeeper can act on', () => {
    const missing = normalisePhone('');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.detail).toMatch(/no phone number/i);

    const wrong = normalisePhone('1234567890');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.detail).toMatch(/6, 7, 8 or 9/);
  });

  it('hands Meta digits without the plus, and the shopkeeper one with it', () => {
    expect(toWhatsAppNumber('+919876543210')).toBe('919876543210');
    expect(formatE164('+919876543210')).toBe('+91 98765 43210');
  });
});

/* ------------------------------------------------------ The provider itself */

/**
 * Config is read once at import, so each case re-imports the modules with its
 * own environment rather than mutating a frozen object.
 */
async function withEnv(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const notifications = await import('../src/services/notifications');
  notifications.setProvider(null);
  return notifications;
}

const CONFIGURED = {
  NOTIFICATION_PROVIDER: 'whatsapp',
  WHATSAPP_ACCESS_TOKEN: 'test-token-never-logged',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_PAYMENT_REMINDER_TEMPLATE: 'payment_reminder',
  WHATSAPP_TEMPLATE_LANGUAGE_CODE: 'en',
};

const REQUEST = {
  vendorId: 'ven_1',
  customerId: 'cus_1',
  type: 'payment_reminder' as const,
  to: '9876543210',
  body: 'Namaste Ramesh, ₹340 is due.',
  templateValues: ['Ramesh Kumar', '₹340', 'Sharma Stores'],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('sending a reminder through WhatsApp', () => {
  it('sends an approved template, not free text', async () => {
    // Meta rejects free-form text outside a window the customer opens by
    // writing first — which a shop chasing money does not have.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getProvider } = await withEnv(CONFIGURED);
    const result = await getProvider().send(REQUEST);

    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe('wamid.TEST');

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      type: string;
      to: string;
      template: {
        name: string;
        language: { code: string };
        components: Array<{ type: string; parameters: Array<{ type: string; text: string }> }>;
      };
    };

    expect(body.type).toBe('template');
    expect(body.template.name).toBe('payment_reminder');
    expect(body.template.language.code).toBe('en');
    expect(body.to).toBe('919876543210');
    expect(body.template.components[0]!.parameters.map((entry) => entry.text)).toEqual([
      'Ramesh Kumar',
      '₹340',
      'Sharma Stores',
    ]);
  });

  it('calls the configured API version', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'x' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { getProvider } = await withEnv({ ...CONFIGURED, WHATSAPP_API_VERSION: 'v22.0' });
    await getProvider().send(REQUEST);

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://graph.facebook.com/v22.0/1234567890/messages',
    );
  });

  it('never puts the access token anywhere but the header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'x' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { getProvider } = await withEnv(CONFIGURED);
    const result = await getProvider().send(REQUEST);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBe('Bearer test-token-never-logged');
    expect(String(url)).not.toContain('test-token-never-logged');
    expect(init.body).not.toContain('test-token-never-logged');
    // And nothing the shopkeeper or the log sees carries it either.
    expect(JSON.stringify(result)).not.toContain('test-token-never-logged');
  });

  it('refuses rather than sending when no template is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { getProvider } = await withEnv({
      ...CONFIGURED,
      WHATSAPP_PAYMENT_REMINDER_TEMPLATE: '',
    });
    const result = await getProvider().send(REQUEST);

    // The failure has to happen here, not at Meta after the shopkeeper has
    // been told the reminder went out.
    expect(result.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.detail).toMatch(/template/i);
  });

  it('does not call WhatsApp at all when there is no number', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { getProvider } = await withEnv(CONFIGURED);
    const result = await getProvider().send({ ...REQUEST, to: '' });

    expect(result.status).toBe('no_phone');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('separates a number it cannot use from one that is missing', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const { getProvider } = await withEnv(CONFIGURED);
    const result = await getProvider().send({ ...REQUEST, to: '12345' });

    // Different problems, different fixes — the shopkeeper needs to know
    // whether to add a number or correct one.
    expect(result.status).toBe('invalid_phone');
  });

  it('turns Meta\'s error into something a shopkeeper can act on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 132001, message: 'Template name does not exist' } }),
          { status: 400 },
        ),
      ),
    );

    const { getProvider } = await withEnv(CONFIGURED);
    const result = await getProvider().send(REQUEST);

    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/no approved template/i);
    // Meta's own words are kept for whoever is fixing it, not shown as the
    // explanation.
    expect(result.failureReason).toContain('Template name does not exist');
  });

  it('names an expired token as the thing to replace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 190, message: 'Session expired' } }), {
          status: 401,
        }),
      ),
    );

    const { getProvider } = await withEnv(CONFIGURED);
    const result = await getProvider().send(REQUEST);

    expect(result.detail).toMatch(/token/i);
  });

  it('reports a network failure as nothing sent, rather than throwing', async () => {
    // A thrown error here would abort a whole batch of reminders partway
    // through, leaving the shopkeeper with no idea which ones went.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    const { getProvider } = await withEnv(CONFIGURED);
    const result = await getProvider().send(REQUEST);

    expect(result.ok).toBe(false);
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/nothing was sent/i);
  });
});

/* ------------------------------------------------------ What the UI is told */

describe('what the browser is allowed to know', () => {
  it('reports WhatsApp as connected once it is fully set up', async () => {
    const { describeProvider } = await withEnv(CONFIGURED);
    const status = describeProvider();

    expect(status.status).toBe('connected');
    expect(status.canDeliver).toBe(true);
    expect(status.template).toBe('payment_reminder');
  });

  it('never returns the access token', async () => {
    const { describeProvider } = await withEnv(CONFIGURED);
    expect(JSON.stringify(describeProvider())).not.toContain('test-token-never-logged');
  });

  it('calls a half-configured WhatsApp what it is', async () => {
    // Credentials set but no template looks like success from outside, right
    // up until a reminder is sent and Meta rejects it.
    const { describeProvider } = await withEnv({
      ...CONFIGURED,
      WHATSAPP_PAYMENT_REMINDER_TEMPLATE: '',
    });
    const status = describeProvider();

    expect(status.status).toBe('incomplete');
    expect(status.canDeliver).toBe(false);
    expect(status.note).toContain('WHATSAPP_PAYMENT_REMINDER_TEMPLATE');
  });

  it('still reports the mock provider honestly', async () => {
    const { describeProvider } = await withEnv({ NOTIFICATION_PROVIDER: 'mock' });
    const status = describeProvider();

    expect(status.status).toBe('not_configured');
    expect(status.canDeliver).toBe(false);
  });

  it('leaves SNS reporting as connected, as it did before', async () => {
    const { describeProvider } = await withEnv({ NOTIFICATION_PROVIDER: 'sns' });
    expect(describeProvider().canDeliver).toBe(true);
  });
});
