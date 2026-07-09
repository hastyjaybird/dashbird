#!/usr/bin/env node
/**
 * Import interchange JSON v1 into the web catalog.
 * Usage: node scripts/catalog-import.mjs path/to/export.json [--project=dashbird] [--section=Imported]
 */
import fs from 'node:fs/promises';
import 'dotenv/config';
import { importResources } from '../src/lib/web-catalog-store.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/catalog-import.mjs <file.json> [--project=dashbird] [--section=Imported]');
  process.exit(1);
}
let project = 'dashbird';
let section = 'Imported';
for (const a of args) {
  if (a.startsWith('--project=')) project = a.slice(10);
  if (a.startsWith('--section=')) section = a.slice(10);
}
const raw = await fs.readFile(file, 'utf8');
const result = await importResources(JSON.parse(raw), { project, section });
console.log(JSON.stringify({ imported: result.imported, source: result.source }, null, 2));
