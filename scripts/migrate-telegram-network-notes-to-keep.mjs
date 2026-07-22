#!/usr/bin/env node
/**
 * One-shot: copy Network CRM notes with source=telegram into Keep Notes.
 * Idempotent — skips network note ids already recorded on a Keep note meta.
 *
 * Usage (prefer cloud, where Telegram wrote them):
 *   docker compose -f docker-compose.cloud.yml exec -T dashboard \
 *     node scripts/migrate-telegram-network-notes-to-keep.mjs
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNetworkNotes } from '../src/lib/network-notes-store.js';
import {
  createKeepNote,
  keepNotesRoot,
  splitKeepNoteTitleBody,
} from '../src/lib/keep-notes-store.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Set<string>>}
 */
async function alreadyMigratedNetworkIds(env = process.env) {
  const root = keepNotesRoot(env);
  const out = new Set();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(root, ent.name, 'meta.json'), 'utf8'));
      const id = String(meta?.migratedFromNetworkNoteId || '').trim();
      if (id) out.add(id);
    } catch {
      /* skip broken note dirs */
    }
  }
  return out;
}

/**
 * @param {string} keepId
 * @param {{ networkNoteId: string, createdAt?: string }} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
async function stampMigratedMeta(keepId, patch, env = process.env) {
  const safe = String(keepId || '').replace(/[^a-z0-9-]/gi, '');
  const metaPath = path.join(keepNotesRoot(env), safe, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  meta.source = 'telegram';
  meta.migratedFromNetworkNoteId = patch.networkNoteId;
  if (patch.createdAt) {
    meta.createdAt = patch.createdAt;
    meta.updatedAt = patch.createdAt;
  }
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

async function main() {
  const env = process.env;
  const { notes } = await loadNetworkNotes(env);
  const telegram = notes.filter((n) => String(n.source || '') === 'telegram' && String(n.text || '').trim());
  const done = await alreadyMigratedNetworkIds(env);

  let created = 0;
  let skipped = 0;
  for (const n of telegram) {
    if (done.has(n.id)) {
      skipped += 1;
      console.log(`skip already-migrated ${n.id}`);
      continue;
    }
    const { title, body } = splitKeepNoteTitleBody(n.text);
    if (!title && !body) {
      skipped += 1;
      console.log(`skip empty ${n.id}`);
      continue;
    }
    const keep = await createKeepNote({ title, body }, env);
    await stampMigratedMeta(keep.id, { networkNoteId: n.id, createdAt: n.createdAt }, env);
    created += 1;
    const preview = (title || body).slice(0, 80).replace(/\s+/g, ' ');
    console.log(`created keep ${keep.id} ← network ${n.id}: ${preview}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        root: keepNotesRoot(env),
        pkg: PKG_ROOT,
        telegramNetworkNotes: telegram.length,
        created,
        skipped,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
