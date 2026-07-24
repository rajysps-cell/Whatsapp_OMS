// Verify extraction + fuzzy matching against the REAL catalog. No browser/WhatsApp/key.
// Run: npm run demo:match
import { strict as assert } from 'node:assert';
import { extractAndMatch, extractItems } from './matcher';
import { count, load } from './products';

load();
console.log(`catalog: ${count()} products\n`);

const samples = [
  'Please send me a price for 5 50gal and 5 pumps',
  '2 floor clean outs 4”',
  'Door Gaurd',
  '40 gallon water heater',
];

for (const text of samples) {
  console.log('== ' + text + ' ==');
  const items = extractAndMatch(text);
  if (!items.length) console.log('  (no items extracted)');
  for (const it of items) {
    if (it.matched) {
      console.log(`  [MATCHED]   ${it.quantity || '?'} x ${it.matched.code} — ${it.matched.description}`);
    } else {
      console.log(`  [UNMATCHED] ${it.quantity || '?'} x "${it.phrase}"  suggestions:`);
      it.suggestions.slice(0, 5).forEach((p) => console.log(`        ${p.code} — ${p.description}`));
    }
  }
  console.log('');
}

// --- self-checks for the non-product extraction filter ---
const dropped = extractItems('Pls deliver\n3008 Godwin\n10 pieces - 2 1/2 groove tee asap');
assert.equal(dropped.length, 1, 'instructions + address dropped, only the product survives');
assert.ok(/groove tee/i.test(dropped[0]!.phrase) && !/asap|pieces/i.test(dropped[0]!.phrase), 'product phrase cleaned');
assert.equal(extractItems('Please deliver to warehouse asap. Thanks').length, 0, 'pure instruction dropped');
assert.equal(extractItems('917 555 1234').length, 0, 'phone number dropped');
assert.ok(extractItems('5 pumps').length === 1, 'product kept');
assert.ok(extractItems('40 gallon water heater').length === 1, 'product kept');

// note/sentence line dropped, real product lines kept (the reported "backorder" message)
const backorder = extractItems(
  'This is backorder will let you know in the morning eta\n3 2x3½ brass nipple\n4 cxf union\n2 3x¾ black tee',
);
assert.equal(backorder.length, 3, 'note line dropped; 3 product lines kept');
assert.ok(!backorder.some((i) => /backorder|morning|eta/i.test(i.phrase)), 'the note text is not among items');

// questions & conversational sentences are notes, not order lines
assert.equal(extractItems('Is this the correct code?').length, 0, 'question dropped');
assert.equal(extractItems('lmk if you have?').length, 0, 'question dropped');
assert.equal(extractItems('this item is not being made').length, 0, 'prose sentence dropped');
assert.equal(extractItems('I completely understand your frustration').length, 0, 'prose sentence dropped');
assert.equal(extractItems('approx time').length, 0, 'note words dropped');

// SAFETY: products with no size/unit/term must still be kept (never dropped by the new rules)
assert.equal(extractItems('6 green kindroff').length, 1, 'no-signal product kept (brand + color)');
assert.equal(extractItems('Water flow switch Potter (vsr s)').length, 1, 'no-signal product kept (multiword)');
assert.equal(extractItems('PABCFA15').length, 1, 'bare product code kept');

// round 2: chatter / status / logistics / places / names / bare numbers dropped
for (const noise of [
  'advise about this', 'advise about this order', 'add', 'checking', 'entered', 'got it', 'copy',
  'ok no problem', 'confirm about this order', 'looking into it', 'driver outside', 'uber', '20 min', '45min',
  'Milton', 'Nate', 'Luis arrived', 'Brooklyn', 'New York', 'Buyer: Brandon', 'Job: 300', 'for 417 Carroll str',
  '20', '/2',
]) {
  assert.equal(extractItems(noise).length, 0, `noise dropped: "${noise}"`);
}
// round 2 SAFETY: real supply/consumable products (now recognised) must be kept
for (const prod of [
  '300 psi gauge', 'red spray paint', 'clear silicone', 'soldering paste', '5 pack of gloves', 'bag of rags',
  '2 map gas', 'turbo torch', 'RFC 49 sprinkler head', "2' 45", '3 pro dope', 'duck butter',
]) {
  assert.equal(extractItems(prod).length, 1, `product kept: "${prod}"`);
}
console.log('✓ non-product extraction filter checks passed');
