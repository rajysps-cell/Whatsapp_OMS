import http from 'node:http';
import QRCode from 'qrcode';
import {
  COOKIE,
  activeAdminCount,
  changePassword,
  cleanupAuth,
  clearCookie,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  ensureSeedAdmin,
  getUser,
  listUsers,
  login as authLogin,
  readCookie,
  sessionCookie,
  sessionUser,
  updateUser,
  allUsernames,
  userExists,
  validatePassword,
  validateUsername,
  verifyPassword,
  type Role,
  type User,
} from './auth';
import type { ChatStore } from './chat-store';
import { config } from './config';
import { logger } from './logger';
import { extractAndMatch, search } from './matcher';
import type { Order } from './order-store';
import { all as allProducts, byCode, count as productCount, normalize } from './products';
import {
  addAlias,
  aliasCodesMatching,
  aliasCount,
  aliasCountsByCode,
  aliasesForProduct,
  deleteAlias,
  getAliasRow,
  chatParticipants,
  isProcessed,
  mentionNames,
  recordSentBy,
  saveExtraction,
  setChatName,
  updateAliasText,
} from './store';

let status = 'starting';
let qrDataUrl: string | null = null;
let ordersProvider: () => Order[] = () => [];
let chatStoreRef: ChatStore | null = null;
/** Injected by index.ts so the UI can send a message through the live WhatsApp connection. */
let sendMessageFn:
  | ((chatId: string, text: string, mentions?: string[], stickerFor?: string) => Promise<string>)
  | null = null;

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
 * Boot-time self-check: render each page and parse its inline <script> blocks. Catches the
 * template-literal escaping trap (\s / \d / \n eaten before the browser sees them), which
 * otherwise ships a page whose JavaScript never runs.
 */
