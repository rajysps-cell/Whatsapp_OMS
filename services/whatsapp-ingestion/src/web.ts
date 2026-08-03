import fs from 'node:fs';
import http from 'node:http';
import nodePath from 'node:path';
import QRCode from 'qrcode';
import {
  COOKIE,
  DEVICE_COOKIE,
  PENDING_COOKIE,
  activeAdminCount,
  changePassword,
  cleanupAuth,
  clearCookie,
  clearPendingCookie,
  createPendingLogin,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  deviceCookie,
  deviceTrusted,
  ensureSeedAdmin,
  getUser,
  listUsers,
  login as authLogin,
  pendingCookie,
  readCookie,
  resendOtp,
  revokeDevices,
  sessionCookie,
  sessionUser,
  trustDevice,
  updateUser,
  allUsernames,
  userExists,
  validateEmail,
  validatePassword,
  validateUsername,
  verifyOtp,
  verifyPassword,
  type Role,
  type User,
} from './auth';
import {
  mailConf,
  resetMailCache,
  sendMail,
  senderAddress,
  tplAdminNewDevice,
  tplCode,
  tplPasswordChanged,
  tplTest,
  tplWelcome,
} from './mailer';
import type { ChatStore } from './chat-store';
import { config } from './config';
import { logger } from './logger';
import { extractAndMatch, search, searchCatalog } from './matcher';
import type { Order } from './order-store';
import { all as allProducts, byCode, count as productCount, normalize } from './products';
import {
  addAlias,
  addIgnoredPhrase,
  aliasCodesMatching,
  aliasCount,
  aliasCountsByCode,
  aliasesForProduct,
  deleteAlias,
  getAliasRow,
  getMessage,
  getSetting,
  chatParticipants,
  isProcessed,
  listActivity,
  logActivity,
  markDeleted,
  markRevoked,
  mentionNames,
  orderNoOf,
  pinnedMessage,
  recordSentBy,
  removeIgnoredPhrase,
  reportRows,
  saveExtraction,
  sentByOf,
  setChatName,
  setOrderNo,
  setPinned,
  setSetting,
  setStarred,
  updateAliasText,
} from './store';

let status = 'starting';
let qrDataUrl: string | null = null;
let ordersProvider: () => Order[] = () => [];
let chatStoreRef: ChatStore | null = null;
/** Injected by index.ts so staff can attach a file to a chat. */
let sendMediaFn:
  | ((
      chatId: string,
      file: { data: string; mimetype: string; filename: string },
      caption?: string,
      mentions?: string[],
      sentBy?: string,
      asVoice?: boolean,
    ) => Promise<string>)
  | null = null;
/** Injected by index.ts so the thread can show images, voice notes and documents. */
let mediaFn: ((messageId: string) => Promise<{ data: string; mimetype: string; filename?: string } | null>) | null =
  null;
/** Injected by index.ts so the UI can send a message through the live WhatsApp connection. */
let sendMessageFn:
  | ((chatId: string, text: string, mentions?: string[], sentBy?: string, quotedId?: string) => Promise<string>)
  | null = null;
/** Injected by index.ts so a user can delete their own sent messages (for me / for everyone). */
let deleteFn: ((messageId: string, everyone: boolean) => Promise<{ ok: boolean; reason?: string }>) | null = null;
/** Injected by index.ts: star/unstar and pin/unpin in the real WhatsApp. */
let starFn: ((messageId: string, on: boolean) => Promise<{ ok: boolean; reason?: string }>) | null = null;
let pinFn: ((messageId: string, on: boolean) => Promise<{ ok: boolean; reason?: string }>) | null = null;
/** Injected by index.ts: react to a message with an emoji ('' removes it). */
let reactFn: ((messageId: string, emoji: string) => Promise<{ ok: boolean; reason?: string }>) | null = null;

export async function setQr(qr: string): Promise<void> {
  try {
    qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    status = 'waiting for scan';
  } catch (err) {
    logger.error({ err }, 'failed to render QR');
  }
}

export function setStatus(s: string): void {
  status = s;
  if (s === 'connected') qrDataUrl = null;
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
// Warehouse/own side vs customer. Own device (fromMe) or a sender whose display name matches a
// configured WAREHOUSE_NAMES substring. Set WAREHOUSE_NAMES to your staff names (e.g. "warehouse,
// shipping,ys plumbing") so their messages sit on the right and never get an Extract button.
function isWarehouseMsg(m: { fromMe: boolean; pushName?: string }): boolean {
  if (m.fromMe) return true;
  const name = (m.pushName ?? '').toLowerCase();
  return config.warehouseNames.some((n) => n && name.includes(n.toLowerCase()));
}
// Shared alias validation (trim, non-empty, <=255, must normalize to something matchable).
function validateAliasInput(raw: unknown): { ok: true; text: string; norm: string } | { ok: false; error: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'Alias cannot be empty.' };
  if (text.length > 255) return { ok: false, error: 'Alias is too long (max 255 characters).' };
  const norm = normalize(text);
  if (!norm) return { ok: false, error: 'Alias must contain letters or numbers.' };
  return { ok: true, text, norm };
}
function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}
/**
 * The ONE tab bar, identical on every page: same tabs, same order (most important first), same
 * look — the current page is a green pill, everything else neutral. Admin-only tabs simply do not
 * render for normal users. Every page pastes NAV_CSS into its stylesheet so the bar cannot drift.
 */
function navHtml(me: User, current: string): string {
  // Everything except Order Matching itself is admin-only — normal users work the chats and
  // nothing else.
  const tabs: Array<[href: string, label: string, show: boolean]> = [
    ['/', 'Order Matching', true],
    ['/report', 'Report', me.role === 'admin'],
    ['/admin', 'Users', me.role === 'admin'],
    ['/settings', 'Settings', me.role === 'admin'],
    ['/activity', 'Activity', me.role === 'admin'],
  ];
  return (
    tabs
      .filter((t) => t[2])
      .map(([href, label]) => `<a class="navlink${href === current ? ' cur' : ''}" href="${href}">${label}</a>`)
      .join('') + '<a class="navlink" href="#" onclick="omsLogout();return false">Sign out</a>'
  );
}
const NAV_CSS = `
  .navlink{color:#667781;text-decoration:none;font-size:13px;font-weight:600;margin-left:2px;padding:6px 11px;border-radius:8px;white-space:nowrap}
  .navlink:hover{background:#f0f2f5;color:#111b21}
  .navlink.cur{background:#e7f8f2;color:#059669}
`;
/**
 * Boot-time self-check: render each page and parse its inline <script> blocks. Catches the
 * template-literal escaping trap (\s / \d / \n eaten before the browser sees them), which
 * otherwise ships a page whose JavaScript never runs.
 */
function checkInlineScripts(): void {
  const fake: User = {
    id: 0,
    username: 'selfcheck',
    name: 'selfcheck',
    email: '',
    role: 'admin',
    active: true,
    mustChange: false,
    createdAt: 0,
    lastLogin: null,
  };
  const pages: Array<[string, string]> = [
    ['/match', matchPage(fake)],
    ['/admin', adminPage(fake)],
    ['/board', dashboardPage()],
    ['/login', loginPage()],
    ['/change-password', changePasswordPage(fake)],
  ];
  for (const [name, body] of pages) {
    const blocks = body.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    blocks.forEach((block, i) => {
      const src = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
      try {
        new Function(src);
      } catch (err) {
        logger.error(
          { page: name, block: i, err: (err as Error).message },
          'INLINE SCRIPT IS BROKEN — the page will render but its JavaScript will not run',
        );
      }
    });
  }
}

/** Caller's IP — behind the Cloudflare tunnel the socket is always localhost, so prefer its header. */
function clientIp(req: http.IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  const cfIp = Array.isArray(cf) ? cf[0] : cf;
  if (cfIp) return cfIp.trim();
  const xff = req.headers['x-forwarded-for'];
  const xffVal = Array.isArray(xff) ? xff[0] : xff;
  if (xffVal) return xffVal.split(',')[0]?.trim() ?? '';
  return req.socket.remoteAddress ?? '';
}
/** True when the browser reached us over HTTPS (directly, or through the Cloudflare tunnel). */
function isSecureReq(req: http.IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto;
  if (first) return first.split(',')[0]?.trim() === 'https';
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}
/** Minimal mime<->extension mapping for the media cache (only what WhatsApp actually sends). */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
  'application/pdf': 'pdf',
  // Documents customers actually send. Without these they cached as ".bin" and would not open on
  // a double-click, which reads as "the attachment is broken".
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/msword': 'doc',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
};
function extFromMime(m: string): string {
  return MIME_EXT[String(m).split(';')[0]!.trim()] ?? 'bin';
}
function mimeFromExt(file: string): string {
  const ext = file.split('.').pop() ?? '';
  for (const [mime, e] of Object.entries(MIME_EXT)) if (e === ext) return mime;
  return 'application/octet-stream';
}
/** Cache-file basename for a message's media. Shared so the eager cacher and the request handler
 *  never disagree about where a file lives. */
export function mediaCacheKey(messageId: string): string {
  return messageId.replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120);
}
export function mediaCacheDir(): string {
  return nodePath.join(config.storeDir, 'media');
}
/**
 * Write a downloaded media blob into the cache.
 *
 * The original filename goes in a sibling ".name" file rather than a database column: it is only
 * needed to set Content-Disposition on the way back out, and a sidecar keeps this callable from
 * the ingest path without a schema migration.
 */
export function writeMediaCache(messageId: string, data: string, mimetype: string, filename?: string): number {
  const dir = mediaCacheDir();
  const safe = mediaCacheKey(messageId);
  const buf = Buffer.from(data, 'base64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, `${safe}.${extFromMime(mimetype)}`), buf);
  if (filename) {
    try {
      fs.writeFileSync(nodePath.join(dir, `${safe}.name`), filename.slice(0, 200), 'utf8');
    } catch {
      /* the file still serves, just under its generated name */
    }
  }
  return buf.length;
}
/** "2026-07-31" -> LOCAL midnight, not UTC: Date.parse on a bare date assumes UTC, which shifted
 *  every date filter by the timezone offset — "today" quietly included yesterday evening. */
function parseLocalDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}
/** "jj***@gmail.com" — enough for "check that inbox", nothing for an attacker who guessed a password. */
function maskEmail(e: string): string {
  const [user = '', domain = ''] = e.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}
/** decodeURIComponent that answers null instead of throwing on a malformed escape like "%" or "%zz". */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
function redirect(res: http.ServerResponse, to: string): void {
  res.writeHead(302, { location: to });
  res.end();
}
/** Escape for safe interpolation into server-rendered HTML. */
function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Admin user-management APIs + page. Returns true when it handled the request. */
async function handleAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  me: User,
): Promise<boolean> {
  if (path === '/qr') {
    html(res, qrPage());
    return true;
  }
  if (path === '/admin') {
    html(res, adminPage(me));
    return true;
  }
  if (path === '/settings') {
    html(res, settingsPage(me));
    return true;
  }
  // Settings read: secrets never leave the server — the UI only learns whether one is set.
  if (path === '/api/settings' && req.method !== 'POST') {
    const m = mailConf();
    json(res, 200, {
      provider: m.provider,
      from: m.from,
      smtp: { host: m.smtp.host, port: m.smtp.port, user: m.smtp.user, hasPass: !!m.smtp.pass },
      ms365: { tenant: m.ms365.tenant, clientId: m.ms365.clientId, hasSecret: !!m.ms365.clientSecret, sender: m.ms365.sender },
      adminNewDevice: getSetting('notify.adminNewDevice', '0') === '1',
      sender: senderAddress(),
    });
    return true;
  }
  if (path === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const str = (k: string): string | null => (typeof body[k] === 'string' ? (body[k] as string).trim() : null);
    const provider = str('provider');
    if (provider !== null) setSetting('mail.provider', provider === 'ms365' ? 'ms365' : 'smtp');
    for (const [field, key] of [
      ['from', 'mail.from'],
      ['smtpHost', 'mail.smtp.host'],
      ['smtpPort', 'mail.smtp.port'],
      ['smtpUser', 'mail.smtp.user'],
      ['ms365Tenant', 'mail.ms365.tenant'],
      ['ms365ClientId', 'mail.ms365.clientId'],
      ['ms365Sender', 'mail.ms365.sender'],
    ] as const) {
      const v = str(field);
      if (v !== null) setSetting(key, v);
    }
    // Secrets: an empty field means "keep what is stored", never "clear it" — the UI shows a
    // placeholder instead of the value, so an untouched field must not wipe the secret.
    const smtpPass = str('smtpPass');
    if (smtpPass) setSetting('mail.smtp.pass', smtpPass);
    const secret = str('ms365ClientSecret');
    if (secret) setSetting('mail.ms365.clientSecret', secret);
    if (body['adminNewDevice'] !== undefined) setSetting('notify.adminNewDevice', body['adminNewDevice'] ? '1' : '0');
    resetMailCache(); // a cached MS365 token for the old app registration must not survive a change
    logger.info({ user: me.username }, 'settings updated');
    logActivity(me.username, 'settings', 'changed email/notification settings', clientIp(req));
    json(res, 200, { ok: true, sender: senderAddress() });
    return true;
  }
  // "Send a test email to me" — proves the configuration without waiting for a real sign-in.
  if (path === '/api/settings/test-mail' && req.method === 'POST') {
    if (!me.email) {
      json(res, 200, { ok: false, error: 'Your own account has no email address — add one on the Users page first.' });
      return true;
    }
    try {
      const t = tplTest();
      await sendMail(me.email, t.subject, t.text, t.html);
      json(res, 200, { ok: true, to: me.email });
    } catch (err) {
      json(res, 200, { ok: false, error: (err as Error).message.slice(0, 300) });
    }
    return true;
  }
  if (path === '/api/users' && req.method !== 'POST') {
    json(res, 200, { users: listUsers(), meId: me.id });
    return true;
  }
  if (path === '/api/users/add' && req.method === 'POST') {
    const body = await readBody(req);
    const u = validateUsername(body['username']);
    if (!u.ok) {
      json(res, 200, { ok: false, error: u.error });
      return true;
    }
    const p = validatePassword(body['password']);
    if (!p.ok) {
      json(res, 200, { ok: false, error: p.error });
      return true;
    }
    if (userExists(u.value)) {
      json(res, 200, { ok: false, error: 'That username is already taken.' });
      return true;
    }
    const role: Role = body['role'] === 'admin' ? 'admin' : 'user';
    const em = validateEmail(body['email']);
    if (!em.ok) {
      json(res, 200, { ok: false, error: em.error });
      return true;
    }
    const created = createUser(u.value, p.value, String(body['name'] ?? '').trim().slice(0, 80), role, true, em.value);
    // Welcome mail with the temporary password — it stops working at first sign-in, when the
    // user must choose their own. Best-effort: a mail outage must not block creating accounts.
    let mailed = false;
    if (em.value) {
      const t = tplWelcome(created.name || created.username, created.username, p.value, 'https://oms.ysps.shop');
      try {
        await sendMail(em.value, t.subject, t.text, t.html);
        mailed = true;
      } catch (err) {
        logger.warn({ err, to: em.value }, 'welcome email failed — give the user their password by hand');
      }
    }
    logActivity(me.username, 'user-add', `${created.username} (${role})${em.value ? ' — welcome mail ' + (mailed ? 'sent' : 'FAILED') : ''}`, clientIp(req));
    json(res, 200, { ok: true, mailed, users: listUsers() });
    return true;
  }
  if (path === '/api/users/edit' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body['id']);
    const target = getUser(id);
    if (!target) {
      json(res, 200, { ok: false, error: 'User not found.' });
      return true;
    }
    const patch: { name?: string; role?: Role; active?: boolean; password?: string; email?: string } = {};
    if (body['name'] !== undefined) patch.name = String(body['name']).trim().slice(0, 80);
    if (body['role'] !== undefined) patch.role = body['role'] === 'admin' ? 'admin' : 'user';
    if (body['active'] !== undefined) patch.active = !!body['active'];
    if (body['email'] !== undefined) {
      const em = validateEmail(body['email']);
      if (!em.ok) {
        json(res, 200, { ok: false, error: em.error });
        return true;
      }
      patch.email = em.value;
    }
    if (body['password']) {
      const p = validatePassword(body['password']);
      if (!p.ok) {
        json(res, 200, { ok: false, error: p.error });
        return true;
      }
      patch.password = p.value;
    }
    // Never let the last active admin be demoted or disabled — that would lock everyone out.
    const losingAdmin =
      (patch.role === 'user' && target.role === 'admin') || (patch.active === false && target.role === 'admin');
    if (losingAdmin && activeAdminCount() <= 1) {
      json(res, 200, { ok: false, error: 'This is the only administrator — promote another admin first.' });
      return true;
    }
    if (target.id === me.id && patch.active === false) {
      json(res, 200, { ok: false, error: 'You cannot disable your own account.' });
      return true;
    }
    updateUser(id, patch);
    logActivity(me.username, 'user-edit', `${target.username}${patch.password ? ' (password reset)' : ''}${patch.active === false ? ' (disabled)' : ''}`, clientIp(req));
    json(res, 200, { ok: true, users: listUsers() });
    return true;
  }
  if (path === '/api/users/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body['id']);
    const target = getUser(id);
    if (!target) {
      json(res, 200, { ok: false, error: 'User not found.' });
      return true;
    }
    if (target.id === me.id) {
      json(res, 200, { ok: false, error: 'You cannot delete your own account.' });
      return true;
    }
    if (target.role === 'admin' && activeAdminCount() <= 1) {
      json(res, 200, { ok: false, error: 'This is the only administrator — promote another admin first.' });
      return true;
    }
    deleteUser(id);
    logActivity(me.username, 'user-delete', target.username, clientIp(req));
    json(res, 200, { ok: true, users: listUsers() });
    return true;
  }
  // Forget every browser this user has verified: their next sign-in anywhere asks for a code
  // again. The admin's answer to "someone's laptop was stolen".
  if (path === '/api/users/reset-devices' && req.method === 'POST') {
    const body = await readBody(req);
    const target = getUser(Number(body['id']));
    if (!target) {
      json(res, 200, { ok: false, error: 'User not found.' });
      return true;
    }
    const n = revokeDevices(target.id);
    logActivity(me.username, 'reset-2fa', `${target.username} — ${n} device(s) forgotten`, clientIp(req));
    json(res, 200, { ok: true, devices: n, users: listUsers() });
    return true;
  }
  // The activity log itself: what everyone did, newest first, filterable. Read-only by design —
  // an audit trail nobody can edit from the UI is the whole point.
  if (path === '/activity') {
    html(res, activityPage(me));
    return true;
  }
  if (path === '/api/activity' && req.method !== 'POST') {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 100) || 100));
    const beforeId = Math.max(0, Number(q.get('before') ?? 0) || 0);
    const user = (q.get('user') ?? '').slice(0, 32);
    const action = (q.get('action') ?? '').slice(0, 32);
    const fromTs = parseLocalDate(q.get('from') ?? '');
    const toRaw = parseLocalDate(q.get('to') ?? '');
    const toTs = toRaw ? toRaw + 86_400_000 - 1 : 0; // "to" is an inclusive DATE, local time
    json(res, 200, { ...listActivity(limit, beforeId, user, action, fromTs, toTs), users: allUsernames() });
    return true;
  }
  return false;
}
/** Bigger cap for file uploads — base64 inflates a file by about a third. */
const UPLOAD_MAX = 26_000_000;

