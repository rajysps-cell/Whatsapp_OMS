import fs from 'node:fs';
import path from 'node:path';
import { listUsers, type User } from './auth';
import { ChatStore } from './chat-store';
import { config } from './config';
import { extractOrder, type Extraction } from './extractor';
import { logger } from './logger';
import { toMessageEvent, toReactionEvent } from './normalize';
import { OrderStore } from './order-store';
import { runProductImportWithReport } from './product-import';
import * as products from './products';
import { scheduleDailyTimes } from './scheduler';
import {
  bumpUnread,
  clearUnread,
  markRevoked,
  hasMessagesFor,
  recordAccountChats,
  recordSentBy,
  saveMessage,
  upsertCatalog,
} from './store';
import { startWaClient, type WaClient } from './wa-client';
import {
  closeWebServer,
  mediaCacheDir,
  mediaCacheKey,
  setQr,
  setStatus,
  startWebServer,
  writeMediaCache,
  type PersonalWa,
} from './web';

/** Hours since products.csv was last written (Infinity if it's missing). */
function catalogAgeHours(): number {
  try {
    return (Date.now() - fs.statSync(config.productsCsvPath).mtimeMs) / 3_600_000;
  } catch {
    return Infinity;
  }
}

/** Wire up the daily DDI product-export import (+ a startup catch-up if the catalog is stale). */
function startProductImport(): void {
  const cfg = config.productImport;
  if (!cfg.enabled || !cfg.imapPassword) {
    logger.info('daily product import off (disabled or no PRODUCT_IMAP_PASSWORD) — using bundled products.csv');
    return;
  }
  if (cfg.catchUpHours > 0) {
    const ageH = catalogAgeHours();
    if (ageH >= cfg.catchUpHours) {
      logger.info({ ageHours: Math.round(ageH) }, 'products.csv is stale — running catch-up import now');
      void runProductImportWithReport().then((r) => logger.info({ result: r }, 'catch-up product import complete'));
    }
  }
  if (!cfg.dailyTimes.length) {
    logger.warn('PRODUCT_IMPORT_TIME is empty — no scheduled imports (manual npm run import:products still works)');
    return;
  }
  logger.info({ times: cfg.dailyTimes }, 'scheduling daily product imports');
  scheduleDailyTimes(cfg.dailyTimes, async () => {
    const r = await runProductImportWithReport();
    logger.info({ result: r }, 'scheduled product import complete');
  });
}

