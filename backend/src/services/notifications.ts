import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { nowIso } from '../utils/dates';
import { newNotificationId } from '../utils/ids';
import { formatMoney } from '../utils/money';
import { normalisePhone, toWhatsAppNumber } from '../utils/phone';
import { notifications as notificationRepo } from './repository';
import type { Notification, NotificationStatus, NotificationType } from '../schemas/entities';

/**
 * Notifications.
 *
 * The single rule this module exists to enforce: **never report a delivery that
 * did not happen.** An agent that claims "3 reminders sent" when nothing left
 * the machine is worse than one that sends nothing, because the shopkeeper
 * stops chasing the money.
 *
 * So `delivered` is a distinct field from `ok`, the mock provider returns
 * `delivered: false` with a plain-language reason, and every caller — including
 * the agent's confirmation screen — reports the per-recipient outcome it
 * actually got back.
 */

export type NotificationRequest = {
  vendorId: string;
  customerId?: string;
  type: NotificationType;
  to: string;
  /**
   * The message in words.
   *
   * Still required: it is what SNS sends, what the mock provider records, and
   * what the reminder log shows the shopkeeper. A WhatsApp template is chosen
   * and filled by Meta, so it is not what goes on the wire there — but the
   * shopkeeper still needs to see what the customer was told.
   */
  body: string;
  subject?: string;
  /** Overrides the configured WhatsApp template for this one message. */
  template?: string;
  /** Values for the template's {{1}}, {{2}}, … in order. */
  templateValues?: string[];
  /** Overrides the configured template language for this one message. */
  templateLanguage?: string;
};

export type DeliveryResult = {
  /** The request was processed without error. */
  ok: boolean;
  /**
   * What to record against the notification.
   *
   * Distinct from `ok` and `delivered` because those two answer yes/no and
   * the shopkeeper's next move depends on *why*: a missing number is
   * something they can fix in ten seconds, an expired token is not.
   */
  status?: NotificationStatus;
  /** The provider's own error, for diagnosis. Never shown to the shopkeeper. */
  failureReason?: string;
  /**
   * A message actually left this system for the recipient. False for the mock
   * provider, always — and the UI says so.
   */
  delivered: boolean;
  provider: string;
  channel: string;
  messageId?: string;
  /** Plain-language explanation, shown to the shopkeeper verbatim. */
  detail: string;
};

export interface NotificationProvider {
  readonly name: string;
  readonly channel: string;
  send(request: NotificationRequest): Promise<DeliveryResult>;
}

/* ------------------------------------------------------------ MockProvider */

/**
 * The default. Records the message so the flow is fully exercisable, and is
 * explicit that nothing was sent.
 */
class MockProvider implements NotificationProvider {
  readonly name = 'mock';
  readonly channel = 'none';

  async send(request: NotificationRequest): Promise<DeliveryResult> {
    logger.info('notification recorded (not delivered)', {
      operation: 'notifications.mock',
      vendorId: request.vendorId,
      notificationType: request.type,
    });
    return {
      ok: true,
      delivered: false,
      provider: this.name,
      channel: this.channel,
      detail:
        'Recorded only — no messaging provider is configured, so nothing was sent to the customer.',
    };
  }
}

/* ------------------------------------------------------------- SNSProvider */

class SNSProvider implements NotificationProvider {
  readonly name = 'sns';
  readonly channel = 'sms';
  private client: SNSClient | null = null;

  private sns(): SNSClient {
    this.client ??= new SNSClient({ region: config.region });
    return this.client;
  }

