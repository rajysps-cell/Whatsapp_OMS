// Verifies the order aggregator against the REAL captured message shapes.
// No WhatsApp, no Anthropic key needed. Run: npm run demo:orders
import { OrderStore } from './order-store';
import type { WaEvent } from './types';

const G1 = '13479399837-1572871666@g.us';
const G2 = '120363428394123311@g.us';
const YOSSI = '5094686908489@lid';
const WAREHOUSE = '83554511929494@lid';
const CUSTOMER = '141025536393444@lid';

// Shapes taken from real captured events on 2026-07-17.
const events: WaEvent[] = [
  {
    type: 'message', groupId: G1, isGroup: true, sender: YOSSI, pushName: 'Yossi @swift',
    messageId: `false_${G1}_3AF2638D3C876D9ECA68`, ts: 1784297384, fromMe: false,
    kind: 'text', text: '2 floor clean outs 4”',
  },
  {
    type: 'message', groupId: G1, isGroup: true, sender: YOSSI, pushName: 'Yossi @swift',
    messageId: `false_${G1}_VOICE0001`, ts: 1784297393, fromMe: false,
    kind: 'voice', media: { kind: 'voice' },
    replyTo: { messageId: '3AF2638D3C876D9ECA68', participant: YOSSI, text: '2 floor clean outs 4”' },
  },
  {
    type: 'message', groupId: G2, isGroup: true, sender: WAREHOUSE, pushName: 'Ys Plumbing Warehouse',
    messageId: `false_${G2}_DOC0001`, ts: 1784297512, fromMe: false,
    kind: 'document', text: 'Q012824.pdf', media: { kind: 'document' },
    replyTo: { messageId: 'AC17A12D0CCDA67B5BB4F0FC1B81F807', participant: CUSTOMER, text: 'Please send me a price for 5 50gal and 5 pumps' },
  },
  // Finalize reaction on the first order's root message.
  {
    type: 'reaction', groupId: G1, isGroup: true, sender: WAREHOUSE, pushName: 'Ys Plumbing Warehouse',
    messageId: `false_${G1}_3AF2638D3C876D9ECA68`, ts: 1784297600, fromMe: false,
    reaction: { emoji: '✅', targetMessageId: `false_${G1}_3AF2638D3C876D9ECA68` },
  },
];

const store = new OrderStore();
for (const e of events) {
  // extraction=null here — this proves the DETERMINISTIC threading/roles/finalize.
  if (e.type === 'reaction') store.ingestReaction(e);
  else store.ingestMessage(e, null);
}

console.log(`Orders reconstructed from ${events.length} events: ${store.all().length}\n`);
console.log(JSON.stringify(store.all(), null, 2));
