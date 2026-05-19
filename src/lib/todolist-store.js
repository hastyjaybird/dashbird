/**
 * Today's to-do list — CSV rows in data/todolist.txt (mounted in Docker).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEED_PATH = path.join(PKG_ROOT, 'src/data/todolist.txt');
const HEADER = 'id,created_at,text,status';

/** @typedef {{ id: string, createdAt: string, text: string, status: string }} TodoRow */

export function todolistPath(env = process.env) {
  const override = String(env.TODOLIST_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/todolist.txt');
}

/**
 * @param {string} value
 */
function escapeCsvField(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * @param {string} raw
 * @returns {TodoRow[]}
 */
function parseTodoCsv(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const start = lines[0].toLowerCase().startsWith('id,') ? 1 : 0;
  /** @type {TodoRow[]} */
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length < 3) continue;
    const id = String(parts[0] || '').trim();
    const createdAt = String(parts[1] || '').trim();
    const text = String(parts[2] || '').trim();
    const status = String(parts[3] || '').trim().toLowerCase();
    if (!id || !text) continue;
    rows.push({ id, createdAt, text, status });
  }
  return rows;
}

/**
 * @param {TodoRow[]} rows
 */
function serializeTodoCsv(rows) {
  const body = rows.map((r) =>
    [
      escapeCsvField(r.id),
      escapeCsvField(r.createdAt),
      escapeCsvField(r.text),
      escapeCsvField(r.status),
    ].join(','),
  );
  return `${HEADER}\n${body.length ? `${body.join('\n')}\n` : ''}`;
}

async function ensureTodoFile() {
  const live = todolistPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    try {
      await fs.copyFile(SEED_PATH, live);
    } catch {
      await fs.writeFile(live, `${HEADER}\n`, 'utf8');
    }
    return live;
  }
}

/**
 * @returns {Promise<TodoRow[]>}
 */
export async function loadAllTodoRows() {
  const live = await ensureTodoFile();
  const raw = await fs.readFile(live, 'utf8');
  return parseTodoCsv(raw);
}

/**
 * @param {TodoRow[]} rows
 */
async function writeAllTodoRows(rows) {
  const live = await ensureTodoFile();
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, serializeTodoCsv(rows), 'utf8');
  await fs.rename(tmp, live);
}

/**
 * Drop completed rows on container start (Docker restart).
 * @returns {Promise<{ removed: number }>}
 */
export async function purgeDoneTodoItemsOnStartup() {
  const rows = await loadAllTodoRows();
  const kept = rows.filter((r) => r.status !== 'done');
  const removed = rows.length - kept.length;
  if (removed > 0) await writeAllTodoRows(kept);
  return { removed };
}

/**
 * All items for the UI (active + done). Done rows are purged on container start.
 * @returns {Promise<Array<{ id: string, text: string, createdAt: string, done: boolean }>>}
 */
export async function loadSessionTodoItems() {
  const rows = await loadAllTodoRows();
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    createdAt: r.createdAt,
    done: r.status === 'done',
  }));
}

/**
 * @param {string} text
 */
export async function addTodoItem(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 280) return { ok: false, error: 'invalid_text' };

  const rows = await loadAllTodoRows();
  const item = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    text: t,
    status: '',
  };
  rows.push(item);
  await writeAllTodoRows(rows);
  return { ok: true, item: { id: item.id, text: item.text, createdAt: item.createdAt } };
}

/**
 * @param {string} id
 */
export async function markTodoItemDone(id) {
  const rows = await loadAllTodoRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return { ok: false, error: 'not_found' };
  row.status = 'done';
  if (!row.createdAt) row.createdAt = new Date().toISOString();
  await writeAllTodoRows(rows);
  return { ok: true };
}

/**
 * @param {string} id
 */
export async function clearTodoItemDone(id) {
  const rows = await loadAllTodoRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return { ok: false, error: 'not_found' };
  row.status = '';
  await writeAllTodoRows(rows);
  return { ok: true, item: { id: row.id, text: row.text, createdAt: row.createdAt } };
}
