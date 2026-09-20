import type { EmailMessage } from './email';

/**
 * The verification email.
 *
 * Written for a phone: most shopkeepers will open this on the same device they
 * are signing up on, and the only thing they need from it is six digits big
 * enough to read at arm's length.
 *
 * Table-based layout, inline styles, no external stylesheet and no images.
 * Gmail strips `<style>` blocks in some views and Outlook ignores most modern
 * CSS, so anything that depends on either would arrive as unstyled text.
 */

const PLUM = '#2b2439';
const PRIMARY = '#76609f';
const INK = '#2b2439';
const MUTED = '#6b6477';
const LINE = '#e8e4ef';
const CANVAS = '#f7f5f2';

export function verificationEmail(input: {
  name: string;
  code: string;
  expiresInMinutes: number;
}): EmailMessage {
  const greeting = input.name.trim() ? `Hi ${escapeHtml(input.name.trim())},` : 'Hi,';

  const text = [
    input.name.trim() ? `Hi ${input.name.trim()},` : 'Hi,',
    '',
    'Your Vyapio verification code is:',
    '',
    input.code,
    '',
    `This code expires in ${input.expiresInMinutes} minutes.`,
    '',
    'Enter it in Vyapio to verify your email address and finish creating your account.',
    '',
    'If you did not request this, you can safely ignore this email.',
    '',
    'Thanks,',
    'Vyapio',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verify your Vyapio account</title>
  </head>
  <body style="margin:0;padding:0;background:${CANVAS};">
    <!-- Preheader: the line shown in the inbox list, before the email is opened. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Your Vyapio verification code is ${input.code}. It expires in ${input.expiresInMinutes} minutes.
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;">

            <tr>
              <td style="padding:28px 28px 0 28px;" align="center">
                <!-- The wordmark, drawn rather than fetched: a remote image is
                     blocked by default in most clients, and a broken one at the
                     top of a verification email looks like a fake. -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-right:3px;"><div style="width:5px;height:11px;background:${PRIMARY};border-radius:3px;"></div></td>
                    <td style="padding-right:3px;"><div style="width:5px;height:16px;background:${PRIMARY};border-radius:3px;"></div></td>
                    <td style="padding-right:8px;"><div style="width:5px;height:21px;background:${PLUM};border-radius:3px;"></div></td>
                    <td style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:${PLUM};letter-spacing:-0.4px;">vyapio</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 28px 0 28px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <h1 style="margin:0 0 6px 0;font-size:20px;line-height:1.3;color:${INK};font-weight:700;">
                  Verify your Vyapio account
                </h1>
                <p style="margin:0;font-size:15px;line-height:1.55;color:${MUTED};">${greeting}</p>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px 0 28px;" align="center">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};border:1px solid ${LINE};border-radius:12px;">
                  <tr>
                    <td align="center" style="padding:20px 12px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                      <div style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:${MUTED};font-weight:600;">
                        Your verification code
                      </div>
                      <div style="margin-top:10px;font-size:34px;line-height:1;letter-spacing:9px;font-weight:700;color:${PLUM};">
                        ${input.code}
                      </div>
                      <div style="margin-top:10px;font-size:13px;color:${MUTED};">
                        Expires in ${input.expiresInMinutes} minutes
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px 0 28px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0;font-size:14px;line-height:1.6;color:${MUTED};">
                  Enter this code in Vyapio to verify your email address and finish creating your account.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 28px 28px 28px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <div style="border-top:1px solid ${LINE};padding-top:14px;">
                  <p style="margin:0 0 6px 0;font-size:13px;line-height:1.6;color:${MUTED};">
                    If you did not ask for this, you can ignore this email — nothing was created.
                  </p>
                  <p style="margin:0;font-size:13px;color:${MUTED};">Thanks,<br />Vyapio</p>
                </div>
              </td>
            </tr>
          </table>

          <p style="margin:14px 0 0 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:${MUTED};">
            This is an automated message. Please do not reply.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to: '', subject: 'Verify your Vyapio account', text, html };
}

/**
 * A name goes straight into the HTML, so it is escaped.
 *
 * The name comes from the signup form, which anyone can type into — without
 * this, "</td><script>" in the name field would reach whoever is reading the
 * email in a client that runs it.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