  async send(request: NotificationRequest): Promise<DeliveryResult> {
    try {
      // Topic publish for fan-out; direct SMS when a number is given.
      const target = config.notifications.snsTopicArn
        ? { TopicArn: config.notifications.snsTopicArn }
        : { PhoneNumber: snsTarget(request.to) };

      const result = await this.sns().send(
        new PublishCommand({
          ...target,
          Message: request.body,
          ...(request.subject ? { Subject: request.subject.slice(0, 100) } : {}),
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
          },
        }),
      );

      return {
        ok: true,
        // SNS accepted it. That is genuine hand-off, not proof of handset
        // receipt, and the wording below does not overclaim.
        delivered: true,
        provider: this.name,
        channel: config.notifications.snsTopicArn ? 'sns-topic' : 'sms',
        messageId: result.MessageId,
        detail: 'Accepted by Amazon SNS for delivery.',
      };
    } catch (error) {
      logger.error('SNS publish failed', {
        operation: 'notifications.sns',
        vendorId: request.vendorId,
        error,
      });
      return {
        ok: false,
        delivered: false,
        provider: this.name,
        channel: this.channel,
        detail: 'Amazon SNS rejected the message. Nothing was sent.',
      };
    }
  }
}

/* -------------------------------------------------------- WhatsAppProvider */

/**
 * WhatsApp Business Cloud API.
 *
 * The important constraint, and the reason this is more than an HTTP POST:
 * Meta only accepts free-form text inside a 24-hour window that the *customer*
 * opens by writing first. A shopkeeper chasing an overdue payment has no such
 * window, so a business-initiated reminder has to be a pre-approved template.
 *
 * Sending text anyway does not fail quietly in a useful place — it fails at
 * Meta, after the shopkeeper has been told the reminder went out. So with no
 * template configured this refuses up front and says why, rather than
 * attempting a send that is known not to work.
 *
 * Template variables are positional in Meta's API — {{1}}, {{2}} — so the only
 * thing that has to line up is their order. `WHATSAPP_TEMPLATE_PARAMS` names
 * which value goes in which slot, so an approved template with a different
 * shape is a configuration change rather than a code change.
 */
class WhatsAppProvider implements NotificationProvider {
  readonly name = 'whatsapp';
  readonly channel = 'whatsapp';

  async send(request: NotificationRequest): Promise<DeliveryResult> {
    const {
      whatsappToken,
      whatsappPhoneNumberId,
      whatsappApiVersion,
      whatsappTemplate,
      whatsappTemplateLanguage,
    } = config.notifications;

    if (!whatsappToken || !whatsappPhoneNumberId) {
      return {
        ok: false,
        delivered: false,
        provider: this.name,
        channel: this.channel,
        status: 'failed',
        detail: 'WhatsApp credentials are not configured, so nothing was sent.',
      };
    }

    const phone = normalisePhone(request.to);
    if (!phone.ok) {
      return {
        ok: false,
        delivered: false,
        provider: this.name,
        channel: this.channel,
        status: phone.reason === 'missing' ? 'no_phone' : 'invalid_phone',
        detail: phone.detail,
      };
    }

    // A caller may name its own template; otherwise the configured one is used.
    const templateName = request.template ?? whatsappTemplate;
    if (!templateName) {
      return {
        ok: false,
        delivered: false,
        provider: this.name,
        channel: this.channel,
        status: 'failed',
        detail:
          'No WhatsApp template is configured. Meta only accepts a message the shop starts if it uses an approved template — set WHATSAPP_PAYMENT_REMINDER_TEMPLATE.',
      };
    }

    const parameters = (request.templateValues ?? []).map((text) => ({
      type: 'text' as const,
      text,
    }));

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWhatsAppNumber(phone.e164),
      type: 'template',
      template: {
        name: templateName,
        language: { code: request.templateLanguage ?? whatsappTemplateLanguage },
        ...(parameters.length > 0 ? { components: [{ type: 'body', parameters }] } : {}),
      },
    };

