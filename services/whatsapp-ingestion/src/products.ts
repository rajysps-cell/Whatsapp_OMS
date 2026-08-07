import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { config } from './config';
import { logger } from './logger';

export interface Product {
  code: string; // the "Product (20)" SKU
  description: string;
  upc: string;
  vendor: string;
  category: string;
  group: string; // "Major Group Description" — the material family ("NO HUB FITTINGS", "COPPER PRESS")
  imageUrl: string;
  stock: number; // on-hand quantity from the "Available" column
  norm: string; // normalized description, precomputed for matching
  /** The product's DEFAULT unit — the one DDI lists first ("EA", "BOX", "PIPE", "FT"…). */
  uom: string;
  /** Every unit this product can be ordered in, default first. Usually one; 303 items have 2-3. */
  uoms: string[];
}

let catalog: Product[] = [];
let byCodeMap = new Map<string, Product>();

/** Lowercase, strip punctuation, collapse whitespace — used for matching everywhere. */
export function normalize(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Load & cache the product catalog from the CSV. Swap this out for a DB later. */
export function load(): void {
  const raw = fs.readFileSync(config.productsCsvPath);
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
    trim: true,
  }) as Record<string, string>[];

  // ONE ROW PER PRODUCT *PER UNIT*, not per product. Since the export gained "Units of Measure" a
  // product orderable in more than one unit repeats: the first row carries the description and the
  // default unit, each extra row adds only another unit and leaves every other column blank.
  // Measured on the first such export: 17,719 rows for 17,392 products — 303 of them multi-unit,
  // and 530 rows with a code but no description. Mapped one-to-one as before, those 530 became
  // blank entries that polluted product search, so the rows have to be folded by code.
  const byCode = new Map<string, Product>();
  for (const r of rows) {
    const code = (r['Product (20)'] ?? '').trim();
    const description = (r['Description'] ?? '').replace(/\s+/g, ' ').trim();
    const uom = (r['Units of Measure'] ?? '').trim();
    if (!code && !description) continue;
    const seen = code ? byCode.get(code) : undefined;
    if (seen) {
      // A continuation row: all it contributes is another unit this product can be ordered in.
      if (uom && !seen.uoms.includes(uom)) seen.uoms.push(uom);
      // Guard against an export that ever puts the description on a later row instead.
      if (!seen.description && description) {
        seen.description = description;
        seen.norm = normalize(description);
      }
      continue;
    }
    const p: Product = {
      code,
      description,
      upc: (r['UPC'] ?? '').trim(),
      vendor: (r['Primary Vendor Name'] ?? '').trim(),
      category: (r['Web Category Description'] ?? '').trim(),
      group: (r['Major Group Description'] ?? '').trim(),
      imageUrl: (r['Image URL'] ?? '').trim(),
      stock: parseFloat(String(r['Available'] ?? '').replace(/[^\d.-]/g, '')) || 0, // decimal (e.g. 1746.8 ft)
      norm: normalize(description),
      uom,
      uoms: uom ? [uom] : [],
    };
    if (code) byCode.set(code, p);
    else catalog.push(p); // codeless rows cannot be folded; keep the old behaviour
  }
  catalog = [...catalog, ...byCode.values()].filter((p) => p.code || p.description);

  // extra-products.csv: hand-kept items missing from the DDI export, e.g. the "Ship with Uber"
  // consumable the client asked for. Kept in a separate file because the daily import overwrites
  // products.csv byte-for-byte — anything added there is gone the next morning. Format: a plain
  // "code,description" header + rows. The DDI row wins when both files carry the same code, so a
  // widened export makes an entry here harmless-redundant rather than conflicting.
  const extraPath = config.productsCsvPath.replace(/[^\\/]+$/, 'extra-products.csv');
  try {
    const extras = parse(fs.readFileSync(extraPath), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: true,
    }) as Record<string, string>[];
    const have = new Set(catalog.map((p) => p.code));
    let added = 0;
    for (const r of extras) {
      const code = (r['code'] ?? '').trim();
      const description = (r['description'] ?? '').replace(/\s+/g, ' ').trim();
      if (!code || !description || have.has(code)) continue;
      catalog.push({
        code,
        description,
        upc: '',
        vendor: '',
        category: '',
        group: (r['group'] ?? '').trim(),
        imageUrl: '',
        stock: 0,
        norm: normalize(description),
        uom: (r['uom'] ?? '').trim() || 'EA',
        uoms: [(r['uom'] ?? '').trim() || 'EA'],
      });
      added++;
    }
    if (added) logger.info({ added, path: extraPath }, 'extra products appended to the catalog');
  } catch {
    /* no extra-products.csv — normal */
  }

  byCodeMap = new Map(catalog.map((p) => [p.code, p]));
  logger.info({ count: catalog.length, path: config.productsCsvPath }, 'product catalog loaded');
}

export function all(): Product[] {
  return catalog;
}

export function byCode(code: string): Product | undefined {
  return byCodeMap.get(code);
}

export function count(): number {
  return catalog.length;
}
