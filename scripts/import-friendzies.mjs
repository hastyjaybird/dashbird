#!/usr/bin/env node
/**
 * One-time Friendzies 2025 spreadsheet → Network friends import.
 * Usage: node scripts/import-friendzies.mjs [path-to-json]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addContact,
  findContactByNameOrAlias,
  updateContact,
} from '../src/lib/network-contacts-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_JSON = path.join(PKG_ROOT, 'data/friendzies-2025-import.json');

function uniqStrings(list, max = 40) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const s = String(item || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function mergeCircles(a, b) {
  const parts = [...String(a || '').split(/[,;]+/), ...String(b || '').split(/[,;]+/)]
    .map((s) => s.trim())
    .filter(Boolean);
  return uniqStrings(parts, 40).join(', ');
}

async function main() {
  const jsonPath = path.resolve(process.argv[2] || DEFAULT_JSON);
  const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const contacts = Array.isArray(raw?.contacts) ? raw.contacts : [];
  if (!contacts.length) {
    console.error('No contacts in', jsonPath);
    process.exit(1);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of contacts) {
    const name = String(row.displayName || '').trim();
    if (!name) {
      skipped += 1;
      continue;
    }
    const existing = await findContactByNameOrAlias(name);
    if (existing) {
      const aliases = uniqStrings([...(existing.aliases || []), ...(row.aliases || [])], 20);
      const urls = uniqStrings(
        [...(existing.channels?.urls || []), ...(row.channels?.urls || [])],
        20,
      );
      const preferred = uniqStrings(
        [...(existing.preferredContactMethods || []), ...(row.preferredContactMethods || [])],
        12,
      );
      const kinds = uniqStrings([...(existing.kinds || []), ...(row.kinds || ['friend'])], 6);
      const patch = {
        aliases,
        kinds: kinds.length ? kinds : ['friend'],
        networkCircles: mergeCircles(existing.networkCircles, row.networkCircles),
        bio: existing.bio || row.bio || '',
        notes: [existing.notes, row.notes].filter(Boolean).join('\n\n').slice(0, 8000),
        preferredContactMethods: preferred,
        channels: {
          email: existing.channels?.email || row.channels?.email || null,
          phone: existing.channels?.phone || row.channels?.phone || null,
          sms: existing.channels?.sms || null,
          signal: existing.channels?.signal || null,
          whatsapp: existing.channels?.whatsapp || null,
          linkedin: existing.channels?.linkedin || null,
          urls,
        },
        source: existing.source === 'seed' ? 'seed' : existing.source || 'friendzies-import',
      };
      await updateContact(existing.id, patch);
      updated += 1;
      continue;
    }

    await addContact({
      ...row,
      kinds: row.kinds?.length ? row.kinds : ['friend'],
      source: 'friendzies-import',
    });
    created += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        file: jsonPath,
        total: contacts.length,
        created,
        updated,
        skipped,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
