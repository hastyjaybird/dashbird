/**
 * Events finder — Telegram bot intake (text, voice, flyer screenshots).
 * Long-polls getUpdates so LAN Docker does not need a public webhook URL.
 *
 * Durable intake: raw updates (+ media) are written to data/telegram-intake.db
 * before the Telegram offset advances, then drained/replayed so messages survive
 * the Bot API ~24h pending-update retention window and process crashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertEventsFinderEvents } from './events-finder-store.js';
import {
  TELEGRAM_EVENT_LOGO_PATH,
  INVITE_VISION_MAX_IMAGES,
  parseInviteImage,
  parseInviteImages,
  parseInviteText,
  transcribeInviteAudio,
} from './events-finder-invite-parse.js';
import { classifyTelegramMessage, parseTelegramTypeOverride } from './telegram-message-classify.js';
import { createPanelTodo } from './vikunja-client.js';
import { addNetworkNote } from './network-notes-store.js';
import { upsertFromTelegram } from './network-contacts-store.js';
import { enrichContact } from './network-enrich.js';
import {
  attachIntakeMediaToMessage,
  deleteTelegramAlbumBuffer,
  enqueueTelegramUpdate,
  extractTelegramMediaRefs,
  getAttachedIntakeMedia,
  listTelegramAlbumBuffers,
  listTelegramIntakeReady,
  loadTelegramAlbumBuffer,
  markTelegramIntakeDone,
  markTelegramIntakeFailed,
  markTelegramIntakeProcessing,
  saveIntakeMediaFile,
  scheduleTelegramAlbumFlush,
  telegramIntakeQueueStats,
  upsertTelegramAlbumBuffer,
} from './telegram-intake-queue.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TG_API = 'https://api.telegram.org';

/** @type {ReturnType<typeof setTimeout> | null} */
let pollTimer = null;
/** @type {AbortController | null} */
let pollAbort = null;
let pollInFlight = false;
/** @type {number | null} */
let updateOffset = null;

/**
 * In-memory album debounce timers (state itself lives in SQLite).
 * @type {Map<string, {
 *   mediaGroupId: string,
 *   chatId: string | number,
 *   timer: ReturnType<typeof setTimeout> | null,
 *   env: NodeJS.ProcessEnv,
 * }>}
 */
const pendingAlbums = new Map();

