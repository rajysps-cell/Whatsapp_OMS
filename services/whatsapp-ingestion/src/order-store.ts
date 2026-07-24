import { config } from './config';
import type { Extraction } from './extractor';
import type { WaEvent } from './types';

export type OrderRole = 'customer' | 'warehouse';
export type OrderStatus = 'new' | 'discussion' | 'waiting_customer' | 'waiting_warehouse' | 'finalized';

export interface OrderItem {
  quantity: string;
  product: string;
}

export interface OrderMessage {
  messageId: string;
  sender: string;
  senderName?: string;
  role: OrderRole;
  kind: string;
  text?: string;
  replyToText?: string;
  ts: number;
  intent?: string;
}

export interface Order {
  id: string;
  groupId: string;
  status: OrderStatus;
  customerName?: string;
  jobSite: string | null;
  pickupLocation: string | null;
  items: OrderItem[];
  summary: string | null;
  messages: OrderMessage[];
  createdTs: number;
  updatedTs: number;
  finalizedBy?: string;
  finalizedTs?: number;
}

// whatsapp-web.js serialized id is `{fromMe}_{chatId}_{ID}[_{participant}]`;
// replyTo.messageId (quotedStanzaID) is the bare {ID}. Match on the bare id.
function bareId(serialized: string | undefined): string {
  if (!serialized) return '';
  return serialized.split('_')[2] ?? serialized;
}

function roleOf(name: string | undefined, sender: string): OrderRole {
  const hay = `${name ?? ''} ${sender}`.toLowerCase();
  return config.warehouseNames.some((w) => hay.includes(w.toLowerCase())) ? 'warehouse' : 'customer';
}

// AI-classified intent → status (structural signals below can override to 'discussion'/'finalized').
const INTENT_STATUS: Record<string, OrderStatus> = {
  finalized: 'finalized',
  customer_approval: 'waiting_warehouse',
  warehouse_approval: 'waiting_customer',
  replacement: 'discussion',
  discussion: 'discussion',
};

/**
 * Groups WhatsApp events into one evolving order per reply-thread.
 * Deterministic on its own (threading, roles, finalize-by-reaction); enriched by
 * Claude extraction (items, job site, summary, intent) when a key is available.
 * In-memory for now — swap in Postgres when persistence is needed.
 */
export class OrderStore {
  private orders = new Map<string, Order>();
  private index = new Map<string, string>(); // message bareId -> orderId

  all(): Order[] {
    return [...this.orders.values()];
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  ingestMessage(event: WaEvent, extraction?: Extraction | null): Order {
    const bare = bareId(event.messageId);
    const role = roleOf(event.pushName, event.sender);

    // Belongs to the order it replies to (if that parent is known); else it roots a new order.
    let orderId = event.replyTo?.messageId ? this.index.get(event.replyTo.messageId) : undefined;
    if (!orderId) orderId = bare;

    let order = this.orders.get(orderId);
    if (!order) {
      order = {
        id: orderId,
        groupId: event.groupId,
        status: 'new',
        jobSite: null,
        pickupLocation: null,
        items: [],
        summary: null,
        messages: [],
        createdTs: event.ts,
        updatedTs: event.ts,
      };
      this.orders.set(orderId, order);
    }

    order.messages.push({
      messageId: event.messageId,
      sender: event.sender,
      senderName: event.pushName,
      role,
      kind: event.kind ?? 'other',
      text: event.text ?? event.media?.transcript,
      replyToText: event.replyTo?.text,
      ts: event.ts,
      intent: extraction?.intent,
    });
    this.index.set(bare, orderId);

    if (role === 'customer' && !order.customerName) {
      order.customerName = event.pushName ?? event.sender;
    }
    // Warehouse joining the thread means it's under discussion (unless already finalized).
    if (order.status === 'new' && role === 'warehouse') order.status = 'discussion';

    if (extraction) {
      if (extraction.jobSite && !order.jobSite) order.jobSite = extraction.jobSite;
      if (extraction.pickupLocation && !order.pickupLocation) order.pickupLocation = extraction.pickupLocation;
      if (extraction.items.length) order.items.push(...extraction.items);
      if (extraction.summary) order.summary = extraction.summary;
      const mapped = INTENT_STATUS[extraction.intent];
      if (mapped && order.status !== 'finalized') order.status = mapped;
    }

    order.updatedTs = event.ts;
    return order;
  }

  /** A finalize-emoji reaction on any message in an order marks the order finalized. */
  ingestReaction(event: WaEvent): Order | undefined {
    if (!event.reaction) return undefined;
    const orderId = this.index.get(bareId(event.reaction.targetMessageId));
    if (!orderId) return undefined;
    const order = this.orders.get(orderId);
    if (!order) return undefined;

    if (event.reaction.emoji && config.finalizeEmojis.includes(event.reaction.emoji)) {
      order.status = 'finalized';
      order.finalizedBy = event.pushName ?? event.sender;
      order.finalizedTs = event.ts;
      order.updatedTs = event.ts;
    }
    return order;
  }
}
