#!/usr/bin/env node
/**
 * Seed local (or Supabase) web catalog from tool-library.json + bookmarks JSON.
 * Usage: node scripts/migrate-to-web-catalog.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { loadToolLibrary } from '../src/lib/tool-library-store.js';
import {
  toolRecordToResource,
  upsertResource,
  catalogBackend,
} from '../src/lib/web-catalog-store.js';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function loadBookmarks(rel) {
  const p = path.join(root, rel);
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function importBookmarkFile(rel, sectionPrefix) {
  const data = await loadBookmarks(rel);
  if (!data) {
    console.log(`skip missing ${rel}`);
    return 0;
  }
  let n = 0;
  const sections = Array.isArray(data.sections)
    ? data.sections
    : Array.isArray(data)
      ? [{ title: 'Bookmarks', items: data }]
      : [];
  for (const sec of sections) {
    const section = `${sectionPrefix}:${sec.title || 'General'}`;
    const items = Array.isArray(sec.items) ? sec.items : [];
    for (const item of items) {
      const href = String(item.href || item.url || '').trim();
      if (!/^https?:\/\//i.test(href)) continue;
      try {
        await upsertResource(
          {
            url: href,
            title: item.word || item.title || href,
            summary: item.title || '',
            kind_hints: ['site'],
            tags: [sec.title || 'bookmarks'].filter(Boolean),
            icon_path: item.icon || null,
          },
          { project: 'dashbird', section },
        );
        n += 1;
      } catch (e) {
        console.warn('bookmark skip', href, e?.message || e);
      }
    }
  }
  return n;
}

async function main() {
  console.log(`backend: ${catalogBackend()}`);
  const lib = await loadToolLibrary();
  let tools = 0;
  for (const tool of lib.tools || []) {
    try {
      const input = toolRecordToResource(tool);
      await upsertResource(input, { project: 'dashbird', section: 'Tools' });
      tools += 1;
    } catch (e) {
      console.warn('tool skip', tool?.url, e?.message || e);
    }
  }
  const personal = await importBookmarkFile('public/data/bookmarks-personal.json', 'Personal');
  const work = await importBookmarkFile('public/data/bookmarks-work.json', 'Work');
  console.log(JSON.stringify({ tools, bookmarksPersonal: personal, bookmarksWork: work }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
