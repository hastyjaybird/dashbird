/**
 * Network notes — SQLite (data/network.db).
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openNetworkDb, remapLegacyNetworkId } from './network-db.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @deprecated JSON path unused
 */
export function networkNotesPath(env = process.env) {
  const override = String(env.NETWORK_NOTES_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/network-notes.json');
}

/**
 * @returns {Promise<{ version: number, notes: object[] }>}
 */
export async function loadNetworkNotes(env = process.env) {
  const db = openNetworkDb(env);
  const rows = db
    .prepare('SELECT id, contact_id, text, source, created_at FROM notes ORDER BY created_at DESC LIMIT 500')
    .all();
  return {
    version: 1,
    notes: rows.map((r) => ({
      id: r.id,
      text: r.text,
      contactId: r.contact_id || null,
      source: r.source || 'manual',
      createdAt: r.created_at,
    })),
  };
}

/**
 * @deprecated no-op
 */
export async function saveNetworkNotes(_data, _env = process.env) {
  /* no-op */
}

/**
 * @param {{ text: string, contactId?: string | null, source?: string }} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addNetworkNote(payload, env = process.env) {
  const text = String(payload?.text || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
  if (!text) {
    const err = new Error('text_required');
    err.code = 'text_required';
    throw err;
  }
  const note = {
    id: randomUUID(),
    text,
    contactId: payload?.contactId ? remapLegacyNetworkId(String(payload.contactId)) : null,
    source: String(payload?.source || 'manual').slice(0, 40),
    createdAt: new Date().toISOString(),
  };
  const db = openNetworkDb(env);
  db.prepare(
    `INSERT INTO notes (id, contact_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(note.id, note.contactId, note.text, note.source, note.createdAt);

  // Keep last 500 notes.
  db.prepare(
    `DELETE FROM notes WHERE id NOT IN (
       SELECT id FROM notes ORDER BY created_at DESC LIMIT 500
     )`,
  ).run();

  return note;
}