    try {
      // A timeout, because a hung request would hold the whole confirm step,
      // and the shopkeeper is standing at a counter watching it.
      const response = await fetch(
        `https://graph.facebook.com/${whatsappApiVersion}/${whatsappPhoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${whatsappToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        },
      );

      const raw = await response.text();

      if (!response.ok) {
        const reason = readMetaError(raw);

        // The token is never logged — it is not in the payload, and the
        // headers are not part of what is recorded here.
        logger.error('WhatsApp send failed', {
          operation: 'notifications.whatsapp',
          vendorId: request.vendorId,
          status: response.status,
          template: templateName,
          metaCode: reason.code,
          metaMessage: reason.message,
        });

        return {
          ok: false,
          delivered: false,
          provider: this.name,
          channel: this.channel,
          status: 'failed',
          failureReason: `HTTP ${response.status}: ${reason.message}`,
          detail: explainMetaFailure(response.status, reason, templateName),
        };
      }

      const accepted = safeJson(raw) as { messages?: Array<{ id?: string }> } | null;
      const messageId = accepted?.messages?.[0]?.id;

      logger.info('WhatsApp message accepted', {
        operation: 'notifications.whatsapp',
        vendorId: request.vendorId,
        template: templateName,
        messageId,
      });

      return {
        ok: true,
        delivered: true,
        provider: this.name,
        channel: this.channel,
        status: 'sent',
        ...(messageId ? { messageId } : {}),
        detail: 'Delivered to WhatsApp.',
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      logger.error('WhatsApp request threw', {
        operation: 'notifications.whatsapp',
        vendorId: request.vendorId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        delivered: false,
        provider: this.name,
        channel: this.channel,
        status: 'failed',
        failureReason: error instanceof Error ? error.message : String(error),
        detail: timedOut
          ? 'WhatsApp did not answer in time. Nothing was sent — try again.'
          : 'Could not reach WhatsApp. Nothing was sent.',
      };
    }
  }
}

/** Meta returns its own error envelope; this digs the useful part out of it. */
function readMetaError(raw: string): { code?: number; message: string } {
  const parsed = safeJson(raw) as
    | { error?: { code?: number; message?: string; error_data?: { details?: string } } }
    | null;
  const error = parsed?.error;
  if (!error) return { message: raw.slice(0, 200) || 'no response body' };
  return {
    ...(error.code !== undefined ? { code: error.code } : {}),
    message: error.error_data?.details ?? error.message ?? 'unknown error',
  };
}

/**
 * Meta's error, rewritten for the person who has to fix it.
 *
 * The raw message names API fields a shopkeeper has never heard of. These say
 * what is wrong and where to change it; the codes are Meta's documented ones.
 */
function explainMetaFailure(
  status: number,
  reason: { code?: number; message: string },
  templateName: string,
): string {
  if (status === 401 || reason.code === 190) {
    return 'WhatsApp rejected the access token — it has expired or been revoked. Generate a new one in Meta.';
  }
  if (reason.code === 132001) {
    return `WhatsApp has no approved template called "${templateName}" in that language. Check the name and the language code in Meta.`;
  }
  if (reason.code === 132000) {
    return `The template "${templateName}" expects a different number of values than were sent. Line up WHATSAPP_TEMPLATE_PARAMS with the template in Meta.`;
  }
  if (reason.code === 131026) {
    return 'That number is not on WhatsApp, so nothing was delivered.';
  }
  if (status === 429 || reason.code === 130429) {
    return 'WhatsApp is rate limiting this number. Nothing was sent — wait a few minutes and try again.';
  }
  if (reason.code === 131047) {
    return 'WhatsApp needs an approved template for a message the shop starts. Nothing was sent.';
  }
  return `WhatsApp rejected the message (HTTP ${status}). Nothing was sent.`;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- Facade */

/** SNS wants E.164 too; an unusable number is left as-is for SNS to reject. */
function snsTarget(phone: string): string {
  const parsed = normalisePhone(phone);
  return parsed.ok ? parsed.e164 : phone;
}

let provider: NotificationProvider | null = null;

export function getProvider(): NotificationProvider {
  if (provider) return provider;
  switch (config.notifications.provider) {
    case 'sns':
      provider = new SNSProvider();
      break;
    case 'whatsapp':
      provider = new WhatsAppProvider();
      break;
    default:
      provider = new MockProvider();
  }
  return provider;
}

/**
 * What the UI is allowed to know about messaging.
 *
 * Every field here is deliberately non-secret. The access token is read in
 * this module and nowhere else, and no route returns it — the browser learns
 * whether messaging works and what to fix, never the credentials themselves.
 */
export type ProviderStatus = {
  provider: string;
  channel: string;
  configured: boolean;
  /** Whether a message would actually reach a customer right now. */
  canDeliver: boolean;
  status: 'connected' | 'not_configured' | 'incomplete';
  /** The template name, which is not a secret and is the usual thing to get wrong. */
  template?: string;
  templateLanguage?: string;
  /** Whether consent is enforced before sending. */
  requiresOptIn: boolean;
  /** Plain language, shown verbatim in the UI. */
  note: string;
};

export function describeProvider(): ProviderStatus {
  const active = getProvider();
  const {
    whatsappToken,
    whatsappPhoneNumberId,
    whatsappTemplate,
    whatsappTemplateLanguage,
    whatsappRequireOptIn,
  } = config.notifications;

  const base = {
    provider: active.name,
    channel: active.channel,
    requiresOptIn: active.name === 'whatsapp' && whatsappRequireOptIn,
  };

  if (active.name === 'mock') {
    return {
      ...base,
      configured: false,
      canDeliver: false,
      status: 'not_configured',
      note: 'No messaging provider is configured, so reminders are recorded but not sent. Set NOTIFICATION_PROVIDER to whatsapp or sns to deliver them.',
    };
  }

  if (active.name === 'whatsapp') {
    /**
     * Three things have to be present, and a missing template is the one that
     * looks fine until a reminder is actually sent: Meta will not accept a
     * message the shop starts without an approved template, so "credentials
     * are set" is not the same as "this works".
     */
    const missing = [
      whatsappToken ? null : 'WHATSAPP_ACCESS_TOKEN',
      whatsappPhoneNumberId ? null : 'WHATSAPP_PHONE_NUMBER_ID',
      whatsappTemplate ? null : 'WHATSAPP_PAYMENT_REMINDER_TEMPLATE',
    ].filter((entry): entry is string => entry !== null);

    if (missing.length > 0) {
      return {
        ...base,
        configured: false,
        canDeliver: false,
        status: 'incomplete',
        ...(whatsappTemplate ? { template: whatsappTemplate } : {}),
        note: `WhatsApp is selected but not finished: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. Reminders are recorded but not sent.`,
      };
    }

    return {
      ...base,
      configured: true,
      canDeliver: true,
      status: 'connected',
      template: whatsappTemplate,
      templateLanguage: whatsappTemplateLanguage,
      note: 'Payment reminders are delivered through WhatsApp.',
    };
  }

  return {
    ...base,
    configured: true,
    canDeliver: true,
    status: 'connected',
    note: `Reminders are delivered through ${active.name}.`,
  };
}

/**
 * Whether Meta has actually approved the configured template.
 *
 * `describeProvider` can only see what is in the environment, and "the
 * credentials are set" is not the same as "this works": a template sits in
 * review for a while after it is created, and until it clears, every reminder
 * is rejected. Reporting "connected" through that window tells the shopkeeper
 * their messages are going out when none of them are.
 *
 * This asks Meta, so it is a network call — it belongs on the screen where
 * someone is setting WhatsApp up, not in the reminder list, which is read far
 * more often.
 */
export async function checkWhatsAppTemplate(): Promise<
  { ok: true } | { ok: false; status: string; detail: string }
> {
  const {
    whatsappToken,
    whatsappBusinessAccountId,
    whatsappApiVersion,
    whatsappTemplate,
    whatsappTemplateLanguage,
  } = config.notifications;

  // Nothing to check. A missing business account id is not an error: it is
  // needed only for this lookup, never for sending.
  if (!whatsappToken || !whatsappTemplate || !whatsappBusinessAccountId) return { ok: true };

  try {
    const response = await fetch(
      `https://graph.facebook.com/${whatsappApiVersion}/${whatsappBusinessAccountId}/message_templates?name=${encodeURIComponent(whatsappTemplate)}`,
      {
        headers: { authorization: `Bearer ${whatsappToken}` },
        signal: AbortSignal.timeout(8_000),
      },
    );

    // Could not ask. That is not evidence of a problem, so this reports no
    // problem rather than inventing one from a failed lookup.
    if (!response.ok) return { ok: true };

    const payload = (await response.json()) as {
      data?: Array<{ name: string; language: string; status: string }>;
    };
    const found = payload.data?.find((entry) => entry.language === whatsappTemplateLanguage);

    if (!found) {
      return {
        ok: false,
        status: 'missing',
        detail: `WhatsApp has no template called "${whatsappTemplate}" in ${whatsappTemplateLanguage}. Check the name and the language code in Meta.`,
      };
    }

    if (found.status !== 'APPROVED') {
      return {
        ok: false,
        status: found.status,
        detail:
          found.status === 'PENDING'
            ? `The template "${whatsappTemplate}" is still being reviewed by Meta. Reminders are recorded but not sent until it is approved.`
            : `Meta has marked the template "${whatsappTemplate}" as ${found.status}. Reminders cannot be sent until that is fixed.`,
      };
    }

    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Test seam. */
export function setProvider(next: NotificationProvider | null): void {
  provider = next;
}

/**
 * Sends and records. The persisted Notification carries the real outcome, so
 * the shopkeeper can later see which reminders genuinely went out.
 */
export async function notify(request: NotificationRequest): Promise<{
  notification: Notification;
  result: DeliveryResult;
}> {
  const active = getProvider();
  const result = await active.send(request);

  const notification: Notification = {
    notificationId: newNotificationId(),
    vendorId: request.vendorId,
    ...(request.customerId ? { customerId: request.customerId } : {}),
    type: request.type,
    provider: result.provider,
    channel: result.channel,
    to: request.to,
    body: request.body,
    /**
     * The provider's own verdict when it gave one.
     *
     * The fallback is the original three-way rule, so a provider that does not
     * classify its outcomes — the mock one, SNS — behaves exactly as before.
     */
    status: result.status ?? (result.delivered ? 'sent' : result.ok ? 'not_delivered' : 'failed'),
    ...(result.messageId ? { providerMessageId: result.messageId } : {}),
    ...(result.delivered ? { sentAt: nowIso() } : {}),
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    detail: result.detail,
    createdAt: nowIso(),
  };

  await notificationRepo.put(notification);
  return { notification, result };
}

/* -------------------------------------------------------------- Templates */

export const templates = {
  /**
   * The values for an approved WhatsApp template, in the configured order.
   *
   * Meta's templates are positional, so what matters is which value lands in
   * {{1}} and which in {{2}}. Naming them here and ordering them by config
   * means an approved template with a different shape needs no code change —
   * and a name that is not recognised yields an empty string rather than
   * silently shifting every later value into the wrong slot.
   */
  paymentReminderValues(input: {
    shopName: string;
    customerName: string;
    amount: number;
    daysOverdue: number;
  }): string[] {
    const known: Record<string, string> = {
      customername: input.customerName,
      shopname: input.shopName,
      amount: formatMoney(input.amount),
      daysoverdue: String(input.daysOverdue),
      duedate:
        input.daysOverdue > 0
          ? `${input.daysOverdue} ${input.daysOverdue === 1 ? 'day' : 'days'} ago`
          : 'today',
    };
    return config.notifications.whatsappTemplateParams.map(
      (name) => known[name.toLowerCase()] ?? '',
    );
  },

  paymentReminder(input: {
    shopName: string;
    customerName: string;
    amount: number;
    daysOverdue: number;
  }): string {
    const when =
      input.daysOverdue > 0
        ? `due ${input.daysOverdue} ${input.daysOverdue === 1 ? 'day' : 'days'} ago`
        : 'due today';
    return `Namaste ${input.customerName}, this is a gentle reminder from ${input.shopName}. ${formatMoney(input.amount)} is ${when}. Thank you!`;
  },

  orderReady(input: { shopName: string; customerName: string; itemCount: number }): string {
    const items = `${input.itemCount} ${input.itemCount === 1 ? 'item' : 'items'}`;
    return `Namaste ${input.customerName}, your order (${items}) is ready for pickup at ${input.shopName}.`;
  },

  stockAlert(input: { shopName: string; productName: string; daysRemaining: number }): string {
    return `${input.shopName}: ${input.productName} is running low — about ${input.daysRemaining} ${input.daysRemaining === 1 ? 'day' : 'days'} of stock left at current sales.`;
  },
};
