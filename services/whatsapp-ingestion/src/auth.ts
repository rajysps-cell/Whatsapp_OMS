import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { logger } from './logger';
import { db } from './store';

/**
 * Multi-user auth for the OMS: scrypt-hashed passwords, server-side sessions, roles, and
 * brute-force throttling. Zero dependencies (node:crypto + the shared SQLite handle).
 *
 * The site sends WhatsApp messages as the business, so every page and API is gated — an
 * unauthenticated request must never reach anything but /login.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name         TEXT NOT NULL DEFAULT '',
    pass_hash    TEXT NOT NULL,
    salt         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'user',
    active       INTEGER NOT NULL DEFAULT 1,
    must_change  INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_login   INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS login_attempts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    ts       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attempts ON login_attempts(username, ts);
`);

// --- two-step verification (meeting 31-07) ---
// One-time codes go to the user's EMAIL (the client rejected authenticator apps: first-time
// registration is friction his staff will not do). A device that has passed a code once carries a
// long-lived cookie and is not asked again — "every time someone logs in from a new device, the
// first time, I need two-step verification". That first-time rule also covers the
// outside-the-network case: behind the Cloudflare Tunnel every request reaches this process from
// 127.0.0.1, so the ONLY trustworthy signal is the device cookie, not the network address.
try {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
} catch {
  /* column already exists */
}
// Which WhatsApp this user works through: 'common' = the shared business account (default),
// 'personal' = their own linked WhatsApp — they scan a QR and see ONLY their account's chats.
try {
  db.exec("ALTER TABLE users ADD COLUMN wa_mode TEXT NOT NULL DEFAULT 'common'");
} catch {
  /* column already exists */
}
// The user's save-emoji: when they save an order, this reacts onto the customer's message.
// Empty = a unique default is picked from a pool by user id.
try {
  db.exec("ALTER TABLE users ADD COLUMN emoji TEXT NOT NULL DEFAULT ''");
} catch {
  /* column already exists */
}
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_logins (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trusted_devices (
    user_id     INTEGER NOT NULL,
    device_hash TEXT NOT NULL,
    user_agent  TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_hash)
  );