/** Wait after last album photo before parsing (ms). */
const ALBUM_DEBOUNCE_MS = 1500;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telegramEventsEnabled(env = process.env) {
  const flag = String(env.TELEGRAM_EVENTS_ENABLED || '').trim();
  if (flag === '0' || flag.toLowerCase() === 'false') return false;
  if (flag === '1' || flag.toLowerCase() === 'true') return true;
  // Auto-enable when a bot token is present.
  return Boolean(telegramBotToken(env));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telegramBotToken(env = process.env) {
  return String(env.TELEGRAM_BOT_TOKEN || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Set<string>}
 */
export function telegramAllowedChatIds(env = process.env) {
  const raw = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function offsetPath(env = process.env) {
  const override = String(env.TELEGRAM_EVENTS_OFFSET_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'telegram-events-offset.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function mediaDir(env = process.env) {
  const override = String(env.TELEGRAM_EVENTS_MEDIA_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'public', 'data', 'telegram-events');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function pollMs(env = process.env) {
  const n = Number(env.TELEGRAM_EVENTS_POLL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 2500;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadOffset(env = process.env) {
  if (updateOffset != null) return updateOffset;
  try {
    const j = JSON.parse(fs.readFileSync(offsetPath(env), 'utf8'));
    const n = Number(j?.offset);
    updateOffset = Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    updateOffset = null;
  }
  return updateOffset;
}

/**
 * @param {number} next
 * @param {NodeJS.ProcessEnv} [env]
 */
function saveOffset(next, env = process.env) {
  updateOffset = next;
  const fp = offsetPath(env);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ offset: next, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} [body]
 * @param {NodeJS.ProcessEnv} [env]
 */
async function tgApi(method, body, env = process.env) {
  const token = telegramBotToken(env);
  if (!token) {
    const err = new Error('TELEGRAM_BOT_TOKEN not set');
    err.code = 'telegram_not_configured';
    throw err;
  }
  const url = `${TG_API}/bot${token}/${method}`;
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json?.ok === false) {
    const err = new Error(json?.description || `Telegram API HTTP ${r.status}`);
    err.code = 'telegram_api_error';
    err.status = r.status;
    err.detail = json;
    throw err;
  }
  return json.result;
}

/**
 * @param {number|string} chatId
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function telegramSendMessage(chatId, text, env = process.env) {
  return tgApi(
    'sendMessage',
    {
      chat_id: chatId,
      text: String(text || '').slice(0, 3900),
      disable_web_page_preview: true,
    },
    env,
  );
}

/**
 * @param {string} ext
 */
function mimeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.ogg' || e === '.oga') return 'audio/ogg';
  if (e === '.mp3') return 'audio/mpeg';
  if (e === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

/**
 * @param {string} fileId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ buffer: Buffer, filePath: string, mimeType: string }>}
 */
async function downloadTelegramFile(fileId, env = process.env) {
  const meta = await tgApi('getFile', { file_id: fileId }, env);
  const filePath = String(meta?.file_path || '');
  if (!filePath) {
    throw new Error('telegram_file_path_missing');
  }
  const token = telegramBotToken(env);
  const r = await fetch(`${TG_API}/file/bot${token}/${filePath}`);
  if (!r.ok) {
    throw new Error(`telegram_file_http_${r.status}`);
  }
  const ab = await r.arrayBuffer();
  const ext = path.extname(filePath).toLowerCase();
  return { buffer: Buffer.from(ab), filePath, mimeType: mimeFromExt(ext) };
}

/**
 * Prefer durable intake media (downloaded before offset ack) over live Telegram fetch.
 * @param {any} message
 * @param {string} kind
 * @param {string | null | undefined} fileId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ buffer: Buffer, filePath: string, mimeType: string, publicPath?: string | null }>}
 */
async function resolveTelegramMedia(message, kind, fileId, env = process.env) {
  const attached = getAttachedIntakeMedia(message, kind);
  if (attached?.localPath) {
    const buffer = fs.readFileSync(attached.localPath);
    return {
      buffer,
      filePath: attached.localPath,
      mimeType: attached.mimeType || mimeFromExt(path.extname(attached.localPath)),
      publicPath: attached.publicPath || null,
    };
  }
  if (!fileId) throw new Error('telegram_file_id_missing');
  const file = await downloadTelegramFile(fileId, env);
  return { ...file, publicPath: null };
}

/**
 * Download media for a raw update and persist under data/telegram-intake-media
 * before acknowledging the Telegram offset.
 * @param {any} update
 * @param {NodeJS.ProcessEnv} [env]
 */
async function downloadUpdateMediaForIntake(update, env = process.env) {
  const message = update?.message || update?.edited_message;
  const refs = extractTelegramMediaRefs(message);
  if (!refs.length) return null;

  const updateId = Number(update?.update_id);
  /** @type {Array<{ kind: string, fileId: string, localPath: string, mimeType: string, publicPath?: string | null }>} */
  const out = [];
  for (const ref of refs) {
    try {
      const file = await downloadTelegramFile(ref.fileId, env);
      const ext = path.extname(file.filePath) || ref.preferredExt || '';
      const localPath = saveIntakeMediaFile(
        file.buffer,
        `u${updateId}_${ref.kind}${ext || '.bin'}`,
        env,
      );
      /** @type {string | null} */
      let publicPath = null;
      if (ref.kind === 'photo' || ref.kind === 'document_image') {
        publicPath = saveMediaPublic(
          file.buffer,
          `${message?.chat?.id || 'chat'}_${message?.message_id || updateId}${ext || '.jpg'}`,
          env,
        );
      }
      out.push({
        kind: ref.kind,
        fileId: ref.fileId,
        localPath,
        mimeType: file.mimeType,
        publicPath,
      });
    } catch (e) {
      console.warn(
        '[telegram-events] intake media download failed',
        ref.kind,
        e?.message || e,
      );
    }
  }
  return out.length ? out : null;
}

/**
 * @param {Buffer} buf
 * @param {string} basename
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} public path e.g. /data/telegram-events/foo.jpg
 */
function saveMediaPublic(buf, basename, env = process.env) {
  const dir = mediaDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(basename || 'media').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  const fp = path.join(dir, safe);
  fs.writeFileSync(fp, buf);
  return `/data/telegram-events/${safe}`;
}

/**
 * @param {any} message
 * @returns {string | null}
 */
function largestPhotoFileId(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (!photos.length) return null;
  const best = photos.reduce((a, b) => ((b?.file_size || 0) >= (a?.file_size || 0) ? b : a), photos[0]);
  return best?.file_id ? String(best.file_id) : null;
}

/**
 * @param {number|string} chatId
 * @param {NodeJS.ProcessEnv} [env]
 */
function chatAllowed(chatId, env = process.env) {
  const allowed = telegramAllowedChatIds(env);
  if (!allowed.size) return false;
  return allowed.has(String(chatId));
}

/**
 * Build a stable event id from a Telegram message or album.
 * @param {any} message
 * @param {{ mediaGroupId?: string | null }} [opts]
 */
function eventIdForMessage(message, opts = {}) {
  const chatId = message?.chat?.id;
  const albumId = clean(opts.mediaGroupId) || clean(message?.media_group_id);
  if (albumId) return `telegram:${chatId}:album:${albumId}`;
  const messageId = message?.message_id;
  return `telegram:${chatId}:${messageId}`;
}

/**
 * @param {Record<string, unknown>} partial
 * @param {any} message
 * @param {{
 *   parseVia: string,
 *   transcript?: string | null,
 *   imageUrl?: string | null,
 *   mediaGroupId?: string | null,
 *   messageIds?: Array<number | string>,
 *   imageUrls?: string[],
 * }} meta
 */
function finalizeEvent(partial, message, meta) {
  const id = eventIdForMessage(message, { mediaGroupId: meta.mediaGroupId });
  const imageUrl = meta.imageUrl || TELEGRAM_EVENT_LOGO_PATH;
  const from = message?.from || {};
  const invitedBy =
    clean(/** @type {{ invitedBy?: unknown }} */ (partial).invitedBy)
    || null;
  const messageIds = Array.isArray(meta.messageIds) && meta.messageIds.length
    ? meta.messageIds
    : [message?.message_id].filter((v) => v != null);

  return {
    ...partial,
    id,
    source: 'telegram',
    imageUrl,
    url: clean(/** @type {{ url?: unknown }} */ (partial).url) || 'https://t.me/',
    raw: {
      chatId: message?.chat?.id ?? null,
      messageId: message?.message_id ?? null,
      messageIds,
      mediaGroupId: meta.mediaGroupId || message?.media_group_id || null,
      imageUrls: Array.isArray(meta.imageUrls) ? meta.imageUrls : [imageUrl],
      fromId: from.id ?? null,
      fromUsername: from.username ?? null,
      parseVia: meta.parseVia,
      transcript: meta.transcript || null,
      invitedBy,
      telegramLogoFallback: imageUrl === TELEGRAM_EVENT_LOGO_PATH,
    },
  };
}

/**
 * @param {unknown} v
 */
function clean(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

/**
 * Format a short confirmation for the bot reply.
 * @param {Record<string, unknown>} event
 */
function formatIngestReply(event) {
  const title = clean(event.title) || 'Event';
  const start = clean(event.start);
  const when = start
    ? new Date(start).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'unknown time';
  const invited =
    clean(/** @type {{ invitedBy?: unknown }} */ (event).invitedBy)
    || clean(/** @type {{ raw?: { invitedBy?: unknown } }} */ (event).raw?.invitedBy);
  const bits = [`Ingested: ${title}`, `When: ${when}`];
  if (invited) bits.push(`Invited by: ${invited}`);
  if (clean(event.venue)) bits.push(`Where: ${clean(event.venue)}`);
  return bits.join('\n');
}

/**
 * @param {any} message
 * @returns {string | null}
 */
function imageFileIdFromMessage(message) {
  const photoId = largestPhotoFileId(message);
  if (photoId) return photoId;
  const doc = message?.document;
  if (doc?.mime_type && String(doc.mime_type).startsWith('image/') && doc.file_id) {
    return String(doc.file_id);
  }
  return null;
}

/**
 * @param {string} why
 * @param {{ transcript?: string | null }} [extra]
 */
function ingestFailHint(why, extra = {}) {
  const hints = {
    not_an_event: 'That did not look like an event invite.',
    missing_title: 'Could not find an event name.',
    missing_start: 'Could not find a date/time.',
    openrouter_not_configured: 'OPENROUTER_API_KEY is not set on the server.',
    empty_album: 'Album had no usable images.',
  };
  const transcript = extra.transcript ? `\nHeard: “${extra.transcript.slice(0, 200)}”` : '';
  return `Not ingested: ${hints[why] || why}${transcript}`;
}

/**
 * Multi-screenshot album → one catalog event.
 * @param {any[]} messages
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function processTelegramAlbum(messages, env = process.env) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter(Boolean)
    .sort((a, b) => Number(a?.message_id || 0) - Number(b?.message_id || 0));
  if (!list.length) return { ok: false, error: 'empty_album' };

  const primary = list[0];
  const chatId = primary?.chat?.id;
  const mediaGroupId = clean(primary?.media_group_id) || clean(list.find((m) => m?.media_group_id)?.media_group_id);
  if (!chatAllowed(chatId, env)) {
    return { ok: false, error: 'chat_not_allowed' };
  }

  const caption = list.map((m) => String(m?.caption || '').trim()).filter(Boolean).join('\n');

  /** @type {Array<{ mimeType: string, base64: string, caption?: string, publicPath: string, messageId: unknown }>} */
  const downloaded = [];
  try {
    for (const message of list) {
      if (downloaded.length >= INVITE_VISION_MAX_IMAGES) break;
      const fileId = imageFileIdFromMessage(message);
      const kind = largestPhotoFileId(message) ? 'photo' : 'document_image';
      if (!fileId && !getAttachedIntakeMedia(message, 'photo') && !getAttachedIntakeMedia(message, 'document_image')) {
        continue;
      }
      const file = await resolveTelegramMedia(message, kind, fileId, env);
      const publicPath =
        file.publicPath
        || saveMediaPublic(
          file.buffer,
          `${message.chat.id}_${message.message_id}${path.extname(file.filePath) || '.jpg'}`,
          env,
        );
      downloaded.push({
        mimeType: file.mimeType.startsWith('image/') ? file.mimeType : 'image/jpeg',
        base64: file.buffer.toString('base64'),
        caption: String(message?.caption || '').trim(),
        publicPath,
        messageId: message?.message_id,
      });
    }
  } catch (e) {
    await telegramSendMessage(chatId, `Ingest error: ${String(e?.message || e).slice(0, 200)}`, env);
    return { ok: false, error: String(e?.message || e) };
  }

  if (!downloaded.length) {
    await telegramSendMessage(chatId, ingestFailHint('empty_album'), env);
    return { ok: false, error: 'empty_album' };
  }

  const imageUrl = downloaded[0].publicPath;
  const imageUrls = downloaded.map((d) => d.publicPath);
  let parsed;
  try {
    parsed = await parseInviteImages(
      downloaded.map((d) => ({
        mimeType: d.mimeType,
        base64: d.base64,
        caption: d.caption || caption,
      })),
      env,
      { defaultImageUrl: imageUrl },
    );
  } catch (e) {
    await telegramSendMessage(chatId, `Ingest error: ${String(e?.message || e).slice(0, 200)}`, env);
    return { ok: false, error: String(e?.message || e) };
  }

  if (!parsed.ok || !parsed.event) {
    const why = parsed.error || 'parse_failed';
    await telegramSendMessage(chatId, ingestFailHint(why), env);
    return { ok: false, error: why };
  }

  const event = finalizeEvent(parsed.event, primary, {
    parseVia: downloaded.length > 1 ? 'photo_album' : 'photo',
    imageUrl,
    mediaGroupId,
    messageIds: list.map((m) => m?.message_id).filter((v) => v != null),
    imageUrls,
  });
  if (parsed.event.invitedBy) event.invitedBy = parsed.event.invitedBy;

  const upsert = upsertEventsFinderEvents([event], env);
  const reply = formatIngestReply(event);
  const albumNote = downloaded.length > 1 ? `\n(${downloaded.length} screenshots → one event)` : '';
  await telegramSendMessage(chatId, `${reply}${albumNote}`, env);

  return {
    ok: true,
    event,
    upserted: upsert?.upserted ?? 1,
    parseVia: downloaded.length > 1 ? 'photo_album' : 'photo',
    albumSize: downloaded.length,
  };
}

/**
 * Flush a durable album buffer (after debounce or on restart).
 * @param {string} key
 * @param {NodeJS.ProcessEnv} [env]
 */
async function flushTelegramAlbumBuffer(key, env = process.env) {
  const bucket = pendingAlbums.get(key);
  if (bucket?.timer) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }
  pendingAlbums.delete(key);

  const stored = loadTelegramAlbumBuffer(key, env);
  const messages = stored?.messages?.length ? stored.messages : [];
  if (!messages.length) {
    deleteTelegramAlbumBuffer(key, env);
    return { ok: false, error: 'empty_album' };
  }

  // Re-attach durable media saved at intake time.
  for (const message of messages) {
    const mid = message?.message_id;
    const media = mid != null ? stored?.mediaByMessage?.[String(mid)] : null;
    if (Array.isArray(media) && media.length) {
      attachIntakeMediaToMessage(message, media);
    }
  }

  try {
    const result = await processTelegramAlbum(messages, env);
    if (result?.ok) {
      deleteTelegramAlbumBuffer(key, env);
    } else {
      // Keep durable album for retry.
      console.warn('[telegram-events] album ingest incomplete', result?.error || result);
      const flushAfter = new Date(Date.now() + 60_000).toISOString();
      scheduleTelegramAlbumFlush(key, flushAfter, env);
      armAlbumFlushTimer(key, flushAfter, env);
    }
    return result;
  } catch (e) {
    console.warn('[telegram-events] album ingest failed', e?.message || e);
    const flushAfter = new Date(Date.now() + 60_000).toISOString();
    scheduleTelegramAlbumFlush(key, flushAfter, env);
    armAlbumFlushTimer(key, flushAfter, env);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Schedule (or reschedule) album flush from durable buffer flush_after.
 * @param {string} key
 * @param {string} [flushAfterIso]
 * @param {NodeJS.ProcessEnv} [env]
 */
function armAlbumFlushTimer(key, flushAfterIso, env = process.env) {
  let bucket = pendingAlbums.get(key);
  if (!bucket) {
    const [chatId, mediaGroupId] = String(key).split(/:(.+)/);
    bucket = {
      mediaGroupId: mediaGroupId || key,
      chatId: chatId || key,
      timer: null,
      env,
    };
    pendingAlbums.set(key, bucket);
  }
  bucket.env = env;
  if (bucket.timer) clearTimeout(bucket.timer);

  const due = flushAfterIso ? Date.parse(flushAfterIso) : Date.now();
  const delay = Number.isFinite(due) ? Math.max(0, due - Date.now()) : ALBUM_DEBOUNCE_MS;
  bucket.timer = setTimeout(() => {
    flushTelegramAlbumBuffer(key, bucket.env).catch((e) => {
      console.warn('[telegram-events] album flush failed', e?.message || e);
    });
  }, delay);
  if (typeof bucket.timer.unref === 'function') bucket.timer.unref();
}

/**
 * Buffer album photos until Telegram finishes sending the media group.
 * Persists to SQLite so restarts mid-album do not lose photos.
 * @param {any} message
 * @param {NodeJS.ProcessEnv} [env]
 */
function queueTelegramAlbumMessage(message, env = process.env) {
  const mediaGroupId = clean(message?.media_group_id);
  const chatId = message?.chat?.id;
  if (!mediaGroupId || chatId == null) {
    return processTelegramEventMessage(message, env);
  }

  const key = `${chatId}:${mediaGroupId}`;
  const mediaMap = message?._dashbirdIntakeMedia;
  /** @type {Array<{ kind: string, fileId: string, localPath: string, mimeType: string, publicPath?: string | null }> | null} */
  let mediaList = null;
  if (mediaMap && typeof mediaMap === 'object') {
    mediaList = Object.entries(mediaMap).map(([kind, v]) => ({
      kind,
      fileId: String(/** @type {{ fileId?: string }} */ (v)?.fileId || ''),
      localPath: String(/** @type {{ localPath?: string }} */ (v)?.localPath || ''),
      mimeType: String(/** @type {{ mimeType?: string }} */ (v)?.mimeType || 'application/octet-stream'),
      publicPath: /** @type {{ publicPath?: string | null }} */ (v)?.publicPath || null,
    })).filter((m) => m.localPath);
  }

  // Strip non-enumerable helper before JSON persistence (re-attached on flush).
  const plain = JSON.parse(JSON.stringify(message));
  const stored = upsertTelegramAlbumBuffer(
    key,
    {
      chatId,
      mediaGroupId,
      message: plain,
      media: mediaList,
      debounceMs: ALBUM_DEBOUNCE_MS,
    },
    env,
  );
  armAlbumFlushTimer(key, stored.flushAfter, env);

  return Promise.resolve({
    ok: true,
    queued: true,
    reason: 'album_buffer',
    mediaGroupId,
    buffered: stored.buffered,
  });
}

/**
 * Re-arm album flush timers from SQLite (call on poller start).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function restoreTelegramAlbumBuffers(env = process.env) {
  const albums = listTelegramAlbumBuffers(env);
  for (const album of albums) {
    armAlbumFlushTimer(album.albumKey, album.flushAfter, env);
  }
  if (albums.length) {
    console.log(`[telegram-events] restored ${albums.length} album buffer(s)`);
  }
  return albums.length;
}

/**
 * Lightweight offline classify when OpenRouter is rate/credit limited.
 * @param {string} text
 * @returns {{ ok: true, type: string, confidence: number, reason: string, todoText: string | null, noteText: string | null, contact: object | null } | null}
 */
function heuristicTelegramClassify(text) {
  const body = String(text || '').trim();
  if (!body) return null;
  const lower = body.toLowerCase();
  if (
    /^(todo|to-do|task)[:\s-]/i.test(body)
    || /\bremind me\b/i.test(body)
    || /^(buy|call|email|text|schedule|book|pick up)\b/i.test(body)
  ) {
    return {
      ok: true,
      type: 'todo',
      confidence: 0.55,
      reason: 'heuristic_todo',
      todoText: body.replace(/^(todo|to-do|task)[:\s-]*/i, '').trim() || body,
      noteText: null,
      contact: null,
    };
  }
  if (/^(note|notes)[:\s-]/i.test(body)) {
    return {
      ok: true,
      type: 'note',
      confidence: 0.55,
      reason: 'heuristic_note',
      todoText: null,
      noteText: body.replace(/^(note|notes)[:\s-]*/i, '').trim() || body,
      contact: null,
    };
  }
  if (
    /^(contact|friend|met)\b/i.test(body)
    || /\b(add contact|new contact|phone|linkedin)\b/i.test(lower)
  ) {
    const name = body.split(/[,\n]/)[0]?.replace(/^(contact|friend|met)\b[:\s-]*/i, '').trim() || body;
    return {
      ok: true,
      type: 'contact',
      confidence: 0.5,
      reason: 'heuristic_contact',
      todoText: null,
      noteText: null,
      contact: { displayName: name, notes: body, aliases: [], kind: 'friend' },
    };
  }
  // Bare invite / ticket URLs are almost certainly events.
  if (
    /\b(luma\.com|lu\.ma|partiful\.com|eventbrite\.com|meetup\.com|facebook\.com\/events|fb\.me\/e|secretparty|posh\.vip)\b/i.test(
      body,
    )
  ) {
    return {
      ok: true,
      type: 'event',
      confidence: 0.85,
      reason: 'heuristic_event_url',
      todoText: null,
      noteText: null,
      contact: null,
    };
  }
  // Default remaining freeform to event (legacy Telegram flyer/text invite path).
  return {
    ok: true,
    type: 'event',
    confidence: 0.4,
    reason: 'heuristic_default_event',
    todoText: null,
    noteText: null,
    contact: null,
  };
}

/**
 * Process one Telegram message: classify → event | todo | note | contact.
 * Flyer photos/albums still prefer the event path.
 * @param {any} message
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ notifyUser?: boolean }} [opts]
 */
export async function processTelegramEventMessage(message, env = process.env, opts = {}) {
  const notifyUser = opts.notifyUser !== false;
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  const caption = String(message?.caption || '').trim();

  if (text === '/start' || text.startsWith('/start ')) {
    const allowed = chatAllowed(chatId, env);
    await telegramSendMessage(
      chatId,
      allowed
        ? 'Dashbird intake is ready. Send text, voice, or a flyer photo.\nI classify as event / todo / note / contact.\nOverrides: /event /todo /note /contact …\nAlbums of screenshots → one event.'
        : `Your Telegram chat id is ${chatId}.\nAdd it to TELEGRAM_ALLOWED_CHAT_IDS in Dashbird .env, then restart.`,
      env,
    );
    return { ok: true, skipped: true, reason: 'start' };
  }

  if (text === '/help') {
    await telegramSendMessage(
      chatId,
      'Send:\n• Flyer photo / album → event\n• Voice or text → auto-classified\n• /todo buy milk\n• /note idea for weekend\n• /contact Sam, met at party, 555-…\n• /event July 18 Rooftop Jazz invited by Maya',
      env,
    );
    return { ok: true, skipped: true, reason: 'help' };
  }

  if (!chatAllowed(chatId, env)) {
    await notifyIntake(
      chatId,
      `Chat ${chatId} is not allowlisted. Add TELEGRAM_ALLOWED_CHAT_IDS=${chatId} in Dashbird .env.`,
      env,
      { notifyUser },
    );
    return { ok: false, error: 'chat_not_allowed' };
  }

  // Albums arrive as separate messages sharing media_group_id — merge them as events.
  if (clean(message?.media_group_id) && imageFileIdFromMessage(message)) {
    return queueTelegramAlbumMessage(message, env);
  }

  const photoId = largestPhotoFileId(message);
  const voiceId = message?.voice?.file_id
    ? String(message.voice.file_id)
    : message?.audio?.file_id
      ? String(message.audio.file_id)
      : null;
  const docIsImage = (() => {
    const doc = message?.document;
    return doc?.mime_type && String(doc.mime_type).startsWith('image/') && doc.file_id
      ? String(doc.file_id)
      : null;
  })();

  // Flyer / image → event path (legacy), unless caption has an explicit non-event override.
  if (
    photoId
    || docIsImage
    || getAttachedIntakeMedia(message, 'photo')
    || getAttachedIntakeMedia(message, 'document_image')
  ) {
    const override = parseTelegramTypeOverride(caption || text);
    if (override && override.type !== 'event') {
      return routeNonEventType(override.type, override.rest || caption || text, chatId, env, {
        force: true,
      });
    }
    return ingestTelegramEventFromMessage(message, env, {
      photoId: photoId || docIsImage || '',
      caption,
      text,
      notifyUser,
    });
  }

  /** @type {string | null} */
  let classifyText = text || caption || null;
  /** @type {string | null} */
  let transcript = null;

  if (voiceId || getAttachedIntakeMedia(message, 'voice') || getAttachedIntakeMedia(message, 'audio')) {
    try {
      const voiceKind = message?.voice?.file_id || getAttachedIntakeMedia(message, 'voice') ? 'voice' : 'audio';
      const file = await resolveTelegramMedia(message, voiceKind, voiceId, env);
      const tr = await transcribeInviteAudio(
        file.buffer,
        { filename: path.basename(file.filePath) || 'voice.ogg', mimeType: file.mimeType },
        env,
      );
      if (!tr.ok) {
        await notifyIntake(
          chatId,
          `Could not transcribe voice (${tr.error || 'unknown'}). Try text or a screenshot.`,
          env,
          { notifyUser },
        );
        return { ok: false, error: tr.error || 'transcribe_failed' };
      }
      transcript = tr.text || null;
      classifyText = transcript;
    } catch (e) {
      await notifyIntake(chatId, `Ingest error: ${String(e?.message || e).slice(0, 200)}`, env, { notifyUser });
      return { ok: false, error: String(e?.message || e) };
    }
  }

  if (!classifyText) {
    await notifyIntake(
      chatId,
      'Send a flyer photo, voice note, or text. /help for examples.',
      env,
      { notifyUser },
    );
    return { ok: false, error: 'unsupported_message' };
  }

  let classified;
  try {
    classified = await classifyTelegramMessage(classifyText, env);
  } catch (e) {
    await notifyIntake(chatId, `Classifier error: ${String(e?.message || e).slice(0, 200)}`, env, { notifyUser });
    return { ok: false, error: String(e?.message || e) };
  }

  // When OpenRouter is credit/rate limited, keep intake usable with light heuristics.
  if (!classified.ok || !classified.type) {
    const heur = heuristicTelegramClassify(classifyText);
    if (heur) {
      classified = heur;
      console.warn('[telegram-events] classifier fallback heuristic', classified.error || classified.reason);
    }
  }

  if (!classified.ok || !classified.type) {
    await notifyIntake(
      chatId,
      `Could not classify (${classified.error || 'unknown'}). Try /event /todo /note /contact.`,
      env,
      { notifyUser },
    );
    return { ok: false, error: classified.error || 'classify_failed', transcript };
  }

  const confidence = Number(classified.confidence) || 0;
  if (confidence < 0.55 && classified.reason !== 'command_override') {
    await notifyIntake(
      chatId,
      `Not sure if this is an event, todo, note, or contact (confidence ${confidence.toFixed(2)}).\nReply with /event /todo /note or /contact plus the text.`,
      env,
      { notifyUser },
    );
    return { ok: false, error: 'low_confidence', confidence, type: classified.type, transcript };
  }

  if (classified.type === 'event') {
    return ingestTelegramEventFromText(classifyText, message, env, {
      transcript,
      parseVia: voiceId ? 'voice' : 'text',
      notifyUser,
    });
  }

  return routeNonEventType(classified.type, classifyText, chatId, env, { classified, transcript, notifyUser });
}

/**
 * @param {string} type
 * @param {string} text
 * @param {number|string} chatId
 * @param {NodeJS.ProcessEnv} env
 * @param {{ classified?: object, transcript?: string | null, force?: boolean }} [meta]
 */
async function routeNonEventType(type, text, chatId, env, meta = {}) {
  const classified = meta.classified || {};

  if (type === 'todo') {
    const todoText = String(classified.todoText || text || '').trim().slice(0, 280);
    try {
      const item = await createPanelTodo(todoText, env);
      await telegramSendMessage(chatId, `Todo added: ${item.text}`, env);
      return { ok: true, type: 'todo', todo: item };
    } catch (e) {
      await telegramSendMessage(
        chatId,
        `Todo failed: ${String(e?.code || e?.message || e).slice(0, 200)}`,
        env,
      );
      return { ok: false, error: String(e?.code || e?.message || e), type: 'todo' };
    }
  }

  if (type === 'note') {
    const noteText = String(classified.noteText || text || '').trim();
    try {
      const note = await addNetworkNote({ text: noteText, source: 'telegram' }, env);
      await telegramSendMessage(chatId, `Note saved (${note.id.slice(0, 8)}…):\n${note.text.slice(0, 300)}`, env);
      return { ok: true, type: 'note', note };
    } catch (e) {
      await telegramSendMessage(chatId, `Note failed: ${String(e?.message || e).slice(0, 200)}`, env);
      return { ok: false, error: String(e?.message || e), type: 'note' };
    }
  }

  if (type === 'contact') {
    const c = classified.contact && typeof classified.contact === 'object' ? classified.contact : {};
    const displayName =
      String(c.displayName || '').trim()
      || String(text).split(/[,\n]/)[0]?.trim()
      || '';
    if (!displayName) {
      await telegramSendMessage(chatId, 'Contact needs a name. Try: /contact Jane Doe, met at …', env);
      return { ok: false, error: 'contact_name_required', type: 'contact' };
    }
    try {
      const contact = await upsertFromTelegram(
        {
          displayName,
          aliases: Array.isArray(c.aliases) ? c.aliases : [],
          kinds: c.kind === 'business' ? ['business'] : ['friend'],
          notes: String(c.notes || text).trim(),
          org: c.org || '',
          title: c.title || '',
          tags: ['telegram'],
          channels: {
            email: c.email || null,
            phone: c.phone || null,
            telegram: c.telegram || null,
            linkedin: c.linkedin || null,
          },
        },
        env,
      );
      // Best-effort enrich; do not fail the ingest if enrichment fails.
      let enriched = contact;
      try {
        const er = await enrichContact(contact.id, {}, env);
        if (er.ok && er.contact) enriched = er.contact;
      } catch {
        // ignore
      }
      await telegramSendMessage(
        chatId,
        `Contact saved: ${enriched.displayName}${enriched.org ? ` (${enriched.org})` : ''}`,
        env,
      );
      return { ok: true, type: 'contact', contact: enriched };
    } catch (e) {
      await telegramSendMessage(chatId, `Contact failed: ${String(e?.message || e).slice(0, 200)}`, env);
      return { ok: false, error: String(e?.message || e), type: 'contact' };
    }
  }

  await telegramSendMessage(chatId, `Unknown type “${type}”. Use /event /todo /note /contact.`, env);
  return { ok: false, error: 'unknown_type', type };
}

/**
 * @param {string} text
 * @param {any} message
 * @param {NodeJS.ProcessEnv} env
 * @param {{ transcript?: string | null, parseVia?: string, notifyUser?: boolean }} meta
 */
async function ingestTelegramEventFromText(text, message, env, meta = {}) {
  const chatId = message?.chat?.id;
  const notifyUser = meta.notifyUser !== false;
  let parsed = await parseInviteText(text, env, { defaultImageUrl: TELEGRAM_EVENT_LOGO_PATH });
  // Bare platform URLs should still ingest when the LLM is rate/credit limited.
  if ((!parsed.ok || !parsed.event) && looksLikeEventPlatformUrl(text)) {
    const fromUrl = await parseInviteFromEventUrl(text, env);
    if (fromUrl.ok && fromUrl.event) parsed = fromUrl;
  }
  if (!parsed.ok || !parsed.event) {
    const why = parsed.error || 'parse_failed';
    await notifyIntake(chatId, ingestFailHint(why, { transcript: meta.transcript }), env, { notifyUser });
    return { ok: false, error: why, transcript: meta.transcript, type: 'event' };
  }
  const event = finalizeEvent(parsed.event, message, {
    parseVia: meta.parseVia || 'text',
    transcript: meta.transcript || null,
    imageUrl: TELEGRAM_EVENT_LOGO_PATH,
  });
  if (parsed.event.invitedBy) event.invitedBy = parsed.event.invitedBy;
  const upsert = upsertEventsFinderEvents([event], env);
  await telegramSendMessage(chatId, formatIngestReply(event), env);
  return {
    ok: true,
    type: 'event',
    event,
    upserted: upsert?.upserted ?? 1,
    parseVia: meta.parseVia || 'text',
    transcript: meta.transcript || null,
  };
}

/**
 * @param {string} text
 */
function looksLikeEventPlatformUrl(text) {
  return /\b(luma\.com|lu\.ma|partiful\.com|eventbrite\.com|meetup\.com|facebook\.com\/events|fb\.me\/e|secretparty|posh\.vip)\b/i.test(
    String(text || ''),
  );
}

/**
 * Best-effort event from a platform URL (og:title) without OpenRouter.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 */
async function parseInviteFromEventUrl(text, env = process.env) {
  const urlMatch = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!urlMatch) return { ok: false, error: 'no_url', event: null };
  let url = urlMatch[0].replace(/[),.]+$/g, '');
  try {
    url = new URL(url).href.split('#')[0];
  } catch {
    return { ok: false, error: 'bad_url', event: null };
  }

  let title = null;
  let description = null;
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 DashbirdTelegramIntake/1.0', Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const html = await r.text();
      title =
        (html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)
          || html.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i)
          || html.match(/<title[^>]*>([^<]+)/i)
          || [])[1] || null;
      description =
        (html.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i)
          || html.match(/content=["']([^"']+)["']\s+property=["']og:description["']/i)
          || [])[1] || null;
      if (title) {
        title = title
          .replace(/\s*[·|].*Luma\s*$/i, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
      if (description) {
        description = description
          .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400);
      }
    }
  } catch {
    /* fall through to slug title */
  }

  if (!title) {
    try {
      const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      title = slug
        .replace(/[-_]+/g, ' ')
        .replace(/\bjul(\d{1,2})\b/i, 'Jul $1')
        .replace(/\b(\d{4})\b/, '$1')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim() || 'Event';
    } catch {
      title = 'Event';
    }
  }

  // Pull a date hint from slug like ...-jul15-2026
  let start = null;
  const m = String(url).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-?(\d{1,2})-?(\d{4})\b/i);
  if (m) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const mon = months[m[1].slice(0, 3).toLowerCase()];
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (Number.isFinite(mon) && day >= 1 && day <= 31 && year >= 2020) {
      // Noon PT as a placeholder when time is unknown.
      start = new Date(Date.UTC(year, mon, day, 19, 0, 0)).toISOString();
    }
  }

  return {
    ok: true,
    error: null,
    event: {
      title,
      start,
      end: null,
      venue: null,
      city: null,
      url,
      source: 'telegram',
      online: false,
      description,
      imageUrl: TELEGRAM_EVENT_LOGO_PATH,
      invitedBy: null,
    },
  };
}

/**
 * @param {any} message
 * @param {NodeJS.ProcessEnv} env
 * @param {{ photoId: string, caption: string, text: string, notifyUser?: boolean }} media
 */
async function ingestTelegramEventFromMessage(message, env, media) {
  const chatId = message?.chat?.id;
  const notifyUser = media.notifyUser !== false;
  /** @type {{ ok: boolean, error?: string | null, event?: Record<string, unknown> | null }} */
  let parsed = { ok: false, error: 'unsupported_message', event: null };
  /** @type {string | null} */
  let imageUrl = TELEGRAM_EVENT_LOGO_PATH;
  const parseVia = 'photo';

  try {
    const kind = largestPhotoFileId(message) ? 'photo' : 'document_image';
    const file = await resolveTelegramMedia(message, kind, media.photoId, env);
    const publicPath =
      file.publicPath
      || saveMediaPublic(
        file.buffer,
        `${message.chat.id}_${message.message_id}${path.extname(file.filePath) || '.jpg'}`,
        env,
      );
    imageUrl = publicPath;
    parsed = await parseInviteImage(
      {
        mimeType: file.mimeType.startsWith('image/') ? file.mimeType : 'image/jpeg',
        base64: file.buffer.toString('base64'),
        caption: media.caption || media.text,
      },
      env,
      { defaultImageUrl: publicPath },
    );
  } catch (e) {
    await notifyIntake(chatId, `Ingest error: ${String(e?.message || e).slice(0, 200)}`, env, { notifyUser });
    return { ok: false, error: String(e?.message || e), type: 'event' };
  }

  if (!parsed.ok || !parsed.event) {
    const why = parsed.error || 'parse_failed';
    await notifyIntake(chatId, ingestFailHint(why), env, { notifyUser });
    return { ok: false, error: why, type: 'event' };
  }

  const event = finalizeEvent(parsed.event, message, { parseVia, imageUrl });
  if (parsed.event.invitedBy) event.invitedBy = parsed.event.invitedBy;
  const upsert = upsertEventsFinderEvents([event], env);
  await telegramSendMessage(chatId, formatIngestReply(event), env);
  return {
    ok: true,
    type: 'event',
    event,
    upserted: upsert?.upserted ?? 1,
    parseVia,
  };
}


/**
 * @param {any} update
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Array<{ kind: string, fileId: string, localPath: string, mimeType: string, publicPath?: string | null }> | null} [media]
 * @param {{ notifyUser?: boolean }} [opts]
 */
export async function handleTelegramUpdate(update, env = process.env, media = null, opts = {}) {
  const message = update?.message || update?.edited_message;
  if (!message) return { ok: true, skipped: true, reason: 'no_message' };
  if (media?.length) attachIntakeMediaToMessage(message, media);
  return processTelegramEventMessage(message, env, opts);
}

/**
 * Errors that should not burn endless retries (allowlist / empty junk / needs human).
 * Transient classify/parse failures (402/429/network) stay queued for retry.
 * @param {unknown} result
 */
function isPermanentIntakeFailure(result) {
  const err = String(/** @type {{ error?: unknown }} */ (result)?.error || '');
  return (
    err === 'chat_not_allowed'
    || err === 'unsupported_message'
    || err === 'unknown_type'
    || err === 'contact_name_required'
    // User already got the /event|/todo prompt — retrying the same text just spams chat.
    || err === 'low_confidence'
  );
}

/**
 * @param {number|string|null|undefined} chatId
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 * @param {{ notifyUser?: boolean }} [opts]
 */
async function notifyIntake(chatId, text, env, opts = {}) {
  if (opts.notifyUser === false) return { ok: true, skipped: true, reason: 'notify_suppressed' };
  return telegramSendMessage(chatId, text, env);
}

/**
 * Drain durable queue: classify/parse from disk, keep failures for retry.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function drainTelegramIntakeQueue(env = process.env) {
  const ready = listTelegramIntakeReady(env, { limit: 25 });
  let handled = 0;
  let failed = 0;
  for (const item of ready) {
    if (!item.payload) {
      markTelegramIntakeFailed(item.updateId, 'invalid_payload_json', env, {
        attempts: item.attempts + 1,
      });
      failed += 1;
      continue;
    }
    markTelegramIntakeProcessing(item.updateId, env);
    try {
      // Only ping Telegram on the first attempt — retries otherwise re-spam the same fail text.
      const result = await handleTelegramUpdate(item.payload, env, item.media, {
        notifyUser: item.attempts === 0,
      });
      if (result?.ok) {
        const status = result?.reason === 'album_buffer' ? 'album_buffered' : 'done';
        markTelegramIntakeDone(item.updateId, result, env, { status });
        handled += 1;
      } else if (isPermanentIntakeFailure(result)) {
        markTelegramIntakeDone(item.updateId, result, env, { status: 'done' });
        handled += 1;
      } else {
        markTelegramIntakeFailed(
          item.updateId,
          /** @type {{ error?: unknown }} */ (result)?.error || 'process_failed',
          env,
          { attempts: item.attempts + 1 },
        );
        failed += 1;
      }
    } catch (e) {
      markTelegramIntakeFailed(item.updateId, e?.message || e, env, {
        attempts: item.attempts + 1,
      });
      console.warn('[telegram-events] intake drain failed', e?.message || e);
      failed += 1;
    }
  }
  return { ok: true, ready: ready.length, handled, failed };
}

