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
   */
  send: (chatId: string, text: string, mentions?: string[]) => Promise<string>;
  /** Fetch one message's media as base64, or null if WhatsApp can no longer provide it. */
  media: (messageId: string) => Promise<{ data: string; mimetype: string; filename?: string } | null>;
  /** Send a file (image / document / etc.) with an optional caption. Human-initiated only. */
  sendMedia: (
    chatId: string,
    file: { data: string; mimetype: string; filename: string },
    caption?: string,
    mentions?: string[],
    sentBy?: string,
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
export function startWaClient(handlers: WaClientHandlers): WaClient {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDir }),
    puppeteer: {
      headless: true,
      // --no-sandbox is needed on most Linux servers / containers.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  // Watchdog state. A start that never reaches 'ready' used to sit there until an operator
  // noticed — that is what caused the outage after the last deploy.
  let catalogTimer: NodeJS.Timeout | null = null;
  let ready = false;
  let initAt = Date.now();
  let sawQr = false; // WhatsApp asked for a scan: only a human can fix that
  let stuckRestarts = 0;

  client.on('qr', (qr) => {
    sawQr = true; // a human must scan; restarting the client cannot help and would loop forever
    logger.info('scan this QR from the phone: WhatsApp → Linked devices → Link a device (or open the web page)');
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
    logger.info({ via }, 'connection open — listening for group events (read-only)');
    handlers.onStatus?.('connected');
    if (handlers.onCatalog) {
      const sync = (): void => {
        catalogSync(client)
          .then((rows) => {
            if (rows) handlers.onCatalog?.(rows);
          })
          .catch((err) => logger.error({ err }, 'catalog sync failed'));
      };
      sync();
      if (catalogTimer) clearInterval(catalogTimer); // 'ready' re-fires after reconnects
      // 2 min: unread is bumped live on each message, so this only needs to catch up on reads
      // done elsewhere (phone/WhatsApp Web) and correct any drift. ponytail: lower if it ever lags.
      catalogTimer = setInterval(sync, 2 * 60 * 1000);
    }
    if (handlers.onHistory) {
      historyBackfill(client, handlers.onHistory).catch((err) =>
        logger.error({ err }, 'history backfill failed'),
      );
    }
  };
  client.on('ready', () => becomeReady('ready event'));
  client.on('auth_failure', (msg) => {
    logger.error({ msg }, 'auth failure');
    handlers.onStatus?.('auth failure');
  });
  client.on('disconnected', (reason) => {
    ready = false;
    initAt = Date.now();
    stuckRestarts = 0;
    logger.warn({ reason }, 'disconnected — reinitializing');
    handlers.onStatus?.('disconnected');
    if (String(reason).toUpperCase().includes('LOGOUT')) {
      // The device was unlinked from the phone. whatsapp-web.js wipes the session on this path,
      // so the reconnect below will surface a QR — which is correct, a human has to re-link.
      logger.error('the linked device was signed out on the phone — a QR re-scan is required');
    }
    // destroy() first: this event fires synchronously from inside the library, which does NOT
    // close the browser here. Calling initialize() straight away launched a second Chromium into
    // the same profile directory, and whichever lost the race was orphaned and never closed.
    client
      .destroy()
      .catch(() => undefined)
      .then(() => client.initialize())
      .catch((err) => logger.error({ err }, 'reconnect failed'));
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
  let probing = false; // catalogSync is async and the interval is not — never overlap two probes
  const watchdog = setInterval(() => {
    if (ready || probing) return;
    if (sawQr) return; // waiting on a human to scan — restarting would loop and lose the QR
    if (Date.now() - initAt < PROBE_AFTER_MS) return;
    const restartIfStuck = (): void => {
      if (Date.now() - initAt < STUCK_MS) return;
      if (stuckRestarts >= MAX_STUCK_RESTARTS) return; // give up quietly; the pill says disconnected
      stuckRestarts++;
      logger.warn(
        { stuckForMs: Date.now() - initAt, attempt: stuckRestarts },
        'WhatsApp never became ready and the chat catalog is unreadable — restarting the client',
      );
      initAt = Date.now(); // reset first so a slow restart cannot trigger a second one
      client
        .destroy()
        .catch(() => undefined)
        .then(() => client.initialize())
        .catch((err) => logger.error({ err }, 'watchdog reinitialize failed'));
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
  client.on('message', (msg) => {
    Promise.resolve(handlers.onMessage(msg)).catch((err) => logger.error({ err }, 'onMessage failed'));
  });
  client.on('message_reaction', (reaction) => {
    Promise.resolve(handlers.onReaction(reaction)).catch((err) =>
      logger.error({ err }, 'onReaction failed'),
    );
  });
  // 'message_create' fires for ALL new messages incl. our own; keep only fromMe here so we don't
  // double-handle inbound (already covered by 'message'). Lets us persist the account's own replies.
  if (handlers.onSent) {
    client.on('message_create', (msg) => {
      if (!msg.fromMe) return;
      Promise.resolve(handlers.onSent?.(msg)).catch((err) => logger.error({ err }, 'onSent failed'));
    });
  }

  client.initialize().catch((err) => logger.error({ err }, 'initialize failed'));

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
    send: async (chatId: string, text: string, mentions?: string[]): Promise<string> => {
      const opts = mentions && mentions.length ? { mentions } : undefined;
      const sent = await client.sendMessage(chatId, text, opts);
      // On @lid chats whatsapp-web.js returns an unusable id, so this is best-effort only —
      // attribution is claimed from the 'message_create' event in index.ts, not from here.
      const id = (sent as { id?: { _serialized?: string } })?.id?._serialized ?? '';
      logger.info({ chatId, chars: text.length, messageId: id }, 'message sent');
      return id;
    },
    media: (messageId: string) => fetchMedia(client, messageId),
    sendMedia: async (chatId, file, caption, mentions): Promise<string> => {
      const media = new MessageMedia(file.mimetype, file.data, file.filename);
      const sent = await client.sendMessage(chatId, media, {
        ...(caption ? { caption } : {}),
        ...(mentions && mentions.length ? { mentions } : {}),
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
