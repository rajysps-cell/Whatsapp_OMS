import nodemailer from 'nodemailer';
import { config } from './config';
import { logger } from './logger';

/**
 * One shared "send an email" for everything that is not the product-import report (which keeps its
 * own copy so a mailer refactor can never break the import). First user: the two-step verification
 * codes. Credentials default to the same Gmail app password the import already has, overridable
 * with MAIL_SMTP_* so OTP mail can move to its own sender without touching the import.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const m = config.mail;
  if (!m.smtpPass) throw new Error('no SMTP password configured (MAIL_SMTP_PASSWORD / PRODUCT_IMAP_PASSWORD)');
  const transport = nodemailer.createTransport({
    host: m.smtpHost,
    port: m.smtpPort,
    secure: m.smtpPort === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: m.smtpUser, pass: m.smtpPass },
  });
  await transport.sendMail({ from: m.from || m.smtpUser, to, subject, text });
  logger.info({ to, subject }, 'mail sent');
}