/**
 * Persist raw updates (+ media) before acknowledging Telegram offset, then drain.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function pollTelegramEventsOnce(env = process.env) {
  if (!telegramEventsEnabled(env) || !telegramBotToken(env)) {
    return { ok: false, error: 'disabled' };
  }
  const offset = loadOffset(env);
  /** @type {Record<string, unknown>} */
  const params = {
    timeout: 25,
    allowed_updates: ['message', 'edited_message'],
  };
  if (offset != null) params.offset = offset;

  const updates = await tgApi('getUpdates', params, env);
  const list = Array.isArray(updates) ? updates : [];
  let enqueued = 0;
  let ackFailed = 0;

  for (const update of list) {
    const updateId = Number(update?.update_id);
    if (!Number.isFinite(updateId)) {
      console.warn('[telegram-events] skip update without update_id');
      continue;
    }
    try {
      // 1) Download media while Telegram still has the update.
      const media = await downloadUpdateMediaForIntake(update, env);
      // 2) Durable write — only then acknowledge (advance offset).
      enqueueTelegramUpdate(update, media, env);
      saveOffset(updateId + 1, env);
      enqueued += 1;
    } catch (e) {
      // Do NOT advance offset — Telegram will redeliver until we can persist.
      ackFailed += 1;
      console.warn(
        '[telegram-events] durable enqueue failed; offset not advanced',
        updateId,
        e?.message || e,
      );
      break;
    }
  }

  const drained = await drainTelegramIntakeQueue(env);
  return {
    ok: true,
    count: list.length,
    enqueued,
    ackFailed,
    handled: drained.handled,
    drainFailed: drained.failed,
  };
}

