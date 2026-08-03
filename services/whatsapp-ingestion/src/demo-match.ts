// Verify extraction + fuzzy matching against the REAL catalog. No browser/WhatsApp/key.
// Run: npm run demo:match
import { strict as assert } from 'node:assert';
import { extractAndMatch, extractItems, searchCatalog } from './matcher';
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
  'ok no problem', 'confirm about this order', 'looking into it', 'driver outside', '20 min', '45min',
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
// Uber, both ways (meeting 31-07): "ship with uber" is a real order line — DDI has a Ship with
// Uber consumable item — while arrival chatter stays dropped. 'uber' used to be a blanket noise
// word, which made the consumable impossible to order.
for (const chatter of ['uber is outside', 'uber in 20 mins', 'uber driver here', 'the uber arrived', 'book an uber']) {
  assert.equal(extractItems(chatter).length, 0, `uber chatter dropped: "${chatter}"`);
}
for (const order of ['ship with uber', 'uber']) {
  assert.equal(extractItems(order).length, 1, `uber order line kept: "${order}"`);
}
assert.ok(
  extractAndMatch('ship with uber')[0]!.matched?.code === 'SHIPWUBER',
  'ship with uber auto-matches the consumable item',
);
// …and an exact name must beat an active material header: "ship with uber" in the middle of a
// Nohub section is still the consumable, not an unmatched no-hub line.
{
  const mixed = extractAndMatch('Nohub\n2 inch coupling\nship with uber');
  assert.equal(mixed[1]!.matched?.code, 'SHIPWUBER', 'exact hit wins over the material pool');
}

// Material headers (meeting 31-07, the client's demonstrated bug): a bare material line applies to
// everything under it, and "2 inch coupling" under Nohub must match a STRAIGHT 2" no-hub coupling —
// not the copper coupling it used to pick, and not the 2x1-1/2 reducer.
{
  const hdr = extractAndMatch('Nohub\n2 inch coupling\n3 inch coupling');
  assert.equal(hdr.length, 2, 'header line emits no item');
  assert.equal(hdr[0]!.material, 'nohub', 'material inherited from the header');
  assert.equal(hdr[0]!.line, 2, 'line number is the source line, not the row index');
  for (const it of hdr) {
    assert.ok(it.matched, `matched under the header: "${it.phrase}"`);
    assert.ok(/no ?hub/i.test(it.matched!.description), `no-hub product chosen: ${it.matched!.description}`);
  }
  assert.ok(/\b2"?\s*(?:no ?hub)/i.test(hdr[0]!.matched!.description), 'straight 2" no-hub coupling');
}

// Package units (meeting 31-07): "box" is a unit, not a product word, and must not poison matching.
{
  const [box] = extractItems('box 2 inch coupling');
  assert.equal(box!.unit, 'box', 'unit captured');
  assert.equal(box!.phrase, '2 inch coupling', 'unit stripped from the phrase');
  const [packOf] = extractItems('box of 100 wire nuts');
  assert.equal(packOf!.unit, 'box of 100', 'pack count kept with the unit');
  assert.equal(packOf!.phrase, 'wire nuts', 'pack count stripped from the phrase');
}

// Quantity/size guard: "40 gallon water heater" is a SIZE, not 40 heaters — this shipped as
// quantity 40 of a 50-gallon heater before the (?!\d) backtracking fix.
{
  const [wh] = extractAndMatch('40 gallon water heater');
  assert.equal(wh!.quantity, '', 'no quantity extracted from the size');
  assert.ok(/40\s*gal/i.test(wh!.matched?.description ?? ''), 'matched a 40-gallon heater');
}

// Staff-taught non-products (the ✕ button): an ignored phrase stays out of future extractions,
// removal brings it back, and the guard means a phrase with a product signal is still skippable
// while an exact SKU never is.
{
  const { addIgnoredPhrase, removeIgnoredPhrase } = await import('./store');
  const { normalize } = await import('./products');
  const phrase = 'galvanized bracket special testcase';
  assert.equal(extractItems(phrase).length, 1, 'phrase extracts before it is taught');
  addIgnoredPhrase(normalize(phrase), phrase, 'demo');
  assert.equal(extractItems(phrase).length, 0, 'taught phrase is skipped');
  removeIgnoredPhrase(normalize(phrase));
  assert.equal(extractItems(phrase).length, 1, 'undo brings the phrase back');
  // an exact SKU can never be silenced, even if a row for it lands in the table
  addIgnoredPhrase(normalize('PABCFA15'), 'PABCFA15', 'demo');
  assert.equal(extractItems('PABCFA15').length, 1, 'exact SKU wins over the ignore list');
  removeIgnoredPhrase(normalize('PABCFA15'));
}

// The catalog search must be space-insensitive both ways: staff type "nohub", the catalog
// writes "NO HUB". Caught by the 03-08 regression sweep — the report search had this rule, the
// product search did not.
assert.ok(searchCatalog('nohub').total > 0, '"nohub" finds "NO HUB" products');
assert.ok(searchCatalog('NBK').total >= 300, 'SKU prefix search');
assert.equal(searchCatalog('NHC50').results[0]?.product.code, 'NHC50', 'exact SKU ranks first');

console.log('✓ non-product extraction filter checks passed');
