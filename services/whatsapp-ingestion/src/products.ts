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
        imageUrl: (r['Image URL'] ?? '').trim(),
        stock: parseFloat(String(r['Available'] ?? '').replace(/[^\d.-]/g, '')) || 0, // decimal (e.g. 1746.8 ft)
        norm: normalize(description),
      };
    })
    .filter((p) => p.code || p.description);

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