function checkInlineScripts(): void {
  const fake: User = {
    id: 0,
    username: 'selfcheck',
    name: 'selfcheck',
    role: 'admin',
    active: true,
    mustChange: false,
    createdAt: 0,
    lastLogin: null,
  };
  const pages: Array<[string, string]> = [
    ['/match', matchPage(fake)],
    ['/admin', adminPage(fake)],
    ['/aliases', aliasPage()],
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
    createUser(u.value, p.value, String(body['name'] ?? '').trim().slice(0, 80), role, true);
    json(res, 200, { ok: true, users: listUsers() });
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
    const patch: { name?: string; role?: Role; active?: boolean; password?: string } = {};
    if (body['name'] !== undefined) patch.name = String(body['name']).trim().slice(0, 80);
    if (body['role'] !== undefined) patch.role = body['role'] === 'admin' ? 'admin' : 'user';
    if (body['active'] !== undefined) patch.active = !!body['active'];
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
    json(res, 200, { ok: true, users: listUsers() });
    return true;
  }
  return false;
}
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
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
  send?: (chatId: string, text: string, mentions?: string[], stickerFor?: string) => Promise<string>,
): http.Server {
  ordersProvider = getOrders;
  chatStoreRef = chatStore;
  sendMessageFn = send ?? null;
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
        originHost = ' '; // unparseable Origin never matches
      }
      if (originHost !== host) {
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
        json(res, 401, { ok: false, error: r.error });
        return;
      }
      const t = createSession(r.user.id);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': sessionCookie(t, isSecureReq(req)),
      });
      res.end(JSON.stringify({ ok: true, mustChange: r.user.mustChange }));
      logger.info({ user: r.user.username }, 'login ok');
      return;
    }
    if (me) {
      redirect(res, '/');
      return;
    }
    html(res, loginPage());
    return;
  }
  // POST-only: a GET logout can be triggered by any third-party page (<img src=".../logout">).
  if (path === '/logout') {
    if (req.method !== 'POST') {
      redirect(res, me ? '/' : '/login');
      return;
    }
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
      json(res, 200, { ok: true });
      return;
    }
    html(res, changePasswordPage(me));
    return;
  }

  // --- admin-only surface ---------------------------------------------------
  // /qr shows the WhatsApp device-linking QR: scanning it links a phone to the business account
  // with full read+send, outside this app and unaffected by disabling the OMS user. Admins only.
  if (path === '/admin' || path === '/qr' || path.startsWith('/api/users')) {
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
    const limit = Math.min(20, Number(u.searchParams.get('limit') ?? 8) || 8);
    json(res, 200, { results: search(q, limit).map((s) => s.product) });
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
    json(res, 200, { items: extractAndMatch(text), sources, ...(newCount >= 0 ? { newMessages: newCount } : {}) });
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
    json(res, 200, { ok: saved > 0, saved });
    return;
  }
  if (path === '/api/alias' && req.method === 'POST') {
    const body = await readBody(req);
    const phrase = typeof body['phrase'] === 'string' ? (body['phrase'] as string) : '';
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const desc = typeof body['description'] === 'string' ? (body['description'] as string) : '';
    if (phrase && code) addAlias(normalize(phrase), code, desc, phrase.trim());
    json(res, 200, { ok: true, aliases: aliasCount() });
    return;
  }
  if (path === '/api/chats/rename' && req.method === 'POST') {
    const body = await readBody(req);
    const cid = typeof body['chatId'] === 'string' ? (body['chatId'] as string) : '';
    const name = typeof body['name'] === 'string' ? (body['name'] as string).trim() : '';
    if (cid && name) setChatName(cid, name);
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
  // People who can be @-mentioned in this chat (fetched once when a chat is opened).
  const pm = path.match(/^\/api\/chats\/(.+)\/participants$/);
  if (pm) {
    json(res, 200, { participants: chatParticipants(decodeURIComponent(pm[1] ?? '')) });
    return;
  }
  const mm = path.match(/^\/api\/chats\/(.+)\/messages$/);
  if (mm) {
    const id = decodeURIComponent(mm[1] ?? '');
    const msgs = chatStoreRef ? chatStoreRef.messages(id) : [];
    json(res, 200, {
      mentions: mentionNames(), // '@<id>' in a body -> display name
      appUsers: allUsernames(), // names recognised in the "-- <username>" signature
      messages: msgs.map((m) => ({ messageId: m.messageId, fromMe: m.fromMe, pushName: m.pushName, text: m.text, kind: m.kind, hasMedia: m.kind !== 'text', ts: m.ts, processed: isProcessed(m.messageId), outgoing: isWarehouseMsg(m), reactions: m.reactions, isGroup: m.isGroup, replyText: m.replyText, replySender: m.replySender, processedBy: m.processedBy, sentBy: m.sentBy })),
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
    try {
      const messageId = await sendMessageFn(chatId, signed, mentions, me.username);
      if (messageId) recordSentBy(messageId, me.username); // best-effort; index.ts also claims it
      logger.info(
        { user: me.username, chatId, chars: trimmed.length, mentions: mentions.length, messageId },
        'user sent message',
      );
      json(res, 200, { ok: true, messageId });
    } catch (err) {
      logger.error({ err, user: me.username, chatId }, 'send failed');
      json(res, 500, { ok: false, error: 'WhatsApp rejected the message. Try again.' });
    }
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
  if (path === '/aliases') {
    html(res, aliasPage());
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
     <div class="err" id="e"></div>`,
    `var f=document.getElementById("f"),b=document.getElementById("b"),e=document.getElementById("e");
     f.addEventListener("submit",async function(ev){ev.preventDefault();e.className="err";b.disabled=true;b.textContent="Signing in…";
       try{
         var r=await fetch("/login",{method:"POST",headers:{"content-type":"application/json"},
           body:JSON.stringify({username:document.getElementById("u").value,password:document.getElementById("p").value})});
         var d=await r.json();
         if(d.ok){location.href=d.mustChange?"/change-password":"/";return;}
         e.textContent=d.error||"Sign in failed.";e.className="err on";
       }catch(err){e.textContent="Network error — please try again.";e.className="err on";}
       b.disabled=false;b.textContent="Sign in";});`,
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
  .navlink{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600;margin-left:14px}
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
  <a class="navlink" href="/">← Order Matching</a><a class="navlink" href="#" onclick="omsLogout();return false">Sign out</a></header>
<div class="wrap">
  <div class="bar"><h2>Users</h2><span class="muted" id="count"></span><div class="spacer"></div>
    <button class="btn" id="addbtn">+ Add user</button></div>
  <div class="card"><table><thead><tr>
    <th>Username</th><th>Name</th><th style="width:96px">Role</th><th style="width:96px">Status</th>
    <th style="width:150px">Last sign-in</th><th style="width:210px"></th>
  </tr></thead><tbody id="tb"></tbody></table></div>
  <p class="muted" style="margin-top:14px">New users must set their own password at first sign-in. Disabling a user
    immediately signs them out everywhere.</p>
</div>

<div class="modal" id="modal"><div class="sheet">
  <h3 id="mTitle">Add user</h3><p class="sub" id="mSub">They will set a new password at first sign-in.</p>
  <div id="mFields">
    <div id="wrapUser"><label for="fUser">Username</label><input id="fUser" autocomplete="off" placeholder="e.g. dhaval"></div>
    <label for="fName">Full name</label><input id="fName" autocomplete="off" placeholder="e.g. Dhaval Patel">
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
      '<td><span class="pill '+(u.role==="admin"?"admin":"user")+'">'+(u.role==="admin"?"Admin":"User")+'</span></td>'+
      '<td><span class="pill '+(u.active?"on":"off")+'">'+(u.active?"Active":"Disabled")+'</span></td>'+
      '<td class="muted">'+when(u.lastLogin)+'</td>'+
      '<td><div class="acts">'+
        '<button class="btn ghost" data-edit="'+u.id+'">Edit</button>'+
        '<button class="btn danger" data-del="'+u.id+'"'+(self?" disabled":"")+'>Delete</button>'+
      '</div></td></tr>';
  }).join("");
}
function openAdd(){editId=null;el("mTitle").textContent="Add user";el("mSub").textContent="They will set their own password at first sign-in.";
  el("wrapUser").style.display="";el("wrapActive").style.display="none";el("lPass").textContent="Temporary password";
  el("fUser").value="";el("fName").value="";el("fRole").value="user";el("fPass").value="";el("fPass").placeholder="at least 8 characters";
  el("mErr").className="err";el("modal").className="modal on";el("fUser").focus();}
function openEdit(id){var u=users.filter(function(x){return x.id===id;})[0];if(!u)return;editId=id;
  el("mTitle").textContent="Edit "+u.username;el("mSub").textContent="Leave the password blank to keep it unchanged.";
  el("wrapUser").style.display="none";el("wrapActive").style.display="";el("lPass").textContent="New password (optional)";
  el("fName").value=u.name||"";el("fRole").value=u.role;el("fActive").value=u.active?"1":"0";
  el("fPass").value="";el("fPass").placeholder="leave blank to keep current";
  el("mErr").className="err";el("modal").className="modal on";el("fName").focus();}
function closeModal(){el("modal").className="modal";}
async function save(){
  var err=el("mErr"),btn=el("mSave");err.className="err";btn.disabled=true;btn.textContent="Saving…";
  var d;
  if(editId===null){
    d=await post("/api/users/add",{username:el("fUser").value,name:el("fName").value,role:el("fRole").value,password:el("fPass").value});
  }else{
    var body={id:editId,name:el("fName").value,role:el("fRole").value,active:el("fActive").value==="1"};
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
el("tb").addEventListener("click",function(e){
  var ed=e.target.closest("[data-edit]");if(ed){openEdit(+ed.dataset.edit);return;}
  var dl=e.target.closest("[data-del]");if(dl&&!dl.disabled){del(+dl.dataset.del);return;}});
el("mFields").addEventListener("keydown",function(e){if(e.key==="Enter")save();});
load();
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
<header><div class="dot" id="dot"></div><h1>Order Command Center</h1><span class="conn" id="conn">connecting…</span><div class="spacer"></div><span class="meta" id="meta"></span><a class="navlink" href="/aliases">Aliases</a><a class="navlink" href="/match">Order Matching →</a></header>
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
  .spacer{flex:1}.navlink{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600}.navlink:hover{text-decoration:underline}
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
  .chatcol{width:280px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;flex-shrink:0;min-height:0}
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
  .thread{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--chatbg)}
  .threadhead{padding:9px 16px;background:#f0f2f5;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
  .threadhead .tt{font-weight:600;font-size:15px;color:var(--tx)}
  .btn{background:var(--blue);color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:filter .15s,transform .05s,border-color .15s,color .15s;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:default;filter:none}
  .btn.green{background:var(--em)}
  .btn.ghost{background:#0000;border:1px solid var(--line);color:var(--mut)}.btn.ghost:hover{border-color:var(--blue);color:var(--blue);filter:none}
  .iconbtn{width:34px;height:34px;padding:0;justify-content:center;font-size:13px}
  .msgs{flex:1;overflow-y:auto;padding:12px 6% 22px;display:flex;flex-direction:column;gap:0;background:var(--chatbg)}
  .daysep{align-self:center;margin:14px 0 8px}
  .daysep span{background:#fff;color:#54656f;font-size:12.5px;font-weight:500;padding:5px 12px;border-radius:8px;box-shadow:0 1px .5px rgba(11,20,26,.13)}
  .bubble{position:relative;max-width:65%;min-width:96px;padding:6px 9px 8px;border-radius:7.5px;font-size:14.2px;line-height:19px;box-shadow:0 1px .5px rgba(11,20,26,.13);margin-top:8px}
  .bubble.grp{margin-top:2px}
  .in{align-self:flex-start;background:#fff;border-top-left-radius:0}
  .out{align-self:flex-end;background:var(--wa);border-top-right-radius:0}
  .bubble.grp.in{border-top-left-radius:7.5px}.bubble.grp.out{border-top-right-radius:7.5px}
  .in:not(.grp)::before{content:"";position:absolute;top:0;left:-8px;border-top:8px solid #fff;border-left:8px solid transparent}
  .out:not(.grp)::before{content:"";position:absolute;top:0;right:-8px;border-top:8px solid var(--wa);border-right:8px solid transparent}
  .who{font-size:12.8px;font-weight:600;margin-bottom:2px;line-height:1.2}
  .tx{white-space:pre-wrap;word-break:break-word}
  /* @mention: WhatsApp renders these as non-clickable coloured text (read-only here by design). */
  .mn{color:#027eb5;font-weight:500}
  /* Quoted reply block, shown above the text inside the same bubble (WhatsApp layout). */
  .q{display:flex;background:rgba(0,0,0,.055);border-radius:6px;overflow:hidden;margin-bottom:4px}
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
  .right{width:clamp(340px,32%,520px);flex-shrink:0;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:16px;background:var(--bg)}
  /* Narrow desktop / tablet: give the thread even more of the remaining width. */
  @media (max-width:1100px){
    .chatcol{width:240px}
    .right{width:clamp(300px,34%,420px)}
  }
  /* Phone: three side-by-side columns cannot work — stack them and scroll the page. */
  @media (max-width:860px){
    body{overflow:auto}
    header{flex-wrap:wrap;gap:8px 10px;padding:10px 14px}
    header h1{font-size:14px}
    .wrap{flex-direction:column;min-height:0}
    .left{flex:none;flex-direction:column;border-right:0}
    .chatcol{width:100%;max-height:38vh;border-right:0;border-bottom:1px solid var(--line)}
    .thread{min-height:60vh}
    .right{width:100%;flex:none;border-top:1px solid var(--line)}
    .bubble{max-width:86%}
    .msgs{padding:12px 12px 20px}
  }
  .sect h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin:0 0 10px}
  .row{border:1px solid var(--line);border-radius:12px;margin-bottom:8px;background:var(--panel);border-left:3px solid var(--line);transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 2px #0000000f;overflow:hidden}
  .row.matched{border-left-color:var(--em)}.row.unmatched{border-left-color:var(--amber)}.row.resolved{border-left-color:var(--em)}
  .row.open{box-shadow:0 2px 8px #00000014}
  .row .top{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}
  .row .top:hover{background:#f9fbfd}
  .qty{width:52px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:6px;font-size:13px;text-align:center;outline:none;flex-shrink:0}
  .qty:focus{border-color:var(--blue)}
  .pinfo{flex:1;min-width:0}
  .pmain{font-size:13px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cust{font-size:11px;color:var(--mut);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cust b{color:var(--em2);font-weight:600}
  .code{color:var(--blue);font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;font-weight:600}
  .sep{color:var(--mut);margin:0 3px}
  .exp{color:var(--mut);font-size:11px;flex-shrink:0;transition:transform .2s,color .2s}
  .row.open .exp{transform:rotate(90deg);color:var(--blue)}
  .expand{max-height:0;opacity:0;overflow:hidden;transition:max-height .25s ease,opacity .25s ease}
  .expand.show{max-height:320px;opacity:1}
  .expand .inner{padding:0 12px 12px}
  .psearch{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;transition:border-color .15s}
  .psearch:focus{border-color:var(--blue)}
  .results{margin-top:8px;max-height:220px;overflow-y:auto;border:1px solid var(--line);border-radius:8px}
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
<header><h1>WhatsApp Order Matching</h1><span class="muted" id="catmeta"></span><div class="spacer"></div><span class="live" id="live" title="WhatsApp connection"><span class="ldot"></span><span id="livetx">connecting…</span></span><span class="user" title="${esc(me.name || me.username)}">${esc(me.username)}</span>${me.role === 'admin' ? '<a class="navlink" href="/admin">Users</a>' : ''}<a class="navlink" href="#" onclick="omsLogout();return false">Sign out</a></header>
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
      <div class="threadhead"><span id="threadtitle" class="muted">Select a chat</span><button class="btn iconbtn ghost" id="renamebtn" disabled title="Rename this chat">&#9998;</button><div class="spacer"></div><span class="muted" id="navlabel" style="display:none">extracted</span><button class="btn iconbtn ghost" id="navprev" title="Previous extracted message">&#9650;</button><button class="btn iconbtn ghost" id="navnext" title="Next extracted message">&#9660;</button></div>
      <div class="msgs" id="msgs"><div class="placeholder">Pick a conversation on the left.</div></div>
      <div class="mentionbox" id="mbox"></div>
      <div class="composer" id="composer">
        <textarea id="cinput" rows="1" placeholder="Type a message…  (Enter to send · Shift+Enter for a new line)" disabled></textarea>
        <button class="sendbtn" id="sendbtn" disabled title="Send">➤</button>
      </div>
    </div>
  </div>
  <div class="right" id="right"><div class="placeholder">Click <b>Extract</b> on any customer message to add its products here.</div></div>
</div>
<script>
var chats=[],curChat=null,items=[],active={},sources=[],proc={},procBy={},openIdx=null,lastSig="",mentionMap={};
var meName=${JSON.stringify(me.name || me.username)},appUsers=[];
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
function jidName(j){if(!j)return"";var id=String(j).split("@")[0].split(":")[0];return mentionMap[id]||"";}
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
function quoteHtml(m){
  if(!m.replyText&&!m.replySender)return"";
  var who=jidName(m.replySender)||"Message";
  var body=m.replyText?fmtBody(m.replyText):'<span class="qm">Media</span>';
  return '<div class="q"><div class="qbar"></div><div class="qin"><div class="qn">'+esc(who)+'</div><div class="qt">'+body+'</div></div></div>';
}
function renderThread(ms){var pk=null,pd=null,o=[];for(var i=0;i<ms.length;i++){var m=ms[i];var out=isOut(m);var sk=out?"~out~":(m.sender||m.pushName||"?");var day=m.ts?dayKeyOf(m.ts):"";var nd=day!==pd;var grp=!nd&&sk===pk;if(nd&&m.ts)o.push('<div class="daysep"><span>'+esc(dayLabel(m.ts))+'</span></div>');pd=day;pk=sk;// Attribution: the server's sent_by record is authoritative; the text signature is only a
// fallback for messages sent before attribution moved into the database.
var sig=splitSignature(m.text||"",out);var sentBy=m.sentBy||sig.by;
var body=sig.body||(m.hasMedia?("["+(m.kind||"media")+"]"):(m.text?"":"["+(m.kind||"msg")+"]"));var xable=(!out&&m.text&&!isBareUrl(m.text));if(xable&&m.processed){proc[m.messageId]=true;if(m.processedBy)procBy[m.messageId]=m.processedBy;}var mid=esc(m.messageId);var nm=(!out&&m.isGroup&&!grp)?'<div class="who" style="color:'+nameColor(sk)+'">'+esc(m.pushName||"~")+'</div>':"";var ck=out?'<span class="ck">✓✓</span>':"";var hr=m.reactions&&m.reactions.length;var re=hr?'<div class="react">'+reactSummary(m.reactions)+'</div>':"";var sentTag=sentBy?'<div class="sentby">Sent by <b>'+esc(sentBy)+'</b></div>':"";
var inner=nm+quoteHtml(m)+'<div class="tx">'+fmtBody(body)+'</div>'+sentTag+'<div class="metarow"><span class="sb" style="display:none"></span><span class="meta">'+esc(fmtTime(m.ts))+ck+'</span></div>'+(xable?'<div class="xrow"><button class="xbtn" data-mid="'+mid+'">Extract</button></div>':"")+re;o.push('<div class="bubble '+(out?"out":"in")+(grp?" grp":"")+(xable?" xable":"")+(hr?" hasreact":"")+'" data-mid="'+mid+'">'+inner+'</div>');}return o.join("");}
// Live thread auto-refresh: re-poll the open chat, re-render only when messages/reactions change.
function threadSig(ms){if(!ms.length)return"0";var last=ms[ms.length-1],rc=0;for(var i=0;i<ms.length;i++)rc+=(ms[i].reactions?ms[i].reactions.length:0);return ms.length+"|"+last.messageId+"|"+rc;}
async function refreshThread(){var cid=curChat;if(!cid)return;if(document.querySelector(".msgs .bubble.busy"))return;try{var d=await(await fetch("/api/chats/"+encodeURIComponent(cid)+"/messages")).json();if(cid!==curChat)return;var ms=d.messages||[];if(d.mentions)mentionMap=d.mentions;if(d.appUsers)appUsers=d.appUsers;var sig=threadSig(ms);if(sig===lastSig)return;lastSig=sig;var mb=el("msgs");var atBottom=(mb.scrollHeight-mb.scrollTop-mb.clientHeight)<80;var prev=mb.scrollTop;el("msgs").innerHTML=ms.length?renderThread(ms):el("msgs").innerHTML;applyStates();mb.scrollTop=atBottom?mb.scrollHeight:prev;}catch(e){}}

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
async function selectChat(id){curChat=id;items=[];active={};sources=[];proc={};procBy={};navIdx=-1;renderChats();renderRight();el("renamebtn").disabled=false;drafted=[];hideMentions();syncComposer();loadParticipants(id);var t=(chats.find(function(c){return c.id===id;})||{}).title||id;el("threadtitle").textContent=t;el("threadtitle").className="tt";var d=await(await fetch("/api/chats/"+encodeURIComponent(id)+"/messages")).json();var ms=d.messages||[];if(d.mentions)mentionMap=d.mentions;if(d.appUsers)appUsers=d.appUsers;el("msgs").innerHTML=ms.length?renderThread(ms):'<div class="placeholder">No messages captured for this chat yet. Messages are stored from the moment they arrive; older history is not available.</div>';lastSig=threadSig(ms);applyStates();renderRight();var mb=el("msgs");mb.scrollTop=mb.scrollHeight;}

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
    if(sb){if(done&&!on){var by=procBy[mid];sb.className="sb d";sb.textContent=by?("✓ Processed by "+by):"✓ Processed";sb.style.display="";}
      else{sb.style.display="none";sb.textContent="";}}
    var btn=b.querySelector(".xbtn");
    if(btn&&!busy){btn.disabled=false;btn.classList.toggle("on",on);btn.classList.toggle("done",done&&!on);
      btn.textContent=on?"Extracted ✓":(done?"Re-Extract":"Extract");}
  }
  var any=document.querySelectorAll(".msgs .bubble.ext, .msgs .bubble.done").length;
  el("navlabel").style.display=any?"":"none";
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
    var add=(d.items||[]).map(function(it){return {mid:mid,phrase:it.phrase,quantity:it.quantity||"1",matched:it.matched,chosen:it.matched||null,suggestions:it.suggestions||[],results:[]};});
    items=items.concat(add);rebuildSources();renderRight();
  }catch(e){}
  finally{if(b)b.classList.remove("busy");applyStates();}
}
// Whole bubble is the extract trigger (button included, since it lives inside .xable).
el("msgs").addEventListener("click",function(e){var b=e.target.closest(".xable");if(b&&!b.classList.contains("busy"))toggleExtract(b.dataset.mid);});
// Jump between extracted/processed messages in a long thread.
var navIdx=-1;
function navExtracted(dir){var list=Array.prototype.slice.call(document.querySelectorAll(".msgs .bubble.ext, .msgs .bubble.done"));if(!list.length)return;navIdx+=dir;if(navIdx<0)navIdx=list.length-1;if(navIdx>=list.length)navIdx=0;var t=list[navIdx];t.scrollIntoView({behavior:"smooth",block:"center"});t.classList.remove("flash");void t.offsetWidth;t.classList.add("flash");}
el("navprev").addEventListener("click",function(){navExtracted(-1);});
el("navnext").addEventListener("click",function(){navExtracted(1);});

el("renamebtn").addEventListener("click",async function(){if(!curChat)return;var cur=(chats.find(function(c){return c.id===curChat;})||{}).title||"";var name=window.prompt("Chat name:",cur);if(!name||!name.trim())return;await fetch("/api/chats/rename",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,name:name.trim()})});await loadChats();el("threadtitle").textContent=name.trim();});

el("chatlist").addEventListener("click",function(e){var r=e.target.closest(".chatrow");if(r)selectChat(r.dataset.id);});
el("chatsearch").addEventListener("input",renderChats);

// One compact row: qty + primary line; chosen rows also show "↳ Customer wrote: <text>".
// The whole header is clickable to expand an inline search (accordion, one open at a time).
function rowHtml(i){
  var it=items[i],ch=it.chosen;
  var cls=ch?(it.matched?"matched":"resolved"):"unmatched";
  var head=ch
    ? '<div class="pinfo"><div class="pmain">'+fmt(ch)+'</div><div class="cust">&#8627; <b>Customer wrote:</b> '+esc(it.phrase)+(it.learned?' <span class="learned">learned &#10003;</span>':'')+'</div></div>'
    : '<div class="pinfo"><div class="pmain">'+esc(it.phrase)+'</div></div>';
  var top='<div class="top" data-idx="'+i+'"><input class="qty" data-idx="'+i+'" value="'+esc(it.quantity)+'">'+head+'<span class="exp">&#9656;</span></div>';
  var body='<div class="expand"><div class="inner"><input class="psearch" data-idx="'+i+'" placeholder="search products…" autocomplete="off"><div class="results" data-res="'+i+'"></div></div></div>';
  return '<div class="row '+cls+'" data-row="'+i+'">'+top+body+'</div>';
}
function renderRight(){
  openIdx=null;
  if(!items.length){el("right").innerHTML='<div class="placeholder">'+(sources.length?"No products found in the selected message(s).":"Click Extract on a customer message to begin.")+'</div>';return;}
  var matched=[],unmatched=[];
  items.forEach(function(it,i){(it.chosen?matched:unmatched).push(i);});
  var h='<div class="sect"><h2>Matched ('+matched.length+')</h2>';
  h+=matched.length?matched.map(rowHtml).join(""):'<div class="muted" style="font-size:12px;padding:0 2px 8px">None yet — resolve items below.</div>';
  h+='</div><div class="sect"><h2>Unmatched ('+unmatched.length+')</h2>';
  h+=unmatched.length?unmatched.map(rowHtml).join(""):'<div class="muted" style="font-size:12px;padding:0 2px 8px">All items matched.</div>';
  h+='</div><div class="finalbox"><div class="h"><h2>Final Order</h2><div style="display:flex;gap:8px"><button class="btn ghost" id="clearbtn">Clear</button><button class="btn green" id="copybtn">Copy</button></div></div><table><thead><tr><th style="width:54px">Qty</th><th style="width:118px">SKU</th><th>Product</th><th style="width:30px" aria-label="remove"></th></tr></thead><tbody id="finalbody"></tbody></table></div>';
  el("right").innerHTML=h;
  updateFinal();
}
// Accordion: expand one row's inline search, fade/slide in, auto-focus, collapse any other.
function renderResults(i,list){var box=el("right").querySelector('.results[data-res="'+i+'"]');if(!box)return;box.innerHTML=(list&&list.length)?list.slice(0,5).map(function(p){return '<button class="opt" data-idx="'+i+'" data-code="'+esc(p.code)+'">'+fmt(p)+'</button>';}).join(""):'<div class="noopt">No suggestions — type to search.</div>';}
function collapseRow(){if(openIdx==null)return;var row=el("right").querySelector('.row[data-row="'+openIdx+'"]');if(row){row.classList.remove("open");var ex=row.querySelector(".expand");if(ex)ex.classList.remove("show");}openIdx=null;}
function expandRow(i){
  if(openIdx===i){collapseRow();return;}
  collapseRow();openIdx=i;
  var row=el("right").querySelector('.row[data-row="'+i+'"]');if(!row)return;
  row.classList.add("open");
  var ex=row.querySelector(".expand");void ex.offsetWidth;ex.classList.add("show"); // reflow → transition = fade/slide in
  renderResults(i,items[i].suggestions||[]);
  var ps=row.querySelector(".psearch");if(ps)ps.focus();
}
function findProduct(i,code){var it=items[i];var pool=(it.results||[]).concat(it.suggestions||[]);for(var k=0;k<pool.length;k++)if(pool[k].code===code)return pool[k];return null;}
function choose(i,code){var p=findProduct(i,code);if(!p)return;var learn=!items[i].matched;items[i].chosen=p;items[i].learned=learn;if(learn){fetch("/api/alias",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phrase:items[i].phrase,code:p.code,description:p.description})}).then(function(){loadCat();}).catch(function(){});}openIdx=null;renderRight();}
function updateFinal(){var body=el("finalbody");if(!body)return;var html="";items.forEach(function(it,i){if(!it.chosen)return;html+='<tr><td>'+esc(it.quantity)+'</td><td><span class="code">'+esc(it.chosen.code)+'</span></td><td>'+esc(it.chosen.description)+'</td><td style="text-align:right"><button class="rmfinal" data-idx="'+i+'" title="Remove — move back to Unmatched" aria-label="Remove">&#10005;</button></td></tr>';});body.innerHTML=html||'<tr><td colspan="4" class="muted">Resolve products to build the order.</td></tr>';}

// Typing in a row's search: <2 chars falls back to its suggestions; else live catalog search into .results.
var doSearch=debounce(async function(i,q){if(!q||q.length<2){renderResults(i,items[i].suggestions||[]);return;}try{var d=await(await fetch("/api/products/search?limit=6&q="+encodeURIComponent(q))).json();items[i].results=d.results||[];var box=el("right").querySelector('.results[data-res="'+i+'"]');if(box)box.innerHTML=items[i].results.length?items[i].results.map(function(p){return '<button class="opt" data-idx="'+i+'" data-code="'+esc(p.code)+'">'+fmt(p)+'</button>';}).join(""):'<div class="noopt">No matches.</div>';}catch(e){}},220);

el("right").addEventListener("input",function(e){var t=e.target;if(t.classList.contains("qty")){items[t.dataset.idx].quantity=t.value;updateFinal();}else if(t.classList.contains("psearch")){doSearch(t.dataset.idx,t.value);}});
el("right").addEventListener("click",function(e){
  var o=e.target.closest(".opt");if(o){choose(o.dataset.idx,o.dataset.code);return;}
  var rm=e.target.closest(".rmfinal");if(rm){var ri=+rm.dataset.idx;if(items[ri]){items[ri].chosen=null;items[ri].learned=false;}renderRight();return;}
  if(e.target.closest("#clearbtn")){clearOrder();return;}
  if(e.target.closest("#copybtn")){copyCsv();return;}
  if(e.target.closest(".psearch")||e.target.closest(".expand"))return; // don't toggle when interacting inside the open panel
  var top=e.target.closest(".top");
  if(top&&!e.target.closest(".qty"))expandRow(+top.dataset.idx);
});
// Clear = discard the current extraction and reset the right panel (bubbles revert to Extract/Re-Extract).
// Does NOT touch the database — nothing is un-processed; it just wipes the unsaved working order.
function clearOrder(){active={};items=[];rebuildSources();renderRight();applyStates();}
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

// --- composer: send a message into the open chat (human-initiated, one at a time) ---
var sending=false;
function autoGrow(){var t=el("cinput");t.style.height="auto";t.style.height=Math.min(t.scrollHeight,120)+"px";}
function syncComposer(){var on=!!curChat&&!sending;el("cinput").disabled=!on;el("sendbtn").disabled=!on||!el("cinput").value.trim();}
async function sendMsg(){
  var t=el("cinput"),txt=t.value.trim();
  if(!curChat||!txt||sending)return;
  sending=true;syncComposer();el("sendbtn").textContent="…";
  var res=resolveDraft(txt);
  try{
    var r=await fetch("/api/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,text:res.text,mentions:res.mentions})});
    var d=await r.json();
    if(d.ok){t.value="";drafted=[];autoGrow();lastSig="";refreshThread();}   // clear + pull the sent message in
    else{alert(d.error||"Could not send the message.");}
  }catch(e){alert("Network error — the message was not sent.");}
  sending=false;el("sendbtn").textContent="➤";syncComposer();t.focus();
}
el("sendbtn").addEventListener("click",sendMsg);
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

loadCat();loadChats();setInterval(loadChats,6000);setInterval(refreshThread,4000);
</script></body></html>`;
}

// --- Product Alias Management page (at /aliases) ---
function aliasPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Product Alias Management</title>
<style>
  :root{color-scheme:light;
    --bg:#f0f2f5;--panel:#ffffff;--line:#e5e7eb;
    --em:#10b981;--em2:#059669;--emdim:#d1fae5;--blue:#2563eb;--amber:#d97706;--red:#dc2626;
    --tx:#111b21;--mut:#667781}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
  ::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#00000026;border-radius:6px}
  header{display:flex;align-items:center;gap:12px;padding:13px 20px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:0 1px 3px #0000001a;position:sticky;top:0;z-index:5}
  header h1{font-size:16px;margin:0;font-weight:700}
  .spacer{flex:1}.navlink{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600}.navlink:hover{text-decoration:underline}
  .muted{color:var(--mut);font-size:12px}
  .wrap{max-width:1000px;margin:0 auto;padding:20px 18px}
  .toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .search{flex:1;min-width:220px;position:relative}
  .search input{width:100%;padding:11px 13px 11px 34px;background:var(--panel);border:1px solid var(--line);color:var(--tx);border-radius:10px;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
  .search input:focus{border-color:var(--blue);box-shadow:0 0 0 3px #2563eb1f}
  .search .ic{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--mut);font-size:15px}
  .count{font-size:13px;color:var(--mut);white-space:nowrap}
  .cardbox{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 2px 8px #0000000f}
  table{width:100%;border-collapse:collapse;font-size:14px}
  thead th{text-align:left;padding:11px 14px;background:#f8fafc;border-bottom:1px solid var(--line);color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
  tbody td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}tbody tr{transition:background .12s}tbody tr:hover{background:#f7f9fc}
  .sku{font-family:ui-monospace,SFMono-Regular,monospace;color:var(--blue);font-weight:600;font-size:13px}
  .pill{display:inline-block;min-width:26px;text-align:center;background:var(--emdim);color:var(--em2);border:1px solid #a7f3d0;border-radius:20px;padding:2px 10px;font-size:12px;font-weight:700}
  .pill.zero{background:#f1f5f9;color:var(--mut);border-color:var(--line)}
  .tright{text-align:right}
  .btn{background:var(--blue);color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:filter .15s,transform .05s;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:default;filter:none}
  .btn.sm{padding:6px 12px;font-size:12px}
  .btn.green{background:var(--em)}.btn.ghost{background:#0000;border:1px solid var(--line);color:var(--mut)}.btn.ghost:hover{border-color:var(--blue);color:var(--blue)}
  .btn.danger{background:var(--red)}
  .pager{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 4px;font-size:13px;color:var(--mut)}
  .pager .pg{display:flex;gap:8px;align-items:center}
  .empty{padding:40px 16px;text-align:center;color:var(--mut);font-size:14px;line-height:1.6}
  .spinner{width:22px;height:22px;border:3px solid #0000001a;border-top-color:var(--blue);border-radius:50%;display:inline-block;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .loadrow{padding:34px;text-align:center}
  .prow{cursor:pointer}
  .prow .chev{display:inline-block;color:var(--mut);font-size:12px;transition:transform .22s,color .22s}
  .prow.open{background:#eef4fb}.prow.open:hover{background:#eef4fb}.prow.open .chev{transform:rotate(90deg);color:var(--blue)}
  .drow>td{padding:0;border-bottom:1px solid var(--line);background:#f8fafc}
  .detail{opacity:0;transform:translateY(-6px);transition:opacity .3s ease,transform .3s ease}
  .detail.show{opacity:1;transform:translateY(0)}
  .detail .inner{padding:14px 16px}
  .detail h3{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);margin:0 0 10px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;min-height:22px;align-items:center}
  .chip{display:inline-flex;align-items:center;gap:5px;background:#f8fafc;border:1px solid var(--line);border-radius:20px;padding:5px 6px 5px 12px;font-size:13px;transition:border-color .12s,box-shadow .12s}
  .chip:hover{border-color:#c9d3e0;box-shadow:0 1px 3px #0000000f}
  .chip .txt{color:var(--tx)}
  .chip .ib{background:#0000;border:0;cursor:pointer;font-size:12px;line-height:1;padding:3px 4px;border-radius:50%;color:var(--mut)}
  .chip .ib:hover{background:#e8eef7;color:var(--blue)}
  .chip .ib.del:hover{background:#fde8e8;color:var(--red)}
  .chip input{border:1px solid var(--blue);border-radius:14px;padding:3px 8px;font-size:13px;outline:none;width:130px}
  .padd{margin-top:16px;display:flex;gap:8px}
  .padd input{flex:1;padding:9px 11px;background:#f8fafc;border:1px solid var(--line);color:var(--tx);border-radius:9px;font-size:13px;outline:none}
  .padd input:focus{border-color:var(--blue)}
  .pempty{color:var(--mut);font-size:13px;padding:8px 0}
  .toasts{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:40}
  .toast{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--em);border-radius:10px;padding:11px 14px;font-size:13px;box-shadow:0 4px 14px #00000022;min-width:220px;max-width:340px;animation:slidein .2s ease}
  .toast.err{border-left-color:var(--red)}
  @keyframes slidein{from{transform:translateX(20px);opacity:0}to{transform:translateX(0);opacity:1}}
  .modal{position:fixed;inset:0;background:#0f172a66;display:none;align-items:center;justify-content:center;z-index:50;padding:16px}
  .modal.on{display:flex}
  .modal .box{background:var(--panel);border-radius:14px;padding:20px;max-width:360px;width:100%;box-shadow:0 12px 40px #00000033}
  .modal h4{margin:0 0 8px;font-size:16px}
  .modal p{margin:0 0 18px;color:var(--mut);font-size:14px;line-height:1.5;word-break:break-word}
  .modal .r{display:flex;justify-content:flex-end;gap:10px}
</style></head><body>
<header><h1>Product Alias Management</h1><span class="muted" id="stat"></span><div class="spacer"></div><a class="navlink" href="/">Order Matching</a></header>
<div class="wrap">
  <div class="toolbar">
    <div class="search"><span class="ic">&#9906;</span><input id="q" placeholder="Search by SKU, product name, or alias…" autocomplete="off"></div>
    <span class="count" id="count"></span>
  </div>
  <div class="cardbox"><table><thead><tr><th style="width:150px">SKU</th><th>Product Name</th><th style="width:96px">Aliases</th><th style="width:104px" class="tright">Actions</th></tr></thead><tbody id="tbody"></tbody></table></div>
  <div class="pager"><span id="pinfo"></span><span class="pg"><button class="btn ghost sm" id="prev">&#8249; Prev</button><button class="btn ghost sm" id="next">Next &#8250;</button></span></div>
</div>
<div class="toasts" id="toasts"></div>
<div class="modal" id="modal"><div class="box"><h4>Delete alias?</h4><p id="mText"></p><div class="r"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn danger" id="mOk">Delete</button></div></div></div>
<script>
var q="",page=1,limit=25,total=0,curCode=null,curAliases=[],curDetail=null;
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function debounce(fn,ms){var t;return function(){var a=arguments,x=this;clearTimeout(t);t=setTimeout(function(){fn.apply(x,a);},ms);};}
function toast(msg,type){var t=document.createElement('div');t.className='toast'+(type==='err'?' err':'');t.textContent=msg;el('toasts').appendChild(t);setTimeout(function(){t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(function(){t.remove();},300);},2600);}
async function post(url,body){try{return await(await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();}catch(e){return {ok:false,error:'Network error'};}}

async function loadList(){
  curCode=null;curDetail=null; // any expanded row is destroyed when tbody re-renders
  el('tbody').innerHTML='<tr><td colspan="4" class="loadrow"><span class="spinner"></span></td></tr>';
  try{
    var d=await(await fetch('/api/aliases?q='+encodeURIComponent(q)+'&page='+page+'&limit='+limit)).json();
    total=d.total||0;var rows=d.rows||[];
    if(!rows.length){el('tbody').innerHTML='<tr><td colspan="4"><div class="empty">'+(q?'No products match &ldquo;'+esc(q)+'&rdquo;.':'No products have aliases yet.<br>Search for a product above to add its first alias.')+'</div></td></tr>';}
    else{el('tbody').innerHTML=rows.map(function(r){var z=r.count?'':' zero';return '<tr class="prow" data-code="'+esc(r.code)+'" data-name="'+esc(r.description||'')+'"><td><span class="sku">'+esc(r.code||'—')+'</span></td><td>'+esc(r.description||'')+'</td><td><span class="pill'+z+'">'+r.count+'</span></td><td class="tright"><span class="chev">&#9656;</span></td></tr>';}).join('');}
    var pages=Math.max(1,Math.ceil(total/limit));
    el('pinfo').textContent=total?('Page '+page+' of '+pages+' · '+total+' product'+(total===1?'':'s')):'';
    el('count').textContent=total?(total+' result'+(total===1?'':'s')):'';
    el('prev').disabled=page<=1;el('next').disabled=page>=pages;
  }catch(e){el('tbody').innerHTML='<tr><td colspan="4"><div class="empty">Failed to load. Is the service running?</div></td></tr>';}
}
async function loadStat(){try{var d=await(await fetch('/api/products/count')).json();el('stat').textContent=(d.count||0).toLocaleString()+' products · '+(d.aliases||0)+' aliases';}catch(e){}}
function updateRowCount(code,n){var rows=el('tbody').querySelectorAll('tr[data-code]');for(var i=0;i<rows.length;i++){if(rows[i].getAttribute('data-code')===code){var p=rows[i].querySelector('.pill');if(p){p.textContent=n;p.className='pill'+(n?'':' zero');}return;}}}

el('q').addEventListener('input',debounce(function(){q=el('q').value.trim();page=1;loadList();},250));
el('prev').addEventListener('click',function(){if(page>1){page--;loadList();}});
el('next').addEventListener('click',function(){page++;loadList();});
// Click a product row to expand its aliases inline (accordion: one open at a time, fade in/out).
el('tbody').addEventListener('click',function(e){var tr=e.target.closest('.prow');if(tr)toggleRow(tr);});

function collapse(){
  if(!curDetail)return;
  var d=curDetail,dt=d.querySelector('.detail');
  var openTr=el('tbody').querySelector('.prow.open');if(openTr)openTr.classList.remove('open');
  if(dt)dt.classList.remove('show');               // fade out
  setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d);},300);
  curDetail=null;curCode=null;curAliases=[];
}
function toggleRow(tr){
  var code=tr.getAttribute('data-code');
  if(curCode===code){collapse();return;}           // clicking the open row closes it
  collapse();                                        // close any other open row
  curCode=code;curAliases=[];tr.classList.add('open');
  var drow=document.createElement('tr');drow.className='drow';
  drow.innerHTML='<td colspan="4"><div class="detail"><div class="inner"><h3>Aliases (<span class="pCount">0</span>)</h3><div class="chips"><span class="spinner"></span></div><div class="pempty" style="display:none">No aliases yet — add the first one below.</div><div class="padd"><input class="newAlias" placeholder="Enter new alias…" maxlength="255" autocomplete="off"><button class="btn green addBtn">Add Alias</button></div></div></div></td>';
  tr.after(drow);curDetail=drow;
  var dt=drow.querySelector('.detail');void dt.offsetWidth;dt.classList.add('show'); // reflow commits opacity:0, then transition to 1 = fade in
  drow.querySelector('.chips').addEventListener('click',chipClick);
  drow.querySelector('.addBtn').addEventListener('click',addAlias);
  drow.querySelector('.newAlias').addEventListener('keydown',function(e){if(e.key==='Enter')addAlias();});
  loadAliases(code);
}
async function loadAliases(code){try{var d=await(await fetch('/api/aliases/product?code='+encodeURIComponent(code))).json();if(curCode!==code)return;curAliases=d.aliases||[];renderChips();}catch(e){if(curDetail)curDetail.querySelector('.chips').innerHTML='';toast('Failed to load aliases','err');}}
function renderChips(){
  if(!curDetail)return;
  curDetail.querySelector('.pCount').textContent=curAliases.length;
  curDetail.querySelector('.pempty').style.display=curAliases.length?'none':'block';
  curDetail.querySelector('.chips').innerHTML=curAliases.map(function(a,i){return '<span class="chip" data-i="'+i+'"><span class="txt">'+esc(a.text)+'</span><button class="ib edit" title="Edit" data-i="'+i+'">&#9998;</button><button class="ib del" title="Delete" data-i="'+i+'">&#128465;</button></span>';}).join('');
  updateRowCount(curCode,curAliases.length);
}
function chipClick(e){var ed=e.target.closest('.edit');if(ed){startEdit(+ed.dataset.i);return;}var dl=e.target.closest('.del');if(dl){askDelete(+dl.dataset.i);return;}}
function startEdit(i){
  if(!curDetail)return;var chip=curDetail.querySelector('.chip[data-i="'+i+'"]');if(!chip)return;var a=curAliases[i];
  chip.innerHTML='<input value="'+esc(a.text)+'" maxlength="255"><button class="ib save" title="Save">&#10003;</button><button class="ib cancel" title="Cancel">&#10005;</button>';
  var inp=chip.querySelector('input');inp.focus();inp.select();
  function done(save){if(save){commitEdit(i,inp.value);}else{renderChips();}}
  chip.querySelector('.save').addEventListener('click',function(){done(true);});
  chip.querySelector('.cancel').addEventListener('click',function(){done(false);});
  inp.addEventListener('keydown',function(ev){if(ev.key==='Enter'){done(true);}else if(ev.key==='Escape'){done(false);}});
}
async function commitEdit(i,val){var a=curAliases[i],code=curCode;var text=val.trim();if(text===a.text){renderChips();return;}var d=await post('/api/aliases/edit',{code:code,oldNorm:a.norm,alias:text});if(d.ok){curAliases=d.aliases;renderChips();toast('Alias updated');}else{toast(d.error||'Edit failed','err');renderChips();}}
function askDelete(i){var a=curAliases[i],code=curCode;el('mText').textContent='Delete alias “'+a.text+'”?';el('modal').classList.add('on');el('mOk').onclick=async function(){el('modal').classList.remove('on');var d=await post('/api/aliases/delete',{code:code,norm:a.norm});if(d.ok){curAliases=d.aliases;renderChips();loadStat();toast('Alias deleted');}else{toast('Delete failed','err');}};}
el('mCancel').addEventListener('click',function(){el('modal').classList.remove('on');});
el('modal').addEventListener('click',function(e){if(e.target===el('modal'))el('modal').classList.remove('on');});

async function addAlias(){if(!curDetail)return;var inp=curDetail.querySelector('.newAlias');var btn=curDetail.querySelector('.addBtn');var text=inp.value.trim();if(!text){toast('Alias cannot be empty','err');return;}btn.disabled=true;var d=await post('/api/aliases/add',{code:curCode,alias:text});btn.disabled=false;if(d.ok){curAliases=d.aliases;renderChips();inp.value='';inp.focus();loadStat();toast('Alias added');}else{toast(d.error||'Add failed','err');}}

loadStat();loadList();
</script></body></html>`;
}
