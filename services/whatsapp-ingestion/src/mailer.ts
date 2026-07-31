import nodemailer from 'nodemailer';
import { config } from './config';
import { logger } from './logger';
import { getSetting } from './store';

/**
 * All outgoing app mail (verification codes, welcome mails, admin alerts — everything except the
 * product-import report, which keeps its own copy so a mailer change can never break the import).
 *
 * The provider is chosen on the admin Settings page: classic SMTP, or Microsoft 365 via the Graph
 * API with client credentials (an Azure app registration with the Mail.Send application
 * permission — no mailbox password ever touches this box). Every field falls back to the .env
 * product-import account so 2FA works before anyone has opened Settings.
 */

interface MailConf {
  provider: 'smtp' | 'ms365';
  from: string;
  smtp: { host: string; port: number; user: string; pass: string };
  ms365: { tenant: string; clientId: string; clientSecret: string; sender: string };
}

export function mailConf(): MailConf {
  return {
    provider: getSetting('mail.provider', 'smtp') === 'ms365' ? 'ms365' : 'smtp',
    from: getSetting('mail.from', config.mail.from),
    smtp: {
      host: getSetting('mail.smtp.host', config.mail.smtpHost),
      port: Number(getSetting('mail.smtp.port', String(config.mail.smtpPort))) || 587,
      user: getSetting('mail.smtp.user', config.mail.smtpUser),
      pass: getSetting('mail.smtp.pass', config.mail.smtpPass),
    },
    ms365: {
      tenant: getSetting('mail.ms365.tenant'),
      clientId: getSetting('mail.ms365.clientId'),
      clientSecret: getSetting('mail.ms365.clientSecret'),
      sender: getSetting('mail.ms365.sender'),
    },
  };
}

/** The address recipients will see, for the Settings page status line. */
export function senderAddress(): string {
  const m = mailConf();
  return m.provider === 'ms365' ? m.ms365.sender : (m.from || m.smtp.user);
}

// --- Microsoft Graph (client credentials) ---
let graphToken: { token: string; expiresAt: number } | null = null;

async function graphAccessToken(m: MailConf['ms365']): Promise<string> {
  if (graphToken && graphToken.expiresAt > Date.now() + 60_000) return graphToken.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(m.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: m.clientId,
      client_secret: m.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`Microsoft 365 sign-in failed: ${j.error_description ?? res.status}`);
  }
  graphToken = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

