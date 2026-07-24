import fs from 'node:fs';
import path from 'node:path';
import type { Message, Reaction } from 'whatsapp-web.js';
import { config } from './config';
import { logger } from './logger';
import type { WaEvent, WaMediaRef, WaMessageKind, WaReplyContext } from './types';

const KIND: Record<string, WaMessageKind> = {
  chat: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  ptt: 'voice', // push-to-talk = voice note
  document: 'document',
  sticker: 'sticker',
};

const EXT: Record<string, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'ogg',
  voice: 'ogg',
  document: 'bin',
  sticker: 'webp',
  other: 'bin',
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
    media = await saveMedia(msg, kind);
  }

  // Read the quoted reference straight from _data. msg.getQuotedMessage() does a
  // Puppeteer eval that throws ("could not load quoted message") whenever the quoted
  // message isn't in the local store — common in busy groups. _data avoids that.
  let replyTo: WaReplyContext | undefined;
  if (msg.hasQuotedMsg) {
    const d = (msg as { _data?: QuotedData })._data;
    if (d?.quotedStanzaID) {
      replyTo = {
        messageId: d.quotedStanzaID,
        participant: d.quotedParticipant ?? undefined,
        text: d.quotedMsg?.conversation ?? d.quotedMsg?.body ?? d.quotedMsg?.caption ?? undefined,
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

async function saveMedia(msg: Message, kind: WaMessageKind): Promise<WaMediaRef> {
  try {
    const m = await msg.downloadMedia();
    if (!m?.data) return { kind };
    fs.mkdirSync(config.storeDir, { recursive: true });
    const buf = Buffer.from(m.data, 'base64');
    const file = path.join(config.storeDir, `${msg.id.id}.${EXT[kind] ?? 'bin'}`);
    fs.writeFileSync(file, buf);

    const ref: WaMediaRef = {
      kind,
      path: file,
      mimetype: m.mimetype,
      bytes: buf.length,
      durationSec: Number((msg as { duration?: string }).duration) || undefined,
    };
    if (kind === 'voice' || kind === 'audio') {
      const transcript = await transcribeVoice(file, m.mimetype);
      if (transcript) ref.transcript = transcript;
    }
    return ref;
  } catch (err) {
    logger.error({ err, messageId: msg.id?.id }, 'media download failed');
    return { kind };
  }
}

/**
 * Voice-note transcription seam. STT engine not chosen yet (Whisper vs hosted API).
 * Only call site — swapping providers touches one function.
 */
async function transcribeVoice(_filePath: string, _mimetype?: string): Promise<string | undefined> {
  return undefined; // TODO(stt)
}
