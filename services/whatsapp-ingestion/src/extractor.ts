import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import { logger } from './logger';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

export type OrderIntent =
  | 'new_order'
  | 'discussion'
  | 'replacement'
  | 'customer_approval'
  | 'warehouse_approval'
  | 'finalized'
  | 'question'
  | 'other';

export interface OrderItem {
  quantity: string;
  product: string;
}

export interface Extraction {
  intent: OrderIntent;
  jobSite: string | null;
  pickupLocation: string | null;
  items: OrderItem[];
  summary: string;
  waitingFor: string | null;
  nextAction: string | null;
}

// Raw JSON Schema (structured outputs): all fields required, additionalProperties false,
// nullable fields expressed as ["string","null"]. No zod dependency.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: {
      type: 'string',
      enum: [
        'new_order',
        'discussion',
        'replacement',
        'customer_approval',
        'warehouse_approval',
        'finalized',
        'question',
        'other',
      ],
    },
    jobSite: { type: ['string', 'null'] },
    pickupLocation: { type: ['string', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quantity: { type: 'string' },
          product: { type: 'string' },
        },
        required: ['quantity', 'product'],
      },
    },
    summary: { type: 'string' },
    waitingFor: { type: ['string', 'null'] },
    nextAction: { type: ['string', 'null'] },
  },
  required: ['intent', 'jobSite', 'pickupLocation', 'items', 'summary', 'waitingFor', 'nextAction'],
} as const;

const SYSTEM = `You are an operations assistant for a US plumbing-supply company. Customers and staff coordinate orders in WhatsApp groups. Real messages are usually SHORT, informal, and part of an ongoing back-and-forth — a single order is often built up across several messages and replies. The tidy "job site / quantity product / pickup" layout is the exception, not the rule.

Real examples: "Tanks and pumps please" · "38 Dodworth - 14 4\" NH 45, 2 grooved check valves" · "do you have the victaulic in stock?" · "yes send it" · a thumbs-up reaction that finalizes an order.

Given a SINGLE message, classify it and extract whatever structured data is actually present:
- intent — the single best label:
  - new_order: a customer requesting product(s), even if terse or missing details ("tanks and pumps please").
  - discussion: discussing availability, stock, quantities, or logistics.
  - replacement: proposing or accepting a substitute product.
  - customer_approval: the customer confirming/accepting.
  - warehouse_approval: the warehouse confirming stock/readiness.
  - finalized: a message stating the order is complete.
  - question: a question needing an answer.
  - other: greetings, chatter, single punctuation ("."), anything not order-related.
- items[]: list any products mentioned. Keep the text as written; if no quantity is stated, use "" for quantity. Never invent SKUs or quantities.
- jobSite / pickupLocation: only if explicitly present (often absent), else null.
- summary: one short plain-English sentence.
- waitingFor: what the order is waiting on (customer, warehouse, price, stock), or null.
- nextAction: the recommended next step, or null.
Be conservative on noise: a bare "." or a greeting is intent "other" with empty items.`;

function buildPrompt(input: { text: string; groupName?: string; sender?: string }): string {
  const meta = [
    input.groupName && `Group: ${input.groupName}`,
    input.sender && `Sender: ${input.sender}`,
  ]
    .filter(Boolean)
    .join('\n');
  return `${meta ? `${meta}\n` : ''}Message:\n${input.text}`;
}

/** Turn one WhatsApp message into a structured order extraction. Returns null on failure. */
export async function extractOrder(input: {
  text: string;
  groupName?: string;
  sender?: string;
}): Promise<Extraction | null> {
  try {
    const res = await client.messages.create({
      model: config.extractModel,
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: buildPrompt(input) }],
    });
    const block = res.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    return JSON.parse(block.text) as Extraction;
  } catch (err) {
    logger.error({ err }, 'order extraction failed');
    return null;
  }
}