/** Settings changed — a cached token for the old app registration must not be reused. */
export function resetMailCache(): void {
  graphToken = null;
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const m = mailConf();
  if (m.provider === 'ms365') {
    if (!m.ms365.tenant || !m.ms365.clientId || !m.ms365.clientSecret || !m.ms365.sender) {
      throw new Error('Microsoft 365 is selected but not fully configured on the Settings page');
    }
    const token = await graphAccessToken(m.ms365);
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m.ms365.sender)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: html ? 'HTML' : 'Text', content: html ?? text },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Microsoft 365 refused the mail (${res.status}): ${detail.slice(0, 300)}`);
    }
  } else {
    if (!m.smtp.pass) throw new Error('no SMTP password configured (Settings page or .env)');
    const transport = nodemailer.createTransport({
      host: m.smtp.host,
      port: m.smtp.port,
      secure: m.smtp.port === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: m.smtp.user, pass: m.smtp.pass },
    });
    await transport.sendMail({ from: m.from || m.smtp.user, to, subject, text, ...(html ? { html } : {}) });
  }
  logger.info({ to, subject, provider: m.provider }, 'mail sent');
}

// --- templates ---
// Inline styles only: mail clients strip <style> blocks. Table layout: Outlook ignores flex/grid.
function shell(title: string, inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f0f2f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Segoe UI,Arial,sans-serif">
  <tr><td style="background:#075e54;padding:18px 28px">
    <span style="font-size:17px;font-weight:700;color:#ffffff">&#128172; WhatsApp OMS</span>
  </td></tr>
  <tr><td style="padding:26px 28px 8px">
    <div style="font-size:16px;font-weight:700;color:#111b21;margin-bottom:12px">${title}</div>
    ${inner}
  </td></tr>
  <tr><td style="padding:14px 28px 22px">
    <div style="border-top:1px solid #e5e7eb;padding-top:12px;font-size:11.5px;color:#8696a0;line-height:1.5">
      YS Plumbing Supply &middot; WhatsApp Order Management System<br>
      This is an automated message &mdash; replies to this email are not read.
    </div>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}
const P = 'font-size:13.5px;color:#3b4a54;line-height:1.6;margin:0 0 12px';

export function tplCode(name: string, code: string): { subject: string; text: string; html: string } {
  return {
    subject: `${code} is your WhatsApp OMS sign-in code`,
    text: `Hi ${name},\n\nYour sign-in code is: ${code}\n\nIt expires in 10 minutes. You are asked because this browser has not been used for WhatsApp OMS before. If this was not you, change your password.\n`,
    html: shell('Your sign-in code', `
      <p style="${P}">Hi <b>${name}</b>,</p>
      <p style="${P}">Use this code to finish signing in. It expires in <b>10 minutes</b>.</p>
      <div style="background:#e7f8f2;border:1px solid #b7ebd9;border-radius:10px;padding:16px;text-align:center;margin:0 0 14px">
        <span style="font-size:30px;font-weight:800;letter-spacing:8px;color:#075e54;font-family:Consolas,monospace">${code}</span>
      </div>
      <p style="${P}">You are asked because this browser has not been used for WhatsApp OMS before.
      If this sign-in was not you, change your password now.</p>`),
  };
}

export function tplWelcome(name: string, username: string, tempPassword: string, url: string): { subject: string; text: string; html: string } {
  return {
    subject: 'Your WhatsApp OMS account is ready',
    text: `Hi ${name},\n\nAn account was created for you.\n\n  Website:  ${url}\n  Username: ${username}\n  Temporary password: ${tempPassword}\n\nYou will choose your own password the first time you sign in.\n`,
    html: shell('Your account is ready', `
      <p style="${P}">Hi <b>${name}</b>,</p>
      <p style="${P}">An account was created for you on the order management system.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;margin:0 0 14px">
        <tr><td style="padding:7px 16px;font-size:13px;color:#8696a0;width:110px">Website</td><td style="padding:7px 8px;font-size:13px"><a href="${url}" style="color:#008069;font-weight:600">${url}</a></td></tr>
        <tr><td style="padding:7px 16px;font-size:13px;color:#8696a0">Username</td><td style="padding:7px 8px;font-size:13.5px;font-weight:700;color:#111b21">${username}</td></tr>
        <tr><td style="padding:7px 16px;font-size:13px;color:#8696a0">Temporary password</td><td style="padding:7px 8px;font-size:13.5px;font-family:Consolas,monospace;color:#111b21">${tempPassword}</td></tr>
      </table>
      <p style="${P}">You will choose your <b>own</b> password the first time you sign in — the
      temporary one stops working after that.</p>`),
  };
}

export function tplPasswordChanged(name: string): { subject: string; text: string; html: string } {
  const when = new Date().toLocaleString('en-US');
  return {
    subject: 'Your WhatsApp OMS password was changed',
    text: `Hi ${name},\n\nYour password was changed on ${when}. Other signed-in devices were signed out.\n\nIf this was not you, contact your administrator immediately.\n`,
    html: shell('Password changed', `
      <p style="${P}">Hi <b>${name}</b>,</p>
      <p style="${P}">Your password was changed on <b>${when}</b>. Every other signed-in device was
      signed out.</p>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px 16px;font-size:13px;color:#9a3412;margin:0 0 6px">
        If this was <b>not</b> you, contact your administrator immediately.
      </div>`),
  };
}

export function tplAdminNewDevice(username: string, userAgent: string): { subject: string; text: string; html: string } {
  const when = new Date().toLocaleString('en-US');
  return {
    subject: `New device sign-in: ${username}`,
    text: `${username} signed in to WhatsApp OMS from a new device.\n\n  When:    ${when}\n  Device:  ${userAgent || 'unknown'}\n\nThey passed email verification. You can revoke this device on the Users page (Reset 2FA).\n`,
    html: shell('New device sign-in', `
      <p style="${P}"><b>${username}</b> signed in from a device they had not used before, and
      passed email verification.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;margin:0 0 14px">
        <tr><td style="padding:7px 16px;font-size:13px;color:#8696a0;width:80px">User</td><td style="padding:7px 8px;font-size:13.5px;font-weight:700;color:#111b21">${username}</td></tr>
        <tr><td style="padding:7px 16px;font-size:13px;color:#8696a0">When</td><td style="padding:7px 8px;font-size:13px;color:#111b21">${when}</td></tr>
        <tr><td style="padding:7px 16px;font-size:13px;color:#8696a0">Device</td><td style="padding:7px 8px;font-size:12px;color:#3b4a54">${userAgent || 'unknown'}</td></tr>
      </table>
      <p style="${P}">If this looks wrong, open the <b>Users</b> page and press <b>Reset&nbsp;2FA</b>
      on this user — every browser they use will need a fresh emailed code.</p>`),
  };
}

export function tplTest(): { subject: string; text: string; html: string } {
  return {
    subject: 'WhatsApp OMS test email',
    text: 'This is a test email from the WhatsApp OMS Settings page. If you can read this, sending works.\n',
    html: shell('Test email', `
      <p style="${P}">This is a test email from the <b>Settings</b> page.</p>
      <p style="${P}">If you can read this, email sending is configured correctly. &#9989;</p>`),
  };
}
