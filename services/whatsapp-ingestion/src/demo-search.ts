/**
 * Product-picker search check.
 *
 * The client's complaint, verbatim: staff typed "SDS" and "he only got six options", while DDI
 * showed pages of them. The assertions at the bottom are that complaint turned into something that
 * fails if it ever comes back — particularly that a real SKU prefix like "NBK" (400 products) must
 * not return zero, which is what it did when codes were only ever compared with ===.
 *
 *   npm run demo:search
 */
import { search, searchCatalog } from './matcher';
import * as products from './products';

products.load();

const QUERIES = ['SDS', 'NBK', 'NBK10', 'nohub coupling', 'copper press tee', 'sds'];

for (const q of QUERIES) {
  const oldTop = search(q, 6).map((s) => s.product.code);
  const now = searchCatalog(q, 200);
  console.log('\n=== "' + q + '"');
  console.log('  OLD search(): ' + oldTop.length + ' results  ' + JSON.stringify(oldTop.slice(0, 6)));
  console.log('  NEW total: ' + now.total + '  returned: ' + now.results.length);
  console.log('  top 8:');
  now.results.slice(0, 8).forEach((r) => {
    console.log('    ' + r.product.code.padEnd(16) + r.product.description.slice(0, 58));
  });
}

// Assertions: the client's exact complaint must be fixed.
const sds = searchCatalog('SDS', 200);
const nbk = searchCatalog('NBK', 200);
const nbk10 = searchCatalog('NBK10', 200);

function assert(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
  if (!cond) process.exitCode = 1;
}

console.log('\n--- assertions ---');
assert('SDS returns more than the old six', sds.total > 6, 'total=' + sds.total);
assert('NBK (real SKU prefix) returns results', nbk.total > 0, 'total=' + nbk.total);
assert(
  'every NBK code-prefix hit ranks before description-only hits',
  (() => {
    const codes = nbk.results.map((r) => r.product.code.toLowerCase());
    const lastPrefix = codes.map((c, i) => (c.startsWith('nbk') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstNonPrefix = codes.findIndex((c) => !c.startsWith('nbk'));
    return firstNonPrefix === -1 || lastPrefix < firstNonPrefix;
  })(),
);
assert('NBK10 exact-ish prefix puts NBK10* first', nbk10.results[0]!.product.code.toLowerCase().startsWith('nbk10'));
assert('search is case-insensitive', searchCatalog('sds', 200).total === sds.total);
assert('cap is respected', searchCatalog('copper', 50).results.length <= 50);
assert('empty query returns nothing', searchCatalog('  ', 10).total === 0);
