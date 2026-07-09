#!/usr/bin/env node
/**
 * Export filtered web catalog as interchange JSON v1.
 * Usage:
 *   node scripts/catalog-export.mjs [--tag=energy] [--ingest] [--proficient] [--kind=tool] [--q=...] [--out=file.json]
 */
import fs from 'node:fs/promises';
import 'dotenv/config';
import { exportResources } from '../src/lib/web-catalog-store.js';

function parseArgs(argv) {
  const out = { filter: {}, outPath: null };
  for (const a of argv) {
    if (a.startsWith('--tag=')) out.filter.tag = a.slice(6);
    else if (a === '--ingest') out.filter.ingest_candidate = true;
    else if (a === '--proficient') out.filter.proficient = true;
    else if (a.startsWith('--kind=')) out.filter.kind = a.slice(7);
    else if (a.startsWith('--q=')) out.filter.search = a.slice(4);
    else if (a.startsWith('--project=')) out.filter.project = a.slice(10);
    else if (a.startsWith('--out=')) out.outPath = a.slice(6);
  }
  return out;
}

const { filter, outPath } = parseArgs(process.argv.slice(2));
const bundle = await exportResources(filter);
const text = `${JSON.stringify(bundle, null, 2)}\n`;
if (outPath) {
  await fs.writeFile(outPath, text, 'utf8');
  console.error(`wrote ${outPath} (${bundle.resources.length} resources)`);
} else {
  process.stdout.write(text);
}
