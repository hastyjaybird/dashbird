/**
 * Google Keep-style scratch notes — one folder per note with note.txt + meta.json.
 * Optional image or voice attachment per note.
 */
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEEP_NOTES_ROOT = path.join(PKG_ROOT, 'data', 'keep-notes');

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VOICE_MIMES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']);

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function keepNotesRoot(env = process.env) {
  const override = String(env.KEEP_NOTES_ROOT || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return KEEP_NOTES_ROOT;
}

/**
 * @param {string} id
 */
function noteDir(id, env = process.env) {
  const safe = String(id || '').replace(/[^a-z0-9-]/gi, '');
  if (!safe) throw Object.assign(new Error('invalid_id'), { code: 'invalid_id' });
  return path.join(keepNotesRoot(env), safe);
}

/**
 * @param {string} filename
 */
function safeFilename(filename) {
  const base = path.basename(String(filename || ''));
  if (!base || base.includes('..') || base.startsWith('.')) return null;
  return base;
}

/**
 * @param {string} dir
 */
async function readNoteFromDir(dir) {
  const id = path.basename(dir);
  const metaPath = path.join(dir, 'meta.json');
  const notePath = path.join(dir, 'note.txt');
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
  let body = '';
  try {
    body = await readFile(notePath, 'utf8');
  } catch {
    body = '';
  }
  /** @type {{ type: 'image' | 'voice', filename: string, mimeType: string } | null} */
  let attachment = null;
  const att = meta?.attachment;
  if (att && typeof att === 'object' && att.filename && att.type) {
    const fn = safeFilename(att.filename);
    if (fn) {
      attachment = {
        type: att.type === 'voice' ? 'voice' : 'image',
        filename: fn,
        mimeType: String(att.mimeType || ''),
      };
    }
  }
  return {
    id,
    title: String(meta.title || ''),
    body,
    pinned: Boolean(meta.pinned),
    createdAt: String(meta.createdAt || ''),
    updatedAt: String(meta.updatedAt || ''),
    attachment,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function listKeepNotes(env = process.env) {
  const root = keepNotesRoot(env);
  await mkdir(root, { recursive: true });
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const notes = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const note = await readNoteFromDir(path.join(root, ent.name));
    if (note) notes.push(note);
  }
  notes.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return notes;
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getKeepNote(id, env = process.env) {
  const dir = noteDir(id, env);
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  return readNoteFromDir(dir);
}

/**
 * @param {{ title?: string, body?: string, pinned?: boolean }} input
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function createKeepNote(input = {}, env = process.env) {
  const id = randomBytes(4).toString('hex');
  const now = new Date().toISOString();
  const dir = noteDir(id, env);
  await mkdir(dir, { recursive: true });
  const meta = {
    id,
    title: String(input.title || '').trim(),
    pinned: Boolean(input.pinned),
    createdAt: now,
    updatedAt: now,
    attachment: null,
  };
  const body = String(input.body || '');
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  await writeFile(path.join(dir, 'note.txt'), body, 'utf8');
  return { ...meta, body, attachment: null };
}

/**
 * @param {string} id
 * @param {{ title?: string, body?: string, pinned?: boolean }} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function updateKeepNote(id, patch = {}, env = process.env) {
  const existing = await getKeepNote(id, env);
  if (!existing) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const dir = noteDir(id, env);
  const metaPath = path.join(dir, 'meta.json');
  const notePath = path.join(dir, 'note.txt');
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const now = new Date().toISOString();
  if (patch.title !== undefined) meta.title = String(patch.title || '').trim();
  if (patch.pinned !== undefined) meta.pinned = Boolean(patch.pinned);
  meta.updatedAt = now;
  let body = existing.body;
  if (patch.body !== undefined) {
    body = String(patch.body || '');
    await writeFile(notePath, body, 'utf8');
  }
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return readNoteFromDir(dir);
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function deleteKeepNote(id, env = process.env) {
  const dir = noteDir(id, env);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    if (e?.code === 'ENOENT') {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    throw e;
  }
}

/**
 * @param {{ dataUrl?: string, base64?: string, mimeType?: string, filename?: string, kind?: string }} payload
 */
function decodeAttachmentPayload(payload) {
  const kind = String(payload?.kind || '').trim().toLowerCase();
  let mime = String(payload?.mimeType || '').trim().toLowerCase();
  let b64 = String(payload?.base64 || '').trim();
  const dataUrl = String(payload?.dataUrl || '').trim();
  if (dataUrl.startsWith('data:')) {
    const m = dataUrl.match(/^data:([a-z0-9/+.-]+);base64,(.+)$/i);
    if (!m) {
      const err = new Error('invalid_attachment');
      err.code = 'invalid_attachment';
      throw err;
    }
    mime = m[1].toLowerCase();
    b64 = m[2];
  }
  if (!b64) {
    const err = new Error('invalid_attachment');
    err.code = 'invalid_attachment';
    throw err;
  }
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    const err = new Error('invalid_attachment');
    err.code = 'invalid_attachment';
    throw err;
  }
  const isImage = IMAGE_MIMES.has(mime) || kind === 'image';
  const isVoice = VOICE_MIMES.has(mime) || kind === 'voice';
  if (!isImage && !isVoice) {
    const err = new Error('invalid_attachment_type');
    err.code = 'invalid_attachment_type';
    throw err;
  }
  const maxSize = isVoice ? 12_000_000 : 8_000_000;
  if (buf.length < 16 || buf.length > maxSize) {
    const err = new Error('invalid_attachment_size');
    err.code = 'invalid_attachment_size';
    throw err;
  }
  let ext = isVoice ? '.webm' : '.jpg';
  if (mime.includes('png')) ext = '.png';
  else if (mime.includes('webp')) ext = '.webp';
  else if (mime.includes('gif')) ext = '.gif';
  else if (mime.includes('ogg')) ext = '.ogg';
  else if (mime.includes('mpeg') || mime.includes('mp3')) ext = '.mp3';
  else if (mime.includes('wav')) ext = '.wav';
  else if (mime.includes('mp4')) ext = '.m4a';
  const type = isVoice ? 'voice' : 'image';
  const filename = type === 'voice' ? `voice${ext}` : `photo${ext}`;
  return { buf, mime, filename, type };
}

/**
 * @param {string} id
 * @param {{ dataUrl?: string, base64?: string, mimeType?: string, filename?: string, kind?: string }} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function setKeepNoteAttachment(id, payload, env = process.env) {
  const dir = noteDir(id, env);
  const existing = await getKeepNote(id, env);
  if (!existing) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const { buf, mime, filename, type } = decodeAttachmentPayload(payload);
  const outPath = path.join(dir, filename);
  await writeFile(outPath, buf);
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (existing.attachment?.filename && existing.attachment.filename !== filename) {
    try {
      await rm(path.join(dir, existing.attachment.filename), { force: true });
    } catch {
      /* ignore */
    }
  }
  meta.attachment = { type, filename, mimeType: mime };
  meta.updatedAt = new Date().toISOString();
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return readNoteFromDir(dir);
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function clearKeepNoteAttachment(id, env = process.env) {
  const existing = await getKeepNote(id, env);
  if (!existing) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const dir = noteDir(id, env);
  if (existing.attachment?.filename) {
    try {
      await rm(path.join(dir, existing.attachment.filename), { force: true });
    } catch {
      /* ignore */
    }
  }
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  meta.attachment = null;
  meta.updatedAt = new Date().toISOString();
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return readNoteFromDir(dir);
}

/**
 * @param {string} id
 * @param {string} filename
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function readKeepNoteAttachment(id, filename, env = process.env) {
  const existing = await getKeepNote(id, env);
  if (!existing?.attachment) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const safe = safeFilename(filename);
  if (!safe || safe !== existing.attachment.filename) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  const buf = await readFile(path.join(noteDir(id, env), safe));
  return { buf, mimeType: existing.attachment.mimeType || 'application/octet-stream' };
}