`);

export type Role = 'admin' | 'user';
export interface User {
  id: number;
  username: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  mustChange: boolean;
  createdAt: number;
  lastLogin: number | null;
  /** 'common' = shared business WhatsApp; 'personal' = their own linked account. */
  waMode: 'common' | 'personal';
  /** Save-emoji: reacted onto the customer's message when this user saves an order. */
  emoji: string;
}

interface UserRow {
  id: number;
  username: string;
  name: string;
  email: string;
  pass_hash: string;
  salt: string;
  role: string;
  active: number;
  must_change: number;
  created_at: number;
  last_login: number | null;
  wa_mode: string | null;
  emoji: string | null;
}

const SESSION_DAYS = 14;
const MAX_FAILS = 8; // per username within the window
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    email: r.email ?? '',
    role: r.role === 'admin' ? 'admin' : 'user',
    active: !!r.active,
    mustChange: !!r.must_change,
    createdAt: r.created_at,
    lastLogin: r.last_login,
    waMode: r.wa_mode === 'personal' ? 'personal' : 'common',
    emoji: r.emoji ?? '',
  };
}

/**
 * scrypt with a per-user random salt. Never store or log the plaintext password.
 *
 * ASYNC on purpose: scryptSync costs ~32ms and this process also runs the WhatsApp ingestion
 * client, so hashing on the main thread let unauthenticated /login traffic stall message capture.
 * The async form runs on the libuv threadpool and keeps the event loop free.
 */
function hash(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, dk) => (err ? reject(err) : resolve(dk.toString('hex'))));
  });
}
/** Sync variant, used only at first-run seeding where nothing is serving traffic yet. */
function hashSync(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}
async function verifyHash(password: string, salt: string, expected: string): Promise<boolean> {
  const a = Buffer.from(await hash(password, salt), 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b); // constant-time: no timing oracle on the hash
}
/** Sessions are stored hashed, so a leaked DB can't be replayed as a live cookie. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function validatePassword(pw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = String(pw ?? '');
  if (s.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (s.length > 200) return { ok: false, error: 'Password is too long.' };
  return { ok: true, value: s };
}
/**
 * Letters and numbers only — no spaces, no punctuation. Messages sent from the app are signed
 * "-- <username>", and that line is parsed back out to attribute the message, so anything that
 * could contain a space or look like punctuation would make the signature ambiguous.
 */
export function validateUsername(u: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = String(u ?? '').trim();
  if (!s) return { ok: false, error: 'Username is required.' };
  if (!/^[a-zA-Z0-9]{3,32}$/.test(s)) {
    return { ok: false, error: 'Username must be 3-32 letters or numbers — no spaces or symbols.' };
  }
  return { ok: true, value: s };
}

/** Empty is allowed (2FA simply stays off for that user until an admin fills it in). */
export function validateEmail(e: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = String(e ?? '').trim();
  if (!s) return { ok: true, value: '' };
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) {
    return { ok: false, error: 'That does not look like an email address.' };
  }
  return { ok: true, value: s };
}

/** Every account name, used to recognise the "-- <username>" signature on outgoing messages. */
export function allUsernames(): string[] {
  return (db.prepare('SELECT username FROM users').all() as Array<{ username: string }>).map((r) => r.username);
}

// --- users ---
const insUser = db.prepare(
  'INSERT INTO users (username, name, pass_hash, salt, role, active, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
const getByName = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const getById = db.prepare('SELECT * FROM users WHERE id = ?');
// Single-quotes: SQLite treats "admin" as an identifier, not a string literal.
const listStmt = db.prepare("SELECT * FROM users ORDER BY (role = 'admin') DESC, username ASC");
const countAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1");
const delUserStmt = db.prepare('DELETE FROM users WHERE id = ?');
const touchLogin = db.prepare('UPDATE users SET last_login = ? WHERE id = ?');

export function listUsers(): User[] {
  return (listStmt.all() as unknown as UserRow[]).map(toUser);
}
export function getUser(id: number): User | null {
  const r = getById.get(id) as UserRow | undefined;
  return r ? toUser(r) : null;
}
export function userExists(username: string): boolean {
  return getByName.get(username) !== undefined;
}
export function activeAdminCount(): number {
  return (countAdmins.get() as { n: number }).n;
}

export function createUser(
  username: string,
  password: string,
  name: string,
  role: Role,
  mustChange = false,
  email = '',
  waMode: 'common' | 'personal' = 'common',
  emoji = '',
): User {
  const salt = randomBytes(16).toString('hex');
  const now = Date.now();
  insUser.run(username, name || username, hashSync(password, salt), salt, role, 1, mustChange ? 1 : 0, now);
  if (email) db.prepare('UPDATE users SET email=? WHERE username=?').run(email, username);
  if (waMode !== 'common') db.prepare('UPDATE users SET wa_mode=? WHERE username=?').run(waMode, username);
  if (emoji) db.prepare('UPDATE users SET emoji=? WHERE username=?').run(emoji.slice(0, 8), username);
  const r = getByName.get(username) as unknown as UserRow;
  logger.info({ username, role }, 'user created');
  return toUser(r);
}

/** Partial update. Only provided fields change; password is re-hashed with a fresh salt. */
export function updateUser(
  id: number,
  patch: { name?: string; role?: Role; active?: boolean; password?: string; email?: string; waMode?: 'common' | 'personal'; emoji?: string },
): void {
  const cur = getById.get(id) as UserRow | undefined;
  if (!cur) return;
  const name = patch.name !== undefined ? patch.name : cur.name;
  const role = patch.role !== undefined ? patch.role : cur.role;
  const active = patch.active !== undefined ? (patch.active ? 1 : 0) : cur.active;
  const email = patch.email !== undefined ? patch.email : (cur.email ?? '');
  const waMode = patch.waMode !== undefined ? patch.waMode : (cur.wa_mode === 'personal' ? 'personal' : 'common');
  const emoji = patch.emoji !== undefined ? patch.emoji.slice(0, 8) : (cur.emoji ?? '');
  if (patch.password) {
    const salt = randomBytes(16).toString('hex');
    // must_change=1: an admin-set password is known to the admin, so the user must replace it at
    // next sign-in. (The user's own self-service change clears the flag.)
    db.prepare('UPDATE users SET name=?, role=?, active=?, email=?, wa_mode=?, emoji=?, pass_hash=?, salt=?, must_change=1 WHERE id=?').run(
      name,
      role,
      active,
      email,
      waMode,
      emoji,
      hashSync(patch.password, salt),
      salt,
      id,
    );
    // A password change invalidates that user's other sessions.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  } else {
    db.prepare('UPDATE users SET name=?, role=?, active=?, email=?, wa_mode=?, emoji=? WHERE id=?').run(name, role, active, email, waMode, emoji, id);
  }
  if (patch.active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  logger.info({ id, role, active: !!active, passwordChanged: !!patch.password }, 'user updated');
}

export function deleteUser(id: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM pending_logins WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(id);
  // Per-user leftovers: read markers and (for a personal account) its chat membership. Without
  // this a deleted user's rows linger forever and a recycled id would inherit them.
  db.prepare('DELETE FROM chat_reads WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM account_chats WHERE account = ?').run(`u${id}`);
  delUserStmt.run(id);
  logger.info({ id }, 'user deleted');
}

// --- brute-force throttle ---
// The hard lock is keyed on the CALLER's ip, never on the username: locking by username lets any
// stranger lock a real user out by spamming their name. Usernames are lower-cased before they touch
// this table because users.username is COLLATE NOCASE while this column is BINARY — without
// normalising, 'Admin' and 'admin' would each get their own private allowance.
try {
  db.exec("ALTER TABLE login_attempts ADD COLUMN ip TEXT NOT NULL DEFAULT ''");
} catch {
  /* column already exists */
}
db.exec('CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, ts)');

const insAttempt = db.prepare('INSERT INTO login_attempts (username, ip, ts) VALUES (?, ?, ?)');
const countByIp = db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ip <> '' AND ts > ?");
const countByUser = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ts > ?');
const clearAttempts = db.prepare('DELETE FROM login_attempts WHERE username = ?');

/** Locked when THIS caller has burned through the allowance (never because of someone else's failures). */
export function isLockedOut(ip: string): boolean {
  if (!ip) return false;
  return (countByIp.get(ip, Date.now() - FAIL_WINDOW_MS) as { n: number }).n >= MAX_FAILS;
}
/** Per-account failure count — used only to slow a spread-out attack, never to refuse a good password. */
function userFailCount(username: string): number {
  return (countByUser.get(username, Date.now() - FAIL_WINDOW_MS) as { n: number }).n;
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; error: string };

export async function login(usernameRaw: unknown, passwordRaw: unknown, ip = ''): Promise<LoginResult> {
  const username = String(usernameRaw ?? '').trim();
  const key = username.toLowerCase();
  const password = String(passwordRaw ?? '');
  if (!username || !password) return { ok: false, error: 'Enter your username and password.' };
  if (isLockedOut(ip)) {
    return { ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' };
  }
  // Reject impossible usernames BEFORE spending a scrypt: this is the cheap guard that stops an
  // unauthenticated flood from consuming threadpool time (and bloating login_attempts).
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    insAttempt.run(key.slice(0, 32), ip, Date.now());
    return { ok: false, error: 'Incorrect username or password.' };
  }
  const row = getByName.get(username) as UserRow | undefined;
  // Same generic message whether the user exists or the password is wrong (no account enumeration).
  const fail = (): LoginResult => {
    insAttempt.run(key, ip, Date.now());
    return { ok: false, error: 'Incorrect username or password.' };
  };
  if (!row) {
    await hash(password, 'decoy-salt-for-constant-work'); // constant work: a missing user isn't faster
    return fail();
  }
  if (!(await verifyHash(password, row.salt, row.pass_hash))) return fail();
  // Correct password, but this account has been under attack — add a small delay rather than refusing.
  if (userFailCount(key) >= MAX_FAILS) await new Promise((r) => setTimeout(r, 1500));
  if (!row.active) return { ok: false, error: 'This account is disabled. Contact an administrator.' };
  clearAttempts.run(key);
  touchLogin.run(Date.now(), row.id);
  return { ok: true, user: toUser(row) };
}

/** Confirm a user's current password (for the change-password flow). Never records a failed attempt. */
export async function verifyPassword(id: number, password: string): Promise<boolean> {
  const r = getById.get(id) as UserRow | undefined;
  if (!r) return false;
  return verifyHash(String(password ?? ''), r.salt, r.pass_hash);
}

/** Set a new password for a user (used by the forced first-login change). */
/** End every login session of one user — used when their WhatsApp mode changes. */
export function signOutUser(id: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}

export function changePassword(id: number, password: string, keepToken?: string): void {
  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash=?, salt=?, must_change=0 WHERE id=?').run(
    hashSync(password, salt),
    salt,
    id,
  );
  // Drop every other session for this user; optionally keep the caller's current one.
  if (keepToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(id, tokenHash(keepToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  logger.info({ id }, 'password changed');
}

// --- sessions ---
const insSession = db.prepare(
  'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)',
);
const getSessionStmt = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?');
const touchSession = db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?');
const delSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');

export function createSession(userId: number): string {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  insSession.run(tokenHash(token), userId, now, now + SESSION_DAYS * 86_400_000, now);
  return token;
}

/** Resolve a cookie token to its (still active) user, or null. Expired rows are cleaned up. */
export function sessionUser(token: string | null): User | null {
  if (!token) return null;
  const th = tokenHash(token);
  const s = getSessionStmt.get(th) as { user_id: number; expires_at: number } | undefined;
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    delSession.run(th);
    return null;
  }
  const u = getUser(s.user_id);
  if (!u || !u.active) return null;
  touchSession.run(Date.now(), th);
  return u;
}

export function destroySession(token: string | null): void {
  if (token) delSession.run(tokenHash(token));
}

/** Purge expired sessions and stale throttle rows (cheap, called on boot). */
export function cleanupAuth(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(Date.now() - FAIL_WINDOW_MS);
}

/**
 * First run: make sure an admin exists. Password comes from ADMIN_PASSWORD if set, otherwise a
 * random one is generated and logged ONCE — the account is flagged must_change either way.
 */
export function ensureSeedAdmin(): void {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (n > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  const fromEnv = process.env.ADMIN_PASSWORD;
  const password = fromEnv || randomBytes(9).toString('base64url');
  createUser(username, password, 'Administrator', 'admin', true);
  if (fromEnv) {
    logger.warn({ username }, 'seed admin created from ADMIN_PASSWORD — change it after first login');
    return;
  }
  // Never log the password: logs rotate into files that are easy to copy and were not gitignored.
  // Write it to the (gitignored) store dir instead, owner-readable, and log only the location.
  const file = path.join(config.storeDir, 'first-login.txt');
  try {
    fs.mkdirSync(config.storeDir, { recursive: true });
    fs.writeFileSync(
      file,
      `WhatsApp OMS - first login\r\n\r\n  Username: ${username}\r\n  Password: ${password}\r\n\r\n` +
        `You will set your own password at first sign-in. Delete this file afterwards.\r\n`,
      { mode: 0o600 },
    );
    logger.warn({ username, file }, 'FIRST-RUN ADMIN CREATED — one-time password written to file');
  } catch (err) {
    logger.error({ err, file }, 'could not write the first-login file — set ADMIN_PASSWORD and restart');
  }
}

// --- two-step verification: one-time codes, pending logins, trusted devices ---
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const DEVICE_DAYS = 365;

/**
 * Password accepted but a code is still owed: park the login in pending_logins and hand back a
 * short-lived token. No session exists yet — the session is only minted by verifyOtp, so a stolen
 * pending cookie without the emailed code is worthless.
 */
export function createPendingLogin(userId: number): { token: string; code: string } {
  const token = randomBytes(32).toString('hex');
  // 6 digits from a CSPRNG. randomInt-style rejection is overkill at this size: 2^32 % 900000
  // bias is ~0.005%, irrelevant against a 5-attempt cap.
  const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
  const now = Date.now();
  db.prepare('DELETE FROM pending_logins WHERE user_id = ?').run(userId); // one pending login per user
  db.prepare(
    'INSERT INTO pending_logins (token_hash, user_id, code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)',
  ).run(tokenHash(token), userId, tokenHash(code), now, now + OTP_TTL_MS);
  return { token, code };
}

export interface PendingInfo {
  userId: number;
  createdAt: number;
}
export function pendingLogin(token: string | null): PendingInfo | null {
  if (!token) return null;
  const r = db.prepare('SELECT user_id, created_at, expires_at FROM pending_logins WHERE token_hash = ?').get(tokenHash(token)) as
    | { user_id: number; created_at: number; expires_at: number }
    | undefined;
  if (!r) return null;
  if (r.expires_at < Date.now()) {
    db.prepare('DELETE FROM pending_logins WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  return { userId: r.user_id, createdAt: r.created_at };
}

export type OtpResult = { ok: true; user: User } | { ok: false; error: string; gone?: boolean };

/** Check the emailed code. Consumes the pending login on success OR when attempts run out. */
export function verifyOtp(token: string | null, code: unknown): OtpResult {
  const bad = { ok: false as const, error: 'That code is not right. Check the newest email.' };
  if (!token) return { ok: false, error: 'This sign-in expired — start again.', gone: true };
  const th = tokenHash(token);
  const r = db.prepare('SELECT user_id, code_hash, attempts, expires_at FROM pending_logins WHERE token_hash = ?').get(th) as
    | { user_id: number; code_hash: string; attempts: number; expires_at: number }
    | undefined;
  if (!r || r.expires_at < Date.now()) {
    db.prepare('DELETE FROM pending_logins WHERE token_hash = ?').run(th);
    return { ok: false, error: 'This sign-in expired — start again.', gone: true };
  }
  if (r.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM pending_logins WHERE token_hash = ?').run(th);
    return { ok: false, error: 'Too many wrong codes — start again.', gone: true };
  }
  const given = String(code ?? '').replace(/\D/g, '');
  const a = Buffer.from(tokenHash(given), 'hex');
  const b = Buffer.from(r.code_hash, 'hex');
  if (!given || a.length !== b.length || !timingSafeEqual(a, b)) {
    db.prepare('UPDATE pending_logins SET attempts = attempts + 1 WHERE token_hash = ?').run(th);
    return bad;
  }
  db.prepare('DELETE FROM pending_logins WHERE token_hash = ?').run(th);
  const u = getUser(r.user_id);
  if (!u || !u.active) return { ok: false, error: 'This account is disabled.', gone: true };
  touchLogin.run(Date.now(), u.id);
  return { ok: true, user: u };
}

/** Replace the code on an existing pending login (the "resend" button). ~30s throttle. */
export function resendOtp(token: string | null): { ok: true; code: string; user: User } | { ok: false; error: string } {
  const p = pendingLogin(token);
  if (!p) return { ok: false, error: 'This sign-in expired — start again.' };
  const last = db.prepare('SELECT created_at FROM pending_logins WHERE token_hash = ?').get(tokenHash(token!)) as
    | { created_at: number }
    | undefined;
  if (last && Date.now() - last.created_at < 30_000) return { ok: false, error: 'Just sent — give it a few seconds.' };
  const u = getUser(p.userId);
  if (!u || !u.active) return { ok: false, error: 'This account is disabled.' };
  const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
  db.prepare('UPDATE pending_logins SET code_hash = ?, attempts = 0, created_at = ? WHERE token_hash = ?').run(
    tokenHash(code),
    Date.now(),
    tokenHash(token!),
  );
  return { ok: true, code, user: u };
}

/** Is this browser already trusted for this user? (Refreshes last_seen when yes.) */
export function deviceTrusted(userId: number, deviceToken: string | null): boolean {
  if (!deviceToken) return false;
  const dh = tokenHash(deviceToken);
  const r = db.prepare('SELECT last_seen FROM trusted_devices WHERE user_id = ? AND device_hash = ?').get(userId, dh) as
    | { last_seen: number }
    | undefined;
  if (!r) return false;
  db.prepare('UPDATE trusted_devices SET last_seen = ? WHERE user_id = ? AND device_hash = ?').run(Date.now(), userId, dh);
  return true;
}

/** Remember this browser after a passed code. Returns the token to set as the device cookie. */
export function trustDevice(userId: number, existingToken: string | null, userAgent: string): string {
  const token = existingToken || randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO trusted_devices (user_id, device_hash, user_agent, created_at, last_seen) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(user_id, device_hash) DO UPDATE SET last_seen = excluded.last_seen',
  ).run(userId, tokenHash(token), userAgent.slice(0, 200), now, now);
  return token;
}

/** Admin reset: the user's next sign-in on every browser asks for a code again. */
export function revokeDevices(userId: number): number {
  const n = db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(userId).changes;
  logger.info({ userId, devices: n }, 'trusted devices revoked');
  return Number(n);
}

// --- cookies ---
export const COOKIE = 'oms_session';
export const PENDING_COOKIE = 'oms_pending';
export const DEVICE_COOKIE = 'oms_device';

export function pendingCookie(token: string, secure: boolean): string {
  return `${PENDING_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=${Math.floor(OTP_TTL_MS / 1000)}`;
}
export function clearPendingCookie(secure: boolean): string {
  return `${PENDING_COOKIE}=; HttpOnly; Path=/; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=0`;
}
/** Long-lived on purpose, and NOT cleared on logout: it says "this browser passed a code once",
 *  which stays true across sessions — clearing it would re-ask a code on every sign-out. */
export function deviceCookie(token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=${DEVICE_DAYS * 86400}`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      // A malformed percent-escape must not throw: it would 500 every route including /login,
      // leaving the browser with no way to recover except clearing cookies by hand.
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}
/**
 * HttpOnly + SameSite=Lax (blocks cross-site POST), plus Secure when the request actually came
 * over HTTPS. Secure must be conditional: a browser silently DROPS a Secure cookie on plain
 * http://localhost:3009 (direct access on the server), which locks the user out of their own box.
 */
export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=${SESSION_DAYS * 86400}`;
}
export function clearCookie(secure: boolean): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=0`;
}
