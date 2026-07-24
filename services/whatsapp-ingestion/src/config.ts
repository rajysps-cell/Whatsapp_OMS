import 'dotenv/config';
import path from 'node:path';

const cwd = process.cwd();

function resolveDir(envVal: string | undefined, fallback: string): string {
  return envVal ? path.resolve(cwd, envVal) : path.join(cwd, fallback);
}

export const config = {
  /** whatsapp-web.js LocalAuth session data (the linked-device credentials). Git-ignored. */
  authDir: resolveDir(process.env.AUTH_DIR, 'auth'),
  /** Where downloaded media / voice notes land. */
  storeDir: resolveDir(process.env.STORE_DIR, 'store'),
  /** Optional allowlist of group chat ids (…@g.us). Empty = all groups. */
  allowedGroups: (process.env.ALLOWED_GROUPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Port for the web page that shows the QR to scan. */
  webPort: Number(process.env.WEB_PORT ?? 3000),
  /** Bind address. 0.0.0.0 = reachable from other devices on the network (needed for a headless server). */
  webHost: process.env.WEB_HOST ?? '0.0.0.0',
  /** Claude model used for order extraction. */
  extractModel: process.env.EXTRACT_MODEL ?? 'claude-opus-4-8',
  /** Presence gate for extraction. The Anthropic SDK reads ANTHROPIC_API_KEY itself. */
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Display-name substrings that mark a sender as warehouse/own staff (role + chat-side detection).
   *  Override with WAREHOUSE_NAMES (comma-separated) to add your team's exact display names. */
  warehouseNames: (process.env.WAREHOUSE_NAMES ?? 'warehouse,shipping')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Emoji reactions that finalize an order. UNCONFIRMED default — set FINALIZE_EMOJIS to your team's real emoji. */
  finalizeEmojis: (process.env.FINALIZE_EMOJIS ?? '✅,👍,🆗')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Product catalog CSV, bundled in the project so the folder is portable. Replace this file to
   *  update the catalog, or set PRODUCTS_CSV to point elsewhere. (Later: move to a DB — touch only products.ts.) */
  productsCsvPath: process.env.PRODUCTS_CSV ? path.resolve(cwd, process.env.PRODUCTS_CSV) : path.join(cwd, 'products.csv'),
  /** Local SQLite DB: learned aliases, processed messages, chat names. */
  dbPath: process.env.DB_PATH ? path.resolve(cwd, process.env.DB_PATH) : path.join(cwd, 'data.sqlite'),

  /** Daily product-catalog import from the DDI export email (mirrors the customer-portal DDIImport job).
   *  Reads the mailbox READ-ONLY (Gmail "All Mail"), never marks/moves/deletes anything, so it can never
   *  interfere with the portal's own import. Disabled automatically if no IMAP password is set. */
  productImport: {
    /** Turn the scheduled import on/off. Default on; it still no-ops without a password. */
    enabled: (process.env.PRODUCT_IMPORT_ENABLED ?? 'true').toLowerCase() !== 'false',
    imapHost: process.env.PRODUCT_IMAP_HOST ?? 'imap.gmail.com',
    imapPort: Number(process.env.PRODUCT_IMAP_PORT ?? 993),
    /** The Gmail account that RECEIVES the DDI export (same mailbox the portal reads). */
    imapUser: process.env.PRODUCT_IMAP_USER ?? 'ysddiexport@gmail.com',
    /** Gmail app password. Set in .env — NEVER commit it. Absent → import is skipped. */
    imapPassword: process.env.PRODUCT_IMAP_PASSWORD ?? '',
    /** Only emails whose Subject contains this string are considered (matches the portal's SUBJECT_FILTER). */
    subjectFilter: process.env.PRODUCT_SUBJECT_FILTER ?? 'ZTMPEXP',
    /** Optional sender-address substring to additionally require. Empty = subject-only match. */
    senderFilter: process.env.PRODUCT_SENDER_FILTER ?? '',
    /** Local times of day to run the import, comma-separated "HH:MM" (24h). The DDI export arrives twice a day
     *  (after ~23:00 and ~11:00), so the default runs shortly after each. e.g. "23:30,11:30". */
    dailyTimes: (process.env.PRODUCT_IMPORT_TIME ?? '23:30,11:30')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** On startup, run an immediate catch-up import if products.csv is older than this many hours. 0 = never. */
    catchUpHours: Number(process.env.PRODUCT_IMPORT_CATCHUP_HOURS ?? 24),
    /** Audit copies of every downloaded export land here (git-ignored). */
    auditDir: resolveDir(process.env.PRODUCT_IMPORT_DIR, 'imports'),
    /** Reject a downloaded file that yields fewer than this many rows (guards against clobbering with junk). */
    minRows: Number(process.env.PRODUCT_IMPORT_MIN_ROWS ?? 1000),
    /** Email a run report (success OR failure) after every import. Empty `reportTo` = no email sent.
     *  SMTP defaults reuse the same Gmail account/app-password as the IMAP read, so no extra secret is needed. */
    report: {
      to: process.env.PRODUCT_REPORT_TO ?? '',
      from: process.env.PRODUCT_REPORT_FROM ?? '', // falls back to the SMTP user at send time
      smtpHost: process.env.PRODUCT_SMTP_HOST ?? 'smtp.gmail.com',
      smtpPort: Number(process.env.PRODUCT_SMTP_PORT ?? 587),
      smtpUser: process.env.PRODUCT_SMTP_USER ?? process.env.PRODUCT_IMAP_USER ?? 'ysddiexport@gmail.com',
      smtpPass: process.env.PRODUCT_SMTP_PASSWORD ?? process.env.PRODUCT_IMAP_PASSWORD ?? '',
    },
  },
} as const;