function readBody(req: http.IncomingMessage, max = 2_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      // Resolve on destroy: an unresolved promise here leaked the handler frame for the life
      // of the process, and the caller was left awaiting forever.
      if (data.length > max) {
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      try {
        // A body of literal `null` parses fine but is not an object — every handler then threw on
        // property access and returned 500, including on the unauthenticated /login route.
        const parsed: unknown = JSON.parse(data || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export function startWebServer(
  getOrders: () => Order[],
  chatStore: ChatStore,
  send?: (chatId: string, text: string, mentions?: string[], sentBy?: string, quotedId?: string) => Promise<string>,
  media?: (messageId: string) => Promise<{ data: string; mimetype: string; filename?: string } | null>,
  sendMedia?: (
    chatId: string,
    file: { data: string; mimetype: string; filename: string },
    caption?: string,
    mentions?: string[],
    sentBy?: string,
    asVoice?: boolean,
  ) => Promise<string>,
  del?: (messageId: string, everyone: boolean) => Promise<{ ok: boolean; reason?: string }>,
  star?: (messageId: string, on: boolean) => Promise<{ ok: boolean; reason?: string }>,
  pin?: (messageId: string, on: boolean) => Promise<{ ok: boolean; reason?: string }>,
  react?: (messageId: string, emoji: string) => Promise<{ ok: boolean; reason?: string }>,
): http.Server {
  ordersProvider = getOrders;
  chatStoreRef = chatStore;
  sendMessageFn = send ?? null;
  mediaFn = media ?? null;
  sendMediaFn = sendMedia ?? null;
  deleteFn = del ?? null;
  starFn = star ?? null;
  pinFn = pin ?? null;
  reactFn = react ?? null;
  ensureSeedAdmin(); // first run: create the admin account and write its one-time password
  cleanupAuth(); // drop expired sessions / stale lockout rows
  // ...and keep doing it: login_attempts grows with every failed attempt, and a boot-only sweep
  // let an unauthenticated flood fill the disk that also holds chats/orders.
  setInterval(cleanupAuth, 10 * 60 * 1000).unref();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error({ err, url: req.url }, 'web request failed');
      try {
        json(res, 500, { error: 'internal' });
      } catch {
        /* response already sent */
      }
    });
  });

  // Every page is a TS template literal, so a single-backslash regex (\s, \d, \n) silently becomes
  // broken JS and the page renders with a dead script — no server error, no console error we'd see.
  // Parse the inline scripts once at boot so that failure is loud instead of invisible.
  checkInlineScripts();

  server.listen(config.webPort, config.webHost, () => {
    logger.info(
      { port: config.webPort },
      `dashboard http://localhost:${config.webPort}  ·  matcher /match  ·  link /qr`,
    );
  });
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? '/', 'http://localhost');
  const path = u.pathname;

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  // --- auth gate -----------------------------------------------------------
  // Everything except /login and /healthz requires a session. The site can send WhatsApp
  // messages as the business, so an unauthenticated request must never reach a page or API.
  const token = readCookie(req.headers.cookie, COOKIE);
  const me = sessionUser(token);

  // CSRF defence-in-depth: state-changing calls must come from our own origin. SameSite=Lax
  // already blocks cross-site cookie POSTs; this rejects anything with a foreign Origin too.
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host ?? '';
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        // Unparseable Origin: leave it empty and let the !originHost test below reject it.
        // This used to be a sentinel character, which worked but put a raw NUL byte in the
        // source — enough to make grep and diff treat this whole file as binary.
      }
      if (!originHost || originHost !== host) {
        json(res, 403, { error: 'cross-origin request rejected' });
        return;
      }
    }
  }

  if (path === '/login') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const r = await authLogin(body['username'], body['password'], clientIp(req));
      if (!r.ok) {
        logger.warn({ username: String(body['username'] ?? '').slice(0, 40) }, 'failed login');
        logActivity(String(body['username'] ?? '').slice(0, 32), 'login-failed', '', clientIp(req));
        json(res, 401, { ok: false, error: r.error });
        return;
      }
      // Two-step verification (meeting 31-07): a browser that has never passed a code gets one by
      // email before any session exists. Device-cookie based, NOT network based — behind the
      // Cloudflare Tunnel every request reaches this process from 127.0.0.1, so "inside the
      // network" is not a signal this server can actually see. A user with no email on file can't
      // receive a code; they sign in as before and the Users page shows the gap to the admin.
      const devTok = readCookie(req.headers.cookie, DEVICE_COOKIE);
      if (r.user.email && !deviceTrusted(r.user.id, devTok)) {
        const pend = createPendingLogin(r.user.id);
        try {
          const t = tplCode(r.user.name || r.user.username, pend.code);
          await sendMail(r.user.email, t.subject, t.text, t.html);
        } catch (err) {
          // Escape hatch: mail down must not lock the whole team out of a live order system. The
          // code lands in the server log, where an operator on the box can read it out.
          logger.warn({ err, user: r.user.username, code: pend.code }, 'OTP email failed — code in this log line is the fallback');
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': pendingCookie(pend.token, isSecureReq(req)),
        });
        res.end(JSON.stringify({ ok: true, otp: true, hint: maskEmail(r.user.email) }));
        logger.info({ user: r.user.username }, 'login ok — verification code sent');
        return;
      }
      const t = createSession(r.user.id);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': sessionCookie(t, isSecureReq(req)),
      });
      res.end(JSON.stringify({ ok: true, mustChange: r.user.mustChange }));
      logger.info({ user: r.user.username }, 'login ok');
      logActivity(r.user.username, 'login', '', clientIp(req));
      return;
    }
    if (me) {
      redirect(res, '/');
      return;
    }
    html(res, loginPage());
    return;
  }
  // Step two of a sign-in: the emailed code. Mints the session and remembers the browser.
  if (path === '/login/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const pendTok = readCookie(req.headers.cookie, PENDING_COOKIE);
    const v = verifyOtp(pendTok, body['code']);
    if (!v.ok) {
      json(res, v.gone ? 410 : 401, { ok: false, error: v.error, gone: !!v.gone });
      return;
    }
    const secure = isSecureReq(req);
    const ua = String(req.headers['user-agent'] ?? '');
    const dev = trustDevice(v.user.id, readCookie(req.headers.cookie, DEVICE_COOKIE), ua);
    const t = createSession(v.user.id);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': [sessionCookie(t, secure), deviceCookie(dev, secure), clearPendingCookie(secure)],
    });
    res.end(JSON.stringify({ ok: true, mustChange: v.user.mustChange }));
    logger.info({ user: v.user.username }, 'two-step verification passed — device remembered');
    logActivity(v.user.username, 'login-new-device', ua.slice(0, 120), clientIp(req));
    // Heads-up to the admins (Settings switch): a verified sign-in from a brand-new device is
    // exactly the event worth a second pair of eyes. Fire-and-forget — mail must never block login.
    if (getSetting('notify.adminNewDevice', '0') === '1') {
      const admins = listUsers().filter((u2) => u2.role === 'admin' && u2.active && u2.email && u2.id !== v.user.id);
      const alert = tplAdminNewDevice(v.user.username, ua);
      for (const a of admins) {
        void sendMail(a.email, alert.subject, alert.text, alert.html).catch((err) =>
          logger.warn({ err, to: a.email }, 'admin new-device alert failed'),
        );
      }
    }
    return;
  }
  if (path === '/login/resend' && req.method === 'POST') {
    const rs = resendOtp(readCookie(req.headers.cookie, PENDING_COOKIE));
    if (!rs.ok) {
      json(res, 429, { ok: false, error: rs.error });
      return;
    }
    try {
      const t = tplCode(rs.user.name || rs.user.username, rs.code);
      await sendMail(rs.user.email, t.subject, t.text, t.html);
    } catch (err) {
      logger.warn({ err, user: rs.user.username, code: rs.code }, 'OTP email failed — code in this log line is the fallback');
    }
    json(res, 200, { ok: true });
    return;
  }
  // POST-only: a GET logout can be triggered by any third-party page (<img src=".../logout">).
  if (path === '/logout') {
    if (req.method !== 'POST') {
      redirect(res, me ? '/' : '/login');
      return;
    }
    if (me) logActivity(me.username, 'logout', '', clientIp(req));
    destroySession(token);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': clearCookie(isSecureReq(req)),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!me) {
    if (path.startsWith('/api/')) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    redirect(res, '/login');
    return;
  }

  // Forced password change (first login / admin reset) — nothing else is reachable until done.
  if (me.mustChange && path !== '/change-password') {
    if (path.startsWith('/api/')) {
      json(res, 403, { error: 'password change required' });
      return;
    }
    redirect(res, '/change-password');
    return;
  }
  if (path === '/change-password') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const v = validatePassword(body['password']);
      if (!v.ok) {
        json(res, 400, { ok: false, error: v.error });
        return;
      }
      if (String(body['password']) !== String(body['confirm'] ?? '')) {
        json(res, 400, { ok: false, error: 'Passwords do not match.' });
        return;
      }
      // Outside the forced first-change, prove ownership: otherwise a single borrowed session
      // (unattended browser, XSS issuing a same-origin POST) becomes a permanent account takeover,
      // since changePassword signs every OTHER session out and keeps the caller's.
      if (!me.mustChange && !(await verifyPassword(me.id, String(body['current'] ?? '')))) {
        json(res, 400, { ok: false, error: 'Current password is incorrect.' });
        return;
      }
      changePassword(me.id, v.value, token ?? undefined);
      logActivity(me.username, 'password-changed', '', clientIp(req));
      // "Your password was changed" — the mail that matters when it WASN'T them. Best-effort.
      if (me.email) {
        const t = tplPasswordChanged(me.name || me.username);
        void sendMail(me.email, t.subject, t.text, t.html).catch((err) =>
          logger.warn({ err, to: me.email }, 'password-changed email failed'),
        );
      }
      json(res, 200, { ok: true });
      return;
    }
    html(res, changePasswordPage(me));
    return;
  }

  // --- admin-only surface ---------------------------------------------------
  // /qr shows the WhatsApp device-linking QR: scanning it links a phone to the business account
  // with full read+send, outside this app and unaffected by disabling the OMS user. Admins only.
  if (path === '/admin' || path === '/qr' || path === '/settings' || path === '/activity' || path === '/report' || path === '/aliases' || path.startsWith('/api/users') || path.startsWith('/api/settings') || path.startsWith('/api/activity') || path.startsWith('/api/report') || path.startsWith('/api/aliases')) {
    if (me.role !== 'admin') {
      if (path.startsWith('/api/')) {
        json(res, 403, { error: 'admin only' });
        return;
      }
      redirect(res, '/');
      return;
    }
    const handled = await handleAdmin(req, res, path, me);
    if (handled) return;
  }

  if (path === '/api/me') {
    json(res, 200, { user: { id: me.id, username: me.username, name: me.name, role: me.role } });
    return;
  }

  if (path === '/api/orders') {
    json(res, 200, { status, ts: Math.floor(Date.now() / 1000), orders: ordersProvider() });
    return;
  }
  if (path === '/api/products/search') {
    const q = u.searchParams.get('q') ?? '';
    // Math.max first: a negative limit made slice(0,-1) mean "all but the last", returning the
    // whole 17k-row catalog (1.7 MB) instead of a handful of suggestions.
    //
    // The ceiling is 300 rather than the old 20: staff searching "SDS" were getting six results
    // while DDI showed pages of them. It is not unlimited, because a broad phrase legitimately
    // matches thousands of products and that response was 1.7 MB.
    const limit = Math.min(300, Math.max(1, Number(u.searchParams.get('limit') ?? 50) || 50));
    const found = searchCatalog(q, limit);
    json(res, 200, { results: found.results.map((s) => s.product), total: found.total });
    return;
  }
  if (path === '/api/extract' && req.method === 'POST') {
    const body = await readBody(req);
    let text = typeof body['text'] === 'string' ? (body['text'] as string) : '';
    let sources: Array<{ messageId: string; text: string }> = [];
    let newCount = -1;
    if (!text && typeof body['chatId'] === 'string' && chatStoreRef) {
      const cid = body['chatId'] as string;
      const mid = typeof body['messageId'] === 'string' ? (body['messageId'] as string) : '';
      const mids = Array.isArray(body['messageIds'])
        ? (body['messageIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : mid
          ? [mid]
          : [];
      const msgs = chatStoreRef.messages(cid);
      // With messageId(s): extract ONLY those bubbles (also serves as Reprocess for processed ones).
      // Without: all inbound customer messages not yet processed. Nothing is marked here —
      // marking happens on explicit /api/save, so unsaved extractions can be re-run.
      const pick = mids.length
        ? msgs.filter((m) => mids.includes(m.messageId))
        : msgs.filter((m) => !m.fromMe && !isProcessed(m.messageId));
      sources = pick.filter((m) => m.text).map((m) => ({ messageId: m.messageId, text: m.text }));
      text = sources.map((s) => s.text).join('\n');
      if (!mids.length) newCount = pick.length;
    }
    // Per-source extraction: line numbers must mean "line N of THAT message", so a 3-message order
    // cannot run its numbering across message boundaries. Material headers also stay scoped to the
    // message that declared them.
    const items = sources.length
      ? sources.flatMap((s) => extractAndMatch(s.text).map((it) => ({ ...it, messageId: s.messageId })))
      : extractAndMatch(text);
    json(res, 200, { items, sources, ...(newCount >= 0 ? { newMessages: newCount } : {}) });
    return;
  }
  if (path === '/api/save' && req.method === 'POST') {
    const body = await readBody(req);
    const cid = typeof body['chatId'] === 'string' ? (body['chatId'] as string) : '';
    const srcs = Array.isArray(body['sources']) ? (body['sources'] as Array<{ messageId?: string; text?: string }>) : [];
    const itemsJson = JSON.stringify(body['items'] ?? []);
    let saved = 0;
    const who = me.name || me.username; // attribute the completed order to whoever clicked Copy
    for (const s of srcs) {
      if (s && typeof s.messageId === 'string' && s.messageId) {
        saveExtraction(s.messageId, cid, typeof s.text === 'string' ? s.text : '', itemsJson, who);
        saved++;
      }
    }
    logger.info({ user: me.username, chatId: cid, messages: saved }, 'order marked processed');
    logActivity(me.username, 'order-saved', `chat ${cid} — ${saved} message(s)`, clientIp(req));
    json(res, 200, { ok: saved > 0, saved });
    return;
  }
  if (path === '/api/alias' && req.method === 'POST') {
    const body = await readBody(req);
    const phrase = typeof body['phrase'] === 'string' ? (body['phrase'] as string) : '';
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const desc = typeof body['description'] === 'string' ? (body['description'] as string) : '';
    if (phrase && code) {
      addAlias(normalize(phrase), code, desc, phrase.trim());
      logActivity(me.username, 'teach-alias', `"${phrase.trim().slice(0, 80)}" -> ${code}`, clientIp(req));
    }
    json(res, 200, { ok: true, aliases: aliasCount() });
    return;
  }
  if (path === '/api/chats/rename' && req.method === 'POST') {
    const body = await readBody(req);
    const cid = typeof body['chatId'] === 'string' ? (body['chatId'] as string) : '';
    const name = typeof body['name'] === 'string' ? (body['name'] as string).trim() : '';
    if (cid && name) {
      setChatName(cid, name);
      logActivity(me.username, 'rename-chat', `${cid} -> "${name.slice(0, 60)}"`, clientIp(req));
    }
    json(res, 200, { ok: !!(cid && name) });
    return;
  }
  if (path === '/api/chats') {
    const list = chatStoreRef ? chatStoreRef.chats() : [];
    json(res, 200, {
      source: 'persisted',
      status, // live-connection state for the header pill (this endpoint is already polled every 6s)
      chats: list.map((c) => ({ id: c.id, title: c.title, lastText: c.lastText, lastTs: c.lastTs, unread: c.unread, isGroup: c.isGroup })),
    });
    return;
  }
  // Serve a message's media (image / voice / video / document). Downloaded from WhatsApp on first
  // request and cached on disk, so a thread with 50 photos does not re-download on every scroll.
  const mm2 = path.match(/^\/api\/media\/(.+)$/);
  if (mm2) {
    const id = safeDecode(mm2[1] ?? '');
    if (!id) {
      json(res, 400, { error: 'missing id' });
      return;
    }
    const safe = mediaCacheKey(id);
    const dir = mediaCacheDir();
    // Content-Disposition so a document saves under the name the customer sent it with, instead of
    // "false_1203...@g.us_3EB0....pdf". inline keeps images and audio rendering in the page;
    // ?dl=1 (the menu's Download) switches to attachment so the browser saves instead of opening.
    const asDownload = u.searchParams.get('dl') === '1';
    const disposition = (name?: string): Record<string, string> => {
      const kind = asDownload ? 'attachment' : 'inline';
      if (name) return { 'content-disposition': `${kind}; filename*=UTF-8''${encodeURIComponent(name)}` };
      return asDownload ? { 'content-disposition': 'attachment' } : {};
    };
    try {
      const hit = fs.readdirSync(dir).find((f) => f.startsWith(safe + '.') && !f.endsWith('.name'));
      if (hit) {
        const buf = fs.readFileSync(nodePath.join(dir, hit));
        let name: string | undefined;
        try {
          name = fs.readFileSync(nodePath.join(dir, `${safe}.name`), 'utf8');
        } catch {
          /* no original filename recorded */
        }
        // Downloads always need SOME filename with the right extension, or the browser saves an
        // extension-less blob named after the URL.
        if (!name && asDownload) name = `whatsapp-${Date.now()}.${hit.split('.').pop()}`;
        res.writeHead(200, {
          'content-type': mimeFromExt(hit),
          'cache-control': 'private, max-age=86400',
          'content-length': buf.length,
          ...disposition(name),
        });
        res.end(buf);
        return;
      }
    } catch {
      /* no cache dir yet */
    }
    if (!mediaFn) {
      json(res, 503, { error: 'media unavailable' });
      return;
    }
    const got = await mediaFn(id);
    if (!got) {
      json(res, 404, { error: 'media could not be downloaded' });
      return;
    }
    let bytes: number;
    try {
      bytes = writeMediaCache(id, got.data, got.mimetype, got.filename);
    } catch (err) {
      logger.warn({ err }, 'could not cache media'); // serving still works
      bytes = Buffer.byteLength(got.data, 'base64');
    }
    res.writeHead(200, {
      'content-type': got.mimetype,
      'cache-control': 'private, max-age=86400',
      'content-length': bytes,
      ...disposition(got.filename ?? (asDownload ? `whatsapp-${Date.now()}.${extFromMime(got.mimetype)}` : undefined)),
    });
    res.end(Buffer.from(got.data, 'base64'));
    return;
  }
  // People who can be @-mentioned in this chat (fetched once when a chat is opened).
  const pm = path.match(/^\/api\/chats\/(.+)\/participants$/);
  if (pm) {
    const pid = safeDecode(pm[1] ?? '');
    if (pid === null) {
      json(res, 400, { error: 'bad chat id' });
      return;
    }
    json(res, 200, { participants: chatParticipants(pid) });
    return;
  }
  const mm = path.match(/^\/api\/chats\/(.+)\/messages$/);
  if (mm) {
    const id = safeDecode(mm[1] ?? '');
    if (id === null) {
      json(res, 400, { error: 'bad chat id' });
      return;
    }
    const msgs = chatStoreRef ? chatStoreRef.messages(id) : [];
    const orderNos = orderNoOf(id); // DDI order numbers typed after Copy, keyed by message
    json(res, 200, {
      mentions: mentionNames(), // '@<id>' in a body -> display name
      appUsers: allUsernames(), // names recognised in the "-- <username>" signature
      pinned: pinnedMessage(id), // newest pinned message -> the banner above the thread
      messages: msgs.map((m) => ({ messageId: m.messageId, fromMe: m.fromMe, pushName: m.pushName, text: m.text, kind: m.kind, hasMedia: m.kind !== 'text', ts: m.ts, processed: isProcessed(m.messageId), outgoing: isWarehouseMsg(m), reactions: m.reactions, isGroup: m.isGroup, replyTo: m.replyTo, replyText: m.replyText, replySender: m.replySender, processedBy: m.processedBy, sentBy: m.sentBy, starred: m.starred, pinned: m.pinned, orderNo: orderNos.get(m.messageId) })),
    });
    return;
  }
  // Send a message to a chat. Human-initiated only: one message per explicit click, always
  // attributed to the signed-in user in the log. No bulk/automated sending anywhere in this app.
  if (path === '/api/send' && req.method === 'POST') {
    if (!sendMessageFn) {
      json(res, 503, { ok: false, error: 'Sending is not available.' });
      return;
    }
    if (status !== 'connected') {
      json(res, 409, { ok: false, error: 'WhatsApp is not connected — reconnect before sending.' });
      return;
    }
    const body = await readBody(req);
    const chatId = typeof body['chatId'] === 'string' ? (body['chatId'] as string).trim() : '';
    const text = typeof body['text'] === 'string' ? (body['text'] as string) : '';
    if (!chatId || !/@(g\.us|c\.us|lid)$/.test(chatId)) {
      json(res, 400, { ok: false, error: 'Pick a chat first.' });
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      json(res, 400, { ok: false, error: 'Message is empty.' });
      return;
    }
    if (trimmed.length > 4000) {
      json(res, 400, { ok: false, error: 'Message is too long (max 4000 characters).' });
      return;
    }
    // Sign the message so WhatsApp readers can see who sent it: two blank lines, then a
    // writing-hand emoji and the username in WhatsApp's bold markup. (Escaped rather than a
    // literal emoji so the source stays plain ASCII.)
    // Uppercase is display-only — the parser matches the name case-insensitively against accounts.
    const signed = `${trimmed}\n\n✍🏼 BY *${me.username.toUpperCase()}*`;
    // A real WhatsApp mention needs BOTH the id in the text ('@8355…') and the full JID here,
    // otherwise it renders as plain text and the person is never notified.
    const mentions = Array.isArray(body['mentions'])
      ? (body['mentions'] as unknown[])
          .filter((x): x is string => typeof x === 'string' && /^\d{5,}@(lid|c\.us)$/.test(x))
          .slice(0, 32)
      : [];
    // Reply: quote must reference a message in the SAME chat — a cross-chat id would quote
    // something the recipients cannot see (and leak that other chat's text into this one).
    let quotedId: string | undefined;
    if (typeof body['replyTo'] === 'string' && body['replyTo']) {
      const target = getMessage(body['replyTo'] as string);
      if (target && target.chatId === chatId) quotedId = body['replyTo'] as string;
    }
    try {
      const messageId = await sendMessageFn(chatId, signed, mentions, me.username, quotedId);
      if (messageId) recordSentBy(messageId, me.username); // best-effort; index.ts also claims it
      logger.info(
        { user: me.username, chatId, chars: trimmed.length, mentions: mentions.length, messageId },
        'user sent message',
      );
      logActivity(me.username, 'send-message', `${chatId} (${trimmed.length} chars${quotedId ? ', reply' : ''})`, clientIp(req));
      json(res, 200, { ok: true, messageId });
    } catch (err) {
      logger.error({ err, user: me.username, chatId }, 'send failed');
      json(res, 500, { ok: false, error: 'WhatsApp rejected the message. Try again.' });
    }
    return;
  }
  // Send a file to a chat. Same rules as a text send: human-initiated, one at a time, attributed.
  if (path === '/api/send-media' && req.method === 'POST') {
    if (!sendMediaFn) {
      json(res, 503, { ok: false, error: 'Sending is not available.' });
      return;
    }
    if (status !== 'connected') {
      json(res, 409, { ok: false, error: 'WhatsApp is not connected — reconnect before sending.' });
      return;
    }
    const body = await readBody(req, UPLOAD_MAX);
    const chatId = typeof body['chatId'] === 'string' ? (body['chatId'] as string).trim() : '';
    const data = typeof body['data'] === 'string' ? (body['data'] as string) : '';
    const mimetype = typeof body['mimetype'] === 'string' ? (body['mimetype'] as string) : '';
    const filename = (typeof body['filename'] === 'string' ? (body['filename'] as string) : 'file')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120);
    const caption = typeof body['caption'] === 'string' ? (body['caption'] as string).trim() : '';
    if (!chatId || !/@(g\.us|c\.us|lid)$/.test(chatId)) {
      json(res, 400, { ok: false, error: 'Pick a chat first.' });
      return;
    }
    if (!data || !mimetype) {
      json(res, 400, { ok: false, error: 'No file received — try again.' });
      return;
    }
    // base64 is ~4/3 of the real size; keep WhatsApp's practical limit in view.
    if (data.length > 22_000_000) {
      json(res, 400, { ok: false, error: 'File is too large (max about 16 MB).' });
      return;
    }
    const signed = caption ? `${caption}\n\n✍🏼 BY *${me.username.toUpperCase()}*` : '';
    // voice:true = a recorded voice note, sent as WhatsApp's push-to-talk bubble.
    const asVoice = !!body['voice'] && /^audio\//.test(mimetype);
    try {
      const messageId = await sendMediaFn(chatId, { data, mimetype, filename }, signed || undefined, undefined, me.username, asVoice);
      if (messageId) recordSentBy(messageId, me.username);
      logger.info({ user: me.username, chatId, filename, mimetype, messageId }, 'user sent a file');
      logActivity(me.username, 'send-file', `${filename} -> ${chatId}`, clientIp(req));
      json(res, 200, { ok: true, messageId });
    } catch (err) {
      logger.error({ err, user: me.username, chatId, filename }, 'file send failed');
      json(res, 500, { ok: false, error: 'Send may have failed — check the chat before resending.' });
    }
    return;
  }
  // Delete a message the signed-in user sent FROM THIS APP. The client's rule, stated twice in
  // the meeting: "every user can only delete their own messages" — enforced here on the server
  // against sent_by (recorded at send time), never on what the browser claims. Messages typed on
  // a phone, or sent before attribution shipped, have no sent_by row: nobody can delete those
  // from the app, by design. Admins get no exemption; the rule was "I don't want ANYBODY".
  if (path === '/api/messages/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const messageId = typeof body['messageId'] === 'string' ? (body['messageId'] as string) : '';
    const everyone = !!body['everyone'];
    const msg = messageId ? getMessage(messageId) : null;
    if (!msg) {
      json(res, 404, { ok: false, error: 'Message not found.' });
      return;
    }
    const owner = sentByOf(messageId);
    if (!owner || owner.toLowerCase() !== me.username.toLowerCase()) {
      json(res, 403, { ok: false, error: 'You can only delete messages you sent from this app.' });
      return;
    }
    if (everyone) {
      if (!deleteFn || status !== 'connected') {
        json(res, 409, { ok: false, error: 'WhatsApp is not connected — try again when the chat is live.' });
        return;
      }
      const r = await deleteFn(messageId, true);
      if (!r.ok) {
        json(res, 500, { ok: false, error: r.reason ?? 'WhatsApp refused to delete this message.' });
        return;
      }
      markRevoked(messageId); // thread now shows "This message was deleted", same as WhatsApp
    } else {
      // Delete-for-me: hidden from the OMS for every user. Deliberate — the OMS is one shared
      // window onto the account, not per-user mailboxes. WhatsApp on phones still shows it.
      // Best-effort mirror into the linked account; the OMS hide must not depend on it.
      if (deleteFn && status === 'connected') void deleteFn(messageId, false);
      markDeleted(messageId);
    }
    logger.info({ user: me.username, messageId, everyone }, 'message deleted');
    logActivity(me.username, 'delete-message', `${everyone ? 'for everyone' : 'for me'} — ${messageId}`, clientIp(req));
    json(res, 200, { ok: true });
    return;
  }
  // Star / pin, mirrored into the real WhatsApp. Any signed-in user may do these — unlike delete
  // they are additive and reversible, and WhatsApp itself lets any group member pin/star.
  if ((path === '/api/messages/star' || path === '/api/messages/pin') && req.method === 'POST') {
    const isStar = path.endsWith('/star');
    const fn = isStar ? starFn : pinFn;
    if (!fn || status !== 'connected') {
      json(res, 409, { ok: false, error: 'WhatsApp is not connected — try again when the chat is live.' });
      return;
    }
    const body = await readBody(req);
    const messageId = typeof body['messageId'] === 'string' ? (body['messageId'] as string) : '';
    const on = !!body['on'];
    if (!messageId || !getMessage(messageId)) {
      json(res, 404, { ok: false, error: 'Message not found.' });
      return;
    }
    const r = await fn(messageId, on);
    if (!r.ok) {
      json(res, 500, { ok: false, error: r.reason ?? 'WhatsApp refused.' });
      return;
    }
    if (isStar) setStarred(messageId, on);
    else setPinned(messageId, on);
    logger.info({ user: me.username, messageId, action: (on ? '' : 'un') + (isStar ? 'star' : 'pin') }, 'message action');
    logActivity(me.username, (on ? '' : 'un') + (isStar ? 'star' : 'pin'), messageId, clientIp(req));
    json(res, 200, { ok: true });
    return;
  }
  // React with an emoji, like tapping a message in WhatsApp. Empty emoji removes the reaction.
  // The reaction lands in the real chat; our own message_reaction event then stores + renders it.
  if (path === '/api/messages/react' && req.method === 'POST') {
    if (!reactFn || status !== 'connected') {
      json(res, 409, { ok: false, error: 'WhatsApp is not connected — try again when the chat is live.' });
      return;
    }
    const body = await readBody(req);
    const messageId = typeof body['messageId'] === 'string' ? (body['messageId'] as string) : '';
    const emoji = typeof body['emoji'] === 'string' ? (body['emoji'] as string).slice(0, 8) : '';
    if (!messageId || !getMessage(messageId)) {
      json(res, 404, { ok: false, error: 'Message not found.' });
      return;
    }
    const r = await reactFn(messageId, emoji);
    if (!r.ok) {
      json(res, 500, { ok: false, error: r.reason ?? 'WhatsApp refused the reaction.' });
      return;
    }
    logger.info({ user: me.username, messageId, emoji }, 'reaction sent');
    logActivity(me.username, 'react', `${emoji || '(removed)'} — ${messageId}`, clientIp(req));
    json(res, 200, { ok: true });
    return;
  }
  // Learned non-products: ✕ on an unmatched extracted row teaches the system to skip that phrase
  // in future extractions. Any signed-in user can teach (the aliases work the same way); the Undo
  // in the toast calls the delete endpoint.
  if (path === '/api/ignored' && req.method === 'POST') {
    const body = await readBody(req);
    const phrase = typeof body['phrase'] === 'string' ? (body['phrase'] as string).trim().slice(0, 200) : '';
    const norm = normalize(phrase);
    if (!norm) {
      json(res, 400, { ok: false, error: 'Nothing to ignore.' });
      return;
    }
    // A phrase that IS an exact SKU must never be silenced — refuse rather than trust the guard.
    if (byCode(phrase)) {
      json(res, 200, { ok: false, error: 'That is a real product code — not added to the ignore list.' });
      return;
    }
    addIgnoredPhrase(norm, phrase, me.username);
    logger.info({ user: me.username, phrase }, 'phrase added to the ignore list');
    logActivity(me.username, 'teach-ignore', phrase, clientIp(req));
    json(res, 200, { ok: true });
    return;
  }
  if (path === '/api/ignored/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const norm = normalize(typeof body['phrase'] === 'string' ? (body['phrase'] as string) : '');
    removeIgnoredPhrase(norm);
    logger.info({ user: me.username, norm }, 'phrase removed from the ignore list');
    logActivity(me.username, 'undo-ignore', norm, clientIp(req));
    json(res, 200, { ok: true });
    return;
  }
  // The DDI order number a sales rep types after Copy — stamped onto every processed message of
  // that order, so the thread badge can show "Processed by Nate · DDI #12345".
  if (path === '/api/processed/order-no' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body['messageIds'])
      ? (body['messageIds'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50)
      : [];
    const orderNo = typeof body['orderNo'] === 'string' ? (body['orderNo'] as string).trim().slice(0, 40) : '';
    if (!ids.length) {
      json(res, 400, { ok: false, error: 'No processed messages given.' });
      return;
    }
    const n = setOrderNo(ids, orderNo);
    logger.info({ user: me.username, orderNo, messages: n }, 'DDI order number saved');
    logActivity(me.username, 'ddi-number', `#${orderNo} on ${n} message(s)`, clientIp(req));
    json(res, 200, { ok: true, updated: n });
    return;
  }
  // Forward a message to another chat. Implemented as copy-and-send through the normal signed
  // send path (media re-served from the cache): WhatsApp's own forward APIs go through the
  // Msg.get lookup that breaks on @lid chats, and a signed copy also keeps the audit trail of
  // WHO forwarded it. Recipients see a normal message, not WhatsApp's "Forwarded" label.
  if (path === '/api/messages/forward' && req.method === 'POST') {
    if (status !== 'connected') {
      json(res, 409, { ok: false, error: 'WhatsApp is not connected — try again when the chat is live.' });
      return;
    }
    const body = await readBody(req);
    const messageId = typeof body['messageId'] === 'string' ? (body['messageId'] as string) : '';
    const toChat = typeof body['chatId'] === 'string' ? (body['chatId'] as string).trim() : '';
    if (!toChat || !/@(g\.us|c\.us|lid)$/.test(toChat)) {
      json(res, 400, { ok: false, error: 'Pick a chat to forward to.' });
      return;
    }
    const msg = messageId ? getMessage(messageId) : null;
    if (!msg) {
      json(res, 404, { ok: false, error: 'Message not found.' });
      return;
    }
    // Strip the original sender's app signature — the forward gets the FORWARDER's signature.
    const text = msg.body.replace(/\n\n✍🏼 BY \*[A-Za-z0-9]+\*\s*$/u, '').trim();
    const MEDIA_KINDS = ['image', 'video', 'audio', 'voice', 'document', 'sticker', 'ptv'];
    try {
      let sentId = '';
      if (MEDIA_KINDS.includes(msg.kind)) {
        if (!mediaFn || !sendMediaFn) {
          json(res, 503, { ok: false, error: 'Media is not available right now.' });
          return;
        }
        const file = await mediaFn(messageId);
        if (!file) {
          json(res, 404, { ok: false, error: 'The file could not be retrieved from WhatsApp any more.' });
          return;
        }
        const caption = text ? `${text}\n\n✍🏼 BY *${me.username.toUpperCase()}*` : undefined;
        sentId = await sendMediaFn(toChat, { data: file.data, mimetype: file.mimetype, filename: file.filename ?? 'file' }, caption, undefined, me.username);
      } else {
        if (!sendMessageFn || !text) {
          json(res, 400, { ok: false, error: 'There is no text to forward.' });
          return;
        }
        sentId = await sendMessageFn(toChat, `${text}\n\n✍🏼 BY *${me.username.toUpperCase()}*`, undefined, me.username);
      }
      if (sentId) recordSentBy(sentId, me.username);
      logger.info({ user: me.username, from: msg.chatId, to: toChat, messageId }, 'message forwarded');
      logActivity(me.username, 'forward', `${msg.chatId} -> ${toChat}`, clientIp(req));
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error({ err, user: me.username, messageId, toChat }, 'forward failed');
      json(res, 500, { ok: false, error: 'Forward failed — check the destination chat before retrying.' });
    }
    return;
  }
  // Match report: every saved order line, searchable by SKU / description / the customer's own
  // words, date-filterable. Feeds the /report page and its export.
  if (path === '/api/report') {
    const q = (u.searchParams.get('q') ?? '').slice(0, 100);
    const from = parseLocalDate(u.searchParams.get('from') ?? '');
    // "to" is a DATE (inclusive): add a day so 31-07 includes everything ON the 31st.
    const toRaw = parseLocalDate(u.searchParams.get('to') ?? '');
    const to = toRaw ? toRaw + 86_400_000 - 1 : 0;
    json(res, 200, reportRows(q, from, to));
    return;
  }
  if (path === '/report') {
    html(res, reportPage(me));
    return;
  }
  if (path === '/api/products/count') {
    json(res, 200, { count: productCount(), aliases: aliasCount() });
    return;
  }
  // --- Alias Management API ---
  if (path === '/api/aliases' && req.method !== 'POST') {
    const q = (u.searchParams.get('q') ?? '').trim();
    const page = Math.max(1, Number(u.searchParams.get('page') ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') ?? 25) || 25));
    const counts = new Map<string, { n: number; desc: string }>();
    for (const c of aliasCountsByCode()) counts.set(c.code, { n: c.n, desc: c.desc });
    let codes: string[];
    if (!q) {
      // Default view: only products that actually have aliases (the ones worth managing).
      codes = [...counts.keys()];
    } else {
      // Search: any product by SKU/name across the full catalog, plus products matched by alias.
      const ql = q.toLowerCase();
      const set = new Set<string>();
      for (const p of allProducts()) {
        if (p.code.toLowerCase().includes(ql) || p.description.toLowerCase().includes(ql)) set.add(p.code);
      }
      for (const c of aliasCodesMatching(ql)) set.add(c);
      codes = [...set];
    }
    const rows = codes.map((code) => {
      const meta = counts.get(code);
      return { code, description: byCode(code)?.description ?? meta?.desc ?? '', count: meta?.n ?? 0 };
    });
    rows.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    const start = (page - 1) * limit;
    json(res, 200, { total: rows.length, page, limit, rows: rows.slice(start, start + limit) });
    return;
  }
  if (path === '/api/aliases/product') {
    const code = u.searchParams.get('code') ?? '';
    json(res, 200, { code, description: byCode(code)?.description ?? '', aliases: aliasesForProduct(code) });
    return;
  }
  if (path === '/api/aliases/add' && req.method === 'POST') {
    const body = await readBody(req);
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    if (!code) {
      json(res, 200, { ok: false, error: 'Missing product.' });
      return;
    }
    const v = validateAliasInput(body['alias']);
    if (!v.ok) {
      json(res, 200, { ok: false, error: v.error });
      return;
    }
    const existing = getAliasRow(v.norm);
    if (existing) {
      json(res, 200, {
        ok: false,
        error:
          existing.code === code
            ? 'This alias already exists for this product.'
            : `That alias is already assigned to another product (${existing.code}).`,
      });
      return;
    }
    addAlias(v.norm, code, byCode(code)?.description ?? '', v.text);
    json(res, 200, { ok: true, aliases: aliasesForProduct(code) });
    return;
  }
  if (path === '/api/aliases/edit' && req.method === 'POST') {
    const body = await readBody(req);
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const oldNorm = typeof body['oldNorm'] === 'string' ? (body['oldNorm'] as string) : '';
    const v = validateAliasInput(body['alias']);
    if (!v.ok) {
      json(res, 200, { ok: false, error: v.error });
      return;
    }
    const old = getAliasRow(oldNorm);
    if (!old || old.code !== code) {
      json(res, 200, { ok: false, error: 'Alias not found.' });
      return;
    }
    if (v.norm === oldNorm) {
      updateAliasText(oldNorm, v.text); // casing/punctuation-only change
    } else {
      const clash = getAliasRow(v.norm);
      if (clash) {
        json(res, 200, {
          ok: false,
          error:
            clash.code === code
              ? 'This alias already exists for this product.'
              : 'That alias is already assigned to another product.',
        });
        return;
      }
      deleteAlias(oldNorm);
      addAlias(v.norm, code, old.desc, v.text);
    }
    json(res, 200, { ok: true, aliases: aliasesForProduct(code) });
    return;
  }
  if (path === '/api/aliases/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const norm = typeof body['norm'] === 'string' ? (body['norm'] as string) : '';
    const ok = deleteAlias(norm);
    json(res, 200, { ok, aliases: aliasesForProduct(code) });
    return;
  }
  // The Aliases page merged into the Report ('learned' rows) — keep old bookmarks working.
  if (path === '/aliases') {
    redirect(res, '/report');
    return;
  }
  if (path === '/match') {
    html(res, matchPage(me));
    return;
  }
  // Home (/) and any unmatched path serve the Order Matching page directly (no redirect).
  // The Kanban dashboard is retired from the public face; keep it reachable at /board only.
  if (path === '/board') {
    html(res, dashboardPage());
    return;
  }
  html(res, matchPage(me));
}

export function closeWebServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- auth pages (login / forced password change / admin) ---
/** Shared chrome for the small centred auth cards. */
function authShell(title: string, inner: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  :root{color-scheme:light;--bg:#f0f2f5;--panel:#fff;--line:#e5e7eb;--tx:#111b21;--mut:#667781;--em:#10b981;--em2:#059669;--red:#dc2626}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
  .card{width:100%;max-width:390px;background:var(--panel);border:1px solid var(--line);border-radius:14px;
    padding:30px 28px;box-shadow:0 4px 22px #00000014}
  .brand{display:flex;align-items:center;gap:9px;margin-bottom:6px}
  .logo{width:32px;height:32px;border-radius:9px;background:var(--em);display:flex;align-items:center;justify-content:center;font-size:17px}
  h1{font-size:17px;margin:0;font-weight:700}
  .sub{color:var(--mut);font-size:13px;margin:0 0 20px}
  label{display:block;font-size:12px;font-weight:600;color:var(--mut);margin:14px 0 5px}
  input{width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--line);border-radius:9px;
    background:#fff;color:var(--tx);outline:none;transition:border-color .15s}
  input:focus{border-color:var(--em2)}
  button{width:100%;margin-top:20px;padding:11px;font-size:14px;font-weight:600;color:#fff;background:var(--em);
    border:0;border-radius:9px;cursor:pointer;transition:filter .15s}
  button:hover{filter:brightness(1.07)}button:disabled{opacity:.6;cursor:default}
  .linkbtn{background:none;color:var(--em2);font-weight:600;border:0;margin-top:10px;padding:4px;cursor:pointer}
  .linkbtn:hover{text-decoration:underline;filter:none}
  .err{display:none;margin-top:14px;padding:9px 11px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;
    border-radius:8px;font-size:13px}
  .err.on{display:block}
  .hint{margin-top:16px;font-size:12px;color:var(--mut);line-height:1.5}
</style></head><body><div class="card">${inner}</div>
<script>${script}</script></body></html>`;
}

function loginPage(): string {
  return authShell(
    'Sign in · WhatsApp OMS',
    `<div class="brand"><div class="logo">💬</div><h1>WhatsApp OMS</h1></div>
     <p class="sub">Sign in to continue</p>
     <form id="f" autocomplete="on">
       <label for="u">Username</label>
       <input id="u" name="username" autocomplete="username" autofocus required>
       <label for="p">Password</label>
       <input id="p" name="password" type="password" autocomplete="current-password" required>
       <button id="b" type="submit">Sign in</button>
     </form>
     <form id="f2" style="display:none">
       <p class="sub" id="otpmsg">We emailed you a 6-digit code.</p>
       <label for="c">Verification code</label>
       <input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required>
       <button id="b2" type="submit">Verify</button>
       <button id="rs" type="button" class="linkbtn">Send a new code</button>
     </form>
     <div class="err" id="e"></div>`,
    `var f=document.getElementById("f"),f2=document.getElementById("f2"),b=document.getElementById("b"),b2=document.getElementById("b2"),e=document.getElementById("e");
     f.addEventListener("submit",async function(ev){ev.preventDefault();e.className="err";b.disabled=true;b.textContent="Signing in…";
       try{
         var r=await fetch("/login",{method:"POST",headers:{"content-type":"application/json"},
           body:JSON.stringify({username:document.getElementById("u").value,password:document.getElementById("p").value})});
         var d=await r.json();
         if(d.ok&&d.otp){
           // Password accepted; this browser is new, so a code went to their email.
           f.style.display="none";f2.style.display="block";
           document.getElementById("otpmsg").textContent="This browser is new, so we emailed a 6-digit code to "+(d.hint||"your email")+".";
           document.getElementById("c").focus();b.disabled=false;b.textContent="Sign in";return;
         }
         if(d.ok){location.href=d.mustChange?"/change-password":"/";return;}
         e.textContent=d.error||"Sign in failed.";e.className="err on";
       }catch(err){e.textContent="Network error — please try again.";e.className="err on";}
       b.disabled=false;b.textContent="Sign in";});
     f2.addEventListener("submit",async function(ev){ev.preventDefault();e.className="err";b2.disabled=true;b2.textContent="Checking…";
       try{
         var r=await fetch("/login/verify",{method:"POST",headers:{"content-type":"application/json"},
           body:JSON.stringify({code:document.getElementById("c").value})});
         var d=await r.json();
         if(d.ok){location.href=d.mustChange?"/change-password":"/";return;}
         e.textContent=d.error||"That code did not work.";e.className="err on";
         if(d.gone){f2.style.display="none";f.style.display="block";}
       }catch(err){e.textContent="Network error — please try again.";e.className="err on";}
       b2.disabled=false;b2.textContent="Verify";});
     document.getElementById("rs").addEventListener("click",async function(){e.className="err";
       try{var r=await fetch("/login/resend",{method:"POST"});var d=await r.json();
         e.textContent=d.ok?"A new code is on its way.":(d.error||"Could not resend.");e.className="err on";
         if(d.ok)e.style.color="var(--em2, #059669)";else e.style.color="";
       }catch(err){e.textContent="Network error — please try again.";e.className="err on";}});`,
  );
}

function changePasswordPage(me: User): string {
  return authShell(
    'Set a new password · WhatsApp OMS',
    `<div class="brand"><div class="logo">🔑</div><h1>Set a new password</h1></div>
     <p class="sub">Signed in as <b>${esc(me.username)}</b> — choose a password to continue.</p>
     <form id="f">
       ${me.mustChange ? '' : '<label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password" required>'}
       <label for="p">New password</label>
       <input id="p" type="password" autocomplete="new-password" autofocus required>
       <label for="c">Confirm password</label>
       <input id="c" type="password" autocomplete="new-password" required>
       <button id="b" type="submit">Save password</button>
     </form>
     <div class="err" id="e"></div>
     <p class="hint">At least 8 characters. Other devices signed in as you will be signed out.</p>`,
    `var f=document.getElementById("f"),b=document.getElementById("b"),e=document.getElementById("e");
     f.addEventListener("submit",async function(ev){ev.preventDefault();e.className="err";b.disabled=true;b.textContent="Saving…";
       try{
         var r=await fetch("/change-password",{method:"POST",headers:{"content-type":"application/json"},
           body:JSON.stringify({current:(document.getElementById("cur")||{}).value||"",password:document.getElementById("p").value,confirm:document.getElementById("c").value})});
         var d=await r.json();
         if(d.ok){location.href="/";return;}
         e.textContent=d.error||"Could not save.";e.className="err on";
       }catch(err){e.textContent="Network error — please try again.";e.className="err on";}
       b.disabled=false;b.textContent="Save password";});`,
  );
}

// --- QR linking page (at /qr) ---
function qrPage(): string {
  const body = qrDataUrl
    ? `<img src="${qrDataUrl}" width="320" height="320" alt="WhatsApp QR code"/>`
    : status === 'connected'
      ? `<p class="ok">Connected — <a href="/">dashboard</a> · <a href="/match">order matching</a>.</p>`
      : `<p class="muted">Preparing QR… this page refreshes automatically.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Link WhatsApp</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;text-align:center;color:#111;padding:0 16px}img{border:1px solid #eee;border-radius:12px;padding:12px}.ok{color:#0a7d33;font-size:18px}.muted{color:#666}.s{margin-top:16px;color:#666;font-size:14px}</style></head><body><h2>Link WhatsApp (read-only)</h2>${body}<p class="s">On the phone: WhatsApp → Linked devices → Link a device</p></body></html>`;
}

// --- User administration (at /admin, admins only) ---
function adminPage(me: User): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>User Management · WhatsApp OMS</title>
<style>
  :root{color-scheme:light;--bg:#f0f2f5;--panel:#fff;--line:#e5e7eb;--tx:#111b21;--mut:#667781;
    --em:#10b981;--em2:#059669;--blue:#2563eb;--red:#dc2626;--amber:#d97706}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
  header{display:flex;align-items:center;gap:12px;padding:13px 20px;background:var(--panel);
    border-bottom:1px solid var(--line);box-shadow:0 1px 3px #0000001a;position:sticky;top:0;z-index:5}
  header h1{font-size:15px;margin:0;font-weight:700}
  .spacer{flex:1}
  ${NAV_CSS}
  .navlink:hover{text-decoration:underline}
  .who{font-size:12px;color:var(--mut)}
  .wrap{max-width:960px;margin:0 auto;padding:22px 18px 60px}
  .bar{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .bar h2{font-size:14px;margin:0;font-weight:700}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px #0000000f;overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:middle}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);font-weight:700;background:#fafbfc}
  tr:last-child td{border-bottom:0}
  .pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px}
  .pill.admin{background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe}
  .pill.user{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}
  .pill.on{background:#eafaf0;color:var(--em2);border:1px solid #a7f3d0}
  .pill.off{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
  .btn{border:0;border-radius:8px;padding:7px 13px;font-size:12.5px;font-weight:600;cursor:pointer;
    transition:filter .15s;color:#fff;background:var(--em)}
  .btn:hover{filter:brightness(1.07)}
  .btn.ghost{background:#0000;border:1px solid var(--line);color:var(--mut)}
  .btn.ghost:hover{border-color:var(--blue);color:var(--blue);filter:none}
  .btn.danger{background:#0000;border:1px solid #fecaca;color:var(--red)}
  .btn.danger:hover{background:#fef2f2;filter:none}
  .btn:disabled{opacity:.45;cursor:default;filter:none}
  .acts{display:flex;gap:6px;justify-content:flex-end}
  .muted{color:var(--mut);font-size:12px}
  .modal{position:fixed;inset:0;background:#0006;display:none;align-items:center;justify-content:center;padding:20px;z-index:20}
  .modal.on{display:flex}
  .sheet{background:#fff;border-radius:14px;padding:24px;width:100%;max-width:420px;box-shadow:0 12px 40px #00000026}
  .sheet h3{margin:0 0 4px;font-size:16px}
  .sheet .sub{color:var(--mut);font-size:12.5px;margin:0 0 14px}
  label{display:block;font-size:12px;font-weight:600;color:var(--mut);margin:12px 0 5px}
  input,select{width:100%;padding:9px 11px;font-size:13.5px;border:1px solid var(--line);border-radius:8px;
    background:#fff;color:var(--tx);outline:none}
  input:focus,select:focus{border-color:var(--em2)}
  .row2{display:flex;gap:10px}.row2>div{flex:1}
  .sheetacts{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
  .err{display:none;margin-top:12px;padding:9px 11px;background:#fef2f2;border:1px solid #fecaca;
    color:#b91c1c;border-radius:8px;font-size:12.5px}
  .err.on{display:block}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(70px);background:#111b21;
    color:#fff;padding:10px 18px;border-radius:9px;font-size:13px;opacity:0;transition:all .25s;z-index:30}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast.err{background:var(--red)}
</style></head><body>
<header><h1>User Management</h1><span class="who">signed in as <b>${esc(me.username)}</b></span>
  <div class="spacer"></div>
  ${navHtml(me, '/admin')}</header>
<div class="wrap">
  <div class="bar"><h2>Users</h2><span class="muted" id="count"></span><div class="spacer"></div>
    <button class="btn" id="addbtn">+ Add user</button></div>
  <div class="card"><table><thead><tr>
    <th>Username</th><th>Name</th><th>Email</th><th style="width:96px">Role</th><th style="width:96px">Status</th>
    <th style="width:150px">Last sign-in</th><th style="width:270px"></th>
  </tr></thead><tbody id="tb"></tbody></table></div>
  <p class="muted" style="margin-top:14px">New users must set their own password at first sign-in. Disabling a user
    immediately signs them out everywhere. Signing in from a new browser emails the user a 6-digit code —
    a user without an email address skips that check, so fill emails in. <b>Reset&nbsp;2FA</b> makes every
    browser ask for a code again (use it when a device is lost).</p>
</div>

<div class="modal" id="modal"><div class="sheet">
  <h3 id="mTitle">Add user</h3><p class="sub" id="mSub">They will set a new password at first sign-in.</p>
  <div id="mFields">
    <div id="wrapUser"><label for="fUser">Username</label><input id="fUser" autocomplete="off" placeholder="e.g. dhaval"></div>
    <label for="fName">Full name</label><input id="fName" autocomplete="off" placeholder="e.g. Dhaval Patel">
    <label for="fEmail">Email <span style="font-weight:400">(for sign-in verification codes)</span></label>
    <input id="fEmail" type="email" autocomplete="off" placeholder="e.g. dhaval@company.com">
    <div class="row2">
      <div><label for="fRole">Role</label><select id="fRole"><option value="user">User</option><option value="admin">Admin</option></select></div>
      <div id="wrapActive"><label for="fActive">Status</label><select id="fActive"><option value="1">Active</option><option value="0">Disabled</option></select></div>
    </div>
    <label for="fPass" id="lPass">Password</label><input id="fPass" type="password" autocomplete="new-password" placeholder="at least 8 characters">
  </div>
  <div class="err" id="mErr"></div>
  <div class="sheetacts"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mSave">Save</button></div>
</div></div>
<div class="toast" id="toast"></div>
<script>
var users=[],meId=${me.id},editId=null;
function omsLogout(){fetch("/logout",{method:"POST"}).then(function(){location.href="/login";}).catch(function(){location.href="/login";});}
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function toast(m,bad){var t=el("toast");t.textContent=m;t.className="toast on"+(bad?" err":"");setTimeout(function(){t.className="toast"+(bad?" err":"");},2600);}
function when(ts){if(!ts)return '<span class="muted">never</span>';var d=new Date(ts);return d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});}
async function post(url,body){var r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return r.json();}
async function load(){var d=await(await fetch("/api/users")).json();users=d.users||[];meId=d.meId;render();}
function render(){
  el("count").textContent=users.length+" user"+(users.length===1?"":"s");
  el("tb").innerHTML=users.map(function(u){
    var self=u.id===meId;
    return '<tr><td><b>'+esc(u.username)+'</b>'+(self?' <span class="muted">(you)</span>':'')+'</td>'+
      '<td>'+esc(u.name||"—")+'</td>'+
      '<td>'+(u.email?esc(u.email):'<span class="pill off" title="No email — this user signs in WITHOUT a verification code. Add one.">no 2FA</span>')+'</td>'+
      '<td><span class="pill '+(u.role==="admin"?"admin":"user")+'">'+(u.role==="admin"?"Admin":"User")+'</span></td>'+
      '<td><span class="pill '+(u.active?"on":"off")+'">'+(u.active?"Active":"Disabled")+'</span></td>'+
      '<td class="muted">'+when(u.lastLogin)+'</td>'+
      '<td><div class="acts">'+
        '<button class="btn ghost" data-edit="'+u.id+'">Edit</button>'+
        '<button class="btn ghost" data-reset="'+u.id+'" title="Every browser must enter an emailed code at next sign-in">Reset 2FA</button>'+
        '<button class="btn danger" data-del="'+u.id+'"'+(self?" disabled":"")+'>Delete</button>'+
      '</div></td></tr>';
  }).join("");
}
function openAdd(){editId=null;el("mTitle").textContent="Add user";el("mSub").textContent="They will set their own password at first sign-in.";
  el("wrapUser").style.display="";el("wrapActive").style.display="none";el("lPass").textContent="Temporary password";
  el("fUser").value="";el("fName").value="";el("fEmail").value="";el("fRole").value="user";el("fPass").value="";el("fPass").placeholder="at least 8 characters";
  el("mErr").className="err";el("modal").className="modal on";el("fUser").focus();}
function openEdit(id){var u=users.filter(function(x){return x.id===id;})[0];if(!u)return;editId=id;
  el("mTitle").textContent="Edit "+u.username;el("mSub").textContent="Leave the password blank to keep it unchanged.";
  el("wrapUser").style.display="none";el("wrapActive").style.display="";el("lPass").textContent="New password (optional)";
  el("fName").value=u.name||"";el("fEmail").value=u.email||"";el("fRole").value=u.role;el("fActive").value=u.active?"1":"0";
  el("fPass").value="";el("fPass").placeholder="leave blank to keep current";
  el("mErr").className="err";el("modal").className="modal on";el("fName").focus();}
function closeModal(){el("modal").className="modal";}
async function save(){
  var err=el("mErr"),btn=el("mSave");err.className="err";btn.disabled=true;btn.textContent="Saving…";
  var d;
  if(editId===null){
    d=await post("/api/users/add",{username:el("fUser").value,name:el("fName").value,email:el("fEmail").value,role:el("fRole").value,password:el("fPass").value});
  }else{
    var body={id:editId,name:el("fName").value,email:el("fEmail").value,role:el("fRole").value,active:el("fActive").value==="1"};
    if(el("fPass").value)body.password=el("fPass").value;
    d=await post("/api/users/edit",body);
  }
  btn.disabled=false;btn.textContent="Save";
  if(d.ok){users=d.users||users;render();closeModal();toast(editId===null?"User added":"User updated");}
  else{err.textContent=d.error||"Could not save.";err.className="err on";}
}
async function del(id){var u=users.filter(function(x){return x.id===id;})[0];if(!u)return;
  if(!window.confirm("Delete user \\""+u.username+"\\"? This cannot be undone."))return;
  var d=await post("/api/users/delete",{id:id});
  if(d.ok){users=d.users||[];render();toast("User deleted");}else{toast(d.error||"Delete failed",true);}}
el("addbtn").addEventListener("click",openAdd);
el("mCancel").addEventListener("click",closeModal);
el("mSave").addEventListener("click",save);
el("modal").addEventListener("click",function(e){if(e.target===el("modal"))closeModal();});
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeModal();});
async function resetDevices(id){var u=users.filter(function(x){return x.id===id;})[0];if(!u)return;
  if(!window.confirm("Reset 2FA for \\""+u.username+"\\"? Every browser they use will ask for an emailed code at the next sign-in."))return;
  var d=await post("/api/users/reset-devices",{id:id});
  if(d.ok){users=d.users||users;render();toast("2FA reset — "+(d.devices||0)+" device(s) forgotten");}else{toast(d.error||"Reset failed",true);}}
el("tb").addEventListener("click",function(e){
  var ed=e.target.closest("[data-edit]");if(ed){openEdit(+ed.dataset.edit);return;}
  var rs=e.target.closest("[data-reset]");if(rs){resetDevices(+rs.dataset.reset);return;}
  var dl=e.target.closest("[data-del]");if(dl&&!dl.disabled){del(+dl.dataset.del);return;}});
el("mFields").addEventListener("keydown",function(e){if(e.key==="Enter")save();});
load();
</script></body></html>`;
}

// --- Settings (admin-only): email sending + notification switches ---
function settingsPage(me: User): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings · WhatsApp OMS</title>
<style>
  :root{color-scheme:light;--bg:#f0f2f5;--panel:#fff;--line:#e5e7eb;--tx:#111b21;--mut:#667781;--em:#10b981;--em2:#059669;--blue:#2563eb;--red:#dc2626}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);font-size:14px}
  header{display:flex;align-items:center;gap:12px;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 18px;position:sticky;top:0;z-index:5}
  header h1{font-size:15.5px;margin:0}
  .who{color:var(--mut);font-size:12.5px}.spacer{flex:1}
  ${NAV_CSS}
  .wrap{max-width:640px;margin:22px auto;padding:0 16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:16px}
  .card h2{font-size:14.5px;margin:0 0 4px}
  .card .sub{color:var(--mut);font-size:12.5px;margin:0 0 14px}
  label{display:block;font-size:12px;font-weight:600;color:var(--mut);margin:12px 0 5px}
  input,select{width:100%;padding:9px 11px;font-size:13.5px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--tx);outline:none}
  input:focus,select:focus{border-color:var(--em2)}
  .row2{display:flex;gap:10px}.row2>div{flex:1}
  .prov{display:flex;gap:10px;margin-top:4px}
  .prov label{flex:1;display:flex;align-items:center;gap:9px;margin:0;padding:11px 13px;border:1.5px solid var(--line);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;color:var(--tx)}
  .prov label.on{border-color:var(--em2);background:#e7f8f2}
  .prov input{width:auto}
  .switch{display:flex;align-items:center;gap:12px;justify-content:space-between}
  .switch .txt{font-size:13.5px}
  .switch .txt small{display:block;color:var(--mut);font-size:12px;margin-top:2px}
  .tgl{position:relative;width:44px;height:24px;flex:none}
  .tgl input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:2}
  .tgl .tr{position:absolute;inset:0;background:#cbd5e1;border-radius:12px;transition:background .15s}
  .tgl .th{position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;box-shadow:0 1px 3px #0003;transition:left .15s}
  .tgl input:checked ~ .tr{background:var(--em)}
  .tgl input:checked ~ .th{left:22px}
  .acts{display:flex;gap:10px;align-items:center;margin-top:6px}
  .btn{padding:9px 18px;font-size:13px;font-weight:600;border-radius:8px;border:1px solid var(--em2);background:var(--em);color:#fff;cursor:pointer}
  .btn.ghost{background:#fff;color:var(--tx);border-color:var(--line)}
  .btn:disabled{opacity:.6;cursor:default}
  .sender{font-size:12.5px;color:var(--mut)}
  .sender b{color:var(--em2)}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(70px);background:#111b21;color:#fff;padding:10px 18px;border-radius:9px;font-size:13px;opacity:0;transition:all .25s;z-index:30}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast.bad{background:var(--red)}
  .hint{font-size:11.5px;color:var(--mut);margin-top:4px}
</style></head><body>
<header><h1>Settings</h1><span class="who">signed in as <b>${esc(me.username)}</b></span><div class="spacer"></div>
  ${navHtml(me, '/settings')}</header>
<div class="wrap">
  <div class="card">
    <h2>Email sending</h2>
    <p class="sub">Used for sign-in verification codes, new-user welcome emails and alerts.
      Currently sending as <span class="sender" id="senderline"><b>…</b></span></p>
    <div class="prov" id="prov">
      <label id="lSmtp"><input type="radio" name="prov" value="smtp"> SMTP <span style="font-weight:400;color:var(--mut)">(Gmail, any mail server)</span></label>
      <label id="lMs"><input type="radio" name="prov" value="ms365"> Microsoft&nbsp;365 <span style="font-weight:400;color:var(--mut)">(Graph API)</span></label>
    </div>
    <div id="fSmtp">
      <div class="row2">
        <div><label for="sHost">SMTP server</label><input id="sHost" placeholder="smtp.gmail.com"></div>
        <div style="max-width:110px"><label for="sPort">Port</label><input id="sPort" inputmode="numeric" placeholder="587"></div>
      </div>
      <label for="sUser">Sign-in email (username)</label><input id="sUser" placeholder="e.g. ysddiexport@gmail.com">
      <label for="sPass">Password / app password</label><input id="sPass" type="password" autocomplete="new-password">
      <div class="hint" id="sPassHint"></div>
      <label for="sFrom">Send as (optional)</label><input id="sFrom" placeholder="leave empty to send as the sign-in email">
    </div>
    <div id="fMs" style="display:none">
      <label for="mTenant">Tenant ID</label><input id="mTenant" placeholder="00000000-0000-0000-0000-000000000000">
      <label for="mClient">Client ID (application ID)</label><input id="mClient" placeholder="00000000-0000-0000-0000-000000000000">
      <label for="mSecret">Client secret</label><input id="mSecret" type="password" autocomplete="new-password">
      <div class="hint" id="mSecretHint"></div>
      <label for="mSender">Send from mailbox</label><input id="mSender" placeholder="e.g. orders@ysps.shop">
      <div class="hint">Needs an Azure app registration with the <b>Mail.Send</b> application permission (admin consent granted).</div>
    </div>
  </div>
  <div class="card">
    <h2>Notifications</h2>
    <p class="sub">Emails the system sends on its own.</p>
    <div class="switch">
      <div class="txt">Email administrators when someone signs in from a new device
        <small>Sent after the person passes their verification code. Goes to every admin with an email address.</small></div>
      <span class="tgl"><input type="checkbox" id="swNewDev"><span class="tr"></span><span class="th"></span></span>
    </div>
  </div>
  <div class="acts">
    <button class="btn" id="save">Save settings</button>
    <button class="btn ghost" id="test">Send a test email to me</button>
    <span class="sender" id="saved"></span>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function el(id){return document.getElementById(id);}
function omsLogout(){fetch("/logout",{method:"POST"}).then(function(){location.href="/login";}).catch(function(){location.href="/login";});}
function toast(m,bad){var t=el("toast");t.textContent=m;t.className="toast on"+(bad?" bad":"");setTimeout(function(){t.className="toast"+(bad?" bad":"");},3200);}
function provider(){var r=document.querySelector('input[name="prov"]:checked');return r?r.value:"smtp";}
function syncProv(){var p=provider();el("fSmtp").style.display=p==="smtp"?"":"none";el("fMs").style.display=p==="ms365"?"":"none";
  el("lSmtp").className=p==="smtp"?"on":"";el("lMs").className=p==="ms365"?"on":"";}
document.querySelectorAll('input[name="prov"]').forEach(function(r){r.addEventListener("change",syncProv);});
async function load(){
  var d=await(await fetch("/api/settings")).json();
  document.querySelector('input[name="prov"][value="'+d.provider+'"]').checked=true;
  el("sHost").value=d.smtp.host||"";el("sPort").value=d.smtp.port||"";el("sUser").value=d.smtp.user||"";
  el("sPassHint").textContent=d.smtp.hasPass?"A password is saved. Leave empty to keep it.":"No password saved yet.";
  el("sFrom").value=d.from||"";
  el("mTenant").value=d.ms365.tenant||"";el("mClient").value=d.ms365.clientId||"";el("mSender").value=d.ms365.sender||"";
  el("mSecretHint").textContent=d.ms365.hasSecret?"A secret is saved. Leave empty to keep it.":"No secret saved yet.";
  el("swNewDev").checked=!!d.adminNewDevice;
  el("senderline").innerHTML="<b>"+(d.sender||"not configured")+"</b>";
  syncProv();
}
el("save").addEventListener("click",async function(){
  var b=el("save");b.disabled=true;b.textContent="Saving…";
  try{
    var d=await(await fetch("/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      provider:provider(),from:el("sFrom").value,
      smtpHost:el("sHost").value,smtpPort:el("sPort").value,smtpUser:el("sUser").value,smtpPass:el("sPass").value,
      ms365Tenant:el("mTenant").value,ms365ClientId:el("mClient").value,ms365ClientSecret:el("mSecret").value,ms365Sender:el("mSender").value,
      adminNewDevice:el("swNewDev").checked})})).json();
    if(d.ok){toast("Settings saved");el("sPass").value="";el("mSecret").value="";el("senderline").innerHTML="<b>"+(d.sender||"?")+"</b>";load();}
    else toast(d.error||"Could not save",true);
  }catch(e){toast("Network error",true);}
  b.disabled=false;b.textContent="Save settings";
});
el("test").addEventListener("click",async function(){
  var b=el("test");b.disabled=true;b.textContent="Sending…";
  try{
    var d=await(await fetch("/api/settings/test-mail",{method:"POST"})).json();
    toast(d.ok?("Test email sent to "+d.to):(d.error||"Send failed"),!d.ok);
  }catch(e){toast("Network error",true);}
  b.disabled=false;b.textContent="Send a test email to me";
});
load();
</script></body></html>`;
}

// --- Match report (all users): how products matched customer requirements, with export ---
function reportPage(me: User): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Match Report · WhatsApp OMS</title>
<style>
  :root{color-scheme:light;--bg:#f0f2f5;--panel:#fff;--line:#e5e7eb;--tx:#111b21;--mut:#667781;--em2:#059669;--blue:#2563eb}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);font-size:14px}
  header{display:flex;align-items:center;gap:12px;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 18px;position:sticky;top:0;z-index:5}
  header h1{font-size:15.5px;margin:0}
  .who{color:var(--mut);font-size:12.5px}.spacer{flex:1}
  ${NAV_CSS}
  .wrap{max-width:1080px;margin:20px auto;padding:0 16px}
  .bar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .bar input[type=text]{flex:1;min-width:220px;padding:9px 12px;font-size:13.5px;border:1px solid var(--line);border-radius:9px;outline:none}
  .bar input[type=date]{padding:8px 10px;font-size:13px;border:1px solid var(--line);border-radius:8px;outline:none}
  .bar input:focus{border-color:var(--em2)}
  .btn{padding:9px 16px;font-size:13px;font-weight:600;border-radius:8px;border:1px solid var(--em2);background:#10b981;color:#fff;cursor:pointer}
  .btn.ghost{background:#fff;color:var(--tx);border-color:var(--line)}
  .btn:disabled{opacity:.5;cursor:default}
  .muted{color:var(--mut);font-size:12.5px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:760px}
  th{background:#f8fafc;text-align:left;padding:9px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--mut);border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:8px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  tr:last-child td{border-bottom:0}
  .code{font-family:ui-monospace,Consolas,monospace;font-weight:700;color:var(--blue);white-space:nowrap}
  .times{background:#e7f8f2;border:1px solid #b7ebd9;color:var(--em2);border-radius:8px;padding:0 6px;font-size:11px;font-family:'Segoe UI',sans-serif}
  .lrn{background:#eef2f6;border:1px solid var(--line);color:#475569;border-radius:7px;padding:0 6px;font-size:10.5px;font-weight:700;white-space:nowrap}
  .delrn{border:0;background:none;color:#cbd5e1;cursor:pointer;font-size:11px;padding:1px 4px;border-radius:5px}
  .delrn:hover{color:#dc2626;background:#fef2f2}
  .ph{color:var(--mut);overflow-wrap:anywhere}
  tr.grp td{border-top:2px solid var(--line)}
  .empty{padding:22px;text-align:center;color:var(--mut)}
</style></head><body>
<header><h1>Match Report</h1><span class="who">signed in as <b>${esc(me.username)}</b></span><div class="spacer"></div>
  ${navHtml(me, '/report')}</header>
<div class="wrap">
  <div class="bar">
    <input type="text" id="q" placeholder="search SKU or description… (e.g. AC, NHC, coupling)" autocomplete="off">
    <input type="date" id="from" title="From date"><span class="muted">to</span><input type="date" id="to" title="To date">
    <button class="btn ghost" id="exportbtn" disabled>Export selected (0)</button>
  </div>
  <div class="bar"><span class="muted" id="count"></span></div>
  <div class="card"><div class="scroll"><table><thead><tr>
    <th style="width:34px"><input type="checkbox" id="all" title="Select every product shown"></th>
    <th style="width:130px">SKU</th><th style="width:26%">Our product</th><th>Customer wrote</th>
    <th style="width:50px">Qty</th><th style="width:110px">Date</th><th style="width:90px">Saved by</th><th style="width:100px">DDI #</th>
  </tr></thead><tbody id="tb"></tbody></table></div></div>
</div>
<script>
function el(id){return document.getElementById(id);}
function omsLogout(){fetch("/logout",{method:"POST"}).then(function(){location.href="/login";}).catch(function(){location.href="/login";});}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function debounce(fn,ms){var t;return function(){var a=arguments,x=this;clearTimeout(t);t=setTimeout(function(){fn.apply(x,a);},ms);};}
var rows=[],groups={},gorder=[];
function when(ts){var d=new Date(ts);return d.toLocaleDateString([],{year:"2-digit",month:"short",day:"numeric"});}
function syncExport(){
  var picked=document.querySelectorAll(".pick:checked"),lines=0;
  picked.forEach(function(c){var g=groups[c.dataset.code];if(g)lines+=g.lines.length;});
  var b=el("exportbtn");b.disabled=!picked.length;
  b.textContent="Export selected ("+picked.length+" product"+(picked.length===1?"":"s")+", "+lines+" line"+(lines===1?"":"s")+")";
}
// GROUPED BY PRODUCT: a popular SKU that matched many different customer wordings shows ONCE,
// with every wording as a sub-row under it — not repeated down the page. Most-matched first.
// The date range is applied by the server, so a group only ever contains in-range lines.
function render(){
  groups={};gorder=[];
  rows.forEach(function(r){
    var k=r.code||"(no code)";
    if(!groups[k]){groups[k]={desc:r.description,lines:[]};gorder.push(k);}
    groups[k].lines.push(r);
  });
  gorder.sort(function(a,b){return groups[b].lines.length-groups[a].lines.length||(groups[b].lines[0].ts-groups[a].lines[0].ts);});
  var h="";
  gorder.forEach(function(k){
    var g=groups[k],n=g.lines.length;
    g.lines.forEach(function(l,j){
      h+='<tr'+(j===0?' class="grp"':'')+'>';
      if(j===0){
        h+='<td rowspan="'+n+'"><input type="checkbox" class="pick" data-code="'+esc(k)+'"></td>'
          +'<td rowspan="'+n+'" class="code">'+esc(k)+(n>1?' <span class="times">&times;'+n+'</span>':'')+'</td>'
          +'<td rowspan="'+n+'">'+esc(g.desc)+'</td>';
      }
      // 'learned' = a wording somebody taught by hand, never part of a saved order (the old
      // Aliases page). It has no qty/by/DDI, and it can be deleted right here if it was wrong.
      if(l.kind==="learned"){
        h+='<td class="ph">'+esc(l.phrase||"—")+' <span class="lrn" title="taught by hand — not from a saved order">learned</span>'
          +' <button class="delrn" data-norm="'+esc(l.norm||"")+'" data-code="'+esc(l.code)+'" title="Delete this learned wording">&#10005;</button></td>'
          +'<td class="muted">—</td><td class="muted">'+when(l.ts)+'</td><td class="muted">—</td><td class="muted">—</td></tr>';
      }else{
        h+='<td class="ph">'+esc(l.phrase||"—")+'</td><td>'+esc(l.qty)+'</td>'
          +'<td class="muted">'+when(l.ts)+'</td><td>'+esc(l.by||"—")+'</td><td>'+esc(l.orderNo||"—")+'</td></tr>';
      }
    });
  });
  el("tb").innerHTML=h||'<tr><td colspan="8" class="empty">No saved order lines match. Try a broader search or a wider date range.</td></tr>';
  el("all").checked=false;syncExport();
}
var loadSeq=0;
var load=debounce(async function(){
  var seq=++loadSeq; // a slower older response must never overwrite a newer search
  var q="q="+encodeURIComponent(el("q").value)+"&from="+el("from").value+"&to="+el("to").value;
  var d=await(await fetch("/api/report?"+q)).json();
  if(seq!==loadSeq)return;
  rows=d.rows||[];
  render();
  el("count").textContent=gorder.length+" product"+(gorder.length===1?"":"s")+" · "+d.total+" matched line"+(d.total===1?"":"s")+(d.total>rows.length?(" — showing the newest "+rows.length):"");
},250);
el("q").addEventListener("input",load);
el("from").addEventListener("change",load);
el("to").addEventListener("change",load);
el("all").addEventListener("change",function(){var on=this.checked;document.querySelectorAll(".pick").forEach?document.querySelectorAll(".pick").forEach(function(c){c.checked=on;}):null;syncExport();});
el("tb").addEventListener("change",function(e){if(e.target.classList.contains("pick"))syncExport();});
// Deleting a bad learned wording, straight from the report (this replaced the Aliases page).
el("tb").addEventListener("click",function(e){
  var b=e.target.closest(".delrn");if(!b)return;
  if(!window.confirm('Delete the learned wording? "'+(b.closest("td").textContent.replace(/learned.*$/,"").trim())+'" will no longer auto-match '+b.dataset.code+"."))return;
  fetch("/api/aliases/delete",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({norm:b.dataset.norm,code:b.dataset.code})}).then(function(r){return r.json();}).then(function(){load();}).catch(function(){});
});
// Export = a CSV of every line of the ticked PRODUCTS, straight from the browser.
el("exportbtn").addEventListener("click",function(){
  var picked=[];document.querySelectorAll(".pick:checked").forEach(function(c){var g=groups[c.dataset.code];if(g)picked=picked.concat(g.lines);});
  if(!picked.length)return;
  var NL=String.fromCharCode(10);
  var csvq=function(s){s=String(s==null?"":s);return '"'+s.replace(/"/g,'""')+'"';};
  var csv="SKU,Product,Customer wrote,Type,Qty,Date,Saved by,DDI order"+NL+picked.map(function(r){
    return [r.code,r.description,r.phrase,r.kind==="learned"?"Learned":"Order",r.qty,new Date(r.ts).toLocaleString(),r.by,r.orderNo].map(csvq).join(",");
  }).join(NL);
  var a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="match-report.csv";document.body.appendChild(a);a.click();a.remove();
});
load();
</script></body></html>`;
}

// --- Activity log (admin-only): who did what, when — the audit trail ---
function activityPage(me: User): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activity · WhatsApp OMS</title>
<style>
  :root{color-scheme:light;--bg:#f0f2f5;--panel:#fff;--line:#e5e7eb;--tx:#111b21;--mut:#667781;--em2:#059669;--red:#dc2626}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx);font-size:14px}
  header{display:flex;align-items:center;gap:12px;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 18px;position:sticky;top:0;z-index:5}
  header h1{font-size:15.5px;margin:0}
  .who{color:var(--mut);font-size:12.5px}.spacer{flex:1}
  ${NAV_CSS}
  .wrap{max-width:980px;margin:20px auto;padding:0 16px}
  .bar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .bar select{padding:8px 11px;font-size:13px;border:1px solid var(--line);border-radius:8px;background:#fff;outline:none}
  .muted{color:var(--mut);font-size:12.5px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#f8fafc;text-align:left;padding:9px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--mut);border-bottom:1px solid var(--line)}
  td{padding:8px 14px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  tr:last-child td{border-bottom:0}
  .act{display:inline-block;background:#eef2f6;border:1px solid var(--line);border-radius:7px;padding:1px 8px;font-size:11.5px;font-weight:700;color:#475569;white-space:nowrap}
  .act.warn{background:#fef2f2;border-color:#fecaca;color:#b91c1c}
  .detail{color:var(--mut);overflow-wrap:anywhere}
  .u{font-weight:700}
  .more{display:block;width:100%;border:0;background:#f8fafc;border-top:1px solid var(--line);padding:10px;font-size:12.5px;font-weight:600;color:var(--em2);cursor:pointer}
  .more:hover{background:#f1f5f9}
  .empty{padding:22px;text-align:center;color:var(--mut)}
</style></head><body>
<header><h1>User Activity</h1><span class="who">signed in as <b>${esc(me.username)}</b></span><div class="spacer"></div>
  ${navHtml(me, '/activity')}</header>
<div class="wrap">
  <div class="bar">
    <select id="fUser"><option value="">All users</option></select>
    <select id="fAction"><option value="">All actions</option></select>
    <input type="date" id="fFrom" title="From date" style="padding:7px 10px;font-size:13px;border:1px solid var(--line);border-radius:8px;outline:none">
    <span class="muted">to</span>
    <input type="date" id="fTo" title="To date" style="padding:7px 10px;font-size:13px;border:1px solid var(--line);border-radius:8px;outline:none">
    <span class="muted" id="count"></span>
  </div>
  <div class="card"><table><thead><tr>
    <th style="width:150px">When</th><th style="width:110px">User</th><th style="width:150px">Action</th><th>Details</th><th style="width:120px">IP</th>
  </tr></thead><tbody id="tb"></tbody></table><button class="more" id="more" style="display:none">Load older entries</button></div>
  <p class="muted" style="margin-top:12px">Sends, deletes, forwards, reactions, sign-ins (including failures), order saves, DDI numbers,
    taught aliases and ignores, user and settings changes — kept for 90 days. Reading chats is not logged.</p>
</div>
<script>
function el(id){return document.getElementById(id);}
function omsLogout(){fetch("/logout",{method:"POST"}).then(function(){location.href="/login";}).catch(function(){location.href="/login";});}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
var lastId=0,ACTIONS=["login","login-failed","login-new-device","logout","password-changed","send-message","send-file","forward","delete-message","react","star","unstar","pin","unpin","order-saved","ddi-number","teach-alias","teach-ignore","undo-ignore","rename-chat","user-add","user-edit","user-delete","reset-2fa","settings"];
function when(ts){var d=new Date(ts);return d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function rowHtml(r){
  var warn=r.action==="login-failed"||r.action==="delete-message"||r.action==="user-delete";
  return '<tr><td class="muted">'+when(r.ts)+'</td><td class="u">'+esc(r.username)+'</td>'+
    '<td><span class="act'+(warn?" warn":"")+'">'+esc(r.action)+'</span></td>'+
    '<td class="detail">'+esc(r.detail||"—")+'</td><td class="muted">'+esc(r.ip||"—")+'</td></tr>';
}
async function load(older){
  var q="limit=100&user="+encodeURIComponent(el("fUser").value)+"&action="+encodeURIComponent(el("fAction").value)
       +"&from="+el("fFrom").value+"&to="+el("fTo").value;
  if(older&&lastId)q+="&before="+lastId;
  var d=await(await fetch("/api/activity?"+q)).json();
  var rows=d.rows||[];
  if(!older){el("tb").innerHTML="";lastId=0;}
  if(rows.length)lastId=rows[rows.length-1].id;
  el("tb").insertAdjacentHTML("beforeend",rows.map(rowHtml).join("")||(older?"":'<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>'));
  el("count").textContent=d.total+" entr"+(d.total===1?"y":"ies");
  el("more").style.display=(rows.length===100)?"block":"none";
  // fill the user filter once
  if(el("fUser").options.length===1&&d.users)d.users.forEach(function(u){var o=document.createElement("option");o.value=u;o.textContent=u;el("fUser").appendChild(o);});
  if(el("fAction").options.length===1)ACTIONS.forEach(function(a){var o=document.createElement("option");o.value=a;o.textContent=a;el("fAction").appendChild(o);});
}
el("fUser").addEventListener("change",function(){load(false);});
el("fAction").addEventListener("change",function(){load(false);});
el("fFrom").addEventListener("change",function(){load(false);});
el("fTo").addEventListener("change",function(){load(false);});
el("more").addEventListener("click",function(){load(true);});
load(false);
</script></body></html>`;
}

// --- Kanban dashboard (at /) ---
function dashboardPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order Command Center</title>
<style>
  :root{color-scheme:light}*{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#111b21}
  header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#fff;z-index:2;box-shadow:0 1px 3px #0000001a}
  header h1{font-size:16px;margin:0;font-weight:700}
  .dot{width:9px;height:9px;border-radius:50%;background:#d97706;box-shadow:0 0 0 3px rgba(217,119,6,.15)}
  .dot.ok{background:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.15)}
  .conn{font-size:13px;color:#667781}.spacer{flex:1}.meta{font-size:12px;color:#667781}
  .navlink{color:#2563eb;text-decoration:none;font-size:13px;margin-left:14px;font-weight:600}
  .board{display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:14px;padding:16px;overflow-x:auto}
  .col{background:#fff;border:1px solid #e5e7eb;border-radius:12px;display:flex;flex-direction:column;min-height:120px;box-shadow:0 1px 2px #0000000f}
  .col h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;margin:0;padding:12px 14px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;color:#667781}
  .col h2 .n{background:#eef2f6;color:#475569;border-radius:10px;padding:0 8px;font-size:11px;line-height:18px}
  .col .items{padding:10px;display:flex;flex-direction:column;gap:10px}
  .card{background:#fff;border:1px solid #e5e7eb;border-left:3px solid var(--ac);border-radius:10px;padding:10px 12px;box-shadow:0 1px 2px #0000000f}
  .card .r1{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:#667781}
  .card .oid{font-family:ui-monospace,monospace}.card .cust{font-weight:600;margin:4px 0 2px;font-size:14px}
  .card .grp{font-size:11px;color:#667781;margin-bottom:6px}.card .txt{font-size:13px;color:#334155;line-height:1.35}
  .card .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
  .chip{background:#eef2f6;border:1px solid #e5e7eb;border-radius:6px;padding:1px 6px;font-size:11px;color:#475569}
  .card .foot{display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:#667781}
  .empty{color:#94a3b8;font-size:12px;text-align:center;padding:18px 0}a{color:#2563eb}
</style></head><body>
<header><div class="dot" id="dot"></div><h1>Order Command Center</h1><span class="conn" id="conn">connecting…</span><div class="spacer"></div><span class="meta" id="meta"></span><a class="navlink" href="/report">Report</a><a class="navlink" href="/match">Order Matching →</a></header>
<div class="board" id="board"></div>
<script>
const COLS=[["new","New Orders","#3b82f6"],["discussion","Discussion","#f59e0b"],["waiting_customer","Waiting Customer","#fb923c"],["waiting_warehouse","Waiting Warehouse","#a78bfa"],["finalized","Finalized","#22c55e"]];
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago=ts=>{if(!ts)return"";let s=Math.floor(Date.now()/1000)-ts;if(s<60)return s+"s";if(s<3600)return Math.floor(s/60)+"m";if(s<86400)return Math.floor(s/3600)+"h";return Math.floor(s/86400)+"d";};
const shortGrp=g=>String(g||"").replace(/@.*$/,"").slice(-10);
function card(o){const ac=(COLS.find(c=>c[0]===o.status)||["","","#334"])[2];const last=o.messages&&o.messages.length?o.messages[o.messages.length-1]:null;const preview=o.summary||(last&&(last.text||last.replyToText||("["+last.kind+"]")))||"";const chips=(o.items||[]).slice(0,6).map(i=>'<span class="chip">'+esc(((i.quantity?i.quantity+" ":"")+i.product))+'</span>').join("");return '<div class="card" style="--ac:'+ac+'"><div class="r1"><span class="oid">#'+esc((o.id||"").slice(0,8))+'</span><span>'+ago(o.updatedTs)+' ago</span></div><div class="cust">'+esc(o.customerName||"—")+'</div><div class="grp">'+esc(shortGrp(o.groupId))+(o.jobSite?" · "+esc(o.jobSite):"")+'</div>'+(preview?'<div class="txt">'+esc(preview)+'</div>':"")+(chips?'<div class="chips">'+chips+'</div>':"")+'<div class="foot"><span>'+(o.messages?o.messages.length:0)+' msg</span>'+(o.finalizedBy?'<span>✅ '+esc(o.finalizedBy)+'</span>':'')+'</div></div>';}
async function tick(){try{const d=await(await fetch("/api/orders")).json();const ok=d.status==="connected";document.getElementById("dot").className="dot"+(ok?" ok":"");document.getElementById("conn").textContent=ok?"connected":d.status+" — link at /qr";const orders=(d.orders||[]).sort((a,b)=>b.updatedTs-a.updatedTs);document.getElementById("meta").textContent=orders.length+" orders";document.getElementById("board").innerHTML=COLS.map(([k,label])=>{const list=orders.filter(o=>o.status===k);return '<div class="col"><h2>'+label+'<span class="n">'+list.length+'</span></h2><div class="items">'+(list.length?list.map(card).join(""):'<div class="empty">—</div>')+'</div></div>';}).join("");}catch(e){document.getElementById("conn").textContent="dashboard offline";}}
tick();setInterval(tick,4000);
</script></body></html>`;
}

// --- Order Matching page (at /match) ---
function matchPage(me: User): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Order Matching</title>
<style>
  :root{color-scheme:light;
    --bg:#f0f2f5;--panel:#ffffff;--card:#ffffff;--line:#e5e7eb;
    --em:#10b981;--em2:#059669;--emdim:#d1fae5;--blue:#2563eb;--amber:#d97706;--red:#dc2626;
    --tx:#111b21;--mut:#667781;--chatbg:#efeae2;--wa:#d9fdd3}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;flex-direction:column;font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--tx);overflow:hidden}
  ::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#00000026;border-radius:6px}::-webkit-scrollbar-thumb:hover{background:#0000003d}
  header{display:flex;align-items:center;gap:12px;padding:13px 20px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:0 1px 3px #0000001a}
  header h1{font-size:15px;margin:0;font-weight:700;letter-spacing:.2px}
  .spacer{flex:1}
  ${NAV_CSS}
  .muted{color:var(--mut);font-size:12px}
  /* Live-connection pill: green pulse when WhatsApp is linked, red when it needs a QR re-scan. */
  .live{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;padding:4px 11px;border-radius:20px;background:#eafaf0;color:var(--em2);border:1px solid #a7f3d0;white-space:nowrap}
  .live .ldot{width:7px;height:7px;border-radius:50%;background:var(--em);box-shadow:0 0 0 3px rgba(16,185,129,.18);animation:pulse 2s ease-in-out infinite}
  .live.off{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
  .live.off .ldot{background:var(--red);box-shadow:0 0 0 3px rgba(220,38,38,.15);animation:none}
  .live.warn{background:#fffbeb;color:#b45309;border-color:#fde68a}
  .live.warn .ldot{background:var(--amber);box-shadow:0 0 0 3px rgba(217,119,6,.15)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .user{font-size:12px;font-weight:600;color:var(--mut);padding-left:4px}
  /* Offline curtain: blurs and blocks the app whenever WhatsApp is not connected, so nobody
     types a reply into a dead connection or trusts a stale thread. */
  .offline{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
    padding:24px;background:rgba(240,242,245,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
  .offline.on{display:flex}
  .offbox{background:#fff;border:1px solid var(--line);border-radius:16px;padding:30px 34px;max-width:430px;
    text-align:center;box-shadow:0 18px 50px #00000026}
  .officon{font-size:38px;line-height:1;margin-bottom:12px}
  .offbox h2{margin:0 0 8px;font-size:18px;font-weight:700}
  .offbox p{margin:0;font-size:14px;line-height:1.6;color:var(--mut)}
  .offnote{margin-top:14px;font-size:12.5px;color:var(--mut);background:var(--bg);border:1px solid var(--line);
    border-radius:9px;padding:9px 12px;line-height:1.55;display:none}
  .offnote.on{display:block}
  .offbox.bad{border-color:#fecaca}
  @keyframes tick{0%,100%{transform:rotate(0)}50%{transform:rotate(12deg)}}
  .officon.wait{animation:tick 1.6s ease-in-out infinite}
  /* Columns: chat list fixed, order panel bounded, and the THREAD takes whatever is left.
     (Previously .left was 40% while containing a fixed 262px list, so the thread — the main
     content — collapsed to ~190px and messages wrapped at about 12 characters.) */
  .wrap{flex:1;display:flex;min-height:0}
  .left{flex:1;min-width:0;border-right:1px solid var(--line);display:flex;min-height:0}
  .chatcol{width:248px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;flex-shrink:0;min-height:0}
  .chatsearch{margin:10px;padding:9px 11px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:9px;font-size:13px;outline:none;transition:border-color .15s}
  .chatsearch:focus{border-color:var(--blue)}
  .chatlist{flex:1;overflow-y:auto;padding:0 6px 6px}
  .more{padding:8px 12px;color:var(--mut);font-size:12px;text-align:center}
  .chatrow{padding:10px 11px;border-radius:9px;cursor:pointer;margin-top:3px;transition:background .12s}
  .chatrow:hover{background:#f5f6f6}.chatrow.active{background:#f0f2f5;box-shadow:inset 0 0 0 1px #d1d7db}
  .chatrow .t{font-weight:600;font-size:13px;display:flex;justify-content:space-between;gap:6px}
  .chatrow .p{font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  /* WhatsApp-Web unread badge: white count on WhatsApp green, circular until it needs to widen. */
  .badge{background:#25d366;color:#fff;border-radius:10px;min-width:19px;height:19px;padding:0 5px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0}
  .chatrow.un .t{font-weight:700}
  .chatrow.un .p{color:var(--tx);font-weight:500}
  .learned{background:var(--emdim);color:var(--em2);border:1px solid #a7f3d0;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:6px}
  /* Matched by similarity rather than an exact code or a learned alias — worth a glance. */
  .guess{background:#fffbeb;color:#b45309;border:1px solid #fde68a;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:6px;font-weight:600}
  .row.guessed{border-left-color:var(--amber)}
  .thread{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--chatbg)}
  .threadhead{padding:9px 16px;background:#f0f2f5;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
  .threadhead .tt{font-weight:600;font-size:15px;color:var(--tx)}
  .btn{background:var(--blue);color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:filter .15s,transform .05s,border-color .15s,color .15s;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:default;filter:none}
  .btn.green{background:var(--em)}
  .btn.ghost{background:#0000;border:1px solid var(--line);color:var(--mut)}.btn.ghost:hover{border-color:var(--blue);color:var(--blue);filter:none}
  .iconbtn{width:34px;height:34px;padding:0;justify-content:center;font-size:13px}
  /* Centre the conversation and cap its width so a wide screen does not leave a band of empty
     wallpaper. Done with padding, not align-self, so the left/right bubble alignment still works. */
  .msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:0;background:var(--chatbg);
    padding:12px max(22px,calc((100% - 780px)/2)) 22px}
  .daysep{align-self:center;margin:14px 0 8px}
  .daysep span{background:#fff;color:#54656f;font-size:12.5px;font-weight:500;padding:5px 12px;border-radius:8px;box-shadow:0 1px .5px rgba(11,20,26,.13)}
  .bubble{position:relative;max-width:min(74%,540px);min-width:96px;padding:6px 9px 8px;border-radius:7.5px;font-size:14.2px;line-height:19px;box-shadow:0 1px .5px rgba(11,20,26,.13);margin-top:8px}
  .bubble.grp{margin-top:2px}
  .in{align-self:flex-start;background:#fff;border-top-left-radius:0}
  .out{align-self:flex-end;background:var(--wa);border-top-right-radius:0}
  .bubble.grp.in{border-top-left-radius:7.5px}.bubble.grp.out{border-top-right-radius:7.5px}
  .in:not(.grp)::before{content:"";position:absolute;top:0;left:-8px;border-top:8px solid #fff;border-left:8px solid transparent}
  .out:not(.grp)::before{content:"";position:absolute;top:0;right:-8px;border-top:8px solid var(--wa);border-right:8px solid transparent}
  .who{font-size:12.8px;font-weight:600;margin-bottom:2px;line-height:1.2}
  .tx{white-space:pre-wrap;word-break:break-word}
  /* Per-line rendering of extractable messages. The number gutter stays invisible until the
     message is extracted — then each line shows the number its order rows refer to. */
  .ml{display:flex;align-items:baseline;gap:6px}
  .mln{display:none;flex:none;min-width:16px;text-align:right;color:var(--mut);font-size:10px;font-variant-numeric:tabular-nums;user-select:none}
  .mlt{min-width:0;flex:1}
  .bubble.ext .mln,.bubble.done .mln{display:inline-block}
  /* While an extraction is OPEN, message lines whose products are all matched turn the same light
     green as their rows — staff skip them and go straight to what still needs work. Scoped to
     .ext on purpose: Copy or Clear drops that class and the bubble goes back to normal. */
  .bubble.ext .ml.mlok{background:#d1efd7;border-radius:5px;padding:0 4px;margin:0 -4px}
  .bubble.ext .ml.mlok .mln{color:var(--em2);font-weight:700}
  /* Media in the thread. Fetched lazily, so a chat with hundreds of photos stays fast. */
  .mediaimg{display:block;margin:0 0 3px}
  .mediaimg img{display:block;max-width:100%;max-height:320px;border-radius:6px;background:#00000008}
  .mediaaud{display:block;width:min(260px,100%);height:38px;margin:2px 0 3px}
  .mediavid{display:block;max-width:100%;max-height:320px;border-radius:6px;margin-bottom:3px;background:#000}
  .mediadoc{display:inline-block;margin-bottom:3px;padding:7px 11px;background:rgba(0,0,0,.05);
    border-radius:7px;color:var(--tx);text-decoration:none;font-size:13px}
  .mediadoc:hover{background:rgba(0,0,0,.08)}
  .medianote{font-size:12px;color:var(--mut);font-style:italic;padding:3px 0}
  .tx.del{color:var(--mut);font-style:italic}
  /* WhatsApp-style message menu: right-click on desktop, long-press on phones. */
  .ctxmenu{position:fixed;z-index:60;background:#fff;border:1px solid var(--line);border-radius:10px;
    box-shadow:0 8px 28px #00000022;min-width:168px;padding:5px 0;display:none}
  .ctxmenu.on{display:block}
  .ctxmenu button{display:block;width:100%;text-align:left;background:none;border:0;padding:9px 16px;
    font-size:13.5px;color:var(--tx);cursor:pointer;font-family:inherit}
  .ctxmenu button:hover{background:var(--bg)}
  .ctxmenu button.danger{color:var(--red)}
  .ctxmenu .sep{height:1px;background:var(--line);margin:4px 0}
  /* "Replying to" bar above the composer. */
  .replybar{display:none;align-items:center;gap:8px;background:var(--panel);border-top:1px solid var(--line);
    padding:7px 12px}
  .replybar.on{display:flex}
  .replybar .rq{flex:1;min-width:0;border-left:3px solid var(--em);padding:3px 9px;background:var(--bg);border-radius:6px}
  .replybar .rqn{font-size:11.5px;font-weight:700;color:var(--em2)}
  .replybar .rqt{font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .replybar .rx{flex:none;background:none;border:0;color:var(--mut);font-size:17px;cursor:pointer;padding:4px 8px}
  /* Forward picker + delete confirm reuse one modal shell. */
  .mmodal{position:fixed;inset:0;background:#0006;display:none;align-items:center;justify-content:center;padding:20px;z-index:70}
  .mmodal.on{display:flex}
  .msheet{background:#fff;border-radius:14px;padding:20px;width:100%;max-width:400px;box-shadow:0 12px 40px #00000026}
  .msheet h3{margin:0 0 12px;font-size:15.5px}
  .fwdlist{max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:9px;margin-top:8px}
  .fwdlist button{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);
    padding:10px 12px;font-size:13px;color:var(--tx);cursor:pointer;font-family:inherit}
  .fwdlist button:last-child{border-bottom:0}
  .fwdlist button:hover{background:var(--bg)}
  .fwdsearch{width:100%;padding:8px 11px;font-size:13px;border:1px solid var(--line);border-radius:8px;outline:none}
  .fwdsearch:focus{border-color:var(--blue)}
  .macts{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .macts .btn.red{background:var(--red);color:#fff;border-color:var(--red)}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(70px);background:#111b21;
    color:#fff;padding:10px 18px;border-radius:9px;font-size:13px;opacity:0;transition:all .25s;z-index:80;pointer-events:none}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast.bad{background:var(--red)}
  .toast.act{pointer-events:auto;cursor:pointer}
  /* The ⌄ that opens the message menu. Hidden until hover on mouse devices, always shown where
     there is no hover — before this, nothing on screen said the menu existed at all. */
  .mbtn{position:absolute;top:2px;right:3px;z-index:2;width:22px;height:20px;border:0;border-radius:6px;
    background:inherit;color:var(--mut);font-size:14px;line-height:18px;cursor:pointer;opacity:0;
    transition:opacity .12s;box-shadow:-6px 0 8px -2px inherit}
  .bubble:hover .mbtn,.mbtn:focus{opacity:1}
  @media (hover:none){.mbtn{opacity:.55}}
  .starred{color:#f59e0b;margin-right:4px;font-size:11px}
  /* Pinned-message bar above the thread, like WhatsApp's. Click scrolls to the message. */
  .pinbar{display:none;align-items:center;gap:8px;background:var(--panel);border-bottom:1px solid var(--line);
    padding:6px 12px;cursor:pointer;min-width:0}
  .pinbar.on{display:flex}
  .pinbar .pico{flex:none;color:var(--em2);font-size:13px}
  .pinbar .ptxt{flex:1;min-width:0;font-size:12.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pinbar .ptxt b{color:var(--tx);font-weight:600}
  .bubble.flash{outline:2px solid var(--em);outline-offset:2px;transition:outline-color 1s}
  /* @mention: WhatsApp renders these as non-clickable coloured text (read-only here by design). */
  .mn{color:#027eb5;font-weight:500}
  /* Quoted reply block, shown above the text inside the same bubble (WhatsApp layout). */
  .q{display:flex;background:rgba(0,0,0,.055);border-radius:6px;overflow:hidden;margin-bottom:4px}
  .q[data-goto]{cursor:pointer}
  .q[data-goto]:hover{background:rgba(0,0,0,.09)}
  .out .q{background:rgba(0,0,0,.05)}
  .q .qbar{width:4px;background:#06cf9c;flex-shrink:0}
  .q .qin{padding:5px 9px;min-width:0;flex:1}
  .qn{font-size:12.5px;font-weight:600;color:#06cf9c;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .qt{font-size:13px;line-height:18px;color:rgba(11,20,26,.6);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
  .qm{font-style:italic;opacity:.85}
  /* "Sent by <user>" — marks a message as sent from this app rather than typed in WhatsApp. */
  .sentby{display:inline-block;margin-top:6px;font-size:11px;letter-spacing:.2px;
    color:#3f6b57;background:#eafaf0;border:1px solid #a7f3d0;border-radius:20px;
    padding:3px 11px;line-height:1.45}
  .sentby b{color:var(--em2);font-weight:700}
  /* Composer — the only write surface in the app; one message per explicit send. */
  .composer{display:flex;align-items:flex-end;gap:9px;padding:9px 14px;background:#f0f2f5;border-top:1px solid var(--line)}
  .composer textarea{flex:1;resize:none;max-height:120px;padding:9px 13px;font:inherit;font-size:14px;line-height:20px;
    border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--tx);outline:none;transition:border-color .15s}
  .composer textarea:focus{border-color:var(--em2)}
  .composer textarea:disabled{background:#f6f7f8;color:var(--mut)}
  .attachbtn{width:36px;height:36px;flex-shrink:0;border:0;border-radius:50%;background:#0000;color:var(--mut);
    font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
  .attachbtn:hover:not(:disabled){background:#0000000d;color:var(--tx)}
  .attachbtn:disabled{opacity:.4;cursor:default}
  /* Chosen file, shown above the composer until it is sent or removed. */
  .filechip{display:none;align-items:center;gap:9px;margin:0 14px 6px;padding:7px 11px;background:var(--panel);
    border:1px solid var(--line);border-radius:9px;font-size:12.5px;color:var(--tx)}
  .filechip.on{display:flex}
  .filechip img{width:34px;height:34px;object-fit:cover;border-radius:6px;flex-shrink:0}
  .filechip .fname{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .filechip .fsize{color:var(--mut);margin-left:auto;white-space:nowrap}
  .filechip .fx{border:0;background:#0000;color:var(--mut);cursor:pointer;font-size:15px;padding:0 2px}
  .filechip .fx:hover{color:var(--red)}
  .sendbtn{width:40px;height:40px;flex-shrink:0;border:0;border-radius:50%;background:var(--em);color:#fff;
    font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:filter .15s,opacity .15s}
  .sendbtn:hover:not(:disabled){filter:brightness(1.08)}
  .sendbtn:disabled{opacity:.4;cursor:default}
  .sendwarn{padding:6px 14px;background:#fffbeb;border-top:1px solid #fde68a;color:#b45309;font-size:12px;display:none}
  .sendwarn.on{display:block}
  /* @mention autocomplete — sits above the composer like WhatsApp's participant picker. */
  .mentionbox{display:none;max-height:210px;overflow-y:auto;background:#fff;border-top:1px solid var(--line);
    box-shadow:0 -4px 14px #0000000f}
  .mentionbox.on{display:block}
  .mrow{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;font-size:14px}
  .mrow:hover,.mrow.sel{background:#f0f2f5}
  .mav{width:30px;height:30px;border-radius:50%;background:var(--em);color:#fff;display:flex;
    align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;text-transform:uppercase}
  .mnm{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mhint{padding:8px 14px;color:var(--mut);font-size:12px}
  .metarow{display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:1px}
  .meta{font-size:11px;color:rgba(11,20,26,.45);white-space:nowrap;user-select:none;line-height:1}
  .ck{margin-left:3px;color:#53bdeb}
  .react{position:absolute;bottom:-13px;background:#fff;border-radius:12px;padding:2px 6px;font-size:13px;box-shadow:0 1px 1.5px rgba(11,20,26,.16);display:inline-flex;align-items:center;line-height:1;white-space:nowrap}
  .in .react{left:10px}.out .react{right:10px}
  .rc{font-size:11px;color:#54656f;margin-left:2px;font-weight:500}
  .bubble.hasreact{margin-bottom:15px}
  .xable{cursor:pointer}
  .xable:hover{box-shadow:0 1px .5px rgba(11,20,26,.13),0 0 0 2px #2563eb55}
  .bubble.ext{box-shadow:0 0 0 2px var(--em),0 2px 9px rgba(16,185,129,.3)}
  .bubble.done{box-shadow:0 0 0 1.5px #8ce3b5}
  .sb{margin-right:auto;display:inline-block;font-size:10px;font-weight:700;border-radius:7px;padding:1px 6px;vertical-align:middle}
  .sb.e{background:var(--em);color:#04210f}.sb.d{background:var(--emdim);color:var(--em2);border:1px solid #a7f3d0}
  .xrow{margin-top:5px;display:none}
  .xable:hover .xrow,.bubble.ext .xrow,.bubble.busy .xrow{display:block}
  .xbtn{background:#eafaf0;border:1px solid #a7f3d0;color:var(--em2);font-size:11px;font-weight:600;border-radius:8px;padding:3px 11px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,color .15s}
  .xbtn:hover{background:#d1fae5;border-color:var(--em)}
  .xbtn.on{background:var(--em);border-color:var(--em);color:#04210f}
  .xbtn.done{background:#0000;border-color:var(--line);color:var(--mut)}.xbtn.done:hover{border-color:var(--em);color:var(--em2)}
  .xbtn:disabled{cursor:default;opacity:.85}
  .spin{width:11px;height:11px;border:2px solid #04210f44;border-top-color:#04210f;border-radius:50%;display:inline-block;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes flash{0%,100%{box-shadow:0 1px .5px rgba(11,20,26,.13)}30%{box-shadow:0 0 0 3px var(--em2),0 0 16px var(--em)}}
  .flash{animation:flash 1s ease}
  /* A little wider than before (the client's ask): full product + customer text must fit without
     cutting off; the conversation column gives up the difference. */
  .right{width:clamp(380px,37%,600px);flex-shrink:0;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:16px;background:var(--bg)}
  /* Narrow desktop / tablet: give the thread even more of the remaining width. */
  @media (max-width:1100px){
    .chatcol{width:240px}
    .right{width:clamp(300px,34%,420px)}
  }
  /* Phone: three side-by-side columns cannot work. The chat fills the screen and the order panel
     slides in over it from the right when a message is extracted — so you are never scrolling
     between two half-height panes on a small screen. */
  .panelclose{display:none}
  .backchat{display:none} /* phone-only: desktop shows both columns at once */
  @media (max-width:860px){
    header{flex-wrap:wrap;gap:8px 10px;padding:9px 12px}
    header h1{font-size:14px}
    .wrap{flex-direction:column;min-height:0}
    .left{flex:1;flex-direction:column;border-right:0;min-height:0}
    /* Two screens like WhatsApp: the chat list fills the phone, then the conversation replaces it.
       Showing a squashed list above a squashed thread made both unusable. */
    .chatcol{width:100%;max-height:none;flex:1;border-right:0;border-bottom:0}
    .thread{min-height:0;flex:1}
    body.inchat .chatcol{display:none}
    body:not(.inchat) .thread{display:none}
    .backchat{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;
      margin-right:2px;border:0;background:#0000;color:var(--blue);font-size:19px;cursor:pointer;flex-shrink:0}
    .bubble{max-width:88%}
    .msgs{padding:12px 12px 20px}
    /* the order panel becomes a full-screen sheet */
    .right{position:fixed;inset:0;z-index:40;width:100%;padding:14px 14px 26px;
      transform:translateX(100%);transition:transform .28s cubic-bezier(.22,.61,.36,1);
      box-shadow:-8px 0 26px #00000026;overscroll-behavior:contain}
    .right.open{transform:translateX(0)}
    .panelclose{display:flex;align-items:center;gap:7px;position:sticky;top:-14px;z-index:2;
      margin:-14px -14px 10px;padding:11px 14px;background:var(--panel);border-bottom:1px solid var(--line);
      font-size:13px;font-weight:600;color:var(--tx)}
    .panelclose button{border:0;background:#0000;color:var(--blue);font-size:14px;font-weight:700;
      cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:2px 0}
    .panelclose .hint{margin-left:auto;font-weight:400;font-size:11px;color:var(--mut)}
  }
  .sect h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin:0 0 8px;display:flex;align-items:baseline;gap:8px}
  .cnt{text-transform:none;letter-spacing:0;font-weight:600;color:var(--em2)}
  .row{border:1px solid var(--line);border-radius:9px;margin-bottom:5px;background:var(--panel);border-left:3px solid var(--line);transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 2px #0000000f;overflow:hidden}
  /* Matched rows get a light-green FILL, not just a colored edge: Yanky is colorblind and could
     not tell the green border from the amber one — a filled vs white row survives that. */
  .row.matched{border-left-color:var(--em);background:#e4f6e8}
  .row.resolved{border-left-color:var(--em);background:#e4f6e8}
  .row.unmatched{border-left-color:var(--amber)}
  .row.open{box-shadow:0 2px 8px #00000014}
  .row .top{display:flex;align-items:flex-start;gap:8px;padding:6px 9px;cursor:pointer}
  .row .top .qty,.row .top .lno,.row .top .exp{margin-top:1px}
  .addbtnrow{width:100%;border:1.5px dashed var(--line);background:none;border-radius:9px;color:var(--em2);font-weight:600;font-size:12.5px;padding:8px;cursor:pointer;margin-bottom:5px}
  .addbtnrow:hover{border-color:var(--em2);background:#f2fbf5}
  .ddirow{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
  .ddirow label{font-size:12px;font-weight:700;color:var(--mut);white-space:nowrap}
  .ddirow input{flex:1;min-width:0;padding:8px 10px;font-size:13px;border:1px solid var(--line);border-radius:8px;outline:none}
  .ddirow input:focus{border-color:var(--em2)}
  .ddirow.need label{color:var(--red)}
  .ddirow.need input{border-color:#fca5a5;background:#fffafa}
  /* Voice-note recording bar (replaces the composer while recording). */
  .recbar{display:none;align-items:center;gap:10px;background:var(--panel);border-top:1px solid var(--line);padding:9px 14px}
  .recbar.on{display:flex}
  .recdot{width:10px;height:10px;border-radius:50%;background:var(--red);animation:recblink 1s infinite}
  @keyframes recblink{50%{opacity:.25}}
  #rectime{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px}
  .micbtn-rec{color:var(--red)!important}
  /* Quick-react strip on top of the message menu, and the composer emoji panel. */
  .rstrip{display:flex;gap:1px;padding:5px 8px;border-bottom:1px solid var(--line)}
  .rstrip button{font-size:17px;background:none;border:0;cursor:pointer;padding:4px 6px;border-radius:7px;line-height:1;width:auto}
  .rstrip button:hover{background:var(--bg);transform:scale(1.15)}
  .epanel{display:none;background:var(--panel);border-top:1px solid var(--line);max-height:230px;overflow-y:auto}
  .epanel.on{display:block}
  .esearchwrap{position:sticky;top:0;background:var(--panel);padding:8px 12px 6px;z-index:2}
  #esearch{width:100%;padding:7px 11px;font-size:13px;border:1px solid var(--line);border-radius:8px;outline:none}
  #esearch:focus{border-color:var(--em2)}
  #egrid{display:grid;grid-template-columns:repeat(10,1fr);gap:2px;padding:2px 12px 10px}
  #egrid button{font-size:19px;background:none;border:0;cursor:pointer;padding:5px 0;border-radius:7px;line-height:1.2}
  #egrid button:hover{background:var(--bg)}
  .ehead{grid-column:1/-1;font-size:10px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;padding:6px 2px 2px}
  .enone{grid-column:1/-1;color:var(--mut);font-size:12.5px;padding:10px 2px}
  .row .top:hover{background:#f9fbfd}
  .qty{width:44px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:7px;padding:4px 3px;font-size:13px;font-weight:600;text-align:center;outline:none;flex-shrink:0}
  .qty:focus{border-color:var(--blue)}
  /* Line number tying an order row back to the message line it came from — "the first one and the
     third one" is exactly what the client could not see. Same numbers render down the message
     bubble once it is extracted. */
  .lno{flex:none;min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:9px;background:var(--bg);border:1px solid var(--line);color:var(--mut);font-size:10px;font-weight:600}
  .unitchip{background:#fef3c7;border:1px solid #fcd34d;color:#92400e;border-radius:7px;padding:0 5px;font-size:9.5px;font-weight:700;text-transform:uppercase}
  .matchip{background:#e0e7ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:7px;padding:0 5px;font-size:9.5px;font-weight:700;text-transform:uppercase}
  /* Template shape on every row: product line, then "Customer Require ->" on its OWN line.
     Nothing shares a line and nothing is cut off — long text wraps and the row grows. */
  .pinfo{flex:1;min-width:0}
  .pmain{min-width:0;font-size:13px;line-height:1.35;overflow-wrap:anywhere}
  .pmain.nopick{color:#b45309;font-style:italic}
  .cust{display:block;min-width:0;font-size:11px;color:var(--mut);margin-top:3px;line-height:1.35;overflow-wrap:anywhere}
  .creq{font-weight:700;color:#64748b;text-transform:uppercase;font-size:9.5px;letter-spacing:.4px}
  .addinline{flex:none;width:20px;height:20px;margin-top:1px;border:1px solid var(--line);border-radius:6px;background:#fff;
    color:var(--em2);font-size:14px;line-height:1;font-weight:700;cursor:pointer;padding:0}
  .addinline:hover{border-color:var(--em2);background:#f2fbf5}
  .rmrow{flex:none;width:20px;height:20px;margin-top:1px;border:1px solid var(--line);border-radius:6px;background:#fff;
    color:var(--mut);font-size:11px;line-height:1;font-weight:700;cursor:pointer;padding:0}
  .rmrow:hover{border-color:#fca5a5;background:#fef2f2;color:var(--red)}
  .cust b{color:var(--em2);font-weight:600}
  .code{color:var(--blue);font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;font-weight:600}
  .sep{color:var(--mut);margin:0 3px}
  .exp{color:var(--mut);font-size:11px;flex-shrink:0;transition:transform .2s,color .2s}
  .row.open .exp{transform:rotate(90deg);color:var(--blue)}
  .expand{max-height:0;opacity:0;overflow:hidden;transition:max-height .25s ease,opacity .25s ease}
  .expand.show{max-height:520px;opacity:1}
  .expand .inner{padding:0 12px 12px}
  .psearch{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;transition:border-color .15s}
  .psearch:focus{border-color:var(--blue)}
  /* Tall enough to be worth scrolling: a search for a code prefix can legitimately return
     hundreds of products and the old 220px showed about four of them. */
  .results{margin-top:8px;max-height:420px;overflow-y:auto;border:1px solid var(--line);border-radius:8px}
  .rescount{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);color:var(--mut);font-size:11px;padding:5px 10px;z-index:1}
  .opt{display:block;width:100%;text-align:left;background:#fff;border:0;border-bottom:1px solid var(--line);color:var(--tx);padding:8px 10px;font-size:12px;cursor:pointer}
  .opt:last-child{border-bottom:0}.opt:hover{background:#eef4fb}
  .opt .code{margin-right:2px}
  .noopt{padding:9px 10px;color:var(--mut);font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line)}
  th{color:var(--mut);font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .finalbox{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 2px 8px #0000001a}
  .finalbox .h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}
  .finalbox .h h2{font-size:14px;margin:0;font-weight:700}
  .rmfinal{border:0;background:none;color:var(--mut);cursor:pointer;font-size:14px;line-height:1;padding:3px 7px;border-radius:6px;transition:background .12s,color .12s}
  .rmfinal:hover{background:#fee2e2;color:#dc2626}
  .placeholder{color:var(--mut);text-align:center;padding:34px 16px;font-size:13px;line-height:1.6}
</style></head><body>
<header><h1>WhatsApp Order Matching</h1><span class="muted" id="catmeta"></span><div class="spacer"></div><span class="live" id="live" title="WhatsApp connection"><span class="ldot"></span><span id="livetx">connecting…</span></span><span class="user" title="${esc(me.name || me.username)}">${esc(me.username)}</span>${navHtml(me, '/')}</header>
<div class="offline" id="offline">
  <div class="offbox">
    <div class="officon" id="officon">⏳</div>
    <h2 id="offtitle">Connecting to WhatsApp…</h2>
    <p id="offmsg">Waiting for the WhatsApp connection. This usually takes a few seconds.</p>
    <div class="offnote" id="offnote"></div>
  </div>
</div>
<div class="wrap">
  <div class="left">
    <div class="chatcol"><input id="chatsearch" class="chatsearch" placeholder="search chats…" autocomplete="off"><div class="chatlist" id="chatlist"></div></div>
    <div class="thread">
      <div class="threadhead"><button class="backchat" id="tolist" title="All chats" aria-label="Back to all chats">&#8592;</button><span id="threadtitle" class="muted">Select a chat</span><button class="btn iconbtn ghost" id="renamebtn" disabled title="Rename this chat">&#9998;</button><div class="spacer"></div><span class="muted" id="navlabel" style="display:none">extracted</span><button class="btn iconbtn ghost" id="navprev" title="Previous extracted message">&#9650;</button><button class="btn iconbtn ghost" id="navnext" title="Next extracted message">&#9660;</button></div>
      <div class="pinbar" id="pinbar"></div>
      <div class="msgs" id="msgs"><div class="placeholder">Pick a conversation on the left.</div></div>
      <div class="mentionbox" id="mbox"></div>
      <div class="filechip" id="filechip"></div>
      <div class="replybar" id="replybar"><div class="rq"><div class="rqn" id="rqn"></div><div class="rqt" id="rqt"></div></div><button class="rx" id="rx" title="Cancel reply" aria-label="Cancel reply">&#10005;</button></div>
      <div class="recbar" id="recbar"><span class="recdot"></span><span id="rectime">0:00</span><span class="muted" style="font-size:12px">recording…</span><div class="spacer" style="flex:1"></div><button class="btn ghost" id="reccancel">Cancel</button><button class="btn green" id="recsend">Send voice note</button></div>
      <div class="epanel" id="epanel"></div>
      <div class="composer" id="composer">
        <input type="file" id="cfile" hidden accept="image/*,video/*,audio/*,.pdf,.csv,.xlsx,.xls,.doc,.docx,.txt">
        <button class="attachbtn" id="emojibtn" title="Emoji" aria-label="Insert an emoji" disabled>&#128578;</button>
        <button class="attachbtn" id="attachbtn" title="Attach a file" aria-label="Attach a file" disabled>&#128206;</button>
        <textarea id="cinput" rows="1" placeholder="Type a message…  (Enter to send · Shift+Enter for a new line)" disabled></textarea>
        <button class="attachbtn" id="micbtn" title="Record a voice note" aria-label="Record a voice note" disabled>&#127908;</button>
        <button class="sendbtn" id="sendbtn" disabled title="Send">➤</button>
      </div>
    </div>
  </div>
  <div class="right" id="right"><div class="placeholder">Click <b>Extract</b> on any customer message to add its products here.</div></div>
</div>
<div class="ctxmenu" id="ctxmenu"></div>
<div class="mmodal" id="fwdmodal"><div class="msheet"><h3>Forward to…</h3>
  <input class="fwdsearch" id="fwdsearch" placeholder="search chats…" autocomplete="off">
  <div class="fwdlist" id="fwdlist"></div>
  <div class="macts"><button class="btn ghost" id="fwdcancel">Cancel</button></div>
</div></div>
<div class="mmodal" id="delmodal"><div class="msheet"><h3>Delete message?</h3>
  <p class="muted" id="delnote" style="font-size:12.5px;margin:0">Delete for everyone removes it from the WhatsApp chat for all members (only possible for a while after sending). Delete for me only hides it in this app.</p>
  <div class="macts"><button class="btn ghost" id="delcancel">Cancel</button><button class="btn ghost" id="delme">Delete for me</button><button class="btn red" id="deleveryone">Delete for everyone</button></div>
</div></div>
<div class="toast" id="toast"></div>
<script>
var chats=[],curChat=null,items=[],active={},sources=[],proc={},procBy={},openIdx=null,lastSig="",mentionMap={};
var meName=${JSON.stringify(me.name || me.username)},meUser=${JSON.stringify(me.username)},appUsers=[];
var msgIndex={},replyTo=null,menuMid=null; // message-menu state (reply / copy / forward / delete)
var orderNos={},lastCopied=[]; // DDI order numbers per processed message; messages of the last Copy
// --- mobile: chat list and conversation are two screens, like WhatsApp ---
function isMobile(){return window.matchMedia("(max-width:860px)").matches;}
function showChat(){document.body.classList.add("inchat");}
function showList(){document.body.classList.remove("inchat");closePanel();}
function openPanel(){if(isMobile())el("right").classList.add("open");}
function closePanel(){el("right").classList.remove("open");}
// Swipe: right closes the panel, left opens it again (when there is something to show).
function wireSwipe(elm){
  var x0=0,y0=0,t0=0;
  elm.addEventListener("touchstart",function(e){var t=e.changedTouches[0];x0=t.clientX;y0=t.clientY;t0=Date.now();},{passive:true});
  elm.addEventListener("touchend",function(e){
    if(!isMobile())return;
    var t=e.changedTouches[0],dx=t.clientX-x0,dy=t.clientY-y0;
    if(Date.now()-t0>600)return;                       // slow drag = scrolling, not a swipe
    if(Math.abs(dx)<60||Math.abs(dy)>Math.abs(dx))return; // must be clearly horizontal
    if(dx<0){ if(items.length)openPanel(); return; }        // swipe left: show the order panel
    // swipe right: close the panel first, otherwise go back to the chat list
    if(el("right").classList.contains("open"))closePanel(); else showList();
  },{passive:true});
}
// Sign-out is a POST so a third-party page can't force it with an <img>/<a> to /logout.
function omsLogout(){fetch("/logout",{method:"POST"}).then(function(){location.href="/login";}).catch(function(){location.href="/login";});}
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function debounce(fn,ms){var t;return function(){var a=arguments,x=this;clearTimeout(t);t=setTimeout(function(){fn.apply(x,a);},ms);};}
function cssq(s){return window.CSS&&CSS.escape?CSS.escape(s):s;}
function fmt(p){var d=p.description||"";if(d.length>62)d=d.slice(0,62)+"…";return '<span class="code">'+esc(p.code)+'</span><span class="sep">—</span>'+esc(d);}
function isOut(m){return m.outgoing!=null?!!m.outgoing:(m.fromMe||/warehouse/i.test(m.pushName||""));}
function isBareUrl(s){s=String(s||"").trim().toLowerCase();return (s.indexOf("http://")===0||s.indexOf("https://")===0)&&s.indexOf(" ")<0&&s.indexOf("\\n")<0;}
// WhatsApp-Web thread rendering: date separators, group sender-name colors, reaction chips, read-only.
function nameColor(k){k=String(k||"");var h=0;for(var i=0;i<k.length;i++)h=(h*31+k.charCodeAt(i))>>>0;return ["#e5679c","#00a884","#c98a00","#3aa0d1","#a45cff","#e5637a","#1fa855","#ff7a4d","#6a5cff","#0087d3","#b7791f","#d1457a"][h%12];}
function fmtTime(ts){return ts?new Date(ts*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";}
function dayKeyOf(ts){var d=new Date(ts*1000);return d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate();}
function dayLabel(ts){var d=new Date(ts*1000),n=new Date();var a=new Date(n.getFullYear(),n.getMonth(),n.getDate()),b=new Date(d.getFullYear(),d.getMonth(),d.getDate());var diff=Math.round((a-b)/86400000);if(diff<=0)return"Today";if(diff===1)return"Yesterday";return d.toLocaleDateString([],{weekday:"short",month:"long",day:"numeric",year:"numeric"});}
function reactSummary(arr){var u=[];for(var i=0;i<arr.length;i++)if(u.indexOf(arr[i])<0)u.push(arr[i]);return esc(u.slice(0,4).join(""))+(arr.length>1?'<span class="rc">'+arr.length+'</span>':"");}
// SAFETY: escape the raw body FIRST, then swap '@<id>' for a highlighted name. Escaped text holds
// no live markup, and the inserted name is escaped too, so a crafted message can't inject HTML.
// (No entity produced by esc() contains '@', so this replace can never split one.)
function fmtBody(s){return esc(s).replace(/@(\\d{5,})/g,function(m,id){var n=mentionMap[id];return n?'<span class="mn">@'+esc(n)+'</span>':m;});}
// Extractable messages render line by line so a number gutter can appear once the message is
// extracted — the same numbers the order rows carry, so "line 3" points at something visible.
// String.fromCharCode(10) instead of a backslash-n literal: this JS lives inside a TS template
// literal, where backslash-n becomes a real newline and truncates the emitted string.
function fmtBodyLines(s){
  var NL=String.fromCharCode(10);
  return String(s).split(NL).map(function(l,ix){
    return '<span class="ml"><span class="mln">'+(ix+1)+'</span><span class="mlt">'+(fmtBody(l)||"&nbsp;")+'</span></span>';
  }).join('');
}
function jidName(j){if(!j)return"";var id=String(j).split("@")[0].split(":")[0];return mentionMap[id]||"";}
// Media is fetched on demand from /api/media/<id> — it is downloaded from WhatsApp the first time
// and cached on disk, so a thread full of photos does not re-download while scrolling.
function mediaBlock(m){
  var k=m.kind||"", src="/api/media/"+encodeURIComponent(m.messageId);
  if(k==="image"||k==="sticker")
    return '<a class="mediaimg" href="'+src+'" target="_blank" rel="noopener"><img loading="lazy" src="'+src+'" alt="'+esc(k)+'" onerror="this.closest(\\'.mediaimg\\').outerHTML=\\'<div class=&quot;medianote&quot;>Image unavailable</div>\\'"></a>';
  // Every branch needs an onerror. Without one a voice note whose download failed renders an
  // <audio> element that just sits there doing nothing when clicked — which is exactly what
  // "we don't see voice notes" looked like from the outside.
  var fail=function(msg){return ' onerror="this.outerHTML=\\'<div class=&quot;medianote&quot;>'+msg+'</div>\\'"';};
  if(k==="voice"||k==="ptt"||k==="audio")
    return '<audio class="mediaaud" controls preload="none" src="'+src+'"'+fail("Voice note unavailable")+'></audio>';
  if(k==="video"||k==="ptv")
    return '<video class="mediavid" controls preload="none" src="'+src+'"'+fail("Video unavailable")+'></video>';
  if(k==="document")
    return '<a class="mediadoc" href="'+src+'" target="_blank" rel="noopener">&#128206; Open document</a>';
  return "";
}
// Chat-list preview: drop a trailing signature line so the sidebar shows the message, not "hi -- admin".
function stripSig(t){return String(t||"").replace(/\\s*(?:\\u270D[\\uD83C\\uDFFB-\\uDFFF\\uFE0F]*\\s*(?:by\\s+)?|sent by\\s*-\\s*|--\\s+)\\*?[A-Za-z0-9]{3,32}\\*?\\s*$/i,"").trim();}
// Messages sent from this app end with a final line of "-- username". Split that off so the bubble
// shows clean text plus a "Sent by" badge. Only OUTGOING messages are checked and the name must be
// a real account, so a customer typing the same thing can never fake it.
// (No backslash-n in this comment on purpose: the page is a TS template literal and it would
//  become a real newline, breaking the comment across two lines and killing the whole script.)
function splitSignature(text,out){
  if(!out)return{body:text,by:null};
  var s=String(text||"");
  var nl=s.lastIndexOf("\\n");
  if(nl<0)return{body:s,by:null};
  var last=s.slice(nl+1).trim();
  // Current form: "<writing-hand emoji> *name*". The older "sent by - *name*" and "-- name"
  // forms are still recognised so messages already sent keep their attribution.
  var EMO=String.fromCodePoint(0x270D);   // matches the emoji with or without a skin-tone modifier
  var m=null;
  if(last.indexOf(EMO)===0){
    var rest=last.slice(1).replace(String.fromCodePoint(0x1F3FB),"").replace(String.fromCodePoint(0x1F3FC),"")
                 .replace(String.fromCodePoint(0x1F3FD),"").replace(String.fromCodePoint(0x1F3FE),"")
                 .replace(String.fromCodePoint(0x1F3FF),"").replace(String.fromCodePoint(0xFE0F),"").trim();
    m=/^(?:by\\s+)?\\*?([A-Za-z0-9]{3,32})\\*?$/i.exec(rest);
  }
  if(!m)m=/^sent by\\s*-\\s*\\*?([A-Za-z0-9]{3,32})\\*?$/i.exec(last)||/^--\\s+\\*?([A-Za-z0-9]{3,32})\\*?$/.exec(last);
  if(!m)return{body:s,by:null};
  var typed=m[1],known=null;
  for(var i=0;i<appUsers.length;i++){if(String(appUsers[i]).toLowerCase()===typed.toLowerCase())known=appUsers[i];}
  if(!known)return{body:s,by:null};                            // not one of our accounts = not ours
  return{body:s.slice(0,nl).replace(/\\s+$/,""),by:known};
}
// WhatsApp-style quoted reply block shown above the message text, inside the same bubble.
// 60+ chars of pure base64 with no spaces is a photo thumbnail, not words — old rows in the DB
// still carry these (stored before ingestion learned to drop them), so the guard lives here too.
function isB64Blob(s){var h=String(s||"").replace(/^\s+/,"").slice(0,80);return h.length>=60&&/^[A-Za-z0-9+\/=]+$/.test(h);}
function quoteHtml(m){
  if(!m.replyText&&!m.replySender)return"";
  var who=jidName(m.replySender)||"Message";
  var body=(m.replyText&&!isB64Blob(m.replyText))?fmtBody(m.replyText):'<span class="qm">'+(m.replyText?'&#128247; Photo':'Media')+'</span>';
  // data-goto: clicking the quote jumps to the original message, like WhatsApp.
  var go=m.replyTo?' data-goto="'+esc(m.replyTo)+'" title="Go to the original message"':'';
  return '<div class="q"'+go+'><div class="qbar"></div><div class="qin"><div class="qn">'+esc(who)+'</div><div class="qt">'+body+'</div></div></div>';
}
function renderThread(ms){var pk=null,pd=null,o=[];for(var i=0;i<ms.length;i++){var m=ms[i];var out=isOut(m);var sk=out?"~out~":(m.sender||m.pushName||"?");var day=m.ts?dayKeyOf(m.ts):"";var nd=day!==pd;var grp=!nd&&sk===pk;if(nd&&m.ts)o.push('<div class="daysep"><span>'+esc(dayLabel(m.ts))+'</span></div>');pd=day;pk=sk;// Attribution: the server's sent_by record is authoritative; the text signature is only a
// fallback for messages sent before attribution moved into the database.
// Gate the signature on fromMe (what our own device actually sent), NOT on the layout side. The
// layout side comes from a substring match on the sender's self-chosen WhatsApp name, so a customer
// who renames themselves "...Shipping" would otherwise get a forged "Sent by staff" badge.
// (No backticks in this comment: the page is a TS template literal and they would end the string.)
var sig=splitSignature(m.text||"",!!m.fromMe);var sentBy=m.sentBy||sig.by;
msgIndex[m.messageId]=m;m._sby=m.sentBy||null;m._clean=sig.body||m.text||""; // for the message menu (delete needs the DB attribution, not the spoofable signature)
var mediaHtml=mediaBlock(m);
var revoked=(m.kind==="revoked"); // sender deleted it in WhatsApp; show what WhatsApp shows, not "[revoked]"
var body=revoked?"":(sig.body||(m.hasMedia&&!mediaHtml?("["+(m.kind||"media")+"]"):(m.text?"":(mediaHtml?"":"["+(m.kind||"msg")+"]"))));var xable=(!out&&m.text&&!isBareUrl(m.text));if(xable&&m.processed){proc[m.messageId]=true;if(m.processedBy)procBy[m.messageId]=m.processedBy;}if(m.orderNo)orderNos[m.messageId]=m.orderNo;var mid=esc(m.messageId);var nm=(!out&&m.isGroup&&!grp)?'<div class="who" style="color:'+nameColor(sk)+'">'+esc(m.pushName||"~")+'</div>':"";var ck=out?'<span class="ck">✓✓</span>':"";var hr=m.reactions&&m.reactions.length;var re=hr?'<div class="react">'+reactSummary(m.reactions)+'</div>':"";var sentTag=sentBy?'<div class="sentby">Sent by <b>'+esc(sentBy)+'</b></div>':"";
// ⌄ opens the message menu — visible on hover (always on touch). Star shows next to the time.
var arrow=revoked?"":'<button class="mbtn" title="Message menu" aria-label="Message menu">&#9662;</button>';
var starTag=m.starred?'<span class="starred" title="Starred">&#9733;</span>':"";
var inner=arrow+nm+quoteHtml(m)+mediaHtml+(revoked?'<div class="tx del">&#128683; This message was deleted</div>':(body?'<div class="tx">'+(xable?fmtBodyLines(body):fmtBody(body))+'</div>':''))+sentTag+'<div class="metarow"><span class="sb" style="display:none"></span><span class="meta">'+starTag+esc(fmtTime(m.ts))+ck+'</span></div>'+(xable?'<div class="xrow"><button class="xbtn" data-mid="'+mid+'">Extract</button></div>':"")+re;o.push('<div class="bubble '+(out?"out":"in")+(grp?" grp":"")+(xable?" xable":"")+(hr?" hasreact":"")+'" data-mid="'+mid+'">'+inner+'</div>');}return o.join("");}
// Live thread auto-refresh: re-poll the open chat, re-render only when messages/reactions change.
function threadSig(ms){if(!ms.length)return"0";var last=ms[ms.length-1],rc=0,sp=0;for(var i=0;i<ms.length;i++){rc+=(ms[i].reactions?ms[i].reactions.length:0);if(ms[i].starred)sp++;if(ms[i].pinned)sp+=100;if(ms[i].kind==="revoked")sp+=10000;}return ms.length+"|"+last.messageId+"|"+rc+"|"+sp;}
async function refreshThread(){var cid=curChat;if(!cid)return;if(document.querySelector(".msgs .bubble.busy"))return;try{var d=await(await fetch("/api/chats/"+encodeURIComponent(cid)+"/messages")).json();if(cid!==curChat)return;var ms=d.messages||[];if(d.mentions)mentionMap=d.mentions;if(d.appUsers)appUsers=d.appUsers;renderPinBar(d.pinned||null);var sig=threadSig(ms);if(sig===lastSig)return;lastSig=sig;var mb=el("msgs");var atBottom=(mb.scrollHeight-mb.scrollTop-mb.clientHeight)<80;var prev=mb.scrollTop;el("msgs").innerHTML=ms.length?renderThread(ms):el("msgs").innerHTML;applyStates();mb.scrollTop=atBottom?mb.scrollHeight:prev;}catch(e){}}

async function loadCat(){try{var d=await(await fetch("/api/products/count")).json();el("catmeta").textContent=(d.count||0).toLocaleString()+" products · "+(d.aliases||0)+" learned";}catch(e){}}
async function loadChats(){try{var d=await(await fetch("/api/chats")).json();chats=d.chats||[];setLive(d.status);renderChats();}catch(e){setLive("offline");}}
// Header pill: green "Live chat" only when WhatsApp is actually linked; red/amber otherwise.
function setLive(s){var box=el("live"),tx=el("livetx");if(!box||!tx)return;var cls="",label="";
  if(s==="connected"){cls="";label="Live chat";}
  else if(s==="waiting for scan"){cls="off";label="Disconnected — scan QR";}
  else if(s==="auth failure"){cls="off";label="Disconnected — re-link";}
  else if(s==="disconnected"){cls="off";label="Disconnected — reconnecting…";}
  else if(s==="offline"){cls="off";label="Server unreachable";}
  else{cls="warn";label=s?String(s):"connecting…";}
  box.className="live"+(cls?" "+cls:"");tx.textContent=label;box.title="WhatsApp connection: "+(s||"unknown");
  showOffline(s);}
// Curtain over the whole app while WhatsApp is not connected. Sending and extracting against a
// dead connection would silently do nothing, so the app is blocked rather than left half-working.
function showOffline(s){
  var box=el("offline");if(!box)return;
  if(s==="connected"){box.className="offline";return;}
  var icon="⏳",title="Connecting to WhatsApp…",
      msg="Waiting for the WhatsApp connection. This usually takes a few seconds.",
      note="",bad=false,wait=true;
  if(s==="waiting for scan"||s==="auth failure"){
    icon="🔌";bad=true;wait=false;
    title="WhatsApp needs to be re-linked";
    msg="The linked device was signed out, so messages cannot be sent or received right now.";
    note="An administrator must open the server and scan the QR code at localhost:3009/qr — WhatsApp → Linked devices → Link a device.";
  }else if(s==="disconnected"){
    icon="🔄";bad=true;
    title="WhatsApp disconnected";
    msg="The connection dropped and is being re-established automatically.";
    note="If this does not clear within a few minutes, tell an administrator.";
  }else if(s==="offline"){
    icon="⚠️";bad=true;wait=false;
    title="Cannot reach the server";
    msg="Your browser cannot reach the OMS. Check your internet connection.";
    note="This page will recover on its own once the connection returns.";
  }
  el("officon").textContent=icon;
  el("officon").className="officon"+(wait?" wait":"");
  el("offtitle").textContent=title;
  el("offmsg").textContent=msg;
  var n=el("offnote");n.textContent=note;n.className="offnote"+(note?" on":"");
  box.querySelector(".offbox").className="offbox"+(bad?" bad":"");
  box.className="offline on";
}
function renderChats(){var q=((el("chatsearch")&&el("chatsearch").value)||"").toLowerCase().trim();var list=q?chats.filter(function(c){return (String(c.title||"").toLowerCase().indexOf(q)>=0)||(String(c.id||"").toLowerCase().indexOf(q)>=0);}):chats;var capped=list.slice(0,300);var more=list.length-capped.length;var html=capped.length?capped.map(function(c){return '<div class="chatrow'+(c.id===curChat?" active":"")+(c.unread>0?" un":"")+'" data-id="'+esc(c.id)+'"><div class="t"><span>'+(c.isGroup?"👥 ":"")+esc(c.title||c.id)+'</span>'+(c.unread>0?'<span class="badge">'+c.unread+'</span>':"")+'</div><div class="p">'+esc(stripSig(c.lastText||""))+'</div></div>';}).join(""):'<div class="placeholder">'+(chats.length?"No chats match.":"Loading chats…")+'</div>';if(more>0)html+='<div class="more">+'+more+' more — refine search</div>';el("chatlist").innerHTML=html;}
async function selectChat(id){if(typeof recStop==="function")recStop(false);curChat=id;items=[];active={};sources=[];proc={};procBy={};orderNos={};lastCopied=[];navIdx=-1;renderChats();renderRight();closePanel();showChat();el("renamebtn").disabled=false;drafted=[];clearFile();clearReply();hideMentions();syncComposer();loadParticipants(id);var t=(chats.find(function(c){return c.id===id;})||{}).title||id;el("threadtitle").textContent=t;el("threadtitle").className="tt";var d=await(await fetch("/api/chats/"+encodeURIComponent(id)+"/messages")).json();var ms=d.messages||[];if(d.mentions)mentionMap=d.mentions;if(d.appUsers)appUsers=d.appUsers;renderPinBar(d.pinned||null);el("msgs").innerHTML=ms.length?renderThread(ms):'<div class="placeholder">No messages captured for this chat yet. Messages are stored from the moment they arrive; older history is not available.</div>';lastSig=threadSig(ms);applyStates();renderRight();var mb=el("msgs");mb.scrollTop=mb.scrollHeight;}

function rebuildSources(){sources=Object.keys(active).map(function(m){return {messageId:m,text:active[m]};});}
// Single source of truth for message visual state: extracted (active) vs processed (proc) vs plain.
function applyStates(){
  var bubbles=document.querySelectorAll(".msgs .xable");
  for(var i=0;i<bubbles.length;i++){
    var b=bubbles[i],mid=b.dataset.mid,on=!!active[mid],done=!!proc[mid],busy=b.classList.contains("busy");
    b.classList.toggle("ext",on);
    b.classList.toggle("done",done&&!on);
    var sb=b.querySelector(".sb");
    // The button already reads "Extracted ✓", so no badge in that state — showing both said
    // "Extracted" twice on the same bubble. The badge is only for the persistent Processed state,
    // where it also names who completed the order.
    if(sb){if(done&&!on){var by=procBy[mid];var dno=orderNos[mid];sb.className="sb d";sb.textContent=(by?("✓ Processed by "+by):"✓ Processed")+(dno?(" · DDI #"+dno):"");sb.style.display="";}
      else{sb.style.display="none";sb.textContent="";}}
    var btn=b.querySelector(".xbtn");
    if(btn&&!busy){btn.disabled=false;btn.classList.toggle("on",on);btn.classList.toggle("done",done&&!on);
      btn.textContent=on?"Extracted ✓":(done?"Re-Extract":"Extract");}
  }
  var any=document.querySelectorAll(".msgs .bubble.ext, .msgs .bubble.done").length;
  el("navlabel").style.display=any?"":"none";
  highlightLines(); // thread re-renders rebuild the bubbles, so the green lines must be re-applied
}
// Toggle one message: OFF removes only that message's items; ON appends its items (others untouched).
async function toggleExtract(mid){
  var b=document.querySelector('.xable[data-mid="'+cssq(mid)+'"]');
  if(active[mid]){delete active[mid];items=items.filter(function(it){return it.mid!==mid;});rebuildSources();renderRight();applyStates();return;}
  if(b)b.classList.add("busy");
  var btn=b&&b.querySelector(".xbtn");
  if(btn){btn.disabled=true;btn.className="xbtn on";btn.innerHTML='<span class="spin"></span>Extracting…';}
  try{
    var d=await(await fetch("/api/extract",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,messageId:mid})})).json();
    active[mid]=(d.sources&&d.sources[0]&&d.sources[0].text)||"(no text)";
    var add=(d.items||[]).map(function(it){return {mid:mid,phrase:it.phrase,quantity:it.quantity||"1",line:it.line||0,raw:it.raw||"",unit:it.unit||"",material:it.material||"",matched:it.matched,chosen:it.matched||null,guess:!!it.guess,suggestions:it.suggestions||[],results:[]};});
    items=items.concat(add);rebuildSources();renderRight();openPanel(); // slide the sheet in on phones
  }catch(e){}
  finally{if(b)b.classList.remove("busy");applyStates();}
}
// Whole bubble is the extract trigger (button included, since it lives inside .xable).
el("msgs").addEventListener("click",function(e){
  // The ⌄ arrow opens the message menu — the visible way in; right-click/long-press still work.
  var mb=e.target.closest(".mbtn");
  if(mb){e.stopPropagation();var r=mb.getBoundingClientRect();showMenu(mb.closest(".bubble").dataset.mid,r.left,r.bottom+4);return;}
  // Clicking a quoted reply jumps to the original message, like WhatsApp.
  // WhatsApp's reply reference is a BARE stanza id ("3A92DD…") while our bubbles carry the full
  // rebuilt id ("true_<chat>_<id>") — an exact compare matches 0 of 549 replies in the DB, so the
  // original is found by id TAIL (547 of 549 match; the rest are genuinely older than the view).
  var q=e.target.closest(".q[data-goto]");
  if(q){
    var g=q.dataset.goto;
    var t=document.querySelector('.msgs .bubble[data-mid="'+cssq(g)+'"]')
        ||document.querySelector('.msgs .bubble[data-mid$="'+cssq("_"+g)+'"]');
    if(t){t.scrollIntoView({behavior:"smooth",block:"center"});t.classList.add("flash");setTimeout(function(){t.classList.remove("flash");},1200);}
    else toast("That message is further back than this view loads.",true);
    return;
  }
  var b=e.target.closest(".xable");if(b&&!b.classList.contains("busy"))toggleExtract(b.dataset.mid);});
// Jump between extracted/processed messages in a long thread.
var navIdx=-1;
function navExtracted(dir){var list=Array.prototype.slice.call(document.querySelectorAll(".msgs .bubble.ext, .msgs .bubble.done"));if(!list.length)return;navIdx+=dir;if(navIdx<0)navIdx=list.length-1;if(navIdx>=list.length)navIdx=0;var t=list[navIdx];t.scrollIntoView({behavior:"smooth",block:"center"});t.classList.remove("flash");void t.offsetWidth;t.classList.add("flash");}
el("tolist").addEventListener("click",showList);
el("navprev").addEventListener("click",function(){navExtracted(-1);});
el("navnext").addEventListener("click",function(){navExtracted(1);});

el("renamebtn").addEventListener("click",async function(){if(!curChat)return;var cur=(chats.find(function(c){return c.id===curChat;})||{}).title||"";var name=window.prompt("Chat name:",cur);if(!name||!name.trim())return;await fetch("/api/chats/rename",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,name:name.trim()})});await loadChats();el("threadtitle").textContent=name.trim();});

el("chatlist").addEventListener("click",function(e){var r=e.target.closest(".chatrow");if(r)selectChat(r.dataset.id);});
el("chatsearch").addEventListener("input",renderChats);

// One compact row: qty + primary line; chosen rows also show "↳ Customer wrote: <text>".
// The whole header is clickable to expand an inline search (accordion, one open at a time).
function rowHtml(i){
  var it=items[i],ch=it.chosen;
  var cls=ch?(it.matched?(it.guess&&!it.learned?"matched guessed":"matched"):"resolved"):"unmatched";
  // Chips: which message line this came from, the package unit the customer wrote ("box"), the
  // material inherited from a header line above ("nohub"), and hand-added rows.
  var chips=(it.unit?' <span class="unitchip" title="the customer gave the quantity in this unit — check what it means for the order">'+esc(it.unit)+'</span>':'')
           +(it.material?' <span class="matchip" title="from the &quot;'+esc(it.material)+'&quot; header line above it in the message">'+esc(it.material)+'</span>':'')
           +(it.manual?' <span class="matchip" title="added by hand — was not in the customer&#39;s message">added</span>':'');
  var lno=it.line?'<span class="lno" title="line '+it.line+' of the message">'+it.line+'</span>':'';
  // Template shape, the same on every row (the client's ask): the product on its own line, then
  // "Customer Require -> <their words>" on a NEW line. Nothing shares a line, nothing is cut off.
  var prod=ch?'<div class="pmain">'+fmt(ch)+(it.learned?' <span class="learned">learned &#10003;</span>':'')+(it.guess&&!it.learned?' <span class="guess">check</span>':'')+'</div>'
             :'<div class="pmain nopick">not matched yet — click to choose</div>';
  var custText=it.manual?"":(it.raw||it.phrase);
  var cust=custText?'<div class="cust"><span class="creq">Customer Require</span> &#10132; '+esc(custText)+chips+'</div>':(chips?'<div class="cust">'+chips+'</div>':'');
  var head='<div class="pinfo">'+prod+cust+'</div>';
  var top='<div class="top" data-idx="'+i+'">'+lno+'<input class="qty" data-idx="'+i+'" value="'+esc(it.quantity)+'">'+head+'<button class="addinline" data-add="'+i+'" title="Add an item below this line (e.g. split into two products)">+</button><span class="exp">&#9656;</span><button class="rmrow" data-rm="'+i+'" title="Remove this line — use when a text word was wrongly treated as a product">&#10005;</button></div>';
  var body='<div class="expand"><div class="inner"><input class="psearch" data-idx="'+i+'" placeholder="search products…" autocomplete="off"><div class="results" data-res="'+i+'"></div></div></div>';
  return '<div class="row '+cls+'" data-row="'+i+'">'+top+body+'</div>';
}
// Panel header (phone only): a way back to the chat. Included in the empty state too, so an
// order panel opened with nothing in it is never a dead end.
function panelHeadHtml(){return '<div class="panelclose"><button type="button" id="backchat">&#8592; Chat</button><span class="hint">swipe right to close</span></div>';}
// Mirror the row state onto the message itself: a line whose extracted items are ALL matched is
// tinted the same green inside the bubble, so staff can see at a glance what is already handled.
// Only while that message's extraction is open — the CSS is scoped to .bubble.ext, and Copy/Clear
// remove that class, which returns the bubble to normal exactly as asked.
function highlightLines(){
  var old=document.querySelectorAll(".msgs .ml.mlok");
  for(var i2=0;i2<old.length;i2++)old[i2].classList.remove("mlok");
  var mids=Object.keys(active);
  for(var k=0;k<mids.length;k++){
    var mid=mids[k];
    var byLine={}; // line -> true while every item from that line has a chosen product
    for(var j=0;j<items.length;j++){
      var it=items[j];
      if(it.mid!==mid||!it.line)continue;
      var ok=!!it.chosen;
      byLine[it.line]=(byLine[it.line]===undefined)?ok:(byLine[it.line]&&ok);
    }
    var bubble=document.querySelector('.msgs .bubble[data-mid="'+cssq(mid)+'"]');
    if(!bubble)continue;
    var mls=bubble.querySelectorAll(".ml");
    for(var ln in byLine){
      if(!byLine[ln])continue;
      var elLn=mls[+ln-1];
      if(elLn)elLn.classList.add("mlok");
    }
  }
}
function renderRight(){
  openIdx=null;
  highlightLines();
  if(!items.length){el("right").innerHTML=panelHeadHtml()+'<div class="placeholder">'+(sources.length?"No products found in the selected message(s).":"Click Extract on a customer message to begin.")+'</div>';return;}
  // ONE list, in the order the customer wrote the items — splitting into Matched/Unmatched
  // reordered the order lines and made them impossible to check against the message.
  // Colour carries the state instead: green = matched, orange = still needs a product.
  var done=items.filter(function(it){return it.chosen;}).length;
  var h=panelHeadHtml();
  // Say how many messages fed this order. Customers routinely send one order as three messages and
  // staff had no idea they could stack them — the client only discovered it by accident on a call.
  var src=sources.length>1?' &nbsp;<span class="cnt">from '+sources.length+' messages</span>':'';
  h+='<div class="sect"><h2>Order lines &nbsp;<span class="cnt">'+done+' of '+items.length+' matched</span>'+src+'</h2>';
  h+=items.map(function(_,i){return rowHtml(i);}).join("");
  h+='<button class="addbtnrow" id="additem">+ Add item &nbsp;<span style="font-weight:400;color:var(--mut)">(a product the customer did not write)</span></button>';
  h+='</div>';
  h+='</div><div class="finalbox"><div class="h"><h2>Final Order</h2><div style="display:flex;gap:8px"><button class="btn ghost" id="clearbtn">Clear</button><button class="btn green" id="copybtn">Copy</button></div></div><table><thead><tr><th style="width:54px">Qty</th><th style="width:118px">SKU</th><th>Product</th><th style="width:30px" aria-label="remove"></th></tr></thead><tbody id="finalbody"></tbody></table>'
   +'<div class="ddirow" id="ddirow" style="display:none"><label for="ddino">DDI order #</label><input id="ddino" placeholder="order number from DDI" maxlength="40"><button class="btn green" id="ddisave">Save</button></div></div>';
  el("right").innerHTML=h;
  updateFinal();
  syncDdiRow();
}
// Accordion: expand one row's inline search, fade/slide in, auto-focus, collapse any other.
// The initial suggestion list (before typing) stays short — these are the matcher's own guesses,
// not a search. Typed searches go through doSearch and are not capped here.
function renderResults(i,list){var box=el("right").querySelector('.results[data-res="'+i+'"]');if(!box)return;box.innerHTML=(list&&list.length)?list.slice(0,8).map(function(p){return '<button class="opt" data-idx="'+i+'" data-code="'+esc(p.code)+'">'+fmt(p)+'</button>';}).join(""):'<div class="noopt">No suggestions — type to search.</div>';}
function collapseRow(){if(openIdx==null)return;var row=el("right").querySelector('.row[data-row="'+openIdx+'"]');if(row){row.classList.remove("open");var ex=row.querySelector(".expand");if(ex)ex.classList.remove("show");}openIdx=null;}
function expandRow(i){
  if(openIdx===i){collapseRow();return;}
  collapseRow();openIdx=i;
  var row=el("right").querySelector('.row[data-row="'+i+'"]');if(!row)return;
  row.classList.add("open");
  var ex=row.querySelector(".expand");void ex.offsetWidth;ex.classList.add("show"); // reflow → transition = fade/slide in
  renderResults(i,items[i].suggestions||[]);
  var ps=row.querySelector(".psearch");if(ps)ps.focus();
  phraseSuggest(i); // widen the quick suggestions into the full ranked list for this phrase
}
// The client's ask: the suggestion list should be as broad as the search, ranked the same way
// (product number first). The matcher's own 8 quick guesses show instantly; this replaces them
// with the full ranked list for the customer's phrase — unless the user already started typing,
// in which case their search owns the box.
async function phraseSuggest(i){
  var it=items[i];if(!it||it.manual||!it.phrase||it.phrase.length<2)return;
  try{
    var d=await(await fetch("/api/products/search?limit=200&q="+encodeURIComponent(it.phrase))).json();
    if(openIdx!==i)return;
    var row=el("right").querySelector('.row[data-row="'+i+'"]');if(!row)return;
    var ps=row.querySelector(".psearch");if(ps&&ps.value)return; // they are typing — leave their results alone
    var list=d.results||[];if(!list.length)return;               // keep the quick guesses over an empty answer
    items[i].results=list;
    var box=row.querySelector('.results[data-res="'+i+'"]');if(!box)return;
    var tot=d.total||list.length;
    var cnt=(tot>list.length?('showing '+list.length+' of '+tot+' — type to narrow'):(tot+(tot===1?' match':' matches')));
    box.innerHTML='<div class="rescount">'+cnt+'</div>'+list.map(function(p){return '<button class="opt" data-idx="'+i+'" data-code="'+esc(p.code)+'">'+fmt(p)+'</button>';}).join("");
  }catch(e){}
}
function findProduct(i,code){var it=items[i];var pool=(it.results||[]).concat(it.suggestions||[]);for(var k=0;k<pool.length;k++)if(pool[k].code===code)return pool[k];return null;}
// Manual rows never teach the matcher: their "phrase" is a placeholder, not customer wording,
// and learning it would poison future matching.
function choose(i,code){var p=findProduct(i,code);if(!p)return;var learn=!items[i].matched&&!items[i].manual;items[i].chosen=p;items[i].learned=learn;if(learn){fetch("/api/alias",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phrase:items[i].phrase,code:p.code,description:p.description})}).then(function(){loadCat();}).catch(function(){});}openIdx=null;renderRight();}
// Add an extra product the customer never wrote — e.g. the customer wants a 1/2" pump we only
// have in 3/4", so the 3/4" pump goes on plus the reducer that makes it fit.
//
// Two entry points: the "+" on a row inserts DIRECTLY BELOW that row and keeps its line number
// (splitting one customer line into two products stays visibly one line), while the button under
// the list appends at the end. Both open straight into the product search.
function addItemAt(after){
  var at=(after==null)?items.length:after+1;
  var line=(after!=null&&items[after])?items[after].line:0;
  items.splice(at,0,{mid:"",manual:true,phrase:"",quantity:"1",line:line,raw:"",unit:"",material:"",matched:null,chosen:null,guess:false,suggestions:[],results:[]});
  renderRight();
  expandRow(at);
  var row=el("right").querySelector('.row[data-row="'+at+'"]');
  if(row){var ps=row.querySelector(".psearch");if(ps)ps.placeholder="search the product to add…";}
}
function addItem(){addItemAt(null);}
function updateFinal(){var body=el("finalbody");if(!body)return;var html="";items.forEach(function(it,i){if(!it.chosen)return;html+='<tr><td>'+esc(it.quantity)+'</td><td><span class="code">'+esc(it.chosen.code)+'</span></td><td>'+esc(it.chosen.description)+'</td><td style="text-align:right"><button class="rmfinal" data-idx="'+i+'" title="Remove — move back to Unmatched" aria-label="Remove">&#10005;</button></td></tr>';});body.innerHTML=html||'<tr><td colspan="4" class="muted">Resolve products to build the order.</td></tr>';}

// Typing in a row's search: <2 chars falls back to its suggestions; else live catalog search into .results.
// limit=200: DDI shows pages of results for a short code like "SDS" and staff were getting six.
// The list scrolls, and the count line says when there are more than were fetched.
var doSearch=debounce(async function(i,q){if(!q||q.length<2){renderResults(i,items[i].suggestions||[]);return;}try{var d=await(await fetch("/api/products/search?limit=200&q="+encodeURIComponent(q))).json();items[i].results=d.results||[];var box=el("right").querySelector('.results[data-res="'+i+'"]');if(!box)return;var n=items[i].results.length,tot=d.total||n;if(!n){box.innerHTML='<div class="noopt">No matches.</div>';return;}var cnt=(tot>n?('showing '+n+' of '+tot+' — type more to narrow'):(tot+(tot===1?' match':' matches')));box.innerHTML='<div class="rescount">'+cnt+'</div>'+items[i].results.map(function(p){return '<button class="opt" data-idx="'+i+'" data-code="'+esc(p.code)+'">'+fmt(p)+'</button>';}).join("");}catch(e){}},220);

el("right").addEventListener("input",function(e){var t=e.target;if(t.classList.contains("qty")){items[t.dataset.idx].quantity=t.value;updateFinal();}else if(t.classList.contains("psearch")){doSearch(t.dataset.idx,t.value);}});
el("right").addEventListener("click",function(e){
  var o=e.target.closest(".opt");if(o){choose(o.dataset.idx,o.dataset.code);return;}
  var rm=e.target.closest(".rmfinal");if(rm){var ri=+rm.dataset.idx;if(items[ri]){if(items[ri].manual){items.splice(ri,1);}else{items[ri].chosen=null;items[ri].learned=false;}}renderRight();return;}
  if(e.target.closest("#backchat")){closePanel();return;}
  if(e.target.closest("#additem")){addItem();return;}
  var ai=e.target.closest(".addinline");if(ai){addItemAt(+ai.dataset.add);return;}
  // ✕ removes the whole row — the fix for a piece of formal text wrongly treated as a product.
  // Removing an UNMATCHED extracted row also teaches the system: that phrase stays out of future
  // extractions (undoable from the toast). A matched row teaches nothing — removing a real
  // product from one order must never blacklist it.
  var rr=e.target.closest(".rmrow");
  if(rr){
    var ri2=+rr.dataset.rm,it2=items[ri2];
    var teach=it2&&!it2.manual&&!it2.chosen&&it2.phrase;
    items.splice(ri2,1);renderRight();
    if(teach)teachIgnore(it2.phrase);
    return;
  }
  if(e.target.closest("#ddisave")){saveDdiNo();return;}
  if(e.target.closest("#clearbtn")){clearOrder();return;}
  if(e.target.closest("#copybtn")){copyCsv();return;}
  if(e.target.closest(".psearch")||e.target.closest(".expand"))return; // don't toggle when interacting inside the open panel
  var top=e.target.closest(".top");
  if(top&&!e.target.closest(".qty"))expandRow(+top.dataset.idx);
});
// Clear = discard the current extraction and reset the right panel (bubbles revert to Extract/Re-Extract).
// Does NOT touch the database — nothing is un-processed; it just wipes the unsaved working order.
// A message someone SAVED earlier keeps its "Processed by … · DDI #…" badge; only this screen's
// working state is dropped. And if the order just copied still has no DDI number, warn first —
// the number is required, not optional.
function clearOrder(){
  if(ddiPending()&&!window.confirm("You have not saved the DDI order number for the order you just copied. Leave without it?"))return;
  lastCopied=[];active={};items=[];rebuildSources();renderRight();applyStates();
}
// Clipboard with a fallback: the async API is blocked in some browsers/policies, so fall back to a
// hidden textarea + execCommand. Returns false only when BOTH fail, which the caller must respect.
async function copyText(s){
  try{ await navigator.clipboard.writeText(s); return true; }catch(e){}
  try{
    var ta=document.createElement("textarea");
    ta.value=s;ta.setAttribute("readonly","");
    ta.style.position="fixed";ta.style.top="-1000px";ta.style.opacity="0";
    document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);
    var ok=document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  }catch(e){ return false; }
}
// Copy = complete the order: copy "qty,SKU", mark every extracted message Processed, then reset the panel.
async function copyCsv(){
  var rows=items.filter(function(it){return it.chosen;});
  // Nothing resolved → don't copy an empty order and (crucially) don't mark messages processed.
  if(!rows.length){var cb=el("copybtn");if(cb){var o=cb.textContent;cb.textContent="Resolve a product first";setTimeout(function(){cb.textContent=o;},1600);}return;}
  // Already saved by someone? Ask BEFORE touching anything. Cancel leaves the old save — who
  // saved it, its DDI number, everything — exactly as it was.
  var midsPre=Object.keys(active),prevMid=null;
  for(var pi=0;pi<midsPre.length;pi++){if(proc[midsPre[pi]]){prevMid=midsPre[pi];break;}}
  if(prevMid){
    var pwho=procBy[prevMid]||"someone",pno=orderNos[prevMid];
    var q="This order was already saved by "+pwho+(pno?(" with DDI order #"+pno):" (no DDI order number yet)")+".";
    q+=String.fromCharCode(10)+String.fromCharCode(10)+"Save it again? OK replaces who saved it";
    q+=pno?" — the DDI number stays until you type a new one.":".";
    q+=" Cancel keeps everything as it is.";
    if(!window.confirm(q))return;
  }
  var csv=rows.map(function(it){return (it.quantity||"1")+","+it.chosen.code;}).join("\\n");
  // The clipboard can refuse (permission, unfocused page, browser policy). If it does we must NOT
  // mark the order Processed — otherwise staff paste nothing and the order silently looks done.
  var copied=await copyText(csv);
  if(!copied){
    var eb=el("copybtn");
    if(eb){eb.textContent="Copy failed — try again";setTimeout(function(){var b=el("copybtn");if(b)b.textContent="Copy";},2600);}
    return;
  }
  var mids=Object.keys(active),cnt=mids.length;
  if(!cnt)return;
  var saveItems=rows.map(function(it){return {qty:it.quantity||"1",code:it.chosen.code,description:it.chosen.description,phrase:it.phrase};});
  try{await fetch("/api/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,sources:sources,items:saveItems})});}catch(e){}
  mids.forEach(function(m){proc[m]=true;procBy[m]=meName;});   // show "Processed by <you>" straight away
  // Keep the panel exactly as-is — just flash the button. The copy + "mark Processed" still happen (above);
  // we only skip the reset so the extracted order stays visible after copying.
  var cb=el("copybtn");if(cb){cb.textContent="Copied ✓";setTimeout(function(){var b=el("copybtn");if(b)b.textContent="Copy";},1600);}
  // The sales rep now pastes into DDI and gets an order number back — the box is REQUIRED from
  // here: it stays highlighted (and Clear warns) until the number is saved. On a resave the
  // existing number is prefilled so they keep it or type the new one.
  lastCopied=mids;syncDdiRow();
  var di=el("ddino");if(di){di.value=(prevMid&&orderNos[prevMid])||"";di.focus();}
  applyStates();
}
// The "DDI order #" box shows only once an order has been copied (that is when DDI hands out
// the number). Saving stamps it on every message of that copy, so the thread badge reads
// "Processed by Nate · DDI #12345". While any copied message still has no number, the box is
// marked required.
function ddiPending(){return lastCopied.length>0&&lastCopied.some(function(m){return !orderNos[m];});}
function syncDdiRow(){
  var r=el("ddirow");if(!r)return;
  r.style.display=lastCopied.length?"flex":"none";
  r.classList.toggle("need",ddiPending());
  var lb=r.querySelector("label");if(lb)lb.textContent=ddiPending()?"DDI order # (required)":"DDI order #";
}
async function saveDdiNo(){
  var no=(el("ddino")?el("ddino").value:"").trim();
  if(!lastCopied.length)return;
  if(!no){toast("Type the order number from DDI first.",true);return;}
  try{
    var d=await(await fetch("/api/processed/order-no",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({messageIds:lastCopied,orderNo:no})})).json();
    if(d.ok){lastCopied.forEach(function(m){orderNos[m]=no;});toast("DDI order #"+no+" saved");syncDdiRow();applyStates();}
    else toast(d.error||"Could not save",true);
  }catch(e){toast("Network error — not saved",true);}
}

// --- @mention autocomplete -------------------------------------------------------------
// The textarea shows readable "@Name" while typing; on send each one is rewritten to the raw
// "@<id>" WhatsApp expects and its JID is passed in the mentions array (both are required for a
// real mention that highlights and notifies).
var participants=[],mSel=0,mMatches=[],mStart=-1,drafted=[];
async function loadParticipants(id){participants=[];try{var d=await(await fetch("/api/chats/"+encodeURIComponent(id)+"/participants")).json();if(curChat===id)participants=d.participants||[];}catch(e){}}
function hideMentions(){el("mbox").className="mentionbox";mMatches=[];mStart=-1;}
function initials(n){var p=String(n||"?").trim().split(/\\s+/);return ((p[0]||"?")[0]+((p[1]||"")[0]||"")).trim();}
// Find an '@word' immediately before the caret that isn't part of a longer token.
function activeToken(){
  var t=el("cinput"),pos=t.selectionStart,v=t.value;
  var i=v.lastIndexOf("@",pos-1);
  if(i<0)return null;
  // NOTE: backslashes are doubled — this file is a TS template literal, so a single \\s or \\n
  // would be eaten before the browser ever sees it (a raw newline inside a regex = syntax error).
  if(i>0&&!/[\\s(]/.test(v[i-1]))return null;         // '@' must start a word
  var frag=v.slice(i+1,pos);
  if(/[\\s]/.test(frag))return null;                  // stop once they've typed past the name
  return {start:i,text:frag};
}
function renderMentions(){
  var box=el("mbox");
  if(!mMatches.length){hideMentions();return;}
  box.innerHTML=mMatches.map(function(p,i){
    return '<div class="mrow'+(i===mSel?" sel":"")+'" data-i="'+i+'"><div class="mav">'+esc(initials(p.name))+'</div><div class="mnm">'+esc(p.name)+'</div></div>';
  }).join("");
  box.className="mentionbox on";
  var sel=box.querySelector(".mrow.sel");if(sel)sel.scrollIntoView({block:"nearest"});
}
function updateMentions(){
  var tok=activeToken();
  if(!tok||!participants.length){hideMentions();return;}
  var q=tok.text.toLowerCase();
  mMatches=participants.filter(function(p){return !q||String(p.name).toLowerCase().indexOf(q)>=0;}).slice(0,8);
  mStart=tok.start;mSel=0;renderMentions();
}
function pickMention(i){
  var p=mMatches[i];if(!p)return;
  var t=el("cinput"),v=t.value,pos=t.selectionStart;
  var display="@"+p.name;
  t.value=v.slice(0,mStart)+display+" "+v.slice(pos);
  var caret=mStart+display.length+1;
  t.focus();t.setSelectionRange(caret,caret);
  drafted.push({display:display,id:p.id,jid:p.jid});
  hideMentions();autoGrow();syncComposer();
}
// Swap each "@Name" the user picked back to "@<id>" and collect the JIDs WhatsApp needs.
function resolveDraft(text){
  var mentions=[],out=text;
  drafted.forEach(function(d){
    if(out.indexOf(d.display)<0)return;               // they edited it away — drop the mention
    out=out.split(d.display).join("@"+d.id);
    if(mentions.indexOf(d.jid)<0)mentions.push(d.jid);
  });
  return {text:out,mentions:mentions};
}

// --- attachments -------------------------------------------------------------------------
var pendingFile=null;   // {name, type, size, b64, previewUrl}
function fmtSize(n){return n<1024?n+" B":n<1048576?(n/1024).toFixed(0)+" KB":(n/1048576).toFixed(1)+" MB";}
function clearFile(){
  if(pendingFile&&pendingFile.previewUrl)URL.revokeObjectURL(pendingFile.previewUrl);
  pendingFile=null;el("cfile").value="";el("filechip").className="filechip";el("filechip").innerHTML="";syncComposer();
}
function showFile(){
  if(!pendingFile)return;
  var thumb=pendingFile.previewUrl?'<img src="'+pendingFile.previewUrl+'" alt="">':'<span style="font-size:19px">&#128206;</span>';
  el("filechip").innerHTML=thumb+'<span class="fname">'+esc(pendingFile.name)+'</span>'
    +'<span class="fsize">'+fmtSize(pendingFile.size)+'</span>'
    +'<button class="fx" id="filex" title="Remove" aria-label="Remove file">&#10005;</button>';
  el("filechip").className="filechip on";
  syncComposer();
}
el("attachbtn").addEventListener("click",function(){if(curChat)el("cfile").click();});
el("filechip").addEventListener("click",function(e){if(e.target.closest("#filex"))clearFile();});
el("cfile").addEventListener("change",function(){
  var f=el("cfile").files&&el("cfile").files[0];
  if(!f)return;
  if(f.size>16*1024*1024){alert("That file is too large. WhatsApp accepts about 16 MB.");el("cfile").value="";return;}
  var r=new FileReader();
  r.onload=function(){
    var s=String(r.result||""),i=s.indexOf(",");
    pendingFile={name:f.name,type:f.type||"application/octet-stream",size:f.size,b64:i>=0?s.slice(i+1):s,
                 previewUrl:/^image\\//.test(f.type)?URL.createObjectURL(f):null};
    showFile();
  };
  r.onerror=function(){alert("Could not read that file.");};
  r.readAsDataURL(f);
});

// --- composer: send a message into the open chat (human-initiated, one at a time) ---
var sending=false;
function autoGrow(){var t=el("cinput");t.style.height="auto";t.style.height=Math.min(t.scrollHeight,120)+"px";}
function syncComposer(){
  var on=!!curChat&&!sending;
  el("cinput").disabled=!on;
  el("attachbtn").disabled=!on;
  el("emojibtn").disabled=!on;
  el("micbtn").disabled=!on;
  if(!on)el("epanel").classList.remove("on");
  el("sendbtn").disabled=!on||(!el("cinput").value.trim()&&!pendingFile); // a file alone is sendable
}
async function sendMsg(){
  var t=el("cinput"),txt=t.value.trim();
  if(!curChat||sending)return;
  if(pendingFile){await sendFile(txt);return;}   // a file send carries the text as its caption
  if(!txt)return;
  sending=true;syncComposer();el("sendbtn").textContent="…";
  var res=resolveDraft(txt);
  try{
    var payload={chatId:curChat,text:res.text,mentions:res.mentions};
    if(replyTo&&replyTo.chatId===curChat)payload.replyTo=replyTo.mid; // quote the message being replied to
    var r=await fetch("/api/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    var d=await r.json();
    if(d.ok){t.value="";drafted=[];clearReply();autoGrow();lastSig="";refreshThread();}   // clear + pull the sent message in
    else{alert(d.error||"Could not send the message.");}
  }catch(e){alert("Network error — the message was not sent.");}
  sending=false;el("sendbtn").textContent="➤";syncComposer();t.focus();
}
// Upload + send the attached file, using whatever is typed as the caption.
async function sendFile(caption){
  if(!pendingFile||!curChat||sending)return;
  sending=true;syncComposer();el("sendbtn").textContent="…";
  try{
    var r=await fetch("/api/send-media",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({chatId:curChat,filename:pendingFile.name,mimetype:pendingFile.type,data:pendingFile.b64,caption:caption||""})});
    var d=await r.json();
    if(d.ok){el("cinput").value="";drafted=[];clearFile();autoGrow();lastSig="";refreshThread();}
    else{alert(d.error||"Could not send the file.");}
  }catch(e){alert("Network error — the file may not have been sent. Check the chat before resending.");}
  sending=false;el("sendbtn").textContent="➤";syncComposer();
}
el("sendbtn").addEventListener("click",sendMsg);

// --- voice notes: record with the mic, send as WhatsApp's push-to-talk bubble ---
var recStream=null,recorder=null,recChunks=[],recTimer=null,recT0=0;
function recStop(keep){
  clearInterval(recTimer);recTimer=null;
  if(recorder&&recorder.state!=="inactive"){recorder._keep=keep;recorder.stop();}
  else recCleanup();
}
function recCleanup(){
  if(recStream){recStream.getTracks().forEach(function(t){t.stop();});recStream=null;}
  recorder=null;
  el("recbar").classList.remove("on");
  el("micbtn").classList.remove("micbtn-rec");
  el("composer").style.display="";
}
async function recStart(){
  if(!curChat||sending)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast("This browser cannot record audio.",true);return;}
  try{recStream=await navigator.mediaDevices.getUserMedia({audio:true});}
  catch(e){toast("Microphone not available — allow it in the browser.",true);return;}
  // Opus is what WhatsApp voice notes use; webm is the container Chrome records it in.
  var mt=window.MediaRecorder&&MediaRecorder.isTypeSupported("audio/webm;codecs=opus")?"audio/webm;codecs=opus":"";
  try{recorder=mt?new MediaRecorder(recStream,{mimeType:mt}):new MediaRecorder(recStream);}
  catch(e){toast("Recording is not supported here.",true);recCleanup();return;}
  recChunks=[];
  recorder.ondataavailable=function(ev){if(ev.data&&ev.data.size)recChunks.push(ev.data);};
  recorder.onstop=function(){
    var keep=recorder&&recorder._keep;
    var blob=keep&&recChunks.length?new Blob(recChunks,{type:(recorder&&recorder.mimeType)||"audio/webm"}):null;
    recCleanup();
    if(blob)sendVoice(blob);
  };
  recorder.start(250);
  recT0=Date.now();
  el("rectime").textContent="0:00";
  recTimer=setInterval(function(){
    var s=Math.floor((Date.now()-recT0)/1000);
    el("rectime").textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");
    if(s>=120){toast("Voice notes are capped at 2 minutes — sending.");recStop(true);} // keep uploads sane
  },250);
  el("recbar").classList.add("on");
  el("micbtn").classList.add("micbtn-rec");
  el("composer").style.display="none";
}
async function sendVoice(blob){
  if(!curChat)return;
  sending=true;syncComposer();
  try{
    var b64=await new Promise(function(res2,rej){var r=new FileReader();r.onload=function(){var s=String(r.result);var i=s.indexOf(",");res2(i>=0?s.slice(i+1):s);};r.onerror=rej;r.readAsDataURL(blob);});
    var r2=await fetch("/api/send-media",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({chatId:curChat,filename:"voice-note.webm",mimetype:blob.type||"audio/webm",data:b64,caption:"",voice:true})});
    var d=await r2.json();
    if(d.ok){toast("Voice note sent");lastSig="";refreshThread();}
    else toast(d.error||"Could not send the voice note",true);
  }catch(e){toast("Network error — the voice note may not have been sent.",true);}
  sending=false;syncComposer();
}
el("micbtn").addEventListener("click",function(){if(el("recbar").classList.contains("on"))recStop(true);else recStart();});
el("reccancel").addEventListener("click",function(){recStop(false);});
el("recsend").addEventListener("click",function(){recStop(true);});

// --- emoji picker: searchable, most-used first, shared by the composer AND reactions ---
// Each entry: [emoji, search keywords]. Keywords are what the search box matches against.
var EMO=[
["😀","grinning happy smile"],["😁","beaming grin teeth"],["😂","joy laugh tears funny lol"],["🤣","rofl rolling laugh"],["😊","smile blush happy"],["😍","heart eyes love"],["🥰","love hearts adore"],["😘","kiss love"],["😉","wink"],["😎","cool sunglasses"],["🤩","star struck wow"],["🤔","thinking hmm"],["🙄","eye roll"],["😅","sweat relief phew"],["😬","grimace awkward"],["😭","crying sob sad"],["😢","cry sad tear"],["😡","angry mad red"],["😤","frustrated steam"],["🥳","party celebrate birthday"],["🤯","mind blown"],["😴","sleep tired zzz"],["🤒","sick fever ill"],["🤗","hug"],["😇","angel innocent"],["🫤","meh unsure"],["😐","neutral blank"],["🙂","slight smile ok"],
["🤝","handshake deal agree"],["👍","thumbs up ok yes like good"],["👎","thumbs down no bad"],["👌","ok perfect"],["🙏","thanks pray please folded hands"],["💪","strong muscle power"],["🙌","raised hands praise celebrate"],["👏","clap applause"],["✌️","peace victory"],["🤞","fingers crossed luck"],["👊","fist bump punch"],["🫡","salute yes sir"],["👋","wave hello bye hi"],["🤙","call me shaka"],["👉","point right"],["👈","point left"],["☝️","point up one"],["✋","stop hand high five"],
["❤️","red heart love"],["🧡","orange heart"],["💚","green heart"],["💙","blue heart"],["💛","yellow heart"],["🖤","black heart"],["💯","hundred 100 percent perfect"],["💔","broken heart"],
["🔥","fire hot lit flame"],["⭐","star"],["✨","sparkles shine new"],["⚡","lightning fast bolt"],["💥","boom explosion"],["🎉","party popper congrats celebrate"],["🎊","confetti celebrate"],["🎯","target bullseye goal"],["🏆","trophy winner champion"],["🥇","gold medal first"],
["✅","check done yes complete green tick"],["☑️","checkbox done tick"],["✔️","check mark tick done"],["❌","cross no wrong x cancel"],["⚠️","warning caution alert"],["❓","question mark"],["❗","exclamation important"],["🚫","prohibited no ban stop"],["♻️","recycle"],["🆗","ok button"],["🆕","new"],["🔴","red circle"],["🟢","green circle go"],["🟡","yellow circle wait"],
["📦","package box parcel order"],["🚚","truck delivery shipping"],["🚛","lorry truck shipping"],["🛻","pickup truck"],["🚗","car"],["🏃","running hurry rush"],["⏳","hourglass waiting time"],["⏰","alarm clock time"],["🕐","clock one time"],["📅","calendar date"],["📍","pin location place"],["🗺️","map directions"],["🏠","house home"],["🏢","building office"],["🏗️","construction crane site"],["🚧","construction barrier work"],
["📞","phone call telephone"],["📱","mobile phone cell"],["💬","speech chat message"],["📧","email envelope mail"],["📋","clipboard list"],["📝","memo note write"],["📄","document page paper"],["🧾","receipt invoice bill"],["💰","money bag cash"],["💵","dollar money cash"],["💳","credit card payment"],["🛒","cart shopping buy"],["🏷️","tag label price"],["⚖️","scale balance weigh"],["📏","ruler measure"],["📐","triangle ruler measure"],
["🔧","wrench tool fix plumbing"],["🔨","hammer tool"],["🛠️","hammer wrench tools repair"],["🔩","nut bolt screw"],["🪛","screwdriver tool"],["⚙️","gear settings cog"],["🧰","toolbox tools kit"],["🪠","plunger plumbing drain"],["🚿","shower plumbing"],["🛁","bathtub bath tub"],["🚽","toilet plumbing wc"],["🔗","link chain"],["🧲","magnet"],["🪜","ladder"],["🧯","fire extinguisher safety"],["💧","water drop leak"],["🌊","water wave flood"],["🧊","ice cold frozen"],["🌡️","thermometer temperature heat"],["☀️","sun sunny hot"],["🌧️","rain weather"],["❄️","snow cold winter freeze"],
["☕","coffee break"],["🍕","pizza food lunch"],["🍔","burger food"],["🥤","drink cup soda"],["🎂","cake birthday"],["🍀","clover luck lucky"],["🌹","rose flower"],["🎁","gift present"],["👀","eyes looking watch see"],["🧠","brain smart think"],["🫶","heart hands love thanks"],["🤲","open palms give"],["💤","zzz sleep"],["🐢","turtle slow"],["🐇","rabbit fast quick"],["🦺","safety vest work"],["⛑️","helmet safety rescue"],["👷","construction worker builder"],["🧑‍🔧","mechanic plumber technician"]
];
var epMode="insert",epMid=null; // insert into the composer, or react to a message
function emojiFreq(){try{return JSON.parse(localStorage.getItem("omsEmojiFreq")||"{}");}catch(e){return{};}}
function bumpEmoji(ch){try{var f=emojiFreq();f[ch]=(f[ch]||0)+1;localStorage.setItem("omsEmojiFreq",JSON.stringify(f));}catch(e){}}
function egridHtml(list){return list.map(function(p2){return '<button type="button" data-emo="'+p2[0]+'" title="'+esc(p2[1])+'">'+p2[0]+'</button>';}).join("");}
function renderEgrid(q){
  var g=el("egrid");
  q=String(q||"").toLowerCase().trim();
  if(q){
    // Word-prefix match: "fir" finds fire, but "truck" must not find "star sTRUCK".
    var hit=EMO.filter(function(p2){
      if(p2[0]===q)return true;
      var words=p2[1].split(" ");
      for(var w=0;w<words.length;w++)if(words[w].indexOf(q)===0)return true;
      return false;
    });
    g.innerHTML=hit.length?egridHtml(hit):'<div class="enone">No emoji found for that.</div>';
    return;
  }
  // No search: the emojis THIS person uses most float to the top automatically.
  var f=emojiFreq();
  var used=EMO.filter(function(p2){return f[p2[0]];}).sort(function(a,b){return f[b[0]]-f[a[0]];}).slice(0,10);
  var h="";
  if(used.length)h+='<div class="ehead">Most used</div>'+egridHtml(used)+'<div class="ehead">All</div>';
  g.innerHTML=h+egridHtml(EMO);
}
function openEmojiPanel(mode,mid){
  epMode=mode;epMid=mid||null;
  el("esearch").value="";renderEgrid("");
  el("epanel").classList.add("on");
  el("esearch").focus();
}
(function(){
  var p=el("epanel");
  p.innerHTML='<div class="esearchwrap"><input id="esearch" placeholder="search emoji… (fire, thanks, truck)" autocomplete="off"></div><div id="egrid"></div>';
  el("esearch").addEventListener("input",function(){renderEgrid(this.value);});
  el("emojibtn").addEventListener("click",function(ev){ev.stopPropagation();
    if(p.classList.contains("on")){p.classList.remove("on");return;}
    openEmojiPanel("insert",null);
  });
  p.addEventListener("click",function(ev){
    var b=ev.target.closest("[data-emo]");if(!b)return;
    bumpEmoji(b.dataset.emo);
    if(epMode==="react"&&epMid){
      var rmid=epMid;p.classList.remove("on");
      fetch("/api/messages/react",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({messageId:rmid,emoji:b.dataset.emo})}).then(function(r){return r.json();}).then(function(d){
          if(d.ok){toast("Reacted "+b.dataset.emo);lastSig="";setTimeout(refreshThread,900);}
          else toast(d.error||"Could not react",true);
        }).catch(function(){toast("Network error",true);});
      return;
    }
    var t=el("cinput"),s=t.selectionStart||0,e2=t.selectionEnd||0;
    t.value=t.value.slice(0,s)+b.dataset.emo+t.value.slice(e2);
    var pos=s+b.dataset.emo.length;
    t.focus();t.setSelectionRange(pos,pos);
    autoGrow();syncComposer();
  });
  document.addEventListener("click",function(ev){if(!ev.target.closest("#epanel")&&!ev.target.closest("#emojibtn"))p.classList.remove("on");});
})();

// --- WhatsApp-style message menu: right-click a bubble on desktop, long-press on phones ---
function toast(m,bad){var t=el("toast");t.textContent=m;t.className="toast on"+(bad?" bad":"");setTimeout(function(){t.className="toast"+(bad?" bad":"");},2600);}
// A toast with an Undo — click anywhere on it to take the action back.
var undoTimer=null,undoHandler=null;
function toastUndo(msg,cb){
  var t=el("toast");
  if(undoHandler)t.removeEventListener("click",undoHandler);
  clearTimeout(undoTimer);
  t.innerHTML=esc(msg)+' &nbsp;<b style="text-decoration:underline">Undo</b>';
  t.className="toast on act";
  var done=function(){t.removeEventListener("click",undoHandler);undoHandler=null;t.className="toast";t.textContent="";};
  // done() BEFORE cb(): the callback usually shows its own confirmation toast, and cleaning up
  // afterwards would wipe that toast the instant it appeared.
  undoHandler=function(){done();cb();};
  t.addEventListener("click",undoHandler);
  undoTimer=setTimeout(done,6000);
}
// Teach the extractor that this phrase is NOT a product. Undo deletes the lesson again.
function teachIgnore(phrase){
  fetch("/api/ignored",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phrase:phrase})})
    .then(function(r){return r.json();}).then(function(d){
      if(!d.ok)return; // the row is already removed either way; a refused lesson needs no noise
      toastUndo('Removed — "'+phrase.slice(0,60)+'" will be skipped next time.',function(){
        fetch("/api/ignored/delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phrase:phrase})});
        toast('Okay — "'+phrase.slice(0,60)+'" will extract again.');
      });
    }).catch(function(){});
}
function clearReply(){replyTo=null;el("replybar").className="replybar";}
// Pinned bar above the thread, like WhatsApp's: newest pinned message, click scrolls to it.
function renderPinBar(p){
  var bar=el("pinbar");
  if(!p){bar.className="pinbar";bar.innerHTML="";bar.onclick=null;return;}
  var label=p.body?stripSig(p.body):("["+(p.kind||"media")+"]");
  bar.innerHTML='<span class="pico">&#128204;</span><span class="ptxt"><b>Pinned</b> &nbsp;'+esc(label.slice(0,140))+'</span>';
  bar.className="pinbar on";
  bar.onclick=function(){
    var t=document.querySelector('.msgs .bubble[data-mid="'+(window.CSS&&CSS.escape?CSS.escape(p.msgId):p.msgId)+'"]');
    if(t){t.scrollIntoView({behavior:"smooth",block:"center"});t.classList.add("flash");setTimeout(function(){t.classList.remove("flash");},1200);}
    else toast("That message is further back than this view loads.",true);
  };
}
function startReply(mid){
  var m=msgIndex[mid];if(!m)return;
  var who=isOut(m)?"You":(m.pushName||jidName(m.sender)||"Customer");
  replyTo={mid:mid,chatId:curChat};
  el("rqn").textContent=who;
  el("rqt").textContent=(m._clean||"").slice(0,120)||("["+(m.kind||"media")+"]");
  el("replybar").className="replybar on";
  el("cinput").focus();
}
el("rx").addEventListener("click",clearReply);
function copyMsg(mid){
  var m=msgIndex[mid];if(!m)return;
  var txt=m._clean||"";
  if(!txt){toast("Nothing to copy in this message.",true);return;}
  // Same two-step strategy as the order Copy button: clipboard API, then the textarea fallback —
  // and never claim success unless one of them actually worked.
  function fallback(){
    try{
      var ta=document.createElement("textarea");ta.value=txt;ta.style.position="fixed";ta.style.opacity="0";
      document.body.appendChild(ta);ta.select();var ok=document.execCommand("copy");ta.remove();
      toast(ok?"Message copied":"Copy failed — select the text by hand.",!ok);
    }catch(e){toast("Copy failed — select the text by hand.",true);}
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){toast("Message copied");}).catch(fallback);
  }else{fallback();}
}
function openForward(mid){
  menuMid=mid;el("fwdsearch").value="";renderFwdList("");el("fwdmodal").className="mmodal on";el("fwdsearch").focus();
}
function renderFwdList(q){
  var ql=q.toLowerCase();
  var list=chats.filter(function(c){return c.id!==curChat&&(!ql||(c.title||c.id).toLowerCase().indexOf(ql)>=0);}).slice(0,40);
  el("fwdlist").innerHTML=list.length?list.map(function(c){
    return '<button data-fwd="'+esc(c.id)+'">'+esc(c.title||c.id)+'</button>';
  }).join(""):'<div style="padding:12px;font-size:12.5px;color:var(--mut)">No chats match.</div>';
}
el("fwdsearch").addEventListener("input",function(){renderFwdList(this.value);});
el("fwdcancel").addEventListener("click",function(){el("fwdmodal").className="mmodal";});
el("fwdmodal").addEventListener("click",function(e){
  if(e.target===el("fwdmodal")){el("fwdmodal").className="mmodal";return;}
  var b=e.target.closest("[data-fwd]");if(!b||!menuMid)return;
  var mid=menuMid,to=b.dataset.fwd;el("fwdmodal").className="mmodal";
  fetch("/api/messages/forward",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({messageId:mid,chatId:to})}).then(function(r){return r.json();}).then(function(d){
      toast(d.ok?"Forwarded":(d.error||"Forward failed"),!d.ok);
    }).catch(function(){toast("Network error — the forward may not have gone out.",true);});
});
function openDelete(mid){menuMid=mid;el("delmodal").className="mmodal on";}
el("delcancel").addEventListener("click",function(){el("delmodal").className="mmodal";});
el("delmodal").addEventListener("click",function(e){if(e.target===el("delmodal"))el("delmodal").className="mmodal";});
function doDelete(everyone){
  var mid=menuMid;if(!mid)return;
  el("delmodal").className="mmodal";
  fetch("/api/messages/delete",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({messageId:mid,everyone:everyone})}).then(function(r){return r.json();}).then(function(d){
      if(d.ok){toast(everyone?"Deleted for everyone":"Deleted for you");lastSig="";refreshThread();}
      else{toast(d.error||"Delete failed",true);}
    }).catch(function(){toast("Network error — the delete may not have happened.",true);});
}
el("delme").addEventListener("click",function(){doDelete(false);});
el("deleveryone").addEventListener("click",function(){doDelete(true);});
var MEDIA_KINDS=["image","video","audio","voice","document","sticker","ptv"];
var QUICK_REACTS=["👍","❤️","😂","😮","😢","🙏"];
function showMenu(mid,x,y){
  var m=msgIndex[mid];if(!m)return;
  var mine=isOut(m)&&m._sby&&String(m._sby).toLowerCase()===meUser.toLowerCase();
  // WhatsApp's quick-react strip sits on top of the menu; + opens the FULL searchable picker
  // (any emoji), ✕ takes a reaction back.
  var h='<div class="rstrip">'+QUICK_REACTS.map(function(e2){return '<button data-react="'+e2+'">'+e2+'</button>';}).join("")+'<button data-reactmore="1" title="All emojis — with search">&#65291;</button><button data-react="" title="Remove my reaction">&#10005;</button></div>'
       +'<button data-act="reply">&#8617;&nbsp; Reply</button>'
       +'<button data-act="copy">&#128203;&nbsp; Copy</button>'
       +'<button data-act="forward">&#10150;&nbsp; Forward</button>'
       +'<button data-act="star">'+(m.starred?'&#9734;&nbsp; Unstar':'&#9733;&nbsp; Star')+'</button>'
       +'<button data-act="pin">'+(m.pinned?'&#128204;&nbsp; Unpin':'&#128204;&nbsp; Pin')+'</button>';
  if(MEDIA_KINDS.indexOf(m.kind||"")>=0)h+='<button data-act="download">&#11015;&nbsp; Download</button>';
  // Own messages only, enforced again server-side: the menu simply does not offer Delete on
  // anything the DB does not attribute to this login.
  if(mine)h+='<div class="sep"></div><button data-act="delete" class="danger">&#128465;&nbsp; Delete</button>';
  var menu=el("ctxmenu");menu.innerHTML=h;menu.className="ctxmenu on";menuMid=mid;
  var mw=menu.offsetWidth,mh=menu.offsetHeight;
  menu.style.left=Math.min(x,window.innerWidth-mw-8)+"px";
  menu.style.top=Math.min(y,window.innerHeight-mh-8)+"px";
}
function hideMenu(){el("ctxmenu").className="ctxmenu";}
function starPin(mid,which){
  var m=msgIndex[mid];if(!m)return;
  var on=which==="star"?!m.starred:!m.pinned;
  fetch("/api/messages/"+which,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({messageId:mid,on:on})}).then(function(r){return r.json();}).then(function(d){
      if(d.ok){toast((on?"":"Un")+(which==="star"?"starred":"pinned"));lastSig="";refreshThread();}
      else{toast(d.error||"Could not do that",true);}
    }).catch(function(){toast("Network error",true);});
}
function downloadMedia(mid){
  // ?dl=1 makes the server answer with attachment disposition, so the browser saves the file
  // under its real name instead of opening it.
  var a=document.createElement("a");a.href="/api/media/"+encodeURIComponent(mid)+"?dl=1";a.download="";
  document.body.appendChild(a);a.click();a.remove();
}
el("ctxmenu").addEventListener("click",function(e){
  var rm2=e.target.closest("[data-reactmore]");
  // stopPropagation: this same click would bubble to the document listener that closes the emoji
  // panel — the panel opened and shut again in the same instant.
  if(rm2){e.stopPropagation();var mmid=menuMid;hideMenu();openEmojiPanel("react",mmid);return;}
  var rb=e.target.closest("[data-react]");
  if(rb){
    var rmid=menuMid;hideMenu();
    if(rb.dataset.react)bumpEmoji(rb.dataset.react); // quick reactions count toward "most used" too
    fetch("/api/messages/react",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({messageId:rmid,emoji:rb.dataset.react})}).then(function(r){return r.json();}).then(function(d){
        if(d.ok){toast(rb.dataset.react?("Reacted "+rb.dataset.react):"Reaction removed");lastSig="";setTimeout(refreshThread,900);}
        else toast(d.error||"Could not react",true);
      }).catch(function(){toast("Network error",true);});
    return;
  }
  var b=e.target.closest("[data-act]");if(!b)return;
  var mid=menuMid;hideMenu();
  if(b.dataset.act==="reply")startReply(mid);
  else if(b.dataset.act==="copy")copyMsg(mid);
  else if(b.dataset.act==="forward")openForward(mid);
  else if(b.dataset.act==="star")starPin(mid,"star");
  else if(b.dataset.act==="pin")starPin(mid,"pin");
  else if(b.dataset.act==="download")downloadMedia(mid);
  else if(b.dataset.act==="delete")openDelete(mid);
});
document.addEventListener("click",function(e){if(!e.target.closest("#ctxmenu"))hideMenu();});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){hideMenu();el("fwdmodal").className="mmodal";el("delmodal").className="mmodal";}});
el("msgs").addEventListener("contextmenu",function(e){
  var b=e.target.closest(".bubble");if(!b||!b.dataset.mid)return;
  e.preventDefault();showMenu(b.dataset.mid,e.clientX,e.clientY);
});
// Long-press for phones: 550ms without movement opens the same menu.
(function(){
  var timer=null,sx=0,sy=0;
  el("msgs").addEventListener("touchstart",function(e){
    var b=e.target.closest(".bubble");if(!b||!b.dataset.mid)return;
    var t=e.touches[0];sx=t.clientX;sy=t.clientY;
    timer=setTimeout(function(){showMenu(b.dataset.mid,sx,sy);},550);
  },{passive:true});
  el("msgs").addEventListener("touchmove",function(e){
    var t=e.touches[0];
    if(Math.abs(t.clientX-sx)>10||Math.abs(t.clientY-sy)>10){clearTimeout(timer);timer=null;}
  },{passive:true});
  el("msgs").addEventListener("touchend",function(){clearTimeout(timer);timer=null;},{passive:true});
})();

el("cinput").addEventListener("input",function(){autoGrow();syncComposer();updateMentions();});
el("cinput").addEventListener("blur",function(){setTimeout(hideMentions,150);}); // let a click land first
el("cinput").addEventListener("keydown",function(e){
  // While the picker is open the arrow/enter keys drive it instead of the composer.
  if(mMatches.length){
    if(e.key==="ArrowDown"){e.preventDefault();mSel=(mSel+1)%mMatches.length;renderMentions();return;}
    if(e.key==="ArrowUp"){e.preventDefault();mSel=(mSel-1+mMatches.length)%mMatches.length;renderMentions();return;}
    if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();pickMention(mSel);return;}
    if(e.key==="Escape"){e.preventDefault();hideMentions();return;}
  }
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();}   // Enter sends, Shift+Enter newlines
});
el("mbox").addEventListener("mousedown",function(e){   // mousedown: fires before the textarea blurs
  var r=e.target.closest(".mrow");if(r){e.preventDefault();pickMention(+r.dataset.i);}
});

wireSwipe(el("msgs"));wireSwipe(el("right"));
// Selecting a different chat resets the working order, so the sheet should not stay open over it.
loadCat();loadChats();setInterval(loadChats,6000);setInterval(refreshThread,4000);
</script></body></html>`;
}

