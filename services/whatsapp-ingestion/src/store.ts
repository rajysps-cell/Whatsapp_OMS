import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import { logger } from './logger';

// Zero-dependency persistence via Node's built-in SQLite (Node 22.5+/24).
const db = new DatabaseSync(config.dbPath);
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
  ['aliases', 'alias_text TEXT'],
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
  'INSERT OR REPLACE INTO processed (message_id, chat_id, processed_at, message_text, items) VALUES (?, ?, ?, ?, ?)',
);
const isProcessedStmt = db.prepare('SELECT 1 FROM processed WHERE message_id = ?');
const setChatNameStmt = db.prepare(
  'INSERT INTO chat_names (chat_id, name, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
);
const getChatNameStmt = db.prepare('SELECT name FROM chat_names WHERE chat_id = ?');

const insMessage = db.prepare(
  'INSERT OR IGNORE INTO messages (msg_id, chat_id, sender, push_name, body, kind, from_me, is_group, ts) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
const chatMsgsStmt = db.prepare(`
  SELECT msg_id, sender, push_name, body, kind, from_me, is_group, ts FROM (
    SELECT msg_id, sender, push_name, body, kind, from_me, is_group, ts
    FROM messages WHERE chat_id = ? ORDER BY ts DESC, msg_id DESC LIMIT ?
  ) ORDER BY ts ASC, msg_id ASC
`);

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
export function saveExtraction(messageId: string, chatId: string, messageText: string, itemsJson: string): void {
  if (!messageId) return;
  insProcessed.run(messageId, chatId, Date.now(), messageText || null, itemsJson || null);
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
  );
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
  return out.sort((a, b) => b.lastTs - a.lastTs);
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
  }>;
  return rows.map((r) => ({
    messageId: r.msg_id,
    sender: r.sender ?? '',
    pushName: r.push_name ?? undefined,
    text: r.body ?? '',
    kind: r.kind ?? 'text',
    fromMe: !!r.from_me,
    ts: r.ts,
    isGroup: !!r.is_group,
  }));
}

logger.info({ db: config.dbPath, aliases: aliasCount() }, 'sqlite store ready');
