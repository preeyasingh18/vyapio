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
 * `sent: false`, and the signup route says plainly where to find the code
 * instead of sending the shopkeeper hunting through an inbox.
 *
 * There is no SMTP client here on purpose. Once a Cognito user pool is
 * configured the whole verification journey belongs to Cognito — it holds the
 * unconfirmed user, generates the code and mails it — and a second mailer
 * would be a second thing that can send a different code for the same signup.
 * This exists for local development, where there is no user pool.
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

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

/* -------------------------------------------------------- ConsoleProvider */

/**
 * The only provider, and what runs whenever Cognito is not configured.
 *
 * Writes the message to the log so the signup flow is fully exercisable on a
 * laptop, and is explicit that nothing was delivered.
 *
 * The code is logged here and nowhere else. Locally it is the only way to
 * finish a signup — there is no inbox for it to arrive in — and with a user
 * pool configured this provider is never reached, because Cognito does the
 * mailing and this code path is not used at all.
 */
class ConsoleProvider implements EmailProvider {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<EmailResult> {
    logger.info('email not sent — no mail provider in local mode', {
      operation: 'email.console',
      to: message.to,
      subject: message.subject,
      body: message.text,
    });
    return {
      ok: true,
      sent: false,
      provider: this.name,
      detail:
        'Local mode has no mailbox, so the code was written to the server log instead of being sent.',
    };
  }
}

/* ------------------------------------------------------------------ Facade */

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  provider ??= new ConsoleProvider();
  return provider;
}

/** Test seam. */
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
