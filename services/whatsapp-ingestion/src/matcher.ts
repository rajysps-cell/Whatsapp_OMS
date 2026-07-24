import { all, byCode, normalize, type Product } from './products';
import { getAlias } from './store';

export interface Scored {
  product: Product;
  score: number;
}
export interface MatchedItem {
  phrase: string;
  quantity: string;
  matched: Product | null;
  suggestions: Product[];
}

// --- fuzzy scoring (trigram Dice + token overlap + code/UPC boost) ---
function trigrams(s: string): Set<string> {
  const t = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}
function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

interface Idx {
  tri: Set<string>;
  codeNorm: string;
}
let index: Idx[] | null = null;
function ensureIndex(): Idx[] {
  if (!index) index = all().map((p) => ({ tri: trigrams(p.norm), codeNorm: normalize(p.code) }));
  return index;
}
/** Call after (re)loading the catalog so the fuzzy index rebuilds. */
export function resetIndex(): void {
  index = null;
}

export function search(q: string, limit = 5): Scored[] {
  const qn = normalize(q);
  if (!qn) return [];
  const qTri = trigrams(qn);
  const qTokens = qn.split(' ').filter((t) => t.length >= 2);
  const products = all();
  const idx = ensureIndex();

  const scored: Scored[] = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i]!;
    const ix = idx[i]!;
    let s: number;
    if (qn === ix.codeNorm || (q.trim() !== '' && q.trim() === p.upc)) {
      s = 1;
    } else {
      const d = dice(qTri, ix.tri);
      const overlap = qTokens.length
        ? qTokens.filter((t) => p.norm.includes(t)).length / qTokens.length
        : 0;
      const sub = qn.length >= 3 && p.norm.includes(qn) ? 0.15 : 0;
      s = 0.55 * d + 0.35 * overlap + sub;
    }
    if (s > 0.06) scored.push({ product: p, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Only surface genuinely relevant suggestions — never pad the list with weak fuzzy noise.
// ponytail: 0.2 combined-score floor is a heuristic; lower it if good matches get hidden.
const SUGG_MIN = 0.2;
function genuine(scored: Scored[]): Product[] {
  return scored.filter((s) => s.score >= SUGG_MIN).slice(0, 5).map((s) => s.product);
}

export function matchItem(phrase: string): { matched: Product | null; suggestions: Product[] } {
  const qn = normalize(phrase);
  const top = search(phrase, 8);
  const best = top[0];

  // 1. Exact product hit (code / UPC / exact description).
  const exact = !!best && (best.score >= 0.999 || best.product.norm === qn || normalize(best.product.code) === qn);
  if (exact) return { matched: best.product, suggestions: genuine(top.slice(1)) };

  // 2. Exact learned alias (this is how manual corrections auto-match next time).
  const alias = getAlias(qn);
  if (alias) {
    const product: Product = byCode(alias.code) ?? {
      code: alias.code,
      description: alias.desc,
      upc: '',
      vendor: '',
      category: '',
      imageUrl: '',
      stock: 0,
      norm: normalize(alias.desc),
    };
    return { matched: product, suggestions: genuine(top) };
  }

  // 3. Fuzzy — not confident enough to auto-accept; surface only genuine suggestions.
  //    (4. AI similarity is a future seam; 5. else stays unmatched.)
  return { matched: null, suggestions: genuine(top) };
}

// --- heuristic, keyless extraction (AI is a later seam via extractor.ts) ---
const NOISE = new Set([
  'please', 'pls', 'plz', 'thanks', 'thank', 'ty', 'hi', 'hello', 'hey', 'ok', 'okay',
  'yes', 'no', 'good', 'morning', 'the', 'a', 'an', 'for', 'me', 'you', 'send', 'need', 'want',
]);
// Leading request words to peel off so "i need 5 pumps" -> "5 pumps".
const REQUEST = /^\s*(?:hi|hello|hey|please|pls|plz|kindly|i|we|you|do|does|have|can|could|would|will|like|need|needs|want|wants|send|get|give|me|us|the|a|an|some|to)\b[\s,:-]*/i;
function cleanSeg(seg: string): string {
  // drop everything up to and including a "price/quote for" preamble
  let s = seg.replace(/^.*\b(?:price|pricing|quote)\b\s*(?:for|on|of)?\s*/i, '');
  // then peel leading request words one at a time
  let prev = '';
  while (s && s !== prev) {
    prev = s;
    s = s.replace(REQUEST, '');
  }
  return s.trim() || seg.trim();
}

// --- non-product-line detection (skip addresses, greetings, delivery notes, phones, etc.) ---
// Instruction / logistics / greeting words — a segment made only of these is not a product.
const INSTRUCTION = new Set([
  'hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'night', 'thanks', 'thank', 'thankyou',
  'thx', 'ty', 'ok', 'okay', 'yes', 'no', 'sure', 'please', 'pls', 'plz', 'kindly', 'deliver', 'delivery',
  'delivered', 'ship', 'shipping', 'shipment', 'send', 'sent', 'pickup', 'pick', 'up', 'asap', 'urgent',
  'urgently', 'today', 'tomorrow', 'tonight', 'now', 'later', 'call', 'me', 'back', 'confirm', 'order',
  'need', 'want', 'get', 'give', 'for', 'the', 'a', 'an', 'some', 'to', 'at', 'this', 'that', 'it', 'them',
  'and', 'or', 'is', 'are', 'be', 'from', 'with', 'on', 'in', 'of', 'by', 'as', 'per',
]);
// Standalone location words that are never products on their own (incl. NYC-area places seen in the data).
const NON_PRODUCT_WORDS = new Set([
  'office', 'warehouse', 'building', 'shop', 'store', 'home', 'house', 'site', 'jobsite', 'job', 'address', 'location',
  'ny', 'nyc', 'new', 'york', 'brooklyn', 'bronx', 'queens', 'manhattan', 'yonkers', 'united', 'states', 'usa', 'america',
]);
// Standalone "note" words — a line made only of these (+ instruction/location words) is chatter, not a product.
const NOTE_WORDS = new Set([
  'lmk', 'advice', 'advise', 'understanding', 'sorry', 'possible', 'correct', 'model', 'update', 'updated', 'info',
  'information', 'question', 'questions', 'guys', 'approx', 'time', 'eta', 'backorder', 'soon', 'price', 'quote',
  // acknowledgements / status / logistics chatter
  'add', 'copy', 'checking', 'entered', 'ready', 'here', 'outside', 'mins', 'min', 'hr', 'hrs', 'uber', 'uver',
  'link', 'driver', 'cancel', 'cancelled', 'approved', 'missing', 'perfect', 'omg', 'yup', 'yesss', 'oky', 'idea',
  'around', 'each', 'these', 'got', 'arrived', 'gm', 'done', 'anything', 'everything', 'nothing', 'ordered',
  'finishing', 'noted', 'received', 'looking', 'problem', 'problems', 'good', 'great', 'fine', 'sure',
  'understood', 'sir', 'spoke', 'did', 'list', 'yes', 'yeah', 'yep', 'nope', 'thx', 'ty', 'welcome',
]);
// Conversational words (pronouns / verbs / question words). 2+ of these in a segment ⇒ it's a sentence,
// not an order line. Deliberately EXCLUDES words that appear in product specs (in, to, of, x, for).
const PROSE = new Set([
  'i', 'we', 'you', 'your', 'yours', 'he', 'she', 'they', 'them', 'their', 'his', 'her', 'me', 'us', 'my',
  'our', 'ours', 'u', 'ur', 'this', 'that', 'these', 'those', 'who', 'what', 'when', 'where', 'why', 'how',
  'which', 'whose', 'whom', 'is', 'are', 'am', 'was', 'were', 'been', 'being', 'be', 'do', 'does', 'did',
  'have', 'has', 'had', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'lmk',
  'know', 'knew', 'think', 'thought', 'understand', 'understood', 'make', 'makes', 'made', 'making', 'let',
  'lets', 'help', 'helps', 'tell', 'told', 'say', 'said', 'sorry', 'guys', 'again', 'still', 'already',
  'soon', 'need', 'needs', 'want', 'wants', 'possible', 'correct', 'advice', 'approx', 'whenever', 'everyone',
  'anybody', 'someone', 'somebody', 'frustration', 'patience', 'busy', 'model', 'understanding',
  // conversational verbs seen in the real chatter
  'advise', 'advised', 'confirm', 'confirmed', 'got', 'copy', 'entered', 'checking', 'arrived', 'looking',
  'posted', 'cancel', 'approved', 'missing', 'ordered', 'spoke', 'keep', 'eta', 'received', 'noted', 'done',
  'into', 'onto', 'about', 'there', 'many',
]);
// Recurring sender / delivery-driver first names seen in the data — never products. (Novel names still need
// the AI seam to catch reliably; deliberately excludes brand-ambiguous words like "Henry" and "Cooper".)
const NAMES = new Set([
  'milton', 'nate', 'luis', 'jose', 'gus', 'zali', 'zevy', 'brandon', 'shulem', 'godwin', 'nathan',
]);
function proseCount(norm: string): number {
  let n = 0;
  for (const t of norm.split(' ')) if (PROSE.has(t)) n++;
  return n;
}
// Plumbing / hardware vocabulary — presence of any of these marks a line as a real product.
// (Address-ambiguous words like street/floor/way/court/place/lane are deliberately excluded.)
const PRODUCT_TERMS = new Set([
  'union', 'tee', 'tees', 'elbow', 'elbows', 'ell', 'coupling', 'couplings', 'coupler', 'nipple', 'nipples',
  'valve', 'valves', 'pipe', 'pipes', 'pump', 'pumps', 'trap', 'traps', 'flange', 'flanges', 'gasket',
  'gaskets', 'washer', 'washers', 'bolt', 'bolts', 'nut', 'nuts', 'screw', 'screws', 'fitting', 'fittings',
  'adapter', 'adapters', 'adaptor', 'bushing', 'bushings', 'cap', 'caps', 'plug', 'plugs', 'wye', 'cross',
  'reducer', 'reducing', 'tank', 'tanks', 'faucet', 'faucets', 'drain', 'drains', 'hose', 'hoses', 'clamp',
  'clamps', 'strainer', 'cleanout', 'cleanouts', 'brass', 'copper', 'pvc', 'cpvc', 'abs', 'galvanized',
  'galv', 'stainless', 'steel', 'npt', 'ips', 'sweat', 'threaded', 'thread', 'sanitary', 'closet', 'toilet',
  'sink', 'urinal', 'boiler', 'heater', 'heaters', 'pex', 'hanger', 'hangers', 'strap', 'bracket', 'aerator',
  'cartridge', 'stem', 'seat', 'ball', 'gate', 'check', 'supply', 'riser', 'stop', 'angle', 'compression',
  'solder', 'flux', 'hammer', 'box', 'boxes', 'pad', 'pads', 'anchor', 'anchors', 'groove', 'grooved',
  'schedule', 'sch', 'dwv', 'nohub', 'cast', 'iron', 'ductile', 'fernco', 'gallon', 'gal', 'spud', 'ptrap',
  'bend', 'flush', 'seal', 'oring', 'wax', 'ring', 'plunger', 'auger', 'teflon', 'tape', 'primer', 'cement',
  'backflow', 'prv', 'expansion', 'dielectric', 'sharkbite', 'propress', 'crimp', 'manifold', 'baseboard',
  'vent', 'flapper', 'fill', 'handle', 'lever', 'bib', 'hosebibb', 'sillcock', 'hydrant', 'sump', 'sewage',
  'ejector', 'grinder', 'insulation', 'setter', 'balancing',
  // supplies / consumables customers order that lack a size or an obvious fitting word
  'sprinkler', 'sprinklers', 'gauge', 'gauges', 'glove', 'gloves', 'rag', 'rags', 'silicone', 'caulk', 'sealant',
  'glue', 'putty', 'dope', 'butter', 'tuff', 'soldering', 'torch', 'propane', 'mapp', 'gas', 'spray', 'paint',
  'wire', 'paste', 'water', 'cover', 'covers', 'kindorf', 'strut', 'nh', 'hub',
]);
const STREET_RE = /\b(st|street|ave|avenue|blvd|rd|road|dr|drive|ln|lane|ct|court|pl|place|way|hwy|highway|pkwy|parkway|apt|suite|ste)\b/i;

/** A phrase has a "product signal" if it has a size/unit, a known product term, or is a saved alias. */
export function hasProductSignal(phrase: string): boolean {
  const low = phrase.toLowerCase();
  if (/\d\s*\/\s*\d/.test(low)) return true; // fraction size (3/4, 1/2)
  if (/\d\s*(?:"|''|”|'|′|in\b|inch|inches|mm|cm|ft|foot|feet|psi|gauge|ga\b|gal\b|gallon|lb\b|oz\b|hp\b)/.test(low)) return true;
  const toks = normalize(low).split(' ');
  for (const t of toks) if (PRODUCT_TERMS.has(t)) return true;
  if (getAlias(normalize(low))) return true; // previously-learned alias → definitely a product
  return false;
}
/** True for lines that are clearly NOT products (addresses, greetings, phones, dates, PO/tracking…). */
function isNonProduct(seg: string, phrase: string): boolean {
  const s = seg.trim();
  const low = s.toLowerCase();
  const norm = normalize(phrase);
  if (!norm) return true;
  if (!/[a-z]/i.test(norm)) return true; // no letters at all → bare number / punctuation fragment ("20", "/2")
  const toks = norm.split(' ').filter(Boolean);
  if (toks.every((t) => INSTRUCTION.has(t) || NON_PRODUCT_WORDS.has(t) || NOTE_WORDS.has(t) || NAMES.has(t))) return true; // pure greeting/instruction/note/place/name
  if (s.includes('?')) return true; // a question is a note/inquiry, not an order line
  if (proseCount(norm) >= 2) return true; // 2+ conversational words ⇒ a sentence, not a product
  if (/^\d+\s*(?:mins?|minutes?|hrs?|hours?|secs?)\b/i.test(s)) return true; // a duration ("20 min", "45min")
  if (STREET_RE.test(s) && /\d/.test(s)) return true; // street address
  if (s.replace(/\D/g, '').length >= 7) return true; // phone / long numeric id
  if (/^\d{5}(-\d{4})?$/.test(s.replace(/\s/g, ''))) return true; // ZIP
  if (/\b(today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight)\b/i.test(low)) return true;
  if (/\b\d{1,2}\s*(?::\d{2})?\s*(am|pm)\b/i.test(low) || /\b\d{1,2}:\d{2}\b/.test(s)) return true; // time
  if (/\b(invoice|inv#|po#|p\.o|order\s*#|tracking|track#|ref#|buyer|job|contacte?)\b/i.test(low)) return true; // invoice / PO / tracking / buyer / job / contact
  if (/^\s*(pickup|pick\s*up|deliver|delivery|shipping|ship\s*to|deliver\s*to|call\s*me|thank|thanks|thankyou|asap)\b/i.test(low)) return true;
  if (/^(?:for|at|to|from|pick\s*up)?\s*\d{3,}\b/i.test(s)) return true; // (opt. prep +) leading 3+ digit number → address / building / ref
  return false;
}

export interface ExtractedItem {
  phrase: string;
  quantity: string;
}
export function extractItems(text: string): ExtractedItem[] {
  const segments = String(text)
    .split(/[\n,;•]+|\band\b/gi)
    .map((s) => s.trim())
    .filter(Boolean);

  const items: ExtractedItem[] = [];
  for (const raw of segments) {
    if (/https?:\/\//i.test(raw)) continue; // links (e.g. Uber trip) are never order lines
    const seg = cleanSeg(raw);
    let quantity = '';
    let phrase = seg;

    // "5 pumps" / "5x pumps" — but NOT when the leading number is a size (2' , 3/4, 6”), which must stay in the phrase.
    let m = seg.match(/^\s*(\d+)(?![\/'"”“′″])\s*x?\b\s*(.+)$/i);
    if (m) {
      quantity = m[1]!;
      phrase = m[2]!;
    } else if ((m = seg.match(/^(.+?)\s*x\s*(\d+)\s*$/i))) {
      // "pumps x5"
      phrase = m[1]!;
      quantity = m[2]!;
    } else if ((m = seg.match(/^(.+?)\s+(\d+)\s*$/)) && m[1]!.trim().length >= 2) {
      // "pumps 5"
      phrase = m[1]!;
      quantity = m[2]!;
    }

    // Clean the phrase: drop leading list-marker/punct, a leading unit/count word ("10 pieces - 2\" tee"
    // -> "2\" tee"), and a trailing instruction word ("2\" tee asap" -> "2\" tee").
    phrase = phrase
      .replace(/^[\s.)\-–—•]+/, '')
      .replace(/^\s*(?:pieces?|pcs?|pc|each|ea|units?|sets?|qty|nos?|x)\b[\s.:)\-–—]*/i, '')
      .replace(/^[\s.)\-–—•]+/, '')
      .replace(/\s*\b(?:asap|please|pls|plz|thanks?|thankyou|thx|today|tomorrow|tonight|urgent|urgently)\b\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const meaningful = phrase.toLowerCase().split(/\s+/).filter((w) => w && !NOISE.has(w));
    if (meaningful.join('').length < 2) continue; // pure noise / too short
    // Skip clear non-product lines (address, greeting, phone, date…), unless it has a product signal.
    if (!hasProductSignal(phrase) && isNonProduct(raw, phrase)) continue;

    items.push({ phrase, quantity });
  }
  return items;
}

/** Extract line-items from conversation text and match each against the catalog. */
export function extractAndMatch(text: string): MatchedItem[] {
  return extractItems(text).map((it) => ({
    phrase: it.phrase,
    quantity: it.quantity,
    ...matchItem(it.phrase),
  }));
}
