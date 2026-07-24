/** Canonical, connector-agnostic event the rest of the system consumes. */

export type WaEventType = 'message' | 'reaction';

export type WaMessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio' // regular audio file
  | 'voice' // ptt / push-to-talk voice note
  | 'document'
  | 'sticker'
  | 'other';

export interface WaMediaRef {
  kind: WaMessageKind;
  /** Absolute path where the media was saved, once downloaded. */
  path?: string;
  mimetype?: string;
  /** Voice-note transcript, once STT is wired up. */
  transcript?: string;
  /** Seconds, for audio/voice/video. */
  durationSec?: number;
  bytes?: number;
}

export interface WaReplyContext {
  /** messageId of the quoted/replied-to message. */
  messageId: string;
  /** Sender JID of the quoted message, if known. */
  participant?: string;
  /** Text of the quoted message, if it was text. */
  text?: string;
}

export interface WaReaction {
  /** The emoji, or '' when a reaction is removed. */
  emoji: string;
  /** messageId the reaction targets. */
  targetMessageId: string;
}

export interface WaEvent {
  type: WaEventType;
  /** Group JID (…@g.us) or user JID for a direct chat. */
  groupId: string;
  isGroup: boolean;
  /** Sender JID (the participant, in a group). */
  sender: string;
  pushName?: string;
  /** WhatsApp message id (for reactions, this is the reacted-to id). */
  messageId: string;
  /** Unix epoch seconds. */
  ts: number;
  /** Whether the linked account authored this (rare in read-only). */
  fromMe: boolean;

  // type === 'message'
  kind?: WaMessageKind;
  text?: string;
  media?: WaMediaRef;
  replyTo?: WaReplyContext;

  // type === 'reaction'
  reaction?: WaReaction;
}