function main(): void {
  products.load(); // load the product catalog once at startup
  const orders = new OrderStore();
  const chats = new ChatStore();

  /**
   * WhatsApp sessions, one per ACCOUNT: 'common' is the shared business WhatsApp that has always
   * existed; 'u<id>' is a user's own linked WhatsApp (admin sets their mode to "personal" on the
   * Users page, they scan a QR at /link). Every session runs the identical pipeline — messages,
   * media, reactions, history all land in the same shared store — the only per-account state is
   * WHICH CHATS the account can see (account_chats) plus its own status/QR.
   */
  interface WaSession {
    account: string;
    client: WaClient;
    status: string;
    qr: string | null;
  }
  const sessions = new Map<string, WaSession>();
  const personalAuthDir = (userId: number): string => `${config.authDir}-personal/u${userId}`;

  /** Chromium refuses a profile with stale lock files after an ungraceful stop — clear them. */
  const cleanSingletons = (authDir: string): void => {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        fs.rmSync(path.join(authDir, 'session', f), { force: true });
      } catch {
        /* best effort */
      }
    }
  };

  /**
   * Pull a message's media down the moment it arrives, instead of waiting for someone to open the
   * thread.
   *
   * The download can only reach messages still in WhatsApp Web's in-memory collection, so anything
   * fetched on demand hours later is simply gone — the request 404s forever. Voice notes took the
   * blame for this because a failed <audio> element renders as a player that silently does nothing:
   * "we don't see voice notes". Fetching on arrival is the only window where the data is reliably
   * there.
   */
  const cacheMediaNow = async (
    fetchMedia: (id: string) => Promise<{ data: string; mimetype: string; filename?: string } | null>,
    messageId: string,
    kind: string | undefined, // reaction-only events carry no kind; it is just log context
  ): Promise<void> => {
    try {
      const dir = mediaCacheDir();
      const safe = mediaCacheKey(messageId);
      // Already cached (a re-delivered message, or someone opened the thread first).
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(safe + '.') && !f.endsWith('.name'))) {
        return;
      }
      const got = await fetchMedia(messageId);
      if (!got) {
        logger.warn({ messageId, kind }, 'media not downloadable on arrival — it will 404 later');
        return;
      }
      const bytes = writeMediaCache(messageId, got.data, got.mimetype, got.filename);
      logger.info({ messageId, kind, bytes, mimetype: got.mimetype }, 'media cached on arrival');
    } catch (err) {
      logger.warn({ err, messageId, kind }, 'eager media cache failed'); // on-demand fetch still tries later
    }
  };

  /**
   * Who sent the next outgoing message in each chat, queued per chat.
   *
   * We cannot use the id returned by sendMessage: on @lid chats whatsapp-web.js gives back a
   * message whose id is unusable (empty), so the attribution record was silently skipped. The
   * 'message_create' event, by contrast, carries the same id we persist in `messages` — so the
   * username is queued just before sending and claimed when that event arrives. Shared across
   * sessions: a chat id is unique enough, and each session only claims for its own chats.
   */
  const pendingSends = new Map<string, Array<{ who: string; at: number }>>();
  const PENDING_TTL_MS = 60_000; // a stale entry must never attribute a phone-typed message
  const queueSend = (chatId: string, who: string): void => {
    const q = pendingSends.get(chatId) ?? [];
    q.push({ who, at: Date.now() });
    pendingSends.set(chatId, q);
  };
  const claimSend = (chatId: string): string | null => {
    const q = pendingSends.get(chatId);
    if (!q?.length) return null;
    const fresh = q.filter((e) => Date.now() - e.at < PENDING_TTL_MS);
    const next = fresh.shift() ?? null;
    if (fresh.length) pendingSends.set(chatId, fresh);
    else pendingSends.delete(chatId);
    return next ? next.who : null;
  };

  /** The full ingestion pipeline for one session; identical logic for common and personal. */
  const buildHandlers = (account: string, session: WaSession): Parameters<typeof startWaClient>[0] => ({
    onMessage: async (msg) => {
      const event = await toMessageEvent(msg);
      if (!event) return;
      chats.record(event);
      // Membership on ARRIVAL, not only at the 2-min catalog sync — a brand-new chat must be
      // openable the moment its first message lands, or the thread endpoint 403s until the sync.
      // Only for real content: protocol notifications must not conjure chats into the list.
      if (event.text || event.media) recordAccountChats(account, [event.groupId]);
      bumpUnread(event.groupId, event.ts); // badge appears now, not at the next 2-min catalog sync
      logger.info({ event, session: account }, 'wa-event');

      // Grab the bytes while WhatsApp still has them (see cacheMediaNow). Deliberately not awaited:
      // order extraction must not wait on a download.
      if (event.media) void cacheMediaNow(session.client.media, event.messageId, event.kind);

      let extraction: Extraction | null = null;
      const text = event.text ?? event.media?.transcript;
      if (config.anthropicKey && text) {
        extraction = await extractOrder({
          text,
          groupName: event.groupId,
          sender: event.pushName ?? event.sender,
        });
      }

      const order = orders.ingestMessage(event, extraction);
      logger.info(
        {
          orderId: order.id,
          status: order.status,
          customer: order.customerName,
          group: order.groupId,
          items: order.items.length,
          messages: order.messages.length,
          summary: order.summary,
        },
        'order-card',
      );
    },
    onSent: async (msg) => {
      // The account's own outgoing messages: record them so warehouse replies show in history
      // and chats where our side spoke also appear. No order extraction on our own messages.
      const event = await toMessageEvent(msg);
      if (event) {
        chats.record(event);
        if (event.text || event.media) recordAccountChats(account, [event.groupId]);
        if (event.media) void cacheMediaNow(session.client.media, event.messageId, event.kind);
        clearUnread(event.groupId); // replying from the account marks the chat read in WhatsApp
        // If this chat has a queued send from the app, this is that message — attribute it.
        const who = claimSend(event.groupId);
        if (who) {
          recordSentBy(event.messageId, who);
          logger.info({ chatId: event.groupId, user: who, messageId: event.messageId }, 'attributed sent message');
        }
      }
    },
    onReaction: async (reaction) => {
      const event = toReactionEvent(reaction);
      if (!event) return;
      logger.info({ event }, 'wa-event');
      chats.recordReaction(event); // persist so it renders on the message in /match
      const order = orders.ingestReaction(event);
      if (order) {
        logger.info(
          { orderId: order.id, status: order.status, finalizedBy: order.finalizedBy },
          'order-updated',
        );
      }
    },
    onQr: (qr) => {
      session.qr = qr;
      session.status = 'waiting for scan';
      if (account === 'common') void setQr(qr); // the admin /qr page
    },
    onStatus: (s) => {
      session.status = s;
      if (s === 'connected') session.qr = null;
      if (account === 'common') setStatus(s); // the shared pill everyone on common sees
    },
    onCatalog: (rows) => {
      upsertCatalog(rows); // names/unread — shared catalog
      // Membership = REAL conversations only. WhatsApp Web's chat store also carries hundreds of
      // bare contact entries — a personal account synced 832 of those as raw-number "chats".
      // (lastTs looked like a discriminator but WhatsApp stamps times onto contact entries too.)
      // The rule that matches what the user sees in their own WhatsApp: groups are chats, and a
      // 1:1 is a chat once ANY message of it exists in our store (live or backfilled).
      recordAccountChats(account, rows.filter((r) => r.isGroup || hasMessagesFor(r.id)).map((r) => r.id));
    },
    // Recovered history goes straight to the messages table (dedup on msg id) — no order
    // extraction on backfill; the /match "only new messages" flow decides what to process.
    onHistory: (rows) => rows.forEach(saveMessage),
    // Someone deleted-for-everyone (their phone or this app) — show WhatsApp's placeholder.
    onRevoked: (messageId) => markRevoked(messageId),
  });

  const startSession = (account: string, authDir: string): WaSession => {
    cleanSingletons(authDir);
    const session: WaSession = { account, client: null as unknown as WaClient, status: 'starting', qr: null };
    session.client = startWaClient(buildHandlers(account, session), { authDir, tag: account });
    sessions.set(account, session);
    logger.info({ session: account, authDir }, 'whatsapp session started');
    return session;
  };

  // The shared business account always runs.
  const common = startSession('common', config.authDir);
  // Personal accounts that were linked before the restart reconnect on boot, so their chats keep
  // flowing even while the user is signed out of the site.
  for (const u of listUsers()) {
    if (u.waMode === 'personal' && fs.existsSync(personalAuthDir(u.id))) {
      startSession(`u${u.id}`, personalAuthDir(u.id));
    }
  }

  /** The web layer's window into personal sessions (typed in web.ts to avoid a cycle). */
  const personalWa: PersonalWa = {
    ensure(u: User): void {
      if (u.waMode !== 'personal') return;
      if (!sessions.has(`u${u.id}`)) startSession(`u${u.id}`, personalAuthDir(u.id));
    },
    state(u: User): { started: boolean; status: string; qr: string | null } {
      const s = sessions.get(`u${u.id}`);
      return { started: !!s, status: s?.status ?? 'not linked', qr: s?.qr ?? null };
    },
    for(u: User): unknown {
      return sessions.get(`u${u.id}`)?.client ?? null;
    },
    unlink(u: User): void {
      const s = sessions.get(`u${u.id}`);
      if (s) void s.client.logout().catch((err) => logger.warn({ err, session: `u${u.id}` }, 'personal unlink failed'));
    },
    stop(userId: number): void {
      const k = `u${userId}`;
      const s = sessions.get(k);
      if (!s) return;
      sessions.delete(k);
      void s.client.stop().catch((err) => logger.warn({ err, session: k }, 'personal session stop failed'));
      logger.info({ session: k }, 'personal session stopped');
    },
  };

  // Every injected action takes an optional `via` (the acting user's own client, resolved by the
  // web layer for personal-mode users); without it the shared business session acts.
  const asClient = (via: unknown): WaClient => (via as WaClient) ?? common.client;

  const server = startWebServer(() => orders.all(), chats, async (chatId, text, mentions, sentBy, quotedId, via) => {
    if (sentBy) queueSend(chatId, sentBy); // queue BEFORE sending so message_create can claim it
    try {
      return await asClient(via).send(chatId, text, mentions, quotedId);
    } catch (err) {
      claimSend(chatId); // send failed — drop the queued entry so it can't mis-attribute later
      throw err;
    }
  },
  (messageId, via) => asClient(via).media(messageId),
  async (chatId, file, caption, mentions, sentBy, asVoice, via) => {
    // Same attribution path as a text send: the id that comes back is unusable on @lid chats,
    // so queue the sender and let the message_create event claim it.
    if (sentBy) queueSend(chatId, sentBy);
    try {
      return await asClient(via).sendMedia(chatId, file, caption, mentions, sentBy, asVoice);
    } catch (err) {
      claimSend(chatId);
      throw err;
    }
  },
  (messageId, everyone, via) => asClient(via).del(messageId, everyone),
  (messageId, on, via) => asClient(via).star(messageId, on),
  (messageId, on, via) => asClient(via).pin(messageId, on),
  (messageId, emoji, via) => asClient(via).react(messageId, emoji),
  personalWa,
  // The admin Settings page's "Unlink" for the BUSINESS account: log the device out; the
  // reconnect surfaces a fresh QR that the same page then displays for the new number.
  () => common.client.logout());

  startProductImport(); // daily catalog refresh from the DDI export email (in-process, hot-reloads)

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    await Promise.all([...sessions.values()].map((s) => s.client.stop().catch(() => undefined)));
    await closeWebServer(server);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
