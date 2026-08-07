import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
import type { Message, Reaction } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

// whatsapp-web.js is CommonJS; Node's ESM loader can't destructure its named
// exports directly, so take the default (module.exports) and pull them off it.
const { Client, LocalAuth, MessageMedia } = pkg;
import { config } from './config';
import { logger } from './logger';

export interface WaClient {
  stop: () => Promise<void>;
  /**
   * Send a text message to a chat. Human-initiated only — never used for automated/bulk sending.
   * Attribution is recorded from the message_create event (see index.ts), not from the return value.
   * quotedId replies to that message; if WhatsApp refuses the quote the text is sent un-quoted
   * rather than not at all.
   */
  send: (chatId: string, text: string, mentions?: string[], quotedId?: string) => Promise<string>;
  /** Fetch one message's media as base64, or null if WhatsApp can no longer provide it. */
  media: (messageId: string) => Promise<{ data: string; mimetype: string; filename?: string } | null>;
  /**
   * Delete a message in WhatsApp. everyone=true revokes it for all group members (only possible
   * within WhatsApp's own revoke window); false removes it from this linked account only.
   * Permission (who may delete what) is the caller's job — this just performs it.
   */
  del: (messageId: string, everyone: boolean) => Promise<{ ok: boolean; reason?: string }>;
  /** Star/unstar a message in the linked WhatsApp account (shows under Starred on the phone). */
  star: (messageId: string, on: boolean) => Promise<{ ok: boolean; reason?: string }>;
  /** Pin/unpin a message in the chat — visible to everyone in it, like WhatsApp's own pin. */
  pin: (messageId: string, on: boolean) => Promise<{ ok: boolean; reason?: string }>;
  /** React to a message with an emoji ('' removes the reaction), like tapping it in WhatsApp. */
  react: (messageId: string, emoji: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Unlink this WhatsApp account (like removing the device on the phone). The 'disconnected'
   * LOGOUT path then wipes the session and reconnects into a fresh QR — which is the point:
   * an admin relinks a different number without ever touching the server.
   */
  logout: () => Promise<void>;
  /** Send a file (image / document / etc.) with an optional caption. Human-initiated only.
   *  asVoice sends an audio file as a WhatsApp VOICE NOTE (the push-to-talk bubble). */
  sendMedia: (
    chatId: string,
    file: { data: string; mimetype: string; filename: string },
    caption?: string,
    mentions?: string[],
    sentBy?: string,
    asVoice?: boolean,
  ) => Promise<string>;
}

/** One chat from WhatsApp Web's own IndexedDB (the broken Store APIs bypassed). */
export interface CatalogRow {
  id: string;
  name: string;
  isGroup: boolean;
  lastTs: number;
  unread: number;
  /** For @lid direct chats: the same contact's phone-number id (@c.us), so callers can dedupe. */
  altId: string | null;
}

export interface WaClientHandlers {
  onMessage: (msg: Message) => void | Promise<void>;
  onReaction: (reaction: Reaction) => void | Promise<void>;
  /** Fires for the linked account's OWN outgoing messages (still read-only — we never send). */
  onSent?: (msg: Message) => void | Promise<void>;
  /** Called with the raw QR string whenever WhatsApp issues a new one. */
  onQr?: (qr: string) => void;
  /** Called on connection lifecycle changes: 'waiting for scan' | 'connected' | 'auth failure' | 'disconnected'. */
  onStatus?: (status: string) => void;
  /** Full chat catalog (ids + real names + unread) read from WhatsApp Web's IndexedDB on connect and every 10 min. */
  onCatalog?: (rows: CatalogRow[]) => void;
  /** History backfill: called once per chat with all messages recovered from the in-memory Store on connect. */
  onHistory?: (msgs: HistoryMsg[]) => void;
  /** Someone deleted a message for everyone (from their phone or from this app). */
  onRevoked?: (messageId: string) => void;
  /** This session's own WhatsApp id, once known — used to identify OUR reactions. */
  onIdentity?: (wid: string) => void;
  /** WhatsApp's delivery state for a message we sent: 1 sent, 2 delivered, 3 read, 4 played. */
  onAck?: (messageId: string, ack: number) => void;
}

/** One message recovered from WhatsApp Web's in-memory (decrypted) message models. */
export interface HistoryMsg {
  messageId: string;
  chatId: string;
  sender: string;
  pushName?: string;
  text: string;
  kind: string;
  fromMe: boolean;
  isGroup: boolean;
  ts: number;
}

/**
 * Starts a READ-ONLY whatsapp-web.js connection. We only subscribe to inbound
 * events — no send method is ever called. Returns a { stop } handle.
 */
export interface WaSessionOpts {
  /** Where this session's login lives on disk. Default: the shared business account's dir. */
  authDir?: string;
  /** Log tag: 'common' or 'u<userId>' — every line of a personal session says whose it is. */
  tag?: string;
}

/**
 * How often each session re-reads its own chat catalog. 2 min: unread is bumped live on each
 * message, so this only needs to catch up on reads done elsewhere (phone/WhatsApp Web) and correct
 * drift. Exported because chat-membership pruning measures its grace period in sweeps of this.
 */
export const CATALOG_EVERY_MS = 2 * 60 * 1000;

export function startWaClient(handlers: WaClientHandlers, opts: WaSessionOpts = {}): WaClient {
  const authDir = opts.authDir ?? config.authDir;
  const tag = opts.tag ?? 'common';
  /**
   * Build a BRAND NEW client. Never reuse one that has been destroyed.
   *
   * destroy() closes the browser and tears down the auth strategy; calling initialize() on that
   * same instance afterwards does not bring a session back — the browser never reappears, while
   * the catalog probe races the dying page and reports "connected". Measured on 2026-08-07: the
   * session restarted every 6 minutes for half an hour, the pill said Live chat the whole time,
   * and there was no Chromium process on the box at all. Reactions sent during those windows were
   * lost for good, because WhatsApp re-delivers queued MESSAGES on reconnect but never re-fires
   * reaction events — which is exactly how this surfaced ("Nate's emoji never showed up").
   */
  const makeClient = (): InstanceType<typeof Client> =>
    new Client({
      authStrategy: new LocalAuth({ dataPath: authDir }),
      puppeteer: {
        headless: true,
        // --no-sandbox is needed on most Linux servers / containers.
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });
  let client = makeClient();
  // Every handler registered below, remembered so a freshly built client gets all of them back.
  const listeners: Array<[string, (...a: never[]) => void]> = [];
  const on = (ev: string, fn: (...a: never[]) => void): void => {
    listeners.push([ev, fn]);
    (client as unknown as { on(e: string, f: (...a: never[]) => void): void }).on(ev, fn);
  };
  /**
   * Close the browser and come back on a FRESH client, re-attaching every handler.
   * The only way back from a dead page — see makeClient() for why re-initializing is not.
   */
  const spawnFresh = (label: string): Promise<void> => {
    client = makeClient();
    sawReadyEvent = false; // a new browser has not proved its event hooks yet
    for (const [ev, fn] of listeners) {
      (client as unknown as { on(e: string, f: (...a: never[]) => void): void }).on(ev, fn);
    }
    return client.initialize().catch((err: unknown) => logger.error({ err, session: tag }, label));
  };
  const rebuild = (label: string): void => {
    void client
      .destroy()
      .catch(() => undefined)
      .then(() => spawnFresh(label));
  };

  // Watchdog state. A start that never reaches 'ready' used to sit there until an operator
  // noticed — that is what caused the outage after the last deploy.
  let catalogTimer: NodeJS.Timeout | null = null;
  let ready = false;
  let initAt = Date.now();
  let sawQr = false; // WhatsApp asked for a scan: only a human can fix that
  let stuckRestarts = 0;
  // When we last actually RECEIVED something from WhatsApp. A session can keep its page (so the
  // catalog still reads back) while its event bridge is dead: sends still go out, nothing ever
  // comes in. That happened for 6 hours straight — 192 catalog syncs, 0 message events — and
  // looked to staff like "voice notes don't work", because the thread never updated.
  let lastEventAt = Date.now();
  // Did whatsapp-web.js fire its OWN 'ready'? That event is what proves the library finished
  // injecting its page hooks — and those hooks are the only path inbound messages travel. The
  // catalog probe below can declare a session live without them: such a session reads its chat
  // list and sends fine but NEVER receives. Measured: every probe-only session delivered zero
  // messages, while every real-ready session delivered them normally.
  let sawReadyEvent = false;
  let readyAt = 0;
  // Consecutive catalog-sync throws. Zero on any answer; three in a row (~6 min) means the page
  // is gone rather than merely quiet, and only a fresh browser brings it back.
  let syncFails = 0;
  let syncRestarts = 0;
  // Counted SEPARATELY from stuckRestarts, which becomeReady resets on every reconnect — sharing it
  // would make the cap meaningless here (each restart reconnects, resetting its own limit) and put a
  // permanently deaf session into an endless restart loop. Only a real event clears this.
  let bridgeRestarts = 0;
  const sawEvent = (): void => {
    lastEventAt = Date.now();
    bridgeRestarts = 0; // traffic is flowing again: this is the only proof that the restart worked
  };

  on('qr', (qr: string) => {
    sawQr = true; // a human must scan; restarting the client cannot help and would loop forever
    logger.info({ session: tag }, 'scan this QR from the phone: WhatsApp → Linked devices → Link a device (or open the web page)');
    qrcode.generate(qr, { small: true });
    handlers.onQr?.(qr);
    handlers.onStatus?.('waiting for scan');
  });
  /**
   * Enter the connected state exactly once, whoever noticed first.
   *
   * whatsapp-web.js' 'ready' event is not reliable on WhatsApp Web 2.3000.x — the same root cause
   * that makes its Store APIs throw Error "r". Usually it arrives in about 5 seconds; sometimes it
   * never arrives at all for a session that is in fact live, and only a re-init shakes it loose.
   * So the watchdog below also probes the page directly; either path lands here, and this stays
   * idempotent because both can happen for the same connection.
   */
  const becomeReady = (via: string): void => {
    if (ready) return;
    ready = true;
    sawQr = false;
    stuckRestarts = 0;
    logger.info({ via, session: tag }, 'connection open — listening for group events (read-only)');
    handlers.onStatus?.('connected');
    lastEventAt = Date.now(); // a fresh connection starts the silence clock over
    readyAt = Date.now();
    // This session's OWN WhatsApp id. Needed to keep our reactions honest: WhatsApp allows one
    // reaction per account per message, so we must know which stored reaction is ours to replace.
    try {
      const wid = (client as unknown as { info?: { wid?: { _serialized?: string } } }).info?.wid?._serialized;
      if (wid) handlers.onIdentity?.(wid);
    } catch {
      /* info is not always populated (notably on the catalog-probe path) — never fatal */
    }
    if (handlers.onCatalog) {
      const sync = (): void => {
        catalogSync(client)
          .then((rows) => {
            syncFails = 0;      // the page answered: whatever it says, it is still there
            syncRestarts = 0;   // …and that is the proof a sync-failure restart actually worked
            if (rows) handlers.onCatalog?.(rows);
            if (rows?.length) checkEventBridge(rows);
          })
          .catch((err) => {
            // A THROWN sync means the page itself is gone — "Attempted to use detached Frame"
            // after WhatsApp Web reloads under us. This was the one dead state no guard could
            // see: the bridge check needs rows it never gets, the false-ready check exits because
            // 'ready' genuinely fired, and the watchdog only runs while NOT ready. It failed every
            // 2 minutes for 15.7 hours and nothing noticed.
            syncFails++;
            logger.error({ err, consecutiveFailures: syncFails }, 'catalog sync failed');
            if (syncFails < MAX_SYNC_FAILS) return;
            syncFails = 0;
            if (syncRestarts >= MAX_SYNC_RESTARTS) return; // stop hammering a genuinely broken host
            syncRestarts++;
            restartClient('the chat catalog has been unreadable for several sweeps — the page is gone, restarting', {
              attempt: syncRestarts,
              consecutiveFailures: MAX_SYNC_FAILS,
            });
          });
      };
      sync();
      if (catalogTimer) clearInterval(catalogTimer); // 'ready' re-fires after reconnects
      catalogTimer = setInterval(sync, CATALOG_EVERY_MS);
    }
    if (handlers.onHistory) {
      historyBackfill(client, handlers.onHistory).catch((err) =>
        logger.error({ err }, 'history backfill failed'),
      );
    }
  };
  on('ready', () => {
    sawReadyEvent = true; // the library's hooks are in: this session can actually receive
    becomeReady('ready event');
  });
  on('auth_failure', (msg: string) => {
    logger.error({ msg }, 'auth failure');
    handlers.onStatus?.('auth failure');
  });
  on('disconnected', (reason: string) => {
    ready = false;
    initAt = Date.now();
    stuckRestarts = 0;
    logger.warn({ reason, session: tag }, 'disconnected — reinitializing');
    handlers.onStatus?.('disconnected');
    if (String(reason).toUpperCase().includes('LOGOUT')) {
      // The device was unlinked from the phone. whatsapp-web.js wipes the session on this path,
      // so the reconnect below will surface a QR — which is correct, a human has to re-link.
      logger.error('the linked device was signed out on the phone — a QR re-scan is required');
    }
    // destroy() first: this event fires synchronously from inside the library, which does NOT
    // close the browser here. Calling initialize() straight away launched a second Chromium into
    // the same profile directory, and whichever lost the race was orphaned and never closed.
    rebuild('reconnect failed');
  });

  // Watchdog. Two jobs, in order of preference:
  //
  //  1. Probe. Ask the page whether the chat catalog reads back from IndexedDB. That is the same
  //     call the app already relies on every 2 minutes, it needs no library API, and it answers
  //     the only question that matters: is this session actually live? When it says yes we go
  //     connected without restarting anything — which is what fixes the "connecting" stall,
  //     because the session was live the whole time and only the 'ready' event was missing.
  //  2. Restart, if the probe keeps coming back empty for STUCK_MS. That is the genuinely-dead
  //     case (browser crashed, page navigated away), where a fresh browser is the only cure.
  const PROBE_AFTER_MS = 15 * 1000; // let the normal path win first; the probe is read-only and cheap
  const STUCK_MS = 90 * 1000;
  const MAX_STUCK_RESTARTS = 6; // stop hammering a genuinely broken session

  /**
   * The watchdog above only runs while NOT ready, so it cannot see a session that connects and
   * then goes deaf. This can: the catalog carries each chat's own last-activity time, straight
   * from the page. If WhatsApp says a chat moved well after the last event we received, messages
   * are arriving at the page and never reaching us — the bridge is dead and only a fresh browser
   * fixes it. Restarting is safe: history backfill re-reads what was missed on reconnect.
   */
  const SILENT_MS = 10 * 60 * 1000; // generous: a real gap must not restart a healthy quiet session
  const MAX_BRIDGE_RESTARTS = 3;
  const MAX_SYNC_FAILS = 3;    // ~6 minutes of an unreadable page before we rebuild the browser
  const MAX_SYNC_RESTARTS = 5; // and give up after five rebuilds if the page will not come back
  // How long a probe-only session is given to produce a real 'ready' before we call it broken.
  // It normally arrives within ~5s, so 3 min is patient; the cost of waiting longer is that
  // inbound customer orders are silently not arriving the whole time.
  const REAL_READY_GRACE_MS = 3 * 60 * 1000;

  /**
   * Rebuild the browser. Callers own their own attempt budget — a session that is deaf and one
   * whose page has vanished are different faults with different evidence of recovery, so sharing
   * a counter would let either mask the other.
   */
  const restartClient = (why: string, extra: Record<string, unknown>): void => {
    logger.warn({ session: tag, ...extra }, why);
    ready = false;
    initAt = Date.now();
    lastEventAt = Date.now();
    handlers.onStatus?.('reconnecting');
    rebuild('restart failed');
  };

  /**
   * A session that only ever went "ready" through the catalog probe cannot receive messages —
   * whatsapp-web.js never installed its page hooks. It looks perfectly healthy (chat list syncs,
   * sends work, the pill says Live) which is precisely why it went unnoticed for 6 hours. Recycle
   * it as soon as the real event is overdue, rather than waiting for someone to notice silence.
   */
  const checkFalseReady = (): void => {
    if (!ready || sawReadyEvent || sawQr) return;
    if (!readyAt || Date.now() - readyAt < REAL_READY_GRACE_MS) return;
    if (bridgeRestarts >= MAX_BRIDGE_RESTARTS) return;
    bridgeRestarts++;
    restartClient('connected only via the catalog probe — whatsapp-web.js never became ready, so no message can arrive; restarting', {
      attempt: bridgeRestarts,
      readySince: new Date(readyAt).toISOString(),
    });
  };
  const checkEventBridge = (rows: CatalogRow[]): void => {
    if (!ready || sawQr) return;
    let newest = 0;
    for (const r of rows) if (r.lastTs > newest) newest = r.lastTs;
    const newestMs = newest * 1000; // catalog stamps are epoch SECONDS
    if (!newestMs || newestMs > Date.now() + 60_000) return; // absent or clock-skewed — ignore
    if (newestMs <= lastEventAt + SILENT_MS) return;
    // Give up after a few tries rather than restarting forever: if reconnecting does not revive the
    // bridge, the cause is outside this process (a whatsapp-web.js/WhatsApp Web mismatch), and a
    // restart loop would only add downtime. History backfill still runs on each connect, so the app
    // keeps catching up even in this degraded state. Cleared only by a real event arriving.
    if (bridgeRestarts >= MAX_BRIDGE_RESTARTS) return;
    bridgeRestarts++;
    restartClient('WhatsApp has newer activity than any event we received — the event bridge is dead, restarting', {
      attempt: bridgeRestarts,
      newestChatActivity: new Date(newestMs).toISOString(),
      lastEventAt: new Date(lastEventAt).toISOString(),
    });
  };
  let probing = false; // catalogSync is async and the interval is not — never overlap two probes
  const watchdog = setInterval(() => {
    checkFalseReady(); // runs even while "ready" — that is the whole point of it
    if (ready || probing) return;
    if (sawQr) return; // waiting on a human to scan — restarting would loop and lose the QR
    if (Date.now() - initAt < PROBE_AFTER_MS) return;
    const restartIfStuck = (): void => {
      if (Date.now() - initAt < STUCK_MS) return;
      if (stuckRestarts >= MAX_STUCK_RESTARTS) return; // give up quietly; the pill says disconnected
      stuckRestarts++;
      logger.warn(
        { stuckForMs: Date.now() - initAt, attempt: stuckRestarts, session: tag },
        'WhatsApp never became ready and the chat catalog is unreadable — restarting the client',
      );
      initAt = Date.now(); // reset first so a slow restart cannot trigger a second one
      rebuild('watchdog reinitialize failed');
    };
    probing = true;
    catalogSync(client)
      .then((rows) => {
        // Empty is not the same as unreadable: a brand-new session legitimately has no chats, so
        // only a non-empty read proves the session is live. rows === null means there is no page.
        if (rows?.length) becomeReady('catalog probe');
        else restartIfStuck();
      })
      .catch(() => restartIfStuck()) // page not up yet, or IndexedDB not open — both mean "not live"
      .finally(() => {
        probing = false;
      });
  }, 10 * 1000);
  watchdog.unref();

  // 'message' fires for inbound messages only (not our own) — exactly the read-only surface we want.
  on('message', (msg: Message) => {
    sawEvent();
    Promise.resolve(handlers.onMessage(msg)).catch((err) => logger.error({ err }, 'onMessage failed'));
  });
  if (handlers.onAck) {
    // The real read receipts. Fires repeatedly per message as it progresses sent -> delivered ->
    // read, for our OWN messages. Only @lid chats sometimes hand back an id without _serialized,
    // so rebuild it the same way the revoke handler does rather than dropping the update.
    on('message_ack', (msg: Message, ack: number) => {
      sawEvent();
      const id = (msg as unknown as { id?: { fromMe?: boolean; remote?: string | { _serialized?: string }; id?: string; _serialized?: string } }).id;
      if (!id) return;
      const remote = typeof id.remote === 'object' ? (id.remote?._serialized ?? '') : (id.remote ?? '');
      const messageId = id._serialized || (id.id ? `${id.fromMe ? 'true' : 'false'}_${remote}_${id.id}` : '');
      if (messageId) handlers.onAck?.(messageId, ack);
    });
  }
  on('message_reaction', (reaction: Reaction) => {
    sawEvent();
    Promise.resolve(handlers.onReaction(reaction)).catch((err) =>
      logger.error({ err }, 'onReaction failed'),
    );
  });
  // 'message_create' fires for ALL new messages incl. our own; keep only fromMe here so we don't
  // double-handle inbound (already covered by 'message'). Lets us persist the account's own replies.
  if (handlers.onSent) {
    on('message_create', (msg: Message) => {
      sawEvent(); // our own echo counts: it proves the bridge is still carrying traffic
      if (!msg.fromMe) return;
      Promise.resolve(handlers.onSent?.(msg)).catch((err) => logger.error({ err }, 'onSent failed'));
    });
  }
  if (handlers.onRevoked) {
    // Fires when ANYONE deletes-for-everyone — a customer from their phone, or this app itself.
    // `before` (the original message) carries the id we stored; `after` is the revocation stub.
    on('message_revoke_everyone', (after: Message, before: Message | null) => {
      const src = (before ?? after) as { id?: { fromMe?: boolean; remote?: string | { _serialized?: string }; id?: string; _serialized?: string } };
      const id = src?.id;
      if (!id) return;
      const remote = typeof id.remote === 'object' ? (id.remote?._serialized ?? '') : (id.remote ?? '');
      const messageId = id._serialized || (id.id ? `${id.fromMe ? 'true' : 'false'}_${remote}_${id.id}` : '');
      if (messageId) handlers.onRevoked?.(messageId);
    });
  }

  client.initialize().catch((err: unknown) => logger.error({ err }, 'initialize failed'));

  // Recover per-chat history through WhatsApp Web's own module system (window.require).
  // The encrypted-at-rest IndexedDB records are decrypted by the page into in-memory models;
  // WAWebChatLoadMessages.loadEarlierMsgs pages older messages into that memory. We read the raw
  // models and pick plain fields ourselves — wwebjs's fetchMessages breaks only in its own
  // getChat/getMessageModel serializers, which this never touches.
  // ponytail: 300 msgs/chat cap, sequential over ~60 chats (~1-2 min once per connect); raise the
  // cap or parallelize if someone needs deeper history.
  async function historyBackfill(
    c: InstanceType<typeof Client>,
    onHistory: (msgs: HistoryMsg[]) => void,
  ): Promise<void> {
    const page = c.pupPage;
    if (!page) return;
    const chatIds = (await page.evaluate(
      `window.require('WAWebCollections').Chat.getModelsArray().map((c) => c.id._serialized)`,
    )) as string[];
    let total = 0;
    let dbgLogged = 0;
    for (const cid of chatIds) {
      const result = (await page.evaluate(`(async () => {
        const dbg = { found: false, before: -1, after: -1, loadErr: null };
        const coll = window.require('WAWebCollections');
        const loader = window.require('WAWebChatLoadMessages');
        // Chat.get() wants a Wid object; matching on the serialized id avoids constructing one.
        const chat = coll.Chat.getModelsArray().find((c) => c.id && c.id._serialized === ${JSON.stringify(cid)});
        if (!chat || !chat.msgs) return { rows: [], dbg };
        dbg.found = true;
        dbg.before = chat.msgs.getModelsArray().length;
        let guard = 15;
        while (chat.msgs.getModelsArray().length < 300 && guard-- > 0) {
          let batch = null;
          try { batch = await loader.loadEarlierMsgs({ chat }); } catch (e) { dbg.loadErr = String(e); break; }
          if (!batch || !batch.length) break;
        }
        dbg.after = chat.msgs.getModelsArray().length;
        const isGroup = /@g\\.us$/.test(${JSON.stringify(cid)});
        const names = {};
        try {
          coll.Contact.getModelsArray().forEach((x) => {
            if (x.id && x.id._serialized) names[x.id._serialized] = x.pushname || x.name || null;
          });
        } catch (e) { /* names stay empty */ }
        const rows = chat.msgs.getModelsArray()
          .filter((m) => m.id && m.id.id && !m.isNotification)
          .map((m) => {
            // Raw in-memory MsgKeys lack _serialized (wwebjs's serializer builds it) — compose
            // the identical fromMe_remote_id format so backfill dedupes against live-captured ids.
            const remote = m.id.remote ? (m.id.remote._serialized || String(m.id.remote)) : ${JSON.stringify(cid)};
            const mid = m.id._serialized || (String(!!m.id.fromMe) + '_' + remote + '_' + m.id.id);
            const author = m.author
              ? (m.author._serialized || String(m.author))
              : (m.from ? (m.from._serialized || String(m.from)) : '');
            let name = m.notifyName || null;
            if (!name && author && !m.id.fromMe) name = names[author] || null;
            const type = m.type || 'chat';
            return {
              messageId: mid,
              chatId: ${JSON.stringify(cid)},
              sender: author,
              pushName: name || undefined,
              text: type === 'chat' ? (m.body || '') : (m.caption || ''),
              kind: type === 'chat' ? 'text' : (type === 'ptt' ? 'voice' : type),
              fromMe: !!m.id.fromMe,
              isGroup,
              ts: m.t || 0,
            };
          });
        return { rows, dbg };
      })()`)) as { rows: HistoryMsg[]; dbg: Record<string, unknown> };
      const rows = result?.rows;
      if (rows && rows.length) {
        onHistory(rows);
        total += rows.length;
      } else if (dbgLogged < 3) {
        dbgLogged++;
        logger.warn({ cid, dbg: result?.dbg }, 'backfill: empty chat');
      }
    }
    logger.info({ chats: chatIds.length, messages: total }, 'history backfill complete');
  }

  /**
   * Download one message's media (image / voice / video / document) as base64.
   *
   * whatsapp-web.js's own Message.downloadMedia() passes `this.id._serialized` into the page, and
   * that field is undefined on @lid chats — which is nearly all of ours. The page then does
   * Msg.get(undefined) and throws the opaque Error "r" that has failed every media download here.
   * This does the same work but finds the message model the way historyBackfill already does:
   * by matching either the serialized id or the rebuilt {fromMe}_{remote}_{id} form.
   */
  async function fetchMedia(
    c: InstanceType<typeof Client>,
    messageId: string,
  ): Promise<{ data: string; mimetype: string; filename?: string } | null> {
    const page = c.pupPage;
    if (!page) throw new Error('browser page not available');
    const res = (await page.evaluate(`(async () => {
      const ID = ${JSON.stringify(messageId)};
      const coll = window.require('WAWebCollections');
      const rebuilt = (m) => {
        if (!m.id) return '';
        if (m.id._serialized) return m.id._serialized;
        const rem = m.id.remote ? (m.id.remote._serialized || String(m.id.remote)) : '';
        return String(!!m.id.fromMe) + '_' + rem + '_' + m.id.id;
      };
      const msg = coll.Msg.getModelsArray().find((m) => rebuilt(m) === ID);
      if (!msg) return { err: 'message not in memory' };
      if (!msg.mediaData) return { err: 'no media on this message' };
      if (msg.mediaData.mediaStage === 'REUPLOADING') return { err: 'media expired on WhatsApp' };
      if (msg.mediaData.mediaStage !== 'RESOLVED') {
        try { await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 }); }
        catch (e) { return { err: 'resolve failed: ' + String(e && e.message || e) }; }
      }
      const stage = String(msg.mediaData.mediaStage || '');
      if (stage.includes('ERROR') || stage === 'FETCHING') return { err: 'stage ' + stage };
      const qpl = { addAnnotations() { return this; }, addPoint() { return this; } };
      try {
        const buf = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash,
          mediaKey: msg.mediaKey, mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type,
          signal: new AbortController().signal, downloadQpl: qpl,
        });
        const data = await window.WWebJS.arrayBufferToBase64Async(buf);
        return { data, mimetype: msg.mimetype || 'application/octet-stream', filename: msg.filename };
      } catch (e) {
        return { err: 'download failed: ' + String(e && e.message || e) };
      }
    })()`)) as { data?: string; mimetype?: string; filename?: string; err?: string };
    if (!res || res.err || !res.data) {
      logger.warn({ messageId, reason: res?.err ?? 'empty' }, 'media fetch failed');
      return null;
    }
    return { data: res.data, mimetype: res.mimetype ?? 'application/octet-stream', filename: res.filename };
  }

  /**
   * Delete a message via the page's own modules. whatsapp-web.js's Message.delete looks the
   * message up with Msg.get(serializedId) — undefined on @lid chats, which is nearly all of ours —
   * so this does the same work but finds the model the way fetchMedia does, then calls the same
   * Cmd.sendRevokeMsgs / sendDeleteMsgs the library would (2.3000+ argument shape; that is the
   * only WhatsApp Web this app runs against).
   */
  async function deleteMsg(
    c: InstanceType<typeof Client>,
    messageId: string,
    everyone: boolean,
  ): Promise<{ ok: boolean; reason?: string }> {
    const page = c.pupPage;
    if (!page) return { ok: false, reason: 'browser page not available' };
    const res = (await page.evaluate(`(async () => {
      const ID = ${JSON.stringify(messageId)};
      const EVERYONE = ${JSON.stringify(everyone)};
      const coll = window.require('WAWebCollections');
      const rebuilt = (m) => {
        if (!m.id) return '';
        if (m.id._serialized) return m.id._serialized;
        const rem = m.id.remote ? (m.id.remote._serialized || String(m.id.remote)) : '';
        return String(!!m.id.fromMe) + '_' + rem + '_' + m.id.id;
      };
      const msg = coll.Msg.getModelsArray().find((m) => rebuilt(m) === ID);
      if (!msg) return { err: 'message not in memory (too old to delete from here)' };
      const remote = msg.id.remote ? (msg.id.remote._serialized || String(msg.id.remote)) : '';
      const chat = coll.Chat.get(msg.id.remote) || coll.Chat.get(remote) || (await coll.Chat.find(msg.id.remote));
      if (!chat) return { err: 'chat not found' };
      const { Cmd } = window.require('WAWebCmd');
      if (EVERYONE) {
        const cap = window.require('WAWebMsgActionCapability');
        const can = cap.canSenderRevokeMsg(msg) || cap.canAdminRevokeMsg(msg);
        if (!can) return { err: 'WhatsApp will no longer revoke this message (too old, or not ours)' };
        await Cmd.sendRevokeMsgs(chat, { list: [msg], type: 'message' }, { clearMedia: true });
        return { done: true };
      }
      await Cmd.sendDeleteMsgs(chat, { list: [msg], type: 'message' }, true);
      return { done: true };
    })()`)) as { done?: boolean; err?: string };
    if (!res?.done) {
      logger.warn({ messageId, everyone, reason: res?.err ?? 'empty result' }, 'message delete failed');
      return { ok: false, reason: res?.err ?? 'delete failed' };
    }
    logger.info({ messageId, everyone }, 'message deleted in WhatsApp');
    return { ok: true };
  }

  /**
   * Star or pin a message via the page's own modules. Same story as deleteMsg: the library's
   * Message.star()/pin() look the message up with Msg.get(serializedId), broken on @lid chats,
   * so the model is found with the rebuilt-id scan and then the SAME actions the library would
   * call are issued (Cmd.sendStarMsgs / WAWebSendPinMessageAction.sendPinInChatMsg).
   */
  async function msgAction(
    c: InstanceType<typeof Client>,
    messageId: string,
    action: 'star' | 'unstar' | 'pin' | 'unpin' | 'react',
    extra = '',
  ): Promise<{ ok: boolean; reason?: string }> {
    const page = c.pupPage;
    if (!page) return { ok: false, reason: 'browser page not available' };
    const res = (await page.evaluate(`(async () => {
      const ID = ${JSON.stringify(messageId)};
      const ACTION = ${JSON.stringify(action)};
      const EXTRA = ${JSON.stringify(extra)};
      const coll = window.require('WAWebCollections');
      const rebuilt = (m) => {
        if (!m.id) return '';
        if (m.id._serialized) return m.id._serialized;
        const rem = m.id.remote ? (m.id.remote._serialized || String(m.id.remote)) : '';
        return String(!!m.id.fromMe) + '_' + rem + '_' + m.id.id;
      };
      const msg = coll.Msg.getModelsArray().find((m) => rebuilt(m) === ID);
      if (!msg) return { err: 'message not in memory (too old for this action)' };
      const remote = msg.id.remote ? (msg.id.remote._serialized || String(msg.id.remote)) : '';
      const chat = coll.Chat.get(msg.id.remote) || coll.Chat.get(remote) || (await coll.Chat.find(msg.id.remote));
      if (!chat) return { err: 'chat not found' };
      if (ACTION === 'star' || ACTION === 'unstar') {
        if (!window.require('WAWebMsgActionCapability').canStarMsg(msg)) return { err: 'WhatsApp does not allow starring this message' };
        const { Cmd } = window.require('WAWebCmd');
        if (ACTION === 'star') await Cmd.sendStarMsgs(chat, [msg], false);
        else await Cmd.sendUnstarMsgs(chat, [msg], false);
        return { done: true };
      }
      if (ACTION === 'react') {
        await window.require('WAWebSendReactionMsgAction').sendReactionToMsg(msg, EXTRA);
        return { done: true };
      }
      // Pin: WhatsApp pins carry an expiry; 7 days is WhatsApp's own default choice. The constant
      // patch mirrors the library's pinUnpinMsgAction (1 = pin, 2 = unpin).
      const DURATION = 604800;
      const constants = window.require('WAWebPinMsgConstants');
      const original = constants.getPinExpiryDuration;
      constants.getPinExpiryDuration = () => DURATION;
      try {
        const r = await window.require('WAWebSendPinMessageAction')
          .sendPinInChatMsg(msg, ACTION === 'pin' ? 1 : 2, DURATION);
        if (r && r.messageSendResult && r.messageSendResult !== 'OK') return { err: 'WhatsApp refused: ' + r.messageSendResult };
        return { done: true };
      } finally {
        constants.getPinExpiryDuration = original;
      }
    })()`)) as { done?: boolean; err?: string };
    if (!res?.done) {
      logger.warn({ messageId, action, reason: res?.err ?? 'empty result' }, 'message action failed');
      return { ok: false, reason: res?.err ?? `${action} failed` };
    }
    logger.info({ messageId, action }, 'message action done');
    return { ok: true };
  }

  // Read the full chat list + real names from WhatsApp Web's IndexedDB ('model-storage').
  // whatsapp-web.js's Store-injection APIs (getChats etc.) are broken against current WhatsApp Web,
  // but the page's own persisted data is directly readable. Message BODIES are encrypted at rest
  // (msgRowOpaqueData), so this recovers the catalog + names — not history.
  async function catalogSync(c: InstanceType<typeof Client>): Promise<CatalogRow[] | null> {
    const page = c.pupPage;
    if (!page) return null;
    // Browser-context code as a string: this Node tsconfig has no DOM lib.
    const rows = (await page.evaluate(`(async () => {
      const open = (name) => new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open('model-storage');
      const all = (store) => new Promise((res, rej) => {
        const tx = db.transaction(store, 'readonly');
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      const chats = await all('chat');
      const groups = {};
      (await all('group-metadata')).forEach((g) => { groups[g.id] = g.subject; });
      const contacts = {};
      (await all('contact')).forEach((ct) => { contacts[ct.id] = ct; });
      db.close();
      return chats
        .filter((ch) => ch.id && ch.id !== '0@c.us' && ch.id.indexOf('broadcast') < 0)
        .map((ch) => {
          const isGroup = /@g\\.us$/.test(ch.id);
          const contact = contacts[ch.id];
          const name = (isGroup ? groups[ch.id] : contact && contact.pushname) || ch.name || '';
          return {
            id: ch.id,
            name: String(name || '').trim(),
            isGroup,
            lastTs: ch.t || 0,
            unread: ch.unreadCount || 0,
            altId: (contact && contact.phoneNumber) || null,
          };
        });
    })()`)) as CatalogRow[];
    logger.info({ chats: rows.length }, 'chat catalog synced from IndexedDB');
    return rows;
  }

  return {
    send: async (chatId: string, text: string, mentions?: string[], quotedId?: string): Promise<string> => {
      const opts: Record<string, unknown> = {};
      if (mentions && mentions.length) opts['mentions'] = mentions;
      if (quotedId) opts['quotedMessageId'] = quotedId;
      let sent;
      try {
        sent = await client.sendMessage(chatId, text, Object.keys(opts).length ? opts : undefined);
      } catch (err) {
        if (!quotedId) throw err;
        // The quote lookup uses the same Msg.get path that breaks on @lid chats. The reply text
        // still matters more than the quote decoration — deliver it plain rather than fail.
        logger.warn({ chatId, quotedId, err: (err as Error).message }, 'quoted send failed — sending without the quote');
        delete opts['quotedMessageId'];
        sent = await client.sendMessage(chatId, text, Object.keys(opts).length ? opts : undefined);
      }
      // On @lid chats whatsapp-web.js returns an unusable id, so this is best-effort only —
      // attribution is claimed from the 'message_create' event in index.ts, not from here.
      const id = (sent as { id?: { _serialized?: string } })?.id?._serialized ?? '';
      logger.info({ chatId, chars: text.length, messageId: id }, 'message sent');
      return id;
    },
    del: (messageId: string, everyone: boolean) => deleteMsg(client, messageId, everyone),
    star: (messageId: string, on: boolean) => msgAction(client, messageId, on ? 'star' : 'unstar'),
    pin: (messageId: string, on: boolean) => msgAction(client, messageId, on ? 'pin' : 'unpin'),
    react: (messageId: string, emoji: string) => msgAction(client, messageId, 'react', emoji),
    logout: async () => {
      logger.warn({ session: tag }, 'unlinking this WhatsApp account on request');
      // Belt and braces: wwebjs' logout() is unreliable on WhatsApp Web 2.3000.x (like everything
      // else that goes through its Store lookups), so the QR must not depend on it succeeding.
      // Try the polite device-logout with a timeout, then FORCE a fresh session regardless:
      // destroy the browser, wipe the saved login, start again — that always ends in a QR. If the
      // polite logout failed, the phone keeps a stale "linked device" entry the user can remove.
      try {
        await Promise.race([
          client.logout(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('logout timed out')), 15_000)),
        ]);
        logger.info({ session: tag }, 'device logged out cleanly');
      } catch (err) {
        logger.warn({ err, session: tag }, 'polite logout failed — forcing a fresh session');
      }
      try {
        await client.destroy();
      } catch {
        /* already down */
      }
      try {
        fs.rmSync(path.join(authDir, 'session'), { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, session: tag }, 'session wipe failed');
      }
      initAt = Date.now();
      sawQr = false;
      stuckRestarts = 0;
      // A fresh client, not this destroyed one — the session dir was just wiped, and a destroyed
      // client never comes back from initialize() (see makeClient).
      void spawnFresh('relink initialize failed');
    },
    media: (messageId: string) => fetchMedia(client, messageId),
    sendMedia: async (chatId, file, caption, mentions, _sentBy, asVoice): Promise<string> => {
      const media = new MessageMedia(file.mimetype, file.data, file.filename);
      const sent = await client.sendMessage(chatId, media, {
        ...(caption ? { caption } : {}),
        ...(mentions && mentions.length ? { mentions } : {}),
        // The push-to-talk bubble instead of an audio-file attachment — how WhatsApp itself
        // sends a recorded voice note.
        ...(asVoice ? { sendAudioAsVoice: true } : {}),
      });
      const id = (sent as { id?: { _serialized?: string } })?.id?._serialized ?? '';
      logger.info({ chatId, filename: file.filename, mimetype: file.mimetype, messageId: id }, 'media sent');
      return id;
    },
    stop: async () => {
      if (catalogTimer) clearInterval(catalogTimer);
      clearInterval(watchdog);
      try {
        await client.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
