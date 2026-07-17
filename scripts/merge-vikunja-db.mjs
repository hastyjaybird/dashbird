#!/usr/bin/env node
/**
 * Merge Vikunja SQLite DBs (LAN + cloud). Union tasks by uid; insert missing
 * projects from the other side by title.
 *
 * Usage:
 *   node scripts/merge-vikunja-db.mjs <base.db> <other.db> [out.db]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * @param {DatabaseSync} db
 */
function checkpoint(db) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/**
 * @param {Record<string, unknown>} row
 */
function taskKey(row) {
  const uid = String(row.uid || '').trim();
  if (uid) return `uid:${uid}`;
  return `t:${String(row.title || '').trim().toLowerCase()}|${String(row.created || '')}`;
}

/**
 * @param {DatabaseSync} db
 * @param {string} table
 */
function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
}

/**
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
function insertRow(db, table, row) {
  const cols = Object.keys(row);
  const quoted = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${quoted}) VALUES (${placeholders})`).run(
    ...cols.map((c) => row[c] ?? null),
  );
}

/**
 * @param {string[]} cols
 */
function quotedCols(cols) {
  return cols.map((c) => `"${c}"`).join(', ');
}

/**
 * @param {DatabaseSync} base
 * @param {DatabaseSync} other
 */
function mergeProjects(base, other) {
  const baseTitles = new Set(
    base.prepare('SELECT title FROM projects').all().map((r) => String(r.title || '').trim().toLowerCase()),
  );
  const cols = tableColumns(base, 'projects');
  const rows = other.prepare(`SELECT ${quotedCols(cols)} FROM projects`).all();
  let inserted = 0;
  for (const row of rows) {
    const titleKey = String(row.title || '').trim().toLowerCase();
    if (!titleKey || baseTitles.has(titleKey)) continue;
    const existingId = base.prepare('SELECT id FROM projects WHERE id = ?').get(row.id);
    const payload = { ...row };
    if (existingId) {
      const maxId = base.prepare('SELECT MAX(id) AS m FROM projects').get().m;
      payload.id = Number(maxId || 0) + 1;
    }
    insertRow(base, 'projects', payload);
    baseTitles.add(titleKey);
    inserted++;
  }
  return inserted;
}

/**
 * @param {DatabaseSync} base
 * @param {DatabaseSync} other
 */
function mergeTasks(base, other) {
  const baseKeys = new Set(base.prepare('SELECT * FROM tasks').all().map(taskKey));
  const cols = tableColumns(base, 'tasks');
  const rows = other.prepare(`SELECT ${quotedCols(cols)} FROM tasks`).all();
  let inserted = 0;
  let nextId = Number(base.prepare('SELECT MAX(id) AS m FROM tasks').get().m || 0) + 1;
  for (const row of rows) {
    const key = taskKey(row);
    if (baseKeys.has(key)) continue;
    const payload = { ...row, id: nextId++ };
    insertRow(base, 'tasks', payload);
    baseKeys.add(key);
    inserted++;
  }
  const maxId = Number(base.prepare('SELECT MAX(id) AS m FROM tasks').get().m || 0);
  try {
    base.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(maxId, 'tasks');
  } catch {
    base.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run('tasks', maxId);
  }
  return inserted;
}

function main() {
  const basePath = path.resolve(process.argv[2] || '');
  const otherPath = path.resolve(process.argv[3] || '');
  const outPath = path.resolve(process.argv[4] || basePath);
  if (!basePath || !otherPath) {
    console.error('Usage: node scripts/merge-vikunja-db.mjs <base.db> <other.db> [out.db]');
    process.exit(1);
  }

  const workBase = outPath === basePath ? basePath : `${basePath}.merge-work`;
  if (outPath !== basePath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(basePath, workBase);
    for (const suffix of ['-wal', '-shm']) {
      const src = `${basePath}${suffix}`;
      if (fs.existsSync(src)) fs.copyFileSync(src, `${workBase}${suffix}`);
    }
  }

  const base = new DatabaseSync(workBase);
  const other = new DatabaseSync(otherPath);
  checkpoint(base);
  checkpoint(other);
  // Re-open other after checkpoint in case WAL was truncated.
  other.close();
  const otherDb = new DatabaseSync(otherPath);

  const beforeTasks = base.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  const beforeProjects = base.prepare('SELECT COUNT(*) AS c FROM projects').get().c;

  const projectsInserted = mergeProjects(base, otherDb);
  const tasksInserted = mergeTasks(base, otherDb);

  checkpoint(base);
  const afterTasks = base.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  const afterProjects = base.prepare('SELECT COUNT(*) AS c FROM projects').get().c;

  base.close();
  otherDb.close();

  if (outPath !== basePath) {
    fs.copyFileSync(workBase, outPath);
    fs.unlinkSync(workBase);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(`${workBase}${suffix}`); } catch { /* noop */ }
      try { fs.unlinkSync(`${outPath}${suffix}`); } catch { /* noop */ }
    }
  }

  console.log(JSON.stringify({
    base: basePath,
    other: otherPath,
    out: outPath,
    before: { tasks: beforeTasks, projects: beforeProjects },
    after: { tasks: afterTasks, projects: afterProjects },
    projectsInserted,
    tasksInserted,
  }, null, 2));
}

main();
