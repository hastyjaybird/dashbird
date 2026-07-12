/**
 * Durable Telegram Bot API intake queue.
 * Raw getUpdates payloads (and downloaded media) are persisted under data/
 * before the Telegram offset advances, so messages survive the ~24h Bot API
 * retention window and process crashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** @type {DatabaseSync | null} */
let dbSingleton = null;
/** @type {string | null} */
let dbPathSingleton = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telegramIntakeDbPath(env = process.env) {
  const override = String(env.TELEGRAM_INTAKE_DB_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'telegram-intake.db');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telegramIntakeMediaDir(env = process.env) {
  const override = String(env.TELEGRAM_INTAKE_MEDIA_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'telegram-intake-media');
}

/**
 * @param {DatabaseSync} db
 */
function migrate(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS telegram_intake (
      update_id INTEGER PRIMARY KEY NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      media_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      processed_at TEXT,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_intake_status ON telegram_intake(status);
    CREATE INDEX IF NOT EXISTS idx_telegram_intake_next ON telegram_intake(next_attempt_at);

    CREATE TABLE IF NOT EXISTS telegram_album_buffers (
      album_key TEXT PRIMARY KEY NOT NULL,
      chat_id TEXT NOT NULL,
      media_group_id TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      media_by_message_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      flush_after TEXT NOT NULL
    );
  `);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DatabaseSync}
 */
export function openTelegramIntakeDb(env = process.env) {
  const dbPath = telegramIntakeDbPath(env);
  if (dbSingleton && dbPathSingleton === dbPath) return dbSingleton;

  if (dbSingleton) {
    try {
      dbSingleton.close();
    } catch {
      /* ignore */
    }
    dbSingleton = null;
    dbPathSingleton = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  migrate(db);
  dbSingleton = db;
  dbPathSingleton = dbPath;
  return db;
}

/**
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function clean(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

/**
 * Collect Telegram file_ids worth downloading before offset ack.
 * @param {any} message
 * @returns {Array<{ kind: string, fileId: string, preferredExt?: string }>}
 */
export function extractTelegramMediaRefs(message) {
  /** @type {Array<{ kind: string, fileId: string, preferredExt?: string }>} */
  const refs = [];
  if (!message || typeof message !== 'object') return refs;

  const photos = Array.isArray(message.photo) ? message.photo : [];
  if (photos.length) {
    const best = photos.reduce((a, b) => ((b?.file_size || 0) >= (a?.file_size || 0) ? b : a), photos[0]);
    if (best?.file_id) refs.push({ kind: 'photo', fileId: String(best.file_id), preferredExt: '.jpg' });
  }

  const doc = message.document;
  if (doc?.file_id && doc?.mime_type && String(doc.mime_type).startsWith('image/')) {
    refs.push({ kind: 'document_image', fileId: String(doc.file_id), preferredExt: '.jpg' });
  }

  if (message.voice?.file_id) {
    refs.push({ kind: 'voice', fileId: String(message.voice.file_id), preferredExt: '.ogg' });
  } else if (message.audio?.file_id) {
    refs.push({ kind: 'audio', fileId: String(message.audio.file_id), preferredExt: '.mp3' });
  }

  return refs;
}

/**
 * @param {Buffer} buf
 * @param {string} basename
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function saveIntakeMediaFile(buf, basename, env = process.env) {
  const dir = telegramIntakeMediaDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(basename || 'media').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  const fp = path.join(dir, safe);
  fs.writeFileSync(fp, buf);
  return fp;
}

/**
 * Persist a raw Telegram update. Idempotent on update_id.
 * @param {any} update
 * @param {Array<{ kind: string, fileId: string, localPath: string, mimeType: string, publicPath?: string | null }> | null} [media]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function enqueueTelegramUpdate(update, media = null, env = process.env) {
  const updateId = Number(update?.update_id);
  if (!Number.isFinite(updateId)) {
    throw new Error('telegram_intake_missing_update_id');
  }
  const db = openTelegramIntakeDb(env);
  const receivedAt = nowIso();
  const payloadJson = JSON.stringify(update);
  const mediaJson = media && media.length ? JSON.stringify(media) : null;

  db.prepare(
    `INSERT INTO telegram_intake (
      update_id, received_at, payload_json, media_json, status, attempts
    ) VALUES (?, ?, ?, ?, 'queued', 0)
    ON CONFLICT(update_id) DO NOTHING`,
  ).run(updateId, receivedAt, payloadJson, mediaJson);

  // If a prior row exists without media and we now have media, backfill.
  if (mediaJson) {
    db.prepare(
      `UPDATE telegram_intake
       SET media_json = COALESCE(media_json, ?)
       WHERE update_id = ? AND media_json IS NULL`,
    ).run(mediaJson, updateId);
  }

  return { updateId, receivedAt };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{
 *   updateId: number,
 *   payload: any,
 *   media: Array<{ kind: string, fileId: string, localPath: string, mimeType: string, publicPath?: string | null }> | null,
 *   attempts: number,
 *   status: string,
 * }>}
 */
export function listTelegramIntakeReady(env = process.env, opts = {}) {
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 25));
  const db = openTelegramIntakeDb(env);
  const now = nowIso();
  // Reclaim rows left in 'processing' after a crash (no in-flight lock across restarts).
  db.prepare(
    `UPDATE telegram_intake
     SET status = 'queued', next_attempt_at = NULL
     WHERE status = 'processing'`,
  ).run();
  const rows = db
    .prepare(
      `SELECT update_id, payload_json, media_json, attempts, status
       FROM telegram_intake
       WHERE status IN ('queued', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY update_id ASC
       LIMIT ?`,
    )
    .all(now, limit);

  return (Array.isArray(rows) ? rows : []).map((row) => {
    let payload = null;
    let media = null;
    try {
      payload = JSON.parse(String(row.payload_json || '{}'));
    } catch {
      payload = null;
    }
    try {
      media = row.media_json ? JSON.parse(String(row.media_json)) : null;
    } catch {
      media = null;
    }
    return {
      updateId: Number(row.update_id),
      payload,
      media: Array.isArray(media) ? media : null,
      attempts: Number(row.attempts) || 0,
      status: String(row.status || 'queued'),
    };
  });
}

/**
 * @param {number} updateId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function markTelegramIntakeProcessing(updateId, env = process.env) {
  const db = openTelegramIntakeDb(env);
  db.prepare(
    `UPDATE telegram_intake
     SET status = 'processing', attempts = attempts + 1
     WHERE update_id = ?`,
  ).run(Number(updateId));
}

/**
 * @param {number} updateId
 * @param {unknown} result
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ status?: string }} [opts]
 */
export function markTelegramIntakeDone(updateId, result, env = process.env, opts = {}) {
  const db = openTelegramIntakeDb(env);
  const status = clean(opts.status) || 'done';
  db.prepare(
    `UPDATE telegram_intake
     SET status = ?, processed_at = ?, last_error = NULL, next_attempt_at = NULL, result_json = ?
     WHERE update_id = ?`,
  ).run(status, nowIso(), JSON.stringify(result ?? null), Number(updateId));
}

/**
 * @param {number} updateId
 * @param {unknown} error
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ attempts?: number }} [opts]
 */
export function markTelegramIntakeFailed(updateId, error, env = process.env, opts = {}) {
  const db = openTelegramIntakeDb(env);
  const attempts = Math.max(1, Number(opts.attempts) || 1);
  // Soft backoff: 30s, 2m, 10m, then 30m capped.
  const delayMs = Math.min(
    30 * 60 * 1000,
    Math.round(30_000 * Math.pow(4, Math.min(attempts - 1, 4))),
  );
  const next = new Date(Date.now() + delayMs).toISOString();
  db.prepare(
    `UPDATE telegram_intake
     SET status = 'failed', last_error = ?, next_attempt_at = ?, result_json = NULL
     WHERE update_id = ?`,
  ).run(String(error || 'failed').slice(0, 500), next, Number(updateId));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telegramIntakeQueueStats(env = process.env) {
  const db = openTelegramIntakeDb(env);
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM telegram_intake GROUP BY status`,
    )
    .all();
  /** @type {Record<string, number>} */
  const byStatus = {};
  let total = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = String(row.status || 'unknown');
    const n = Number(row.n) || 0;
    byStatus[status] = n;
    total += n;
  }
  const albums = db.prepare(`SELECT COUNT(*) AS n FROM telegram_album_buffers`).get();
  return {
    total,
    byStatus,
    pendingAlbums: Number(/** @type {{ n?: unknown }} */ (albums)?.n) || 0,
  };
}

/**
 * Append a message into a durable album buffer and set flush_after.
 * @param {string} albumKey
 * @param {{ chatId: string | number, mediaGroupId: string, message: any, media?: object[] | null, debounceMs?: number }} args
 * @param {NodeJS.ProcessEnv} [env]
 */
export function upsertTelegramAlbumBuffer(albumKey, args, env = process.env) {
  const db = openTelegramIntakeDb(env);
  const key = String(albumKey);
  const chatId = String(args.chatId);
  const mediaGroupId = String(args.mediaGroupId);
  const debounceMs = Number.isFinite(args.debounceMs) ? Number(args.debounceMs) : 1500;
  const flushAfter = new Date(Date.now() + debounceMs).toISOString();
  const updatedAt = nowIso();
  const message = args.message;
  const mid = message?.message_id;

  const existing = db
    .prepare(
      `SELECT messages_json, media_by_message_json FROM telegram_album_buffers WHERE album_key = ?`,
    )
    .get(key);

  /** @type {any[]} */
  let messages = [];
  /** @type {Record<string, unknown>} */
  let mediaByMessage = {};
  if (existing) {
    try {
      messages = JSON.parse(String(existing.messages_json || '[]'));
    } catch {
      messages = [];
    }
    try {
      mediaByMessage = JSON.parse(String(existing.media_by_message_json || '{}')) || {};
    } catch {
      mediaByMessage = {};
    }
  }
  if (!Array.isArray(messages)) messages = [];
  if (!messages.some((m) => m?.message_id === mid)) {
    messages.push(message);
  }
  if (mid != null && Array.isArray(args.media) && args.media.length) {
    mediaByMessage[String(mid)] = args.media;
  }

  db.prepare(
    `INSERT INTO telegram_album_buffers (
      album_key, chat_id, media_group_id, messages_json, media_by_message_json, updated_at, flush_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(album_key) DO UPDATE SET
      messages_json = excluded.messages_json,
      media_by_message_json = excluded.media_by_message_json,
      updated_at = excluded.updated_at,
      flush_after = excluded.flush_after`,
  ).run(
    key,
    chatId,
    mediaGroupId,
    JSON.stringify(messages),
    JSON.stringify(mediaByMessage),
    updatedAt,
    flushAfter,
  );

  return {
    albumKey: key,
    chatId,
    mediaGroupId,
    messages,
    mediaByMessage,
    flushAfter,
    buffered: messages.length,
  };
}

/**
 * @param {string} albumKey
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadTelegramAlbumBuffer(albumKey, env = process.env) {
  const db = openTelegramIntakeDb(env);
  const row = db
    .prepare(
      `SELECT album_key, chat_id, media_group_id, messages_json, media_by_message_json, flush_after, updated_at
       FROM telegram_album_buffers WHERE album_key = ?`,
    )
    .get(String(albumKey));
  if (!row) return null;
  return parseAlbumRow(row);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function listTelegramAlbumBuffers(env = process.env) {
  const db = openTelegramIntakeDb(env);
  const rows = db
    .prepare(
      `SELECT album_key, chat_id, media_group_id, messages_json, media_by_message_json, flush_after, updated_at
       FROM telegram_album_buffers
       ORDER BY flush_after ASC`,
    )
    .all();
  return (Array.isArray(rows) ? rows : []).map(parseAlbumRow).filter(Boolean);
}

/**
 * @param {any} row
 */
function parseAlbumRow(row) {
  if (!row) return null;
  let messages = [];
  let mediaByMessage = {};
  try {
    messages = JSON.parse(String(row.messages_json || '[]'));
  } catch {
    messages = [];
  }
  try {
    mediaByMessage = JSON.parse(String(row.media_by_message_json || '{}')) || {};
  } catch {
    mediaByMessage = {};
  }
  return {
    albumKey: String(row.album_key),
    chatId: row.chat_id,
    mediaGroupId: String(row.media_group_id),
    messages: Array.isArray(messages) ? messages : [],
    mediaByMessage: mediaByMessage && typeof mediaByMessage === 'object' ? mediaByMessage : {},
    flushAfter: String(row.flush_after || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

/**
 * @param {string} albumKey
 * @param {NodeJS.ProcessEnv} [env]
 */
export function deleteTelegramAlbumBuffer(albumKey, env = process.env) {
  const db = openTelegramIntakeDb(env);
  db.prepare(`DELETE FROM telegram_album_buffers WHERE album_key = ?`).run(String(albumKey));
}

/**
 * Attach durable local media onto a Telegram message for downstream ingest.
 * @param {any} message
 * @param {Array<{ kind: string, fileId: string, localPath: string, mimeType: string, publicPath?: string | null }> | null | undefined} media
 */
export function attachIntakeMediaToMessage(message, media) {
  if (!message || !Array.isArray(media) || !media.length) return message;
  /** @type {Record<string, { localPath: string, mimeType: string, publicPath?: string | null, fileId: string }>} */
  const byKind = {};
  for (const m of media) {
    if (!m?.kind || !m?.localPath) continue;
    byKind[m.kind] = {
      localPath: String(m.localPath),
      mimeType: String(m.mimeType || 'application/octet-stream'),
      publicPath: m.publicPath || null,
      fileId: String(m.fileId || ''),
    };
  }
  Object.defineProperty(message, '_dashbirdIntakeMedia', {
    value: byKind,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return message;
}

/**
 * @param {any} message
 * @param {string} kind
 * @returns {{ localPath: string, mimeType: string, publicPath?: string | null, fileId: string } | null}
 */
export function getAttachedIntakeMedia(message, kind) {
  const map = message?._dashbirdIntakeMedia;
  if (!map || typeof map !== 'object') return null;
  const hit = map[kind];
  if (!hit?.localPath) return null;
  try {
    if (!fs.existsSync(hit.localPath)) return null;
  } catch {
    return null;
  }
  return hit;
}
