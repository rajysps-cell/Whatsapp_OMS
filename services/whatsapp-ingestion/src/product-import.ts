/**
 * Daily product-catalog import from the DDI "ZTMPEXP" product-export email.
 *
 * Mirrors the customer-portal DDIImport job (YSPSCustomerPortal/DDIImport/ddi_email_import.py) but is
 * deliberately NON-DESTRUCTIVE: it opens the mailbox READ-ONLY (Gmail "All Mail", which retains every
 * message regardless of label) and never marks/moves/deletes anything. That means it works whether it runs
 * before or after the portal's 23:59 job, and can never interfere with it.
 *
 * On success it atomically overwrites products.csv, keeps an audit copy under imports/, and hot-reloads the
 * in-memory catalog (products.load()) so the running service sees the new data with no restart.
 *
 * Manual run:  npm run import:products
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { parse } from 'csv-parse/sync';
import { config } from './config';
import { logger } from './logger';
import * as products from './products';

const log = logger.child({ mod: 'product-import' });

export interface ImportResult {
  ok: boolean; // did the run complete without error
  changed: boolean; // was products.csv actually replaced
  rows?: number; // product rows in the imported file
  file?: string; // audit-copy path
  reason?: string; // why nothing changed / what failed
}

/** Keep only characters safe for a filename (mirrors the portal's audit-copy naming). */
function safeName(name: string): string {
  const cleaned = Array.from(name).filter((c) => /[A-Za-z0-9._-]/.test(c)).join('');
  return cleaned || 'import.csv';
}

/** yyyymmdd-hhmmss stamp for audit-copy filenames. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Validate the downloaded bytes look like a real DDI product export before we overwrite the catalog. */
function validateCsv(buf: Buffer): { ok: true; rows: number } | { ok: false; reason: string } {
  let rows: Record<string, string>[];
  try {
    rows = parse(buf, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: true,
    }) as Record<string, string>[];
  } catch (err) {
    return { ok: false, reason: `CSV parse failed: ${(err as Error).message}` };
  }
  if (!rows.length || !('Product (20)' in rows[0]!)) {
    return { ok: false, reason: 'file has no "Product (20)" column — not a DDI product export' };
  }
  if (rows.length < config.productImport.minRows) {
    return { ok: false, reason: `only ${rows.length} rows (< PRODUCT_IMPORT_MIN_ROWS=${config.productImport.minRows}) — refusing to overwrite catalog` };
  }
  return { ok: true, rows: rows.length };
}

/** Resolve Gmail's "All Mail" folder (special-use \All), falling back to the common default. */
async function findAllMail(client: ImapFlow): Promise<string> {
  try {
    for (const box of await client.list()) {
      if (box.specialUse === '\\All') return box.path;
    }
  } catch {
    /* fall through to default */
  }
  return '[Gmail]/All Mail';
}

/** Find the UID of the newest email matching the subject/sender filters, with an attachment. */
async function findLatestExportUid(client: ImapFlow): Promise<number | null> {
  const { subjectFilter, senderFilter } = config.productImport;

  // Prefer Gmail's raw search (precise: subject + has:attachment [+ from]).
  let uids: number[] | false = false;
  try {
    const raw = `subject:${subjectFilter} has:attachment${senderFilter ? ` from:${senderFilter}` : ''}`;
    uids = await client.search({ gmailraw: raw }, { uid: true });
  } catch {
    uids = false;
  }
  // Fallback: plain IMAP SUBJECT (+ FROM) substring search.
  if (!uids || !uids.length) {
    const query: Record<string, unknown> = { subject: subjectFilter };
    if (senderFilter) query.from = senderFilter;
    uids = await client.search(query, { uid: true });
  }
  if (!uids || !uids.length) return null;

  // Pick the newest by internal date (UID order usually agrees, but don't rely on it).
  let best: { uid: number; ts: number } | null = null;
  for await (const m of client.fetch(uids, { uid: true, internalDate: true }, { uid: true })) {
    const ts = m.internalDate ? new Date(m.internalDate).getTime() : 0;
    if (!best || ts > best.ts) best = { uid: m.uid, ts };
  }
  return best ? best.uid : null;
}

