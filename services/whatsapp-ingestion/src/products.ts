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

  catalog = rows
    .map((r) => {
      const description = (r['Description'] ?? '').replace(/\s+/g, ' ').trim();
      return {
        code: (r['Product (20)'] ?? '').trim(),
        description,
        upc: (r['UPC'] ?? '').trim(),
        vendor: (r['Primary Vendor Name'] ?? '').trim(),
        category: (r['Web Category Description'] ?? '').trim(),
        group: (r['Major Group Description'] ?? '').trim(),
        imageUrl: (r['Image URL'] ?? '').trim(),
        stock: parseFloat(String(r['Available'] ?? '').replace(/[^\d.-]/g, '')) || 0, // decimal (e.g. 1746.8 ft)
        norm: normalize(description),
      };
    })
    .filter((p) => p.code || p.description);

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
