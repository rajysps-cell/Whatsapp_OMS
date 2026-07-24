import type { WaEvent } from './types';
import * as store from './store';

export type ChatSummary = store.ChatRow;
export type ChatMsg = store.MsgRow;

/**
 * Per-chat message log, now SQLite-backed (via store) so the chat list and history
 * survive restarts and accumulate — the in-memory version reset on every boot, which
 * is why only chats with a live message since the last start ever showed up.
 */
export class ChatStore {
  record(e: WaEvent): void {
    if (e.type !== 'message') return;
    store.saveMessage({
      messageId: e.messageId,
      chatId: e.groupId,
      sender: e.sender,
      pushName: e.pushName,
      text: e.text ?? '',
      kind: e.kind ?? 'text',
      fromMe: e.fromMe,
      isGroup: e.isGroup,
      ts: e.ts,
    });
    // Direct chat: the sender's WhatsApp display name IS the contact's real name → use it as the title.
    // (Group subjects aren't in the message payload, so groups keep an id-based title. ponytail: no getChat() eval.)
    if (!e.isGroup && !e.fromMe && e.pushName) store.setChatName(e.groupId, e.pushName);
  }

  chats(): ChatSummary[] {
    return store.listChats();
  }

  messages(id: string): ChatMsg[] {
    return store.chatMessages(id, 500);
  }
}