/**
 * Status for Settings / smoke tests.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function probeTelegramEventsIntake(env = process.env) {
  const enabled = telegramEventsEnabled(env);
  const token = telegramBotToken(env);
  const allowed = [...telegramAllowedChatIds(env)];
  const openRouter = Boolean(String(env.OPENROUTER_API_KEY || '').trim());

  if (!enabled || !token) {
    return {
      active: false,
      value: 'Off — set TELEGRAM_BOT_TOKEN (+ TELEGRAM_EVENTS_ENABLED=1)',
      output: 'Telegram Events intake disabled.',
      ingestOk: null,
      ingestTest: 'Not wired — bot token missing',
      allowedChatIds: allowed,
      openRouter,
      queue: telegramIntakeQueueStats(env),
    };
  }

  try {
    const me = await tgApi('getMe', undefined, env);
    const username = me?.username ? `@${me.username}` : 'bot';
    if (!allowed.length) {
      return {
        active: true,
        value: `Bot ${username} · allowlist empty`,
        output: 'Send /start to the bot to learn your chat id, then set TELEGRAM_ALLOWED_CHAT_IDS.',
        ingestOk: false,
        ingestTest: 'Fail — TELEGRAM_ALLOWED_CHAT_IDS is empty',
        bot: me,
        allowedChatIds: allowed,
        openRouter,
        queue: telegramIntakeQueueStats(env),
      };
    }
    if (!openRouter) {
      return {
        active: true,
        value: `Bot ${username} · OpenRouter missing`,
        output: 'Voice/photo/NL parse needs OPENROUTER_API_KEY.',
        ingestOk: false,
        ingestTest: 'Fail — OPENROUTER_API_KEY not set',
        bot: me,
        allowedChatIds: allowed,
        openRouter,
        queue: telegramIntakeQueueStats(env),
      };
    }
    return {
      active: true,
      value: `Bot ${username} · polling`,
      output: `Allowlist ${allowed.length} chat(s). Text, voice, and flyer screenshots → Events catalog. Durable intake queue survives Bot API 24h retention.`,
      ingestOk: true,
      ingestTest: `Pass — ${username} ready (${allowed.length} chat id(s))`,
      bot: me,
      allowedChatIds: allowed,
      openRouter,
      queue: telegramIntakeQueueStats(env),
    };
  } catch (e) {
    return {
      active: false,
      value: 'Bot token invalid / unreachable',
      output: String(e?.message || e),
      ingestOk: false,
      ingestTest: `Fail — ${String(e?.message || e).slice(0, 160)}`,
      allowedChatIds: allowed,
      openRouter,
      queue: telegramIntakeQueueStats(env),
    };
  }
}

/**
 * Background long-poll loop (started from server.js).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startTelegramEventsPoller(env = process.env) {
  if (!telegramEventsEnabled(env) || !telegramBotToken(env)) {
    console.log('[telegram-events] poller disabled');
    return;
  }
  if (pollTimer) return;

  console.log('[telegram-events] poller starting (long-poll getUpdates + durable intake)');
  try {
    restoreTelegramAlbumBuffers(env);
  } catch (e) {
    console.warn('[telegram-events] album restore failed', e?.message || e);
  }
  // Replay anything left from a prior crash before the first long-poll.
  drainTelegramIntakeQueue(env).catch((e) => {
    console.warn('[telegram-events] startup drain failed', e?.message || e);
  });

  const tick = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    pollAbort = new AbortController();
    try {
      await pollTelegramEventsOnce(env);
    } catch (e) {
      console.warn('[telegram-events] poll failed', e?.message || e);
      // Still try to drain leftover durable rows even if getUpdates failed.
      try {
        await drainTelegramIntakeQueue(env);
      } catch (drainErr) {
        console.warn('[telegram-events] drain failed', drainErr?.message || drainErr);
      }
    } finally {
      pollInFlight = false;
      pollAbort = null;
      pollTimer = setTimeout(tick, pollMs(env));
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
    }
  };

  // Small delay so listen() finishes logging first.
  pollTimer = setTimeout(tick, 1500);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

/**
 * @returns {void}
 */
export function stopTelegramEventsPoller() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  for (const bucket of pendingAlbums.values()) {
    if (bucket.timer) clearTimeout(bucket.timer);
  }
  pendingAlbums.clear();
  try {
    pollAbort?.abort();
  } catch {
    /* ignore */
  }
  pollAbort = null;
  pollInFlight = false;
}
