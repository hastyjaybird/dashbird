#!/usr/bin/env node
/**
 * Verify every static import under public/ resolves to a file that exists.
 *
 * A module missing from a deploy does not 404 loudly in the browser — it turns
 * into "error loading dynamically imported module" against the *entry* module,
 * so the panel that breaks is never the file that is missing. Run this before
 * and after a deploy (see scripts/sync-to-cloud.sh).
 *
 * Run: npm run check:modules [repoRoot]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingModuleImports } from '../src/lib/module-graph-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

if (!fs.existsSync(publicDir)) {
  console.error(`FAIL missing public dir: ${publicDir}`);
  process.exit(1);
}

const { files, imports, missing } = findMissingModuleImports(publicDir);

for (const m of missing) {
  console.error(`FAIL public/${m.from} → ${m.spec} (missing ${path.relative(root, m.target)})`);
}
console.log(
  `RESULT module graph: ${files} files, ${imports} imports, ${missing.length} missing`,
);

if (missing.length) process.exit(1);
