#!/usr/bin/env node
/**
 * Merge two events-finder.db copies (e.g. LAN dev + cloud prod).
 * Union events/skipped by id; when both sides have a row, keep the newer timestamp.
 *
 * Usage:
 *   node scripts/merge-events-finder-db.mjs <base.db> <other.db> [out.db]
 * Default out: <base.db> (in-place on base)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EVENT_COLS = [
  'id', 'source', 'external_id', 'url', 'title', 'start_at', 'end_at', 'venue', 'city',
  'lat', 'lon', 'online', 'description', 'image_url', 'payload_json', 'first_seen_at', 'last_seen_at',
];
const SKIP_COLS = [
  'id', 'url_key', 'name_date_key', 'title', 'start_at', 'source', 'venue', 'city',
  'image_url', 'skipped_at', 'series_key', 'taste_json',
];

/**
 * @param {string} a
 * @param {string} b
 */
function newerIso(a, b) {
  const ta = Date.parse(a || '');
  const tb = Date.parse(b || '');
  if (!Number.isFinite(ta)) return b || a || '';
  if (!Number.isFinite(tb)) return a || b || '';
  return ta >= tb ? a : b;
}

/**
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string[]} cols
 * @param {Record<string, unknown>} row
 */
function upsertRow(db, table, cols, row) {
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updates}`;
  db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
}

/**
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string[]} preferred
 */
function tableCols(db, table, preferred) {
  const present = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)),
  );
  return preferred.filter((c) => present.has(c));
}

/**
 * @param {DatabaseSync} base
 * @param {DatabaseSync} other
 * @param {string} table
 * @param {string[]} preferredCols
 * @param {string} tsCol
 */
function mergeTable(base, other, table, preferredCols, tsCol) {
  const cols = tableCols(base, table, preferredCols);
  const otherCols = tableCols(other, table, preferredCols);
  const shared = cols.filter((c) => otherCols.includes(c));
  if (!shared.includes('id') || !shared.includes(tsCol)) {
    throw new Error(`Cannot merge ${table}: missing id or ${tsCol}`);
  }
  const rows = other.prepare(`SELECT ${shared.join(', ')} FROM ${table}`).all();
  let inserted = 0;
  let updated = 0;
  let keptBase = 0;
  for (const row of rows) {
    const existing = base.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE id = ?`).get(row.id);
    if (!existing) {
      const full = { ...Object.fromEntries(cols.map((c) => [c, null])), ...row };
      upsertRow(base, table, cols, full);
      inserted++;
      continue;
    }
    const otherTs = String(row[tsCol] || '');
    const baseTs = String(existing[tsCol] || '');
    if (Date.parse(otherTs) > Date.parse(baseTs)) {
      upsertRow(base, table, cols, {
        ...existing,
        ...row,
        first_seen_at: table === 'events' && shared.includes('first_seen_at')
          ? newerIso(String(existing.first_seen_at || ''), String(row.first_seen_at || ''))
          : existing.first_seen_at,
      });
      updated++;
    } else {
      keptBase++;
    }
  }
  return { inserted, updated, keptBase, scanned: rows.length };
}

function main() {
  const basePath = path.resolve(process.argv[2] || '');
  const otherPath = path.resolve(process.argv[3] || '');
  const outPath = path.resolve(process.argv[4] || basePath);
  if (!basePath || !otherPath) {
    console.error('Usage: node scripts/merge-events-finder-db.mjs <base.db> <other.db> [out.db]');
    process.exit(1);
  }

  const workBase = outPath === basePath ? basePath : `${basePath}.merge-work`;
  if (outPath !== basePath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(basePath, workBase);
  }

  const base = new DatabaseSync(workBase);
  const other = new DatabaseSync(otherPath, { readOnly: true });

  const beforeEvents = base.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  const beforeSkipped = base.prepare('SELECT COUNT(*) AS c FROM skipped_events').get().c;

  const eventMerge = mergeTable(base, other, 'events', EVENT_COLS, 'last_seen_at');
  const skipMerge = mergeTable(base, other, 'skipped_events', SKIP_COLS, 'skipped_at');

  const afterEvents = base.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  const afterSkipped = base.prepare('SELECT COUNT(*) AS c FROM skipped_events').get().c;

  base.close();
  other.close();

  if (outPath !== basePath) {
    fs.copyFileSync(workBase, outPath);
    fs.unlinkSync(workBase);
  }

  console.log(JSON.stringify({
    base: basePath,
    other: otherPath,
    out: outPath,
    before: { events: beforeEvents, skipped: beforeSkipped },
    after: { events: afterEvents, skipped: afterSkipped },
    events: eventMerge,
    skipped: skipMerge,
  }, null, 2));
}

main();