/** Run one import cycle. Never throws — always resolves an ImportResult. */
export async function runProductImport(): Promise<ImportResult> {
  const cfg = config.productImport;
  if (!cfg.enabled) return { ok: true, changed: false, reason: 'disabled (PRODUCT_IMPORT_ENABLED=false)' };
  if (!cfg.imapPassword) {
    log.warn('product import skipped — PRODUCT_IMAP_PASSWORD not set');
    return { ok: true, changed: false, reason: 'no IMAP password configured' };
  }

  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.imapUser, pass: cfg.imapPassword },
    logger: false, // silence imapflow's own verbose logging; we log the summary ourselves
  });

  try {
    await client.connect();
    const allMail = await findAllMail(client);

    // READ-ONLY open (EXAMINE): the server never sets \Seen and we never write flags → the portal job is safe.
    const lock = await client.getMailboxLock(allMail, { readOnly: true });
    let payload: Buffer | null = null;
    let filename = 'import.csv';
    try {
      const uid = await findLatestExportUid(client);
      if (!uid) {
        log.info({ subject: cfg.subjectFilter, mailbox: allMail }, 'no matching product-export email found');
        return { ok: true, changed: false, reason: 'no matching email' };
      }
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      const source = msg && typeof msg !== 'boolean' ? msg.source : null;
      if (!source) return { ok: true, changed: false, reason: 'could not fetch email source' };

      const parsed = await simpleParser(source);
      const att =
        parsed.attachments.find((a) => /\.csv$/i.test(a.filename ?? '')) ??
        parsed.attachments.find((a) => /\.(csv|xlsx)$/i.test(a.filename ?? '')) ??
        null;
      if (!att) return { ok: true, changed: false, reason: 'matching email had no CSV/XLSX attachment' };
      if (/\.xlsx$/i.test(att.filename ?? '')) {
        return { ok: false, changed: false, reason: `attachment "${att.filename}" is XLSX; this importer expects the CSV export` };
      }
      payload = att.content;
      filename = att.filename ?? 'import.csv';
    } finally {
      lock.release();
    }

    // Validate before touching anything on disk.
    const v = validateCsv(payload);
    if (!v.ok) {
      log.warn({ filename, reason: v.reason }, 'downloaded export rejected — catalog left unchanged');
      return { ok: false, changed: false, reason: v.reason };
    }

    // Audit copy (best-effort — never blocks the actual import).
    let auditPath: string | undefined;
    try {
      fs.mkdirSync(cfg.auditDir, { recursive: true });
      auditPath = path.join(cfg.auditDir, `${stamp()}_${safeName(filename)}`);
      fs.writeFileSync(auditPath, payload);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not save audit copy');
    }

    // Atomically replace products.csv (write temp in the same dir, then rename over — overwrites on Windows).
    const dest = config.productsCsvPath;
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, dest);

    // Hot-reload the in-memory catalog so the running service uses the new data immediately.
    const before = products.count();
    products.load();
    const after = products.count();

    log.info({ filename, rows: v.rows, catalogBefore: before, catalogAfter: after, audit: auditPath }, 'product catalog updated from email');
    return { ok: true, changed: true, rows: v.rows, file: auditPath };
  } catch (err) {
    log.error({ err: (err as Error).message }, 'product import failed');
    return { ok: false, changed: false, reason: (err as Error).message };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

/** Human-readable subject + body for an import run (success or failure). */
function formatReport(r: ImportResult): { subject: string; body: string } {
  const state = !r.ok ? 'FAILED' : r.changed ? 'updated' : 'no change';
  const subject = `WhatsApp OMS product import — ${state}${r.changed ? ` (${r.rows} products)` : ''}`;
  const body = [
    'WhatsApp OMS — daily product catalog import',
    `Host:          ${os.hostname()}`,
    `Finished:      ${new Date().toString()}`,
    `Result:        ${state}`,
    `Rows imported: ${r.rows ?? '—'}`,
    `Catalog now:   ${products.count()} products`,
    `Audit copy:    ${r.file ?? '—'}`,
    `Details:       ${r.reason ?? (r.changed ? 'products.csv replaced and catalog hot-reloaded' : '—')}`,
  ].join('\n');
  return { subject, body };
}

/** Email the run report. Gated on reportTo + SMTP password; never throws (reporting must not fail the import). */
export async function sendImportReport(r: ImportResult): Promise<void> {
  const rep = config.productImport.report;
  if (!rep.to || !rep.smtpPass) {
    if (!rep.to) log.info('no PRODUCT_REPORT_TO set — skipping report email');
    return;
  }
  const { subject, body } = formatReport(r);
  try {
    const transport = nodemailer.createTransport({
      host: rep.smtpHost,
      port: rep.smtpPort,
      secure: rep.smtpPort === 465, // 465 = implicit TLS; 587 = STARTTLS (secure:false)
      auth: { user: rep.smtpUser, pass: rep.smtpPass },
    });
    await transport.sendMail({ from: rep.from || rep.smtpUser, to: rep.to, subject, text: body });
    log.info({ to: rep.to, subject }, 'import report emailed');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not send import report email');
  }
}

/** Run one import and email the report — the entry point used by the scheduler and the manual CLI. */
export async function runProductImportWithReport(): Promise<ImportResult> {
  const r = await runProductImport();
  await sendImportReport(r);
  return r;
}

// --- Manual run: `npm run import:products` ---
const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  runProductImportWithReport()
    .then((r) => {
      log.info({ result: r }, 'manual product import finished');
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      log.error({ err: (err as Error).message }, 'manual product import crashed');
      process.exit(2);
    });
}
