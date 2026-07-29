/**
 * Self-check for quantity parsing (run: npx tsx src/qty.test.ts).
 * Guards the two failure modes we actually hit with real customer messages:
 *   - spelled-out counts before a dash ("Two – copper couplings") must become quantities
 *   - sizes and elbow angles ("three quarter inch", "1/2 inch 90") must NOT become quantities
 */
import assert from 'node:assert';
import { extractItems } from './matcher';

function qty(line: string): string {
  const r = extractItems(line);
  return r.length ? r[0]!.quantity : '(skipped)';
}
function phrase(line: string): string {
  const r = extractItems(line);
  return r.length ? r[0]!.phrase : '(skipped)';
}

// Spelled-out counts (the reported bug).
assert.strictEqual(qty('Two – copper couplings half inch'), '2');
assert.strictEqual(qty('One – half inch copper pipe cut in half'), '1');
assert.strictEqual(qty('Six – half inch copper 90'), '6');
assert.strictEqual(phrase('Two – copper couplings'), 'copper couplings');
assert.strictEqual(qty('ten 3/4 tees'), '10');

// Digits, with and without separators.
assert.strictEqual(qty('5 pumps'), '5');
assert.strictEqual(qty('5x pumps'), '5');
assert.strictEqual(qty('pumps x5'), '5');
assert.strictEqual(qty('2 -Copper Street 90s half inch'), '2');
assert.strictEqual(qty('4–2 inch No Hub couplings'), '4');
assert.strictEqual(phrase('4–2 inch No Hub couplings'), '2 inch No Hub couplings');

// Sizes must stay in the phrase, never become quantities.
assert.strictEqual(qty('two inch pipe'), '');
assert.strictEqual(qty('three quarter inch tee'), '');
assert.strictEqual(qty('one half inch copper'), '');
assert.strictEqual(qty('3/4 copper tee'), '');
assert.strictEqual(qty('2" ball valve'), '');

// Trailing elbow angles are part of the product, not a count.
assert.strictEqual(qty('1/2 inch 90'), '');
assert.strictEqual(qty('copper 45'), '');

console.log('qty parsing: all checks passed');
