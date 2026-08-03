import type { Message, Reaction } from 'whatsapp-web.js';
import { config } from './config';
import type { WaEvent, WaMediaRef, WaMessageKind, WaReplyContext } from './types';

const KIND: Record<string, WaMessageKind> = {
  chat: 'text',
  image: 'image',
  video: 'video',
  ptv: 'video', // round video note — without this a live one fell through to 'other' and rendered nothing
  audio: 'audio',
  ptt: 'voice', // push-to-talk = voice note
  document: 'document',
  sticker: 'sticker',
};

function allowed(chatId: string): boolean {
  return config.allowedGroups.length === 0 || config.allowedGroups.includes(chatId);
}

// Shape of the reply reference inside whatsapp-web.js Message._data.
interface QuotedData {
  quotedStanzaID?: string;
  quotedParticipant?: string;
  quotedMsg?: { conversation?: string; body?: string; caption?: string };
}

// whatsapp-web.js can leave msg.id._serialized undefined (newer @lid messages).
// Prefer _serialized; else rebuild `{fromMe}_{remote}_{id}` so bareId() still yields the stanza id.
function serializedId(
  id: { fromMe?: boolean; remote?: string; id?: string; _serialized?: string } | undefined,
  fallback: string,
): string {
  if (!id) return fallback;
  if (id._serialized) return id._serialized;
  if (id.id) return `${id.fromMe ? 'true' : 'false'}_${id.remote ?? ''}_${id.id}`;
  return fallback;
}

/** whatsapp-web.js inbound Message → canonical event (downloads media, resolves replies). */
export async function toMessageEvent(msg: Message): Promise<WaEvent | null> {
  // Inbound: msg.from IS the chat. Outbound (fromMe): msg.from is the account, so the chat is id.remote.
  const chatId =
    (msg.fromMe ? (msg.id as { remote?: string } | undefined)?.remote : msg.from) || msg.from;
  if (!chatId || chatId === 'status@broadcast') return null;

  const isGroup = chatId.endsWith('@g.us');
  if (isGroup && !allowed(chatId)) return null;

  const kind = KIND[msg.type] ?? 'other';

  let media: WaMediaRef | undefined;
  if (msg.hasMedia && kind !== 'text') {
    media = describeMedia(msg, kind);
  }

  // 60+ chars of pure base64 alphabet with no spaces is never human text — it is a thumbnail.
  const looksLikeBase64 = (s: string): boolean => {
    const head = s.trim().slice(0, 80);
    return head.length >= 60 && /^[A-Za-z0-9+/=]+$/.test(head);
  };
  // Read the quoted reference straight from _data. msg.getQuotedMessage() does a
  // Puppeteer eval that throws ("could not load quoted message") whenever the quoted
  // message isn't in the local store — common in busy groups. _data avoids that.
  let replyTo: WaReplyContext | undefined;
  if (msg.hasQuotedMsg) {
    const d = (msg as { _data?: QuotedData })._data;
    if (d?.quotedStanzaID) {
      // A quoted PHOTO carries its JPEG thumbnail as base64 in quotedMsg.body — image bytes, not
      // words, and they rendered as a wall of "/9j/4AAQSkZJRg…" gibberish in the quote preview.
      // Prefer real text (conversation, then the photo's caption); take body only when it reads
      // like something a human typed.
      const raw = d.quotedMsg?.conversation ?? d.quotedMsg?.caption ?? d.quotedMsg?.body;
      replyTo = {
        messageId: d.quotedStanzaID,
        participant: d.quotedParticipant ?? undefined,
        text: raw && !looksLikeBase64(raw) ? raw : undefined,
      };
    }
  }

  return {
    type: 'message',
    groupId: chatId,
    isGroup,
    sender: isGroup ? (msg.author ?? chatId) : chatId,
    // ponytail: notifyName is the cheap sync source; getContact() would be an extra round-trip per message.
    pushName: (msg as { _data?: { notifyName?: string } })._data?.notifyName ?? undefined,
    messageId: serializedId(msg.id, `${chatId}:${msg.timestamp}`),
    ts: msg.timestamp,
    fromMe: msg.fromMe,
    kind,
    text: msg.body || undefined,
    media,
    replyTo,
  };
}

/** whatsapp-web.js Reaction → canonical event. This is the "order finalized" emoji signal. */
export function toReactionEvent(r: Reaction): WaEvent | null {
  const chatId = r.msgId?.remote;
  const targetId = serializedId(r.msgId, '');
  if (!chatId || !targetId) return null;

  const isGroup = chatId.endsWith('@g.us');
  if (isGroup && !allowed(chatId)) return null;

  return {
    type: 'reaction',
    groupId: chatId,
    isGroup,
    sender: r.senderId ?? chatId,
    messageId: targetId,
    ts: r.timestamp,
    fromMe: false,
    reaction: { emoji: r.reaction ?? '', targetMessageId: targetId },
  };
}

/**
 * Describe a message's media without downloading it.
 *
 * This used to call msg.downloadMedia(). That is the whatsapp-web.js path documented as broken on
 * @lid chats (see wa-client.ts) — it failed on every single message, wrote no files, and the
 * caller discarded the result anyway. The bytes are now fetched by the working page-level path in
 * wa-client, cached on arrival by index.ts, and served from /api/media. All that is needed here is
 * the metadata, which comes off the message for free.
 */
function describeMedia(msg: Message, kind: WaMessageKind): WaMediaRef {
  return {
    kind,
    mimetype: (msg as { _data?: { mimetype?: string } })._data?.mimetype,
    bytes: Number((msg as { _data?: { size?: number } })._data?.size) || undefined,
    durationSec: Number((msg as { duration?: string }).duration) || undefined,
  };
}
