import { createTransport, type Transporter } from 'nodemailer';
import { config } from '../config/index';
import { logger } from '../utils/logger';

/**
 * Email.
 *
 * Built on the same rule as services/notifications.ts: **never report a send
 * that did not happen.** A signup that says "check your inbox" when nothing
 * was posted leaves someone waiting for a code that is never coming, and they
 * have no way to tell whether to wait or start again.
 *
 * So `sent` is a distinct field from `ok`, the console provider returns
 * `sent: false`, and the signup route refuses to move the user to the
 * verification screen when nothing left the machine.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  /** The fallback for clients that will not render HTML, and it must stand alone. */
  text: string;
  html: string;
};

export type EmailResult = {
  /** The request was handled without error. */
  ok: boolean;
  /** A message actually left this system. False for the console provider. */
  sent: boolean;
  provider: string;
  /** Plain language, safe to show. Never carries credentials. */
  detail: string;
};

/* -------------------------------------------------------- ConsoleProvider */

/**
 * The default, and what runs with no mail credentials configured.
 *
 * Writes the message to the log so the whole flow is exercisable on a laptop
 * with no mail server, and is explicit that nothing was delivered.
 *
 * The code itself is logged here and nowhere else, and only in this provider:
 * it is the only way to complete a signup locally, and there is no inbox for
 * it to arrive in. Configure a real provider and it stops being logged.
 */
class ConsoleProvider {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<EmailResult> {
    logger.info('email not sent — no provider configured', {
      operation: 'email.console',
      to: message.to,
      subject: message.subject,
      body: message.text,
    });
    return {
      ok: true,
      sent: false,
      provider: this.name,
      detail: 'No email provider is configured, so nothing was sent.',
    };
  }
}

/* ----------------------------------------------------------- SmtpProvider */

class SmtpProvider {
  readonly name = 'smtp';
  private transporter: Transporter | null = null;

  private transport(): Transporter {
    this.transporter ??= createTransport({
      host: config.email.host,
      port: config.email.port,
      // Implicit TLS on 465; STARTTLS is negotiated on everything else.
      secure: config.email.port === 465,
      auth:
        config.email.user && config.email.password
          ? { user: config.email.user, pass: config.email.password }
          : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const info = await this.transport().sendMail({
        from: config.email.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      logger.info('email sent', {
        operation: 'email.smtp',
        to: message.to,
        subject: message.subject,
        messageId: info.messageId,
      });

      return { ok: true, sent: true, provider: this.name, detail: 'Sent.' };
    } catch (error) {
      /**
       * The message, not the error object.
       *
       * Some SMTP libraries attach the connection options — including the
       * password — to the thrown error, and logging the whole thing would put
       * the mail credentials in the log file.
       */
      logger.error('email send failed', {
        operation: 'email.smtp',
        to: message.to,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return {
        ok: false,
        sent: false,
        provider: this.name,
        detail: 'Could not send the email. Nothing was delivered.',
      };
    }
  }
}

/* ------------------------------------------------------------------ Facade */

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (provider) return provider;
  provider =
    config.email.provider === 'smtp' && config.email.host ? new SmtpProvider() : new ConsoleProvider();
  return provider;
}

/** Test seam, and what the config reload path uses. */
export function setEmailProvider(next: EmailProvider | null): void {
  provider = next;
}

/** Whether a verification email would actually reach someone right now. */
export function canSendEmail(): boolean {
  return getEmailProvider().name !== 'console';
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  return getEmailProvider().send(message);
}
