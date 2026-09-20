import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { nowIso } from '../utils/dates';
import { newNotificationId } from '../utils/ids';
import { formatMoney } from '../utils/money';
import { notifications as notificationRepo } from './repository';
import type { Notification, NotificationType } from '../schemas/entities';

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
  body: string;
  subject?: string;
};

export type DeliveryResult = {
  /** The request was processed without error. */
  ok: boolean;
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
        : { PhoneNumber: toE164(request.to) };

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

class WhatsAppProvider implements NotificationProvider {
  readonly name = 'whatsapp';
  readonly channel = 'whatsapp';

  async send(request: NotificationRequest): Promise<DeliveryResult> {
    const { whatsappToken, whatsappPhoneNumberId } = config.notifications;
    if (!whatsappToken || !whatsappPhoneNumberId) {
      return {
        ok: false,
        delivered: false,
        provider: this.name,
        channel: this.channel,
        detail: 'WhatsApp credentials are not configured, so nothing was sent.',
      };
    }

    try {
      const response = await fetch(
        `https://graph.facebook.com/v21.0/${whatsappPhoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${whatsappToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: toE164(request.to).replace('+', ''),
            type: 'text',
            text: { body: request.body },
          }),
        },
      );

      if (!response.ok) {
        const detail = await response.text();
        logger.error('WhatsApp send failed', {
          operation: 'notifications.whatsapp',
          vendorId: request.vendorId,
          status: response.status,
          detail,
        });
        return {
          ok: false,
          delivered: false,
          provider: this.name,
          channel: this.channel,
          detail: `WhatsApp rejected the message (HTTP ${response.status}). Nothing was sent.`,
        };
      }

      const payload = (await response.json()) as { messages?: Array<{ id?: string }> };
      return {
        ok: true,
        delivered: true,
        provider: this.name,
        channel: this.channel,
        messageId: payload.messages?.[0]?.id,
        detail: 'Accepted by the WhatsApp Cloud API.',
      };
    } catch (error) {
      logger.error('WhatsApp request threw', {
        operation: 'notifications.whatsapp',
        vendorId: request.vendorId,
        error,
      });
      return {
        ok: false,
        delivered: false,
        provider: this.name,
        channel: this.channel,
        detail: 'Could not reach WhatsApp. Nothing was sent.',
      };
    }
  }
}

/* ----------------------------------------------------------------- Facade */

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  return `+${digits}`;
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
    status: result.delivered ? 'sent' : result.ok ? 'not_delivered' : 'failed',
    ...(result.messageId ? { providerMessageId: result.messageId } : {}),
    detail: result.detail,
    createdAt: nowIso(),
  };

  await notificationRepo.put(notification);
  return { notification, result };
}

/* -------------------------------------------------------------- Templates */

export const templates = {
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
