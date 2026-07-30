import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import { logger } from './logger';

// Zero-dependency persistence via Node's built-in SQLite (Node 22.5+/24).
// Exported so auth.ts shares this one connection (avoids a second writer on the same file).
export const db = new DatabaseSync(config.dbPath, { timeout: 5000 });
// WAL + a busy timeout so a reader (backup, monitoring, an operator opening the file) cannot make
// the next write throw. Without these an incoming WhatsApp message is caught, logged and lost.
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS aliases (
    phrase_norm  TEXT PRIMARY KEY,
    product_code TEXT NOT NULL,
    product_desc TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS processed (
    message_id   TEXT PRIMARY KEY,
    chat_id      TEXT,
    processed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_names (
    chat_id    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    msg_id    TEXT PRIMARY KEY,
    chat_id   TEXT NOT NULL,
    sender    TEXT,
    push_name TEXT,
    body      TEXT,
    kind      TEXT,
    from_me   INTEGER NOT NULL DEFAULT 0,
    is_group  INTEGER NOT NULL DEFAULT 0,
    ts        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
  -- Messages this app sent, and who sent them. Authoritative attribution: recorded at send time
  -- rather than parsed out of the message text, so the outgoing message can stay clean and
  -- nobody can fake it by typing a signature.
  CREATE TABLE IF NOT EXISTS sent_by (
    msg_id   TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    ts       INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reactions (
    msg_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    emoji  TEXT NOT NULL,
    ts     INTEGER NOT NULL,
    PRIMARY KEY (msg_id, sender)
  );
  CREATE TABLE IF NOT EXISTS catalog_chats (
    chat_id  TEXT PRIMARY KEY,
    name     TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_ts  INTEGER NOT NULL DEFAULT 0,
    unread   INTEGER NOT NULL DEFAULT 0,
    alt_id   TEXT
  );
`);

// Added columns on existing tables (idempotent-by-catch: they already exist after one run).
// processed.message_text/items = extraction trace; aliases.alias_text = original display text
// for the Alias Management page (matching still keys on the normalized phrase_norm).
for (const [table, col] of [
  ['processed', 'message_text TEXT'],
  ['processed', 'items TEXT'],
  ['processed', 'processed_by TEXT'], // display name of the user who completed the order
  ['aliases', 'alias_text TEXT'],
  ['messages', 'reply_to TEXT'],
  ['messages', 'reply_text TEXT'],
  ['messages', 'reply_sender TEXT'],
  // Tombstone, NOT a row delete: history backfill re-INSERTs on every reconnect (INSERT OR
  // IGNORE), so a deleted row would quietly come back. A flagged row stays put and stays hidden.
  ['messages', 'deleted INTEGER NOT NULL DEFAULT 0'],
] as const) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

const insAlias = db.prepare(
  'INSERT OR IGNORE INTO aliases (phrase_norm, product_code, product_desc, created_at, alias_text) VALUES (?, ?, ?, ?, ?)',
);
const getAliasStmt = db.prepare('SELECT product_code, product_desc FROM aliases WHERE phrase_norm = ?');
const countAliasStmt = db.prepare('SELECT COUNT(*) AS n FROM aliases');
// Alias Management page queries.
const aliasCountsStmt = db.prepare('SELECT product_code AS code, COUNT(*) AS n, MAX(product_desc) AS desc FROM aliases GROUP BY product_code');
const aliasesForProductStmt = db.prepare('SELECT phrase_norm AS norm, alias_text AS text, created_at AS createdAt FROM aliases WHERE product_code = ? ORDER BY created_at ASC, phrase_norm ASC');
const aliasCodesMatchStmt = db.prepare('SELECT DISTINCT product_code AS code FROM aliases WHERE lower(COALESCE(alias_text, phrase_norm)) LIKE ? OR phrase_norm LIKE ?');
const getAliasRowStmt = db.prepare('SELECT product_code AS code, product_desc AS desc, alias_text AS text FROM aliases WHERE phrase_norm = ?');
const delAliasStmt = db.prepare('DELETE FROM aliases WHERE phrase_norm = ?');
const updAliasTextStmt = db.prepare('UPDATE aliases SET alias_text = ? WHERE phrase_norm = ?');
const insProcessed = db.prepare(
  'INSERT OR REPLACE INTO processed (message_id, chat_id, processed_at, message_text, items, processed_by) VALUES (?, ?, ?, ?, ?, ?)',
);
const insSentBy = db.prepare('INSERT OR REPLACE INTO sent_by (msg_id, username, ts) VALUES (?, ?, ?)');
const chatSentByStmt = db.prepare(
  'SELECT s.msg_id AS id, s.username AS who FROM sent_by s ' +
    'JOIN messages m ON m.msg_id = s.msg_id WHERE m.chat_id = ?',
);

/** Record that this app sent a message, and which user sent it. */
export function recordSentBy(msgId: string, username: string): void {
  if (!msgId || !username) return;
  insSentBy.run(msgId, username, Date.now());
}

/** The OMS user this app recorded as the sender of a message, or null (phone-typed / pre-attribution). */
export function sentByOf(msgId: string): string | null {
  const r = db.prepare('SELECT username FROM sent_by WHERE msg_id = ?').get(msgId) as { username: string } | undefined;
  return r?.username ?? null;
}

/** One message row, for the delete/forward endpoints. */
export function getMessage(msgId: string): { chatId: string; kind: string; body: string; fromMe: boolean } | null {
  const r = db.prepare('SELECT chat_id, kind, body, from_me FROM messages WHERE msg_id = ?').get(msgId) as
    | { chat_id: string; kind: string; body: string | null; from_me: number }
    | undefined;
  return r ? { chatId: r.chat_id, kind: r.kind, body: r.body ?? '', fromMe: !!r.from_me } : null;
}

/** Delete-for-me: hide the message from every OMS view. WhatsApp on phones still shows it. */
export function markDeleted(msgId: string): void {
  db.prepare('UPDATE messages SET deleted = 1 WHERE msg_id = ?').run(msgId);
}

/** Delete-for-everyone landed (from this app or someone's phone): render the WhatsApp placeholder. */
export function markRevoked(msgId: string): void {
  db.prepare("UPDATE messages SET kind = 'revoked', body = '' WHERE msg_id = ?").run(msgId);
}

// Who completed each message in a chat, for the "Processed by …" badge in the thread.
const chatProcessedStmt = db.prepare(
  'SELECT p.message_id AS id, p.processed_by AS who FROM processed p ' +
    'JOIN messages m ON m.msg_id = p.message_id WHERE m.chat_id = ?',
);
const isProcessedStmt = db.prepare('SELECT 1 FROM processed WHERE message_id = ?');
const setChatNameStmt = db.prepare(
  'INSERT INTO chat_names (chat_id, name, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
);
const getChatNameStmt = db.prepare('SELECT name FROM chat_names WHERE chat_id = ?');

const insMessage = db.prepare(
  'INSERT OR IGNORE INTO messages (msg_id, chat_id, sender, push_name, body, kind, from_me, is_group, ts, reply_to, reply_text, reply_sender) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
// Latest message per chat (window fn), newest chat first. Powers the /match chat list.
const listChatsStmt = db.prepare(`
  SELECT chat_id, is_group, cnt, ts AS last_ts, body AS last_text, kind FROM (
    SELECT chat_id, is_group, body, kind, ts,
      COUNT(*) OVER (PARTITION BY chat_id) AS cnt,
      ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY ts DESC, msg_id DESC) AS rn
    FROM messages
  ) WHERE rn = 1
  ORDER BY last_ts DESC
  LIMIT 1000
`);
const upsertCatalogStmt = db.prepare(
  'INSERT INTO catalog_chats (chat_id, name, is_group, last_ts, unread, alt_id) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, last_ts = excluded.last_ts, ' +
    'unread = excluded.unread, alt_id = excluded.alt_id',
);
const catalogAllStmt = db.prepare('SELECT chat_id, name, is_group, last_ts, unread, alt_id FROM catalog_chats');
// WhatsApp's own protocol traffic (encryption notices, group-membership events, call logs) is
// stored but has neither text nor media, so it rendered as a blank bubble AND ate a slot in the
// LIMIT window below, pushing real messages out of the thread. Drop the content-free ones only:
// anything with a body, and every media kind, still shows.
const SYSTEM_KINDS = [
  'unknown',
  'e2e_notification',
  'gp2',
  'notification_template',
  'call_log',
  'message_history_notice',
  'biz_content_placeholder',
  'interactive',
];
const chatMsgsStmt = db.prepare(`
  SELECT msg_id, sender, push_name, body, kind, from_me, is_group, ts, reply_to, reply_text, reply_sender FROM (
    SELECT msg_id, sender, push_name, body, kind, from_me, is_group, ts, reply_to, reply_text, reply_sender
    FROM messages
    WHERE chat_id = ?
      AND deleted = 0
      AND NOT (COALESCE(body, '') = '' AND kind IN (${SYSTEM_KINDS.map((k) => `'${k}'`).join(',')}))
    ORDER BY ts DESC, msg_id DESC LIMIT ?
  ) ORDER BY ts ASC, msg_id ASC
`);
// Emoji reactions, keyed by (target message, reactor). Upsert on react, delete on un-react (empty emoji).
const upsertReactionStmt = db.prepare(
  'INSERT INTO reactions (msg_id, sender, emoji, ts) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(msg_id, sender) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts',
);
const delReactionStmt = db.prepare('DELETE FROM reactions WHERE msg_id = ? AND sender = ?');
const chatReactionsStmt = db.prepare(
  "SELECT r.msg_id AS msg_id, r.emoji AS emoji FROM reactions r " +
    "JOIN messages m ON m.msg_id = r.msg_id WHERE m.chat_id = ? AND r.emoji <> '' ORDER BY r.ts ASC",
);

export interface AliasHit {
  code: string;
  desc: string;
}

/** Save a learned mapping (customer text -> product). Dedup on the normalized phrase.
 *  `text` is the original display alias (falls back to the normalized phrase). */
export function addAlias(phraseNorm: string, code: string, desc: string, text?: string): void {
  if (!phraseNorm || !code) return;
  insAlias.run(phraseNorm, code, desc, Date.now(), (text ?? phraseNorm) || null);
}
export function getAlias(phraseNorm: string): AliasHit | null {
  const r = getAliasStmt.get(phraseNorm) as { product_code: string; product_desc: string } | undefined;
  return r ? { code: r.product_code, desc: r.product_desc } : null;
}
export function aliasCount(): number {
  return (countAliasStmt.get() as { n: number }).n;
}

// --- Alias Management page ---
export interface AliasRow {
  norm: string;
  text: string;
  createdAt: number;
}
/** One entry per product that has aliases: its code, alias count, and a stored description. */
export function aliasCountsByCode(): Array<{ code: string; n: number; desc: string }> {
  return aliasCountsStmt.all() as Array<{ code: string; n: number; desc: string }>;
}
/** All aliases for one product, oldest first. `text` falls back to the normalized phrase. */
export function aliasesForProduct(code: string): AliasRow[] {
  const rows = aliasesForProductStmt.all(code) as Array<{ norm: string; text: string | null; createdAt: number }>;
  return rows.map((r) => ({ norm: r.norm, text: r.text ?? r.norm, createdAt: r.createdAt }));
}
/** Product codes whose alias text (or normalized phrase) contains the lowercase query. */
export function aliasCodesMatching(qLower: string): Set<string> {
  const like = `%${qLower}%`;
  const rows = aliasCodesMatchStmt.all(like, like) as Array<{ code: string }>;
  return new Set(rows.map((r) => r.code));
}
export function getAliasRow(norm: string): { code: string; desc: string; text: string } | null {
  const r = getAliasRowStmt.get(norm) as { code: string; desc: string; text: string | null } | undefined;
  return r ? { code: r.code, desc: r.desc, text: r.text ?? norm } : null;
}
export function deleteAlias(norm: string): boolean {
  return (delAliasStmt.run(norm).changes ?? 0) > 0;
}
/** Casing/punctuation-only edit that keeps the same normalized phrase. */
export function updateAliasText(norm: string, text: string): void {
  updAliasTextStmt.run(text || null, norm);
}

/** Mark a message processed, recording its text and the final matched items (JSON) for traceability. */
export function saveExtraction(
  messageId: string,
  chatId: string,
  messageText: string,
  itemsJson: string,
  processedBy?: string,
): void {
  if (!messageId) return;
  insProcessed.run(messageId, chatId, Date.now(), messageText || null, itemsJson || null, processedBy || null);
}
export function isProcessed(messageId: string): boolean {
  return isProcessedStmt.get(messageId) !== undefined;
}

export function setChatName(chatId: string, name: string): void {
  if (!chatId || !name) return;
  setChatNameStmt.run(chatId, name, Date.now());
}
export function getChatName(chatId: string): string | null {
  const r = getChatNameStmt.get(chatId) as { name: string } | undefined;
  return r ? r.name : null;
}

export interface ChatRow {
  id: string;
  title: string;
  lastText: string;
  lastTs: number;
  count: number;
  isGroup: boolean;
  unread: number;
}

export interface CatalogChat {
  id: string;
  name: string;
  isGroup: boolean;
  lastTs: number;
  unread: number;
  altId: string | null;
}

/** Refresh the full-chat catalog (from WhatsApp Web's IndexedDB). */
export function upsertCatalog(rows: CatalogChat[]): void {
  for (const r of rows) {
    if (!r.id) continue;
    upsertCatalogStmt.run(r.id, r.name || null, r.isGroup ? 1 : 0, r.lastTs, r.unread, r.altId);
  }
}
export interface MsgRow {
  messageId: string;
  sender: string;
  pushName?: string;
  text: string;
  kind: string;
  fromMe: boolean;
  ts: number;
  isGroup: boolean;
  /** Emoji reactions applied to this message (one entry per reactor). */
  reactions: string[];
  /** Quoted-reply context, when this message replies to another. */
  replyText?: string;
  replySender?: string;
  /** Display name of the user who marked this message processed (Copy), if any. */
  processedBy?: string;
  /** Username who sent this message from the app (recorded at send time). */
  sentBy?: string;
}

// --- @mention names ------------------------------------------------------------------
// Message bodies contain mentions as the raw user id ('@272103391686822'). Resolve each id to a
// display name so the UI can show '@Zali - YS - Sales Rep'. Built once and memoized: it is a
// global map (~70 rows) and the thread endpoint is polled every 4s per open tab.
const mentionFromMsgsStmt = db.prepare(`
  SELECT substr(sender, 1, COALESCE(NULLIF(instr(sender, ':'), 0), instr(sender, '@')) - 1) AS id,
         push_name AS name, COUNT(*) AS n
    FROM messages
   WHERE instr(sender, '@') > 1 AND trim(COALESCE(push_name, '')) <> ''
   GROUP BY id, name
`);
const mentionFromCatalogStmt = db.prepare(`
  SELECT substr(chat_id, 1, instr(chat_id, '@') - 1) AS id, name FROM catalog_chats
   WHERE is_group = 0 AND instr(chat_id, '@') > 1 AND trim(COALESCE(name, '')) <> ''
  UNION ALL
  SELECT substr(alt_id, 1, instr(alt_id, '@') - 1) AS id, name FROM catalog_chats
   WHERE is_group = 0 AND instr(COALESCE(alt_id, ''), '@') > 1 AND trim(COALESCE(name, '')) <> ''
`);

// Who can be @-mentioned in a given chat. WhatsApp's own participant list isn't reachable (the
// Store APIs are broken), so derive it from everyone who has actually spoken in the chat — which
// is exactly who staff would want to tag.
const chatSendersStmt = db.prepare(
  "SELECT sender, MAX(ts) AS last_ts FROM messages WHERE chat_id = ? AND sender <> '' AND from_me = 0 GROUP BY sender ORDER BY last_ts DESC",
);

export interface Participant {
  /** Bare numeric id — this is what goes in the message text after '@'. */
  id: string;
  /** Full JID (…@lid / …@c.us) — this is what goes in the mentions array. */
  jid: string;
  name: string;
}

export function chatParticipants(chatId: string): Participant[] {
  const names = mentionNames();
  const seen = new Set<string>();
  const out: Participant[] = [];
  for (const r of chatSendersStmt.all(chatId) as Array<{ sender: string; last_ts: number }>) {
    const jid = r.sender;
    const at = jid.indexOf('@');
    if (at < 1) continue;
    const domain = jid.slice(at); // keep @lid vs @c.us — mentioning the wrong one won't resolve
    const id = jid.slice(0, at).split(':')[0] ?? ''; // drop any device suffix (123:45@lid)
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, jid: id + domain, name: names[id] || id });
  }
  return out;
}

let mentionCache: { at: number; map: Record<string, string> } | null = null;

/** id -> display name for @mentions. Cached for 60s. */
export function mentionNames(): Record<string, string> {
  if (mentionCache && Date.now() - mentionCache.at < 60_000) return mentionCache.map;
  const map: Record<string, string> = {};
  // Catalog names first (stable contact names), then the most-frequent pushName wins any gap.
  for (const r of mentionFromCatalogStmt.all() as Array<{ id: string; name: string }>) {
    if (r.id && r.name && !map[r.id]) map[r.id] = r.name;
  }
  const byCount = (mentionFromMsgsStmt.all() as Array<{ id: string; name: string; n: number }>).sort(
    (a, b) => b.n - a.n,
  );
  for (const r of byCount) {
    if (r.id && r.name && !map[r.id]) map[r.id] = r.name;
  }
  mentionCache = { at: Date.now(), map };
  return map;
}

function tail(id: string): string {
  return id.replace(/@.*$/, '').slice(-14);
}

export interface SaveMsg {
  messageId: string;
  chatId: string;
  sender: string;
  pushName?: string;
  text?: string;
  kind?: string;
  fromMe: boolean;
  isGroup: boolean;
  ts: number;
  /** Quoted message this one replies to (WhatsApp reply context). */
  replyTo?: string;
  replyText?: string;
  replySender?: string;
}
/** Persist one captured message (dedup on WhatsApp message id). */
export function saveMessage(m: SaveMsg): void {
  if (!m.messageId || !m.chatId) return;
  insMessage.run(
    m.messageId,
    m.chatId,
    m.sender || null,
    m.pushName ?? null,
    m.text ?? '',
    m.kind ?? 'text',
    m.fromMe ? 1 : 0,
    m.isGroup ? 1 : 0,
    m.ts,
    m.replyTo ?? null,
    m.replyText ?? null,
    m.replySender ?? null,
  );
}

// Live unread tracking. The 10-min IndexedDB catalog sync is the authority, but waiting up to
// 10 min for a badge feels broken — so mirror what WhatsApp itself does between syncs: bump on an
// inbound message, clear when our own account replies (sending marks a chat read). The next
// catalog sync overwrites both with WhatsApp's truth (e.g. after the phone reads a chat).
const bumpUnreadStmt = db.prepare(
  'UPDATE catalog_chats SET unread = unread + 1, last_ts = MAX(last_ts, ?) WHERE chat_id = ? OR alt_id = ?',
);
const clearUnreadStmt = db.prepare('UPDATE catalog_chats SET unread = 0 WHERE chat_id = ? OR alt_id = ?');

/** An inbound message arrived: show it as unread immediately (WhatsApp does the same). */
export function bumpUnread(chatId: string, ts: number): void {
  if (!chatId) return;
  bumpUnreadStmt.run(ts, chatId, chatId);
}
/** Our account spoke in this chat — WhatsApp treats that as reading it. */
export function clearUnread(chatId: string): void {
  if (!chatId) return;
  clearUnreadStmt.run(chatId, chatId);
}

/** Record one emoji reaction on a message (empty emoji = reaction removed). */
export function saveReaction(msgId: string, sender: string, emoji: string, ts: number): void {
  if (!msgId || !sender) return;
  if (emoji) upsertReactionStmt.run(msgId, sender, emoji, ts);
  else delReactionStmt.run(msgId, sender);
}

/**
 * All known chats, newest first: chats we've captured messages in, merged with the full
 * catalog synced from WhatsApp Web's IndexedDB (so every chat appears even before any
 * message is captured). Title priority: manual/learned name > WhatsApp name > id tail.
 */
export function listChats(): ChatRow[] {
  const captured = listChatsStmt.all() as Array<{
    chat_id: string;
    is_group: number;
    cnt: number;
    last_ts: number;
    last_text: string | null;
    kind: string | null;
  }>;
  const byId = new Map<string, ChatRow>();
  for (const r of captured) {
    const body = r.last_text ?? '';
    const lastText = body || (r.kind && r.kind !== 'text' ? `[${r.kind}]` : '');
    byId.set(r.chat_id, {
      id: r.chat_id,
      title: getChatName(r.chat_id) || '',
      lastText,
      lastTs: r.last_ts,
      count: r.cnt,
      isGroup: !!r.is_group,
      unread: 0,
    });
  }
  const cat = catalogAllStmt.all() as Array<{
    chat_id: string;
    name: string | null;
    is_group: number;
    last_ts: number;
    unread: number;
    alt_id: string | null;
  }>;
  for (const c of cat) {
    // A @lid catalog chat and its @c.us captured twin are the same conversation — fold together.
    const hit = byId.get(c.chat_id) ?? (c.alt_id ? byId.get(c.alt_id) : undefined);
    if (hit) {
      if (!hit.title && c.name) hit.title = c.name;
      hit.unread = c.unread;
      if (c.last_ts > hit.lastTs) hit.lastTs = c.last_ts;
    } else {
      byId.set(c.chat_id, {
        id: c.chat_id,
        title: getChatName(c.chat_id) || c.name || tail(c.chat_id),
        lastText: '',
        lastTs: c.last_ts,
        count: 0,
        isGroup: !!c.is_group,
        unread: c.unread,
      });
    }
  }
  const out = Array.from(byId.values());
  for (const r of out) if (!r.title) r.title = tail(r.id);
  // Unread chats float to the top (newest first within each group), then everything else by recency.
  return out.sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.lastTs - a.lastTs);
}

/** Recent persisted history for one chat, chronological. */
export function chatMessages(chatId: string, limit: number): MsgRow[] {
  const rows = chatMsgsStmt.all(chatId, limit) as Array<{
    msg_id: string;
    sender: string | null;
    push_name: string | null;
    body: string | null;
    kind: string | null;
    from_me: number;
    is_group: number;
    ts: number;
    reply_to: string | null;
    reply_text: string | null;
    reply_sender: string | null;
  }>;
  const reMap = new Map<string, string[]>();
  for (const rr of chatReactionsStmt.all(chatId) as Array<{ msg_id: string; emoji: string }>) {
    const arr = reMap.get(rr.msg_id);
    if (arr) arr.push(rr.emoji);
    else reMap.set(rr.msg_id, [rr.emoji]);
  }
  const byMap = new Map<string, string>();
  for (const pr of chatProcessedStmt.all(chatId) as Array<{ id: string; who: string | null }>) {
    if (pr.who) byMap.set(pr.id, pr.who);
  }
  const sentMap = new Map<string, string>();
  for (const sr of chatSentByStmt.all(chatId) as Array<{ id: string; who: string | null }>) {
    if (sr.who) sentMap.set(sr.id, sr.who);
  }
  return rows.map((r) => ({
    messageId: r.msg_id,
    sender: r.sender ?? '',
    pushName: r.push_name ?? undefined,
    text: r.body ?? '',
    kind: r.kind ?? 'text',
    fromMe: !!r.from_me,
    ts: r.ts,
    isGroup: !!r.is_group,
    reactions: reMap.get(r.msg_id) ?? [],
    replyText: r.reply_text ?? undefined,
    replySender: r.reply_sender ?? undefined,
    processedBy: byMap.get(r.msg_id),
    sentBy: sentMap.get(r.msg_id),
  }));
}

logger.info({ db: config.dbPath, aliases: aliasCount() }, 'sqlite store ready');
