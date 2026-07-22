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
import { getEventsFinderEventById, upsertEventsFinderEvents } from './events-finder-store.js';
import {
  TELEGRAM_EVENT_LOGO_PATH,
  INVITE_VISION_MAX_IMAGES,
  parseInviteImage,
  parseInviteImages,
  parseInviteText,
  transcribeInviteAudio,
} from './events-finder-invite-parse.js';
import {
  isTelegramPlaceholderUrl,
  resolveEventPageUrl,
} from './events-finder-event-url.js';
import { cropFlyerRegion, pickBestFlyerImage } from './events-finder-flyer-crop.js';
import {
  TELEGRAM_CONTACT_IMAGE_KINDS,
  TELEGRAM_COMPANY_IMAGE_KINDS,
  TELEGRAM_GUEST_LIST_MAX,
  classifyTelegramImage,
  classifyTelegramMessage,
  cropImageRegion,
  extractContactHintsFromText,
  heuristicTelegramImageClassify,
  looksLikeFlyerPerformerLineup,
  parseTelegramTypeOverride,
} from './telegram-message-classify.js';
import { createPanelTodo } from './vikunja-client.js';
import { createKeepNote, splitKeepNoteTitleBody } from './keep-notes-store.js';
import { upsertFromTelegram, getContactById, updateContact } from './network-contacts-store.js';
import {
  saveOrganizationLogo,
  upsertOrganizationFromTelegram,
} from './network-organizations-store.js';
import { enrichContact, enrichContactFromFile, enrichOrganization } from './network-enrich.js';
import { decodeContactQrFromImage } from './network-qr-decode.js';
import { applyContactAvatarFromImage, looksLikeSocialProfileScreenshot } from './network-avatar-crop.js';
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
import {
  consumeHowWeMetPrompt,
  createHowWeMetPrompt,
  eventHappeningAt,
  matchByGps,
} from './calendar-presence-index.js';
import { extractImageGps } from './image-exif-gps.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TG_API = 'https://api.telegram.org';

/** @type {ReturnType<typeof setTimeout> | null} */
let pollTimer = null;
/** @type {AbortController | null} */
let pollAbort = null;
let pollInFlight = false;
/** @type {number | null} */
let updateOffset = null;
/** Consecutive getUpdates Conflict errors (another poller sharing the bot token). */
let telegramConflictStreak = 0;
/** @type {string | null} */
let telegramLastConflictAt = null;
/** @type {string | null} */
let telegramLastConflictMessage = null;

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
 * True for events the user deliberately sent via the Telegram intake bot.
 * These bypass taste/geo/attendance filters in the feed — only date filters apply.
 * @param {{ source?: unknown, id?: unknown }} [event]
 */
export function isTelegramIntakeEvent(event) {
  if (String(event?.source || '').trim().toLowerCase() === 'telegram') return true;
  const id = String(event?.id || '').trim();
  return id.startsWith('telegram:');
}

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
 * Per-chat pointer to the last event created via Telegram, so a follow-up
 * `/more <details>` can append to it. Persisted so it survives restarts.
 * @param {NodeJS.ProcessEnv} [env]
 */
function lastEventPath(env = process.env) {
  const override = String(env.TELEGRAM_LAST_EVENT_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'telegram-last-event.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, { eventId: string, at: string }>}
 */
function readLastEventMap(env = process.env) {
  try {
    const j = JSON.parse(fs.readFileSync(lastEventPath(env), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * @param {number|string|null|undefined} chatId
 * @param {string|null|undefined} eventId
 * @param {NodeJS.ProcessEnv} [env]
 */
function recordLastTelegramEvent(chatId, eventId, env = process.env) {
  if (chatId == null || !eventId) return;
  try {
    const map = readLastEventMap(env);
    map[String(chatId)] = { eventId: String(eventId), at: new Date().toISOString() };
    const fp = lastEventPath(env);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(map, null, 2));
  } catch (e) {
    console.warn('[telegram-events] last-event pointer write failed', e?.message || e);
  }
}

/**
 * @param {number|string|null|undefined} chatId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function getLastTelegramEvent(chatId, env = process.env) {
  if (chatId == null) return null;
  const rec = readLastEventMap(env)[String(chatId)];
  return rec?.eventId ? String(rec.eventId) : null;
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
 * @param {{ reply_markup?: object }} [extra]
 */
export async function telegramSendMessage(chatId, text, env = process.env, extra = {}) {
  /** @type {Record<string, unknown>} */
  const body = {
    chat_id: chatId,
    text: String(text || '').slice(0, 3900),
    disable_web_page_preview: true,
  };
  if (extra?.reply_markup) body.reply_markup = extra.reply_markup;
  return tgApi('sendMessage', body, env);
}

/**
 * @param {number|string} chatId
 * @param {number|string} messageId
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 */
async function telegramEditMessageText(chatId, messageId, text, env = process.env) {
  return tgApi(
    'editMessageText',
    {
      chat_id: chatId,
      message_id: messageId,
      text: String(text || '').slice(0, 3900),
      disable_web_page_preview: true,
    },
    env,
  );
}

/**
 * @param {string} callbackQueryId
 * @param {string} [text]
 * @param {NodeJS.ProcessEnv} [env]
 */
async function telegramAnswerCallbackQuery(callbackQueryId, text = '', env = process.env) {
  /** @type {Record<string, unknown>} */
  const body = { callback_query_id: callbackQueryId };
  if (text) body.text = String(text).slice(0, 200);
  return tgApi('answerCallbackQuery', body, env);
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
 * Prefer a cropped flyer file next to the original screenshot.
 * @param {Buffer} buf
 * @param {string} publicPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ imageUrl: string, cropped: boolean, score: number }>}
 */
async function saveCroppedFlyerPublic(buf, publicPath, env = process.env) {
  const crop = await cropFlyerRegion(buf);
  if (!crop.cropped) {
    return {
      imageUrl: publicPath || null,
      cropped: false,
      score: crop.score || 0,
    };
  }
  const base = path.basename(String(publicPath || 'flyer.jpg')).replace(/\.[^.]+$/, '');
  const croppedPath = saveMediaPublic(crop.buffer, `${base}-flyer.jpg`, env);
  return { imageUrl: croppedPath, cropped: true, score: crop.score || 0 };
}

/**
 * True when imageUrl is the banned Telegram tile (must never be event card art).
 * @param {unknown} url
 */
function isTelegramTileImage(url) {
  return String(url || '').trim() === TELEGRAM_EVENT_LOGO_PATH;
}

/**
 * Never keep Telegram URLs; web-search a public event page when missing.
 * @param {Record<string, unknown>} event
 * @param {{ textHint?: string, urlHints?: string[] }} [opts]
 */
async function enrichEventPublicUrl(event, opts = {}) {
  const current = clean(event?.url);
  if (current && !isTelegramPlaceholderUrl(current)) {
    event.url = current;
    return event;
  }
  const resolved = await resolveEventPageUrl(event, {
    textHint: opts.textHint || '',
    urlHints: opts.urlHints || [],
  });
  event.url = resolved.url || null;
  if (!event.raw || typeof event.raw !== 'object') event.raw = {};
  /** @type {Record<string, unknown>} */ (event.raw).urlResolveVia = resolved.via;
  /** @type {Record<string, unknown>} */ (event.raw).urlCandidates = resolved.candidates.slice(0, 6);
  return event;
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
  // Prefer an explicit media path; never fall back to /assets/tile-telegram.svg.
  const fromPartial = clean(/** @type {{ imageUrl?: unknown }} */ (partial).imageUrl);
  const fromMeta = clean(meta.imageUrl);
  let imageUrl = fromMeta || fromPartial || null;
  if (isTelegramTileImage(imageUrl)) imageUrl = null;
  const from = message?.from || {};
  const invitedBy =
    clean(/** @type {{ invitedBy?: unknown }} */ (partial).invitedBy)
    || null;
  const messageIds = Array.isArray(meta.messageIds) && meta.messageIds.length
    ? meta.messageIds
    : [message?.message_id].filter((v) => v != null);
  const imageUrls = (Array.isArray(meta.imageUrls) ? meta.imageUrls : [imageUrl])
    .map((u) => clean(u))
    .filter((u) => u && !isTelegramTileImage(u));

  return {
    ...partial,
    id,
    source: 'telegram',
    imageUrl,
    url: (() => {
      const u = clean(/** @type {{ url?: unknown }} */ (partial).url);
      return u && !isTelegramPlaceholderUrl(u) ? u : null;
    })(),
    raw: {
      chatId: message?.chat?.id ?? null,
      messageId: message?.message_id ?? null,
      messageIds,
      mediaGroupId: meta.mediaGroupId || message?.media_group_id || null,
      imageUrls,
      fromId: from.id ?? null,
      fromUsername: from.username ?? null,
      parseVia: meta.parseVia,
      transcript: meta.transcript || null,
      invitedBy,
      telegramLogoFallback: false,
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
  const bits = [`Event saved: ${title}`, `When: ${when}`];
  if (invited) bits.push(`Invited by: ${invited}`);
  if (clean(event.venue)) bits.push(`Where: ${clean(event.venue)}`);
  return bits.join('\n');
}

/**
 * `/more <details>` — append extra info to the last event created in this chat.
 * @param {number|string} chatId
 * @param {string} extraText
 * @param {NodeJS.ProcessEnv} env
 * @param {{ notifyUser?: boolean }} [opts]
 */
async function appendToLastTelegramEvent(chatId, extraText, env = process.env, opts = {}) {
  const notifyUser = opts.notifyUser !== false;
  const addition = String(extraText || '').replace(/\s+/g, ' ').trim();
  if (!addition) {
    await notifyIntake(
      chatId,
      'Send /more followed by the extra details to add to your last event, e.g. /more parking is around back.',
      env,
      { notifyUser },
    );
    return { ok: false, error: 'more_empty', type: 'more' };
  }

  const lastId = getLastTelegramEvent(chatId, env);
  if (!lastId) {
    await notifyIntake(
      chatId,
      'No recent event to add to. Send an event (flyer or text) first, then reply /more <details>.',
      env,
      { notifyUser },
    );
    return { ok: false, error: 'more_no_target', type: 'more' };
  }

  const event = getEventsFinderEventById(lastId, env);
  if (!event) {
    await notifyIntake(chatId, 'Could not find your last event to update.', env, { notifyUser });
    return { ok: false, error: 'more_event_missing', type: 'more' };
  }

  const existing = clean(event.description) || '';
  const nextDescription = existing ? `${existing} — ${addition}` : addition;
  /** @type {Record<string, unknown>} */
  const updated = { ...event, description: nextDescription };
  if (!updated.raw || typeof updated.raw !== 'object') updated.raw = {};
  const raw = /** @type {Record<string, unknown>} */ (updated.raw);
  const prior = Array.isArray(raw.moreNotes) ? raw.moreNotes : [];
  raw.moreNotes = [...prior, { text: addition, at: new Date().toISOString() }];

  upsertEventsFinderEvents([updated], env);
  const verified = requirePersistedEvent(updated, env);
  recordLastTelegramEvent(chatId, verified.id, env);
  await telegramSendMessage(
    chatId,
    `Added to ${clean(verified.title) || 'event'}:\n${addition.slice(0, 400)}`,
    env,
  );
  return { ok: true, type: 'more', event: verified };
}

/**
 * @param {object} contact
 * @param {{ photoSet?: boolean }} [opts]
 */
/**
 * Where Network UI should be opened for Telegram-saved contacts.
 * Cloud is the sole getUpdates consumer — LAN Network DB will not see new rows
 * until synced.
 * @param {NodeJS.ProcessEnv} [env]
 */
function telegramNetworkViewHint(env = process.env) {
  const origin = String(env.DASHBOARD_LAN_ORIGIN || '').trim().replace(/\/$/, '');
  if (origin) return `${origin}/`;
  const domain = String(env.DASHBOARD_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (domain) return `https://${domain}/`;
  return null;
}

function formatContactSavedReply(contact, opts = {}, env = process.env) {
  const name = clean(contact?.displayName) || 'Contact';
  const org = clean(contact?.org);
  const pending = Array.isArray(contact?.mergeSuggestions)
    ? contact.mergeSuggestions.filter((s) => s && s.status === 'pending')
    : [];
  const suggestName =
    clean(contact?._telegramSuggestMergeWithName)
    || clean(pending[0]?.otherDisplayName)
    || null;
  const viewAt = telegramNetworkViewHint(env);
  if (suggestName) {
    let line = `Intake saved: ${name}${org ? ` (${org})` : ''}`;
    if (opts.photoSet) line += ' · photo set';
    if (opts.howWeMetTitle) line += `\nHow we met: ${opts.howWeMetTitle}`;
    line += `\nMatched existing: ${suggestName}`;
    line += '\nConfirm merge in Network (open task) to fold this info in.';
    if (viewAt) line += `\nOpen: ${viewAt}`;
    return line;
  }
  let line = `Contact saved: ${name}${org ? ` (${org})` : ''}`;
  if (opts.photoSet) line += ' · photo set';
  if (opts.howWeMetTitle) line += `\nHow we met: ${opts.howWeMetTitle}`;
  if (viewAt) line += `\nOpen Network: ${viewAt}`;
  return line;
}

/**
 * After Telegram contact save(s): EXIF GPS → autofill howWeMet, else Yes/No if during an event.
 * @param {{
 *   chatId: number | string,
 *   contactIds: Array<number | string>,
 *   message?: object | null,
 *   imageBuffer?: Buffer | null,
 *   atMs?: number,
 *   notifyUser?: boolean,
 * }} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   applied: boolean,
 *   asked: boolean,
 *   howWeMetTitle?: string,
 *   howWeMet?: string,
 * }>}
 */
async function maybeApplyHowWeMetFromPresence(opts, env = process.env) {
  const chatId = opts.chatId;
  const contactIds = (opts.contactIds || []).map((id) => String(id)).filter(Boolean);
  if (!contactIds.length || chatId == null) {
    return { applied: false, asked: false };
  }

  const messageAtMs = Number(opts.message?.date) * 1000;
  const fallbackAt =
    Number.isFinite(Number(opts.atMs))
      ? Number(opts.atMs)
      : Number.isFinite(messageAtMs) && messageAtMs > 0
        ? messageAtMs
        : Date.now();

  let gps = null;
  if (opts.imageBuffer && Buffer.isBuffer(opts.imageBuffer)) {
    try {
      gps = await extractImageGps(opts.imageBuffer);
    } catch {
      gps = null;
    }
  }

  if (gps) {
    const atMs = Number.isFinite(gps.capturedAtMs) ? gps.capturedAtMs : fallbackAt;
    const hit = matchByGps(
      {
        lat: gps.lat,
        lon: gps.lon,
        accuracyMeters: gps.accuracyMeters,
        atMs,
      },
      env,
    );
    if (hit?.howWeMet) {
      for (const id of contactIds) {
        try {
          await updateContact(id, { howWeMet: hit.howWeMet }, env);
        } catch (e) {
          console.warn('[telegram-events] howWeMet autofill failed', id, e?.message || e);
        }
      }
      const title = String(hit.event?.title || '').trim() || 'event';
      console.log('[telegram-events] howWeMet autofill', title, contactIds.length);
      return {
        applied: true,
        asked: false,
        howWeMetTitle: title,
        howWeMet: hit.howWeMet,
      };
    }
  }

  // No usable GPS match — ask if upload time falls in an indexed event.
  const happening = eventHappeningAt(fallbackAt, env);
  if (!happening?.howWeMet || opts.notifyUser === false) {
    return { applied: false, asked: false };
  }

  const prompt = createHowWeMetPrompt(
    {
      chatId,
      contactIds,
      howWeMet: happening.howWeMet,
      eventTitle: String(happening.event?.title || '').trim() || 'this event',
      eventId: happening.event?.id,
    },
    env,
  );
  const title = prompt.eventTitle;
  try {
    await telegramSendMessage(
      chatId,
      `Did you meet them at ${title}?`,
      env,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Yes', callback_data: `hwm:y:${prompt.promptId}` },
              { text: 'No', callback_data: `hwm:n:${prompt.promptId}` },
            ],
          ],
        },
      },
    );
    return { asked: true, applied: false, howWeMetTitle: title, howWeMet: happening.howWeMet };
  } catch (e) {
    console.warn('[telegram-events] howWeMet prompt failed', e?.message || e);
    return { applied: false, asked: false };
  }
}

/**
 * @param {any} callbackQuery
 * @param {NodeJS.ProcessEnv} [env]
 */
async function handleHowWeMetCallback(callbackQuery, env = process.env) {
  const data = String(callbackQuery?.data || '').trim();
  const m = data.match(/^hwm:([yn]):([A-Za-z0-9_-]+)$/);
  const cqId = String(callbackQuery?.id || '');
  if (!m) {
    if (cqId) await telegramAnswerCallbackQuery(cqId, '', env).catch(() => {});
    return { ok: true, skipped: true, reason: 'not_how_we_met' };
  }
  const yes = m[1] === 'y';
  const promptId = m[2];
  const prompt = consumeHowWeMetPrompt(promptId, env);
  const chatId = callbackQuery?.message?.chat?.id ?? callbackQuery?.from?.id;
  const messageId = callbackQuery?.message?.message_id;

  if (!prompt) {
    if (cqId) await telegramAnswerCallbackQuery(cqId, 'Expired', env).catch(() => {});
    if (chatId != null && messageId != null) {
      await telegramEditMessageText(chatId, messageId, 'How we met prompt expired.', env).catch(
        () => {},
      );
    }
    return { ok: true, type: 'how_we_met', expired: true };
  }

  if (yes) {
    for (const id of prompt.contactIds || []) {
      try {
        await updateContact(id, { howWeMet: prompt.howWeMet }, env);
      } catch (e) {
        console.warn('[telegram-events] howWeMet Yes patch failed', id, e?.message || e);
      }
    }
    if (cqId) await telegramAnswerCallbackQuery(cqId, 'Saved', env).catch(() => {});
    if (chatId != null && messageId != null) {
      await telegramEditMessageText(
        chatId,
        messageId,
        `Marked as met at ${prompt.eventTitle}.`,
        env,
      ).catch(() => {});
    }
    return { ok: true, type: 'how_we_met', applied: true, eventTitle: prompt.eventTitle };
  }

  if (cqId) await telegramAnswerCallbackQuery(cqId, 'Skipped', env).catch(() => {});
  if (chatId != null && messageId != null) {
    await telegramEditMessageText(chatId, messageId, 'Skipped how we met.', env).catch(() => {});
  }
  return { ok: true, type: 'how_we_met', applied: false };
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

  const bestFlyer = await pickBestFlyerImage(
    downloaded.map((d) => ({
      buffer: Buffer.from(d.base64, 'base64'),
      publicPath: d.publicPath,
      mimeType: d.mimeType,
    })),
  );
  let imageUrl = downloaded[0].publicPath;
  const imageUrls = downloaded.map((d) => d.publicPath);
  if (bestFlyer) {
    if (bestFlyer.cropped) {
      const base = path.basename(String(bestFlyer.publicPath || downloaded[bestFlyer.index].publicPath || 'album'))
        .replace(/\.[^.]+$/, '');
      imageUrl = saveMediaPublic(bestFlyer.buffer, `${base}-flyer.jpg`, env);
    } else {
      // Keep the real photo even when flyer-crop confidence is low — never the Telegram tile.
      imageUrl = bestFlyer.publicPath || downloaded[bestFlyer.index].publicPath || imageUrl;
    }
  }
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
  await enrichEventPublicUrl(event, {
    textHint: caption,
    urlHints: imageUrls,
  });
  if (bestFlyer) {
    if (!event.raw || typeof event.raw !== 'object') event.raw = {};
    /** @type {Record<string, unknown>} */ (event.raw).flyerCropped = Boolean(bestFlyer.cropped);
    /** @type {Record<string, unknown>} */ (event.raw).flyerScore = bestFlyer.score;
  }

  const upsert = upsertEventsFinderEvents([event], env);
  const verified = requirePersistedEvent(event, env);
  recordLastTelegramEvent(chatId, verified.id, env);
  const reply = formatIngestReply(verified);
  const albumNote = downloaded.length > 1 ? `\n(${downloaded.length} screenshots → one event)` : '';
  await telegramSendMessage(chatId, `${reply}${albumNote}`, env);

  return {
    ok: true,
    event: verified,
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
    || (
      /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b|\+\d{8,15}\b/.test(body)
      && /[A-Za-z]{2,}/.test(body)
      && body.length < 280
    )
    || (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(body) && body.length < 280)
  ) {
    const hints = extractContactHintsFromText(body);
    const name =
      hints.displayName
      || body.split(/[,\n]/)[0]?.replace(/^(contact|friend|met)\b[:\s-]*/i, '').trim()
      || body;
    return {
      ok: true,
      type: 'contact',
      confidence: hints.phone || hints.email || hints.linkedin ? 0.72 : 0.5,
      reason: 'heuristic_contact',
      todoText: null,
      noteText: null,
      contact: {
        displayName: name,
        notes: body,
        aliases: [],
        kind: 'friend',
        org: hints.org,
        email: hints.email,
        phone: hints.phone,
        officePhone: hints.officePhone,
        telegram: hints.telegram,
        linkedin: hints.linkedin,
        website: hints.website,
      },
      company: null,
    };
  }
  if (
    /^(company|org|organization)\b/i.test(body)
    || /\b(add company|new company|new org)\b/i.test(lower)
  ) {
    const hints = extractContactHintsFromText(body);
    const name =
      hints.displayName
      || body.split(/[,\n]/)[0]?.replace(/^(company|org|organization)\b[:\s-]*/i, '').trim()
      || body;
    return {
      ok: true,
      type: 'company',
      confidence: 0.65,
      reason: 'heuristic_company',
      todoText: null,
      noteText: null,
      contact: null,
      company: {
        name,
        website: hints.website,
        phone: hints.phone,
        email: hints.email,
        linkedin: hints.linkedin,
        notes: body,
      },
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
    company: null,
  };
}

/**
 * Process one Telegram message: classify → event | todo | note | contact | company.
 * Photos run a vision intake-kind classifier (flyer vs card/LinkedIn/headshot/logo).
 *
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
        ? 'Dashbird intake is ready. Send text, voice, flyer, business card, LinkedIn screenshot, guest list, headshot, or company logo.\nI classify as event / todo / note / contact / company.\nOverrides: /event /todo /note /contact /company …\nAdd details to your last event: /more <details>.\nAlbums of screenshots → one event.\nSend "help" any time for the full list.'
        : `Your Telegram chat id is ${chatId}.\nAdd it to TELEGRAM_ALLOWED_CHAT_IDS in Dashbird .env, then restart.`,
      env,
    );
    return { ok: true, skipped: true, reason: 'start' };
  }

  if (/^\/help(@\w+)?$/i.test(text) || /^help[!.?]*$/i.test(text)) {
    await telegramSendMessage(
      chatId,
      'Send:\n• Flyer photo / album → event\n• Business card / LinkedIn / headshot → contact\n• Guest list screenshot → contacts (everyone listed)\n• Company logo → company card\n• Voice or text → auto-classified\n• Name + phone → contact\n• /more extra details → adds to your LAST event (e.g. send a flyer, then /more parking around back)\n• /todo buy milk\n• /note idea for weekend\n• /contact Sam, met at party, 555-…\n• /company Acme Labs, acme.com\n• /event July 18 Rooftop Jazz invited by Maya',
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

  // `/more <details>` (or a photo caption) appends to the last event in this chat.
  const moreSource = text || caption;
  const moreMatch = moreSource.match(/^\/more(?:@\w+)?\b([\s\S]*)$/i);
  if (moreMatch) {
    return appendToLastTelegramEvent(chatId, moreMatch[1], env, { notifyUser });
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

  // Flyer / CRM image → classify kind, then event | contact | company.
  if (
    photoId
    || docIsImage
    || getAttachedIntakeMedia(message, 'photo')
    || getAttachedIntakeMedia(message, 'document_image')
  ) {
    const override = parseTelegramTypeOverride(caption || text);
    if (override && (override.type === 'todo' || override.type === 'note')) {
      return routeNonEventType(override.type, override.rest || caption || text, chatId, env, {
        force: true,
      });
    }

    const kind = photoId || getAttachedIntakeMedia(message, 'photo') ? 'photo' : 'document_image';
    const fileId = photoId || docIsImage || '';
    let file;
    try {
      file = await resolveTelegramMedia(message, kind, fileId, env);
    } catch (e) {
      await notifyIntake(chatId, `Image download failed: ${String(e?.message || e).slice(0, 160)}`, env, {
        notifyUser,
      });
      return { ok: false, error: String(e?.message || e) };
    }

    const mime = file.mimeType || 'image/jpeg';
    const dataUrl = `data:${mime.startsWith('image/') ? mime : 'image/jpeg'};base64,${file.buffer.toString('base64')}`;

    if (override?.type === 'event') {
      return ingestTelegramEventFromMessage(message, env, {
        photoId: fileId,
        caption,
        text,
        notifyUser,
      });
    }
    if (override?.type === 'contact') {
      return ingestTelegramContactFromImage(message, file, env, {
        caption: override.rest || caption || text,
        classified: null,
        forceKind: 'business_card',
        notifyUser,
      });
    }
    if (override?.type === 'company') {
      return ingestTelegramCompanyFromImage(message, file, env, {
        caption: override.rest || caption || text,
        classified: null,
        notifyUser,
      });
    }

    let classified = null;
    try {
      classified = await classifyTelegramImage(dataUrl, caption || text || '', env);
    } catch (e) {
      console.warn('[telegram-events] image classify error', e?.message || e);
    }
    if (!classified?.ok) {
      const heur = heuristicTelegramImageClassify(caption || text || '');
      if (heur) classified = heur;
    }

    const imageKind = String(classified?.kind || '').toLowerCase();
    const conf = Number(classified?.confidence) || 0;

    if (
      imageKind === 'guest_list'
      && (conf >= 0.45
        || classified?.reason === 'heuristic_caption_guest_list'
        || (Array.isArray(classified?.contacts) && classified.contacts.length >= 1))
    ) {
      let routeAsEvent =
        looksLikeFlyerPerformerLineup(classified?.contacts)
        || Boolean(clean(classified?.eventName));
      if (!routeAsEvent) {
        try {
          const mime = file.mimeType || 'image/jpeg';
          const probe = await parseInviteImage(
            {
              mimeType: mime.startsWith('image/') ? mime : 'image/jpeg',
              base64: file.buffer.toString('base64'),
              caption: caption || text,
            },
            env,
            { defaultImageUrl: null },
          );
          routeAsEvent = Boolean(probe.ok && probe.event && clean(probe.event.start));
        } catch (e) {
          console.warn('[telegram-events] guest_list event probe failed', e?.message || e);
        }
      }
      if (routeAsEvent) {
        return ingestTelegramEventFromMessage(message, env, {
          photoId: fileId,
          caption,
          text,
          notifyUser,
        });
      }
      return ingestTelegramGuestListFromImage(message, file, env, {
        caption: caption || text,
        classified,
        notifyUser,
      });
    }
    if (
      TELEGRAM_CONTACT_IMAGE_KINDS.has(imageKind)
      && (conf >= 0.45 || classified?.reason === 'heuristic_caption_contact' || classified?.reason === 'heuristic_caption_crm')
    ) {
      return ingestTelegramContactFromImage(message, file, env, {
        caption: caption || text,
        classified,
        notifyUser,
      });
    }
    if (
      TELEGRAM_COMPANY_IMAGE_KINDS.has(imageKind)
      && (conf >= 0.45 || classified?.reason === 'heuristic_caption_company' || classified?.reason === 'heuristic_caption_logo')
    ) {
      return ingestTelegramCompanyFromImage(message, file, env, {
        caption: caption || text,
        classified,
        notifyUser,
      });
    }

    // Ambiguous CRM-ish caption with phone/email → contact even if vision said other.
    const captionHints = extractContactHintsFromText(caption || text || '');
    if (
      (imageKind === 'other' || !classified?.ok)
      && captionHints.displayName
      && (captionHints.phone || captionHints.email || captionHints.linkedin)
    ) {
      return ingestTelegramContactFromImage(message, file, env, {
        caption: caption || text,
        classified: {
          ok: true,
          kind: 'business_card',
          confidence: 0.55,
          reason: 'caption_contact_hints',
          hasHeadshot: Boolean(classified?.hasHeadshot),
          headshotCrop: classified?.headshotCrop || null,
          hasLogo: Boolean(classified?.hasLogo),
          logoCrop: classified?.logoCrop || null,
          contact: {
            displayName: captionHints.displayName,
            notes: caption || text,
            aliases: [],
            kind: 'business',
            org: captionHints.org,
            email: captionHints.email,
            phone: captionHints.phone,
            officePhone: captionHints.officePhone,
            telegram: captionHints.telegram,
            linkedin: captionHints.linkedin,
            website: captionHints.website,
            title: null,
            location: null,
          },
          company: null,
        },
        notifyUser,
      });
    }

    return ingestTelegramEventFromMessage(message, env, {
      photoId: fileId,
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
      `Could not classify (${classified.error || 'unknown'}). Try /event /todo /note /contact /company.`,
      env,
      { notifyUser },
    );
    return { ok: false, error: classified.error || 'classify_failed', transcript };
  }

  const confidence = Number(classified.confidence) || 0;
  if (confidence < 0.55 && classified.reason !== 'command_override') {
    await notifyIntake(
      chatId,
      `Not sure if this is an event, todo, note, contact, or company (confidence ${confidence.toFixed(2)}).\nReply with /event /todo /note /contact or /company plus the text.`,
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
    const noteText = String(classified.noteText || text || '')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, 20000);
    try {
      if (!noteText) {
        const err = new Error('text_required');
        err.code = 'text_required';
        throw err;
      }
      const { title, body } = splitKeepNoteTitleBody(noteText);
      const note = await createKeepNote({ title, body }, env);
      const preview = (note.title || note.body || '').slice(0, 300);
      await telegramSendMessage(chatId, `Note saved (${note.id}):\n${preview}`, env);
      return { ok: true, type: 'note', note };
    } catch (e) {
      await telegramSendMessage(chatId, `Note failed: ${String(e?.message || e).slice(0, 200)}`, env);
      return { ok: false, error: String(e?.message || e), type: 'note' };
    }
  }

  if (type === 'contact') {
    const c = classified.contact && typeof classified.contact === 'object' ? classified.contact : {};
    const hints = extractContactHintsFromText(text);
    const displayName =
      String(c.displayName || '').trim()
      || hints.displayName
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
          org: c.org || hints.org || '',
          title: c.title || '',
          location: c.location || '',
          address: c.address || '',
          website: c.website || hints.website || '',
          tags: ['telegram'],
          channels: {
            email: c.email || hints.email || null,
            phone: c.phone || hints.phone || null,
            officePhone: c.officePhone || hints.officePhone || null,
            telegram: c.telegram || hints.telegram || null,
            linkedin: c.linkedin || hints.linkedin || null,
            urls: c.website || hints.website ? [c.website || hints.website].filter(Boolean) : [],
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
      const verified = await requirePersistedContact(enriched, env);
      const hwm = await maybeApplyHowWeMetFromPresence(
        {
          chatId,
          contactIds: [verified.id],
          atMs: Date.now(),
          notifyUser: true,
        },
        env,
      );
      await telegramSendMessage(
        chatId,
        formatContactSavedReply(verified, { howWeMetTitle: hwm.applied ? hwm.howWeMetTitle : undefined }, env),
        env,
      );
      return { ok: true, type: 'contact', contact: verified, howWeMet: hwm };
    } catch (e) {
      await telegramSendMessage(chatId, `Contact failed: ${String(e?.message || e).slice(0, 200)}`, env);
      return { ok: false, error: String(e?.message || e), type: 'contact' };
    }
  }

  if (type === 'company') {
    const co = classified.company && typeof classified.company === 'object' ? classified.company : {};
    const hints = extractContactHintsFromText(text);
    const name =
      String(co.name || '').trim()
      || hints.displayName
      || String(text).split(/[,\n]/)[0]?.trim()
      || '';
    if (!name) {
      await telegramSendMessage(chatId, 'Company needs a name. Try: /company Acme Labs, acme.com', env);
      return { ok: false, error: 'company_name_required', type: 'company' };
    }
    try {
      let org = await upsertOrganizationFromTelegram(
        {
          name,
          notes: String(co.notes || text).trim(),
          website: co.website || hints.website || '',
          phone: co.phone || hints.phone || '',
          email: co.email || hints.email || '',
          linkedin: co.linkedin || hints.linkedin || '',
          location: co.location || '',
        },
        env,
      );
      try {
        const er = await enrichOrganization(org.id, {}, env);
        if (er.ok && er.organization) org = er.organization;
      } catch {
        // ignore
      }
      await telegramSendMessage(chatId, `Company saved: ${org.name}`, env);
      return { ok: true, type: 'company', organization: org };
    } catch (e) {
      await telegramSendMessage(chatId, `Company failed: ${String(e?.message || e).slice(0, 200)}`, env);
      return { ok: false, error: String(e?.message || e), type: 'company' };
    }
  }

  await telegramSendMessage(chatId, `Unknown type “${type}”. Use /event /todo /note /contact /company.`, env);
  return { ok: false, error: 'unknown_type', type };
}

/**
 * @param {Buffer} buf
 * @param {string} mimeType
 */
function bufferToDataUrl(buf, mimeType = 'image/jpeg') {
  const mime = String(mimeType || 'image/jpeg').startsWith('image/')
    ? String(mimeType || 'image/jpeg')
    : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Guest / RSVP / attendee list screenshot → many Network contacts.
 * @param {any} message
 * @param {{ buffer: Buffer, filePath?: string, mimeType?: string }} file
 * @param {NodeJS.ProcessEnv} env
 * @param {{ caption?: string, classified?: object | null, notifyUser?: boolean }} [meta]
 */
async function ingestTelegramGuestListFromImage(message, file, env, meta = {}) {
  const chatId = message?.chat?.id;
  const notifyUser = meta.notifyUser !== false;
  const caption = String(meta.caption || message?.caption || message?.text || '').trim();
  const classified = meta.classified && typeof meta.classified === 'object' ? meta.classified : {};
  const eventName = String(classified.eventName || '').trim() || null;
  const noteBase = [
    eventName ? `Guest list: ${eventName}` : 'Guest list (Telegram)',
    caption && caption !== eventName ? caption : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);

  /** @type {object[]} */
  let people = Array.isArray(classified.contacts) ? classified.contacts.filter((c) => c?.displayName) : [];
  if (!people.length && classified.contact?.displayName) {
    people = [classified.contact];
  }

  // Vision may have labeled guest_list but failed to fill contacts — one more pass via enrich prompt is too heavy;
  // ask the user to caption if empty.
  if (!people.length) {
    await notifyIntake(
      chatId,
      'Looks like a guest list, but I could not read any names. Resend with a clearer crop, or caption /contact Name1, Name2…',
      env,
      { notifyUser },
    );
    return { ok: false, error: 'guest_list_empty', type: 'contact' };
  }

  people = people.slice(0, TELEGRAM_GUEST_LIST_MAX);
  /** @type {object[]} */
  const saved = [];
  /** @type {string[]} */
  const failed = [];

  for (const person of people) {
    const displayName = String(person.displayName || '').trim();
    if (!displayName) continue;
    try {
      let contact = await upsertFromTelegram(
        {
          displayName,
          aliases: Array.isArray(person.aliases) ? person.aliases : [],
          kinds: person.kind === 'business' ? ['business'] : ['friend'],
          notes: String(person.notes || noteBase).trim(),
          org: person.org || '',
          title: person.title || '',
          location: person.location || '',
          address: person.address || '',
          website: person.website || '',
          channels: {
            email: person.email || null,
            phone: person.phone || null,
            officePhone: person.officePhone || null,
            telegram: person.telegram || null,
            linkedin: person.linkedin || null,
            urls: person.website ? [person.website] : [],
          },
        },
        env,
      );

      if ((person.hasHeadshot || person.headshotCrop) && !contact.avatarUrl) {
        try {
          const applied = await applyContactAvatarFromImage(
            contact.id,
            file.buffer,
            {
              kind: 'guest_list',
              headshotCrop: person.headshotCrop || null,
              mimeType: file.mimeType || 'image/jpeg',
            },
            env,
          );
          if (applied.ok && applied.contact) {
            contact = applied.contact;
            console.log(
              '[telegram-events] guest avatar crop',
              displayName,
              applied.source,
              JSON.stringify(applied.crop),
            );
          }
        } catch (e) {
          console.warn('[telegram-events] guest avatar crop failed', displayName, e?.message || e);
        }
      }

      saved.push(await requirePersistedContact(contact, env));
    } catch (e) {
      failed.push(displayName);
      console.warn('[telegram-events] guest upsert failed', displayName, e?.message || e);
    }
  }

  if (!saved.length) {
    await notifyIntake(chatId, 'Guest list ingest failed — could not save any contacts.', env, {
      notifyUser,
    });
    return { ok: false, error: 'guest_list_save_failed', type: 'contact' };
  }

  const preview = saved
    .slice(0, 8)
    .map((c) => c.displayName)
    .join(', ');
  const more = saved.length > 8 ? ` (+${saved.length - 8} more)` : '';
  const failBit = failed.length ? `\nSkipped ${failed.length}: ${failed.slice(0, 5).join(', ')}` : '';
  const hwm = await maybeApplyHowWeMetFromPresence(
    {
      chatId,
      contactIds: saved.map((c) => c.id),
      message,
      imageBuffer: file?.buffer || null,
      notifyUser,
    },
    env,
  );

  const hwmBit = hwm.applied
    ? `\nHow we met: ${hwm.howWeMetTitle}`
    : '';
  await notifyIntake(
    chatId,
    `Guest list → ${saved.length} contact${saved.length === 1 ? '' : 's'}${
      eventName ? ` · ${eventName}` : ''
    }:\n${preview}${more}${failBit}${hwmBit}`,
    env,
    { notifyUser },
  );

  return {
    ok: true,
    type: 'contact',
    imageKind: 'guest_list',
    eventName,
    contacts: saved,
    saved: saved.length,
    failed: failed.length,
    howWeMet: hwm,
    // Keep single-contact shape for older status tooling.
    contact: saved[0],
  };
}

/**
 * Business card / LinkedIn / social / headshot → Network contact (+ optional company logo).
 * @param {any} message
 * @param {{ buffer: Buffer, filePath?: string, mimeType?: string }} file
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   caption?: string,
 *   classified?: object | null,
 *   forceKind?: string,
 *   notifyUser?: boolean,
 * }} [meta]
 */
async function ingestTelegramContactFromImage(message, file, env, meta = {}) {
  const chatId = message?.chat?.id;
  const notifyUser = meta.notifyUser !== false;
  const caption = String(meta.caption || message?.caption || message?.text || '').trim();
  const classified = meta.classified && typeof meta.classified === 'object' ? meta.classified : {};
  const c = classified.contact && typeof classified.contact === 'object' ? classified.contact : {};
  const co = classified.company && typeof classified.company === 'object' ? classified.company : {};
  const hints = extractContactHintsFromText(caption);

  const displayName =
    String(c.displayName || '').trim()
    || hints.displayName
    || caption.split(/[,\n]/)[0]?.replace(/^\/contact(?:@\w+)?\s*/i, '').trim()
    || '';

  if (!displayName) {
    await notifyIntake(
      chatId,
      'Looks like a contact photo, but I need a name. Caption with /contact Jane Doe or resend with the name visible.',
      env,
      { notifyUser },
    );
    return { ok: false, error: 'contact_name_required', type: 'contact' };
  }

  const imageKind = String(classified.kind || meta.forceKind || 'business_card').toLowerCase();
  // Physical/digital business cards are always Type = business only (not friend).
  const kinds = imageKind === 'business_card' ? ['business'] : c.kind === 'business' ? ['business'] : ['friend'];

  /** Decode QR before create so the first write already has the card URL. */
  let qr = { urls: [], emails: [], phones: [], linkedin: null };
  try {
    qr = await decodeContactQrFromImage(file.buffer);
    if (qr.urls.length || qr.linkedin) {
      console.log(
        '[telegram-events] business-card QR',
        displayName,
        JSON.stringify({ urls: qr.urls, linkedin: qr.linkedin }),
      );
    }
  } catch (e) {
    console.warn('[telegram-events] QR decode failed', e?.message || e);
  }

  try {
    let contact = await upsertFromTelegram(
      {
        displayName,
        aliases: Array.isArray(c.aliases) ? c.aliases : [],
        kinds,
        notes: String(c.notes || caption || `Telegram ${classified.kind || 'contact'} photo`).trim(),
        org: c.org || co.name || hints.org || '',
        title: c.title || '',
        location: c.location || co.location || '',
        address: c.address || '',
        website: c.website || co.website || hints.website || qr.urls[0] || '',
        channels: {
          email: c.email || hints.email || qr.emails?.[0] || null,
          phone: c.phone || hints.phone || qr.phones?.[0] || null,
          officePhone: c.officePhone || hints.officePhone || null,
          telegram: c.telegram || hints.telegram || null,
          linkedin: c.linkedin || hints.linkedin || qr.linkedin || null,
          urls: [c.website, co.website, hints.website, ...qr.urls].filter(Boolean),
        },
      },
      env,
    );

    const mime = file.mimeType || 'image/jpeg';
    const dataUrl = bufferToDataUrl(file.buffer, mime);
    const profileShot =
      imageKind === 'social_screenshot'
      || imageKind === 'linkedin_screenshot'
      || (await looksLikeSocialProfileScreenshot(file.buffer));
    // Always crop avatars for profile screenshots (even if VLM forgot hasHeadshot).
    const wantAvatar =
      profileShot
      || Boolean(classified.hasHeadshot)
      || imageKind === 'headshot'
      || imageKind === 'business_card';

    if (wantAvatar && !contact.avatarUrl) {
      try {
        const applied = await applyContactAvatarFromImage(
          contact.id,
          file.buffer,
          {
            kind: imageKind || (profileShot ? 'social_screenshot' : ''),
            headshotCrop: classified.headshotCrop || null,
            mimeType: mime,
            allowFullFrame: true,
          },
          env,
        );
        if (applied.ok && applied.contact) {
          contact = applied.contact;
          console.log(
            '[telegram-events] avatar crop',
            displayName,
            applied.source,
            JSON.stringify(applied.crop),
          );
        } else {
          console.warn(
            '[telegram-events] avatar crop skipped',
            displayName,
            applied.error || applied.source,
          );
        }
      } catch (e) {
        console.warn('[telegram-events] avatar apply failed', e?.message || e);
      }
    }

    try {
      const er = await enrichContactFromFile(
        contact.id,
        {
          dataUrl,
          filename: path.basename(file.filePath || 'telegram-contact.jpg'),
          mimeType: mime,
          force: true,
          // Never overwrite a carefully cropped avatar with the full screenshot.
          preserveAvatar: Boolean(contact.avatarUrl) || profileShot,
          useImageAsAvatar: imageKind === 'headshot' && !contact.avatarUrl && !profileShot,
        },
        env,
      );
      if (er.ok && er.contact) contact = er.contact;
    } catch (e) {
      console.warn('[telegram-events] contact file enrich failed', e?.message || e);
    }

    // Best-effort web enrich for LinkedIn / missing fields.
    try {
      const er = await enrichContact(contact.id, {}, env);
      if (er.ok && er.contact) contact = er.contact;
    } catch {
      // ignore
    }

    // If company was identified on the card, ensure org + optional logo.
    const orgName = String(co.name || contact.org || '').trim();
    if (orgName) {
      try {
        let org = await upsertOrganizationFromTelegram(
          {
            name: orgName,
            website: co.website || '',
            phone: co.phone || '',
            email: co.email || '',
            linkedin: co.linkedin || '',
            location: co.location || '',
            notes: co.notes || `From Telegram contact ${displayName}`,
          },
          env,
        );
        if (classified.hasLogo || classified.logoCrop) {
          try {
            let logoBuf = null;
            if (classified.logoCrop) {
              logoBuf = await cropImageRegion(file.buffer, classified.logoCrop, { maxEdge: 512 });
            }
            // Only use full image as logo when the image is primarily a logo (not a person card).
            if (!logoBuf && imageKind === 'company_logo') logoBuf = file.buffer;
            if (logoBuf) {
              org = await saveOrganizationLogo(
                org.id,
                {
                  base64: logoBuf.toString('base64'),
                  mimeType: logoBuf === file.buffer ? mime : 'image/jpeg',
                },
                env,
              );
            } else {
              console.warn(
                '[telegram-events] logo crop empty',
                JSON.stringify({
                  hasLogo: Boolean(classified.hasLogo),
                  logoCrop: classified.logoCrop || null,
                  imageKind,
                }),
              );
            }
          } catch (e) {
            console.warn('[telegram-events] company logo from contact card failed', e?.message || e);
          }
        }
        // Link contact → org if still missing orgId.
        if (!contact.orgId || contact.org !== org.name) {
          contact = await updateContact(contact.id, { org: org.name, orgId: org.id }, env);
        }
      } catch (e) {
        console.warn('[telegram-events] org from contact image failed', e?.message || e);
      }
    }

    const verified = await requirePersistedContact(contact, env);
    const hwm = await maybeApplyHowWeMetFromPresence(
      {
        chatId,
        contactIds: [verified.id],
        message,
        imageBuffer: file?.buffer || null,
        notifyUser,
      },
      env,
    );
    await notifyIntake(
      chatId,
      formatContactSavedReply(verified, {
        photoSet: Boolean(verified.avatarUrl),
        howWeMetTitle: hwm.applied ? hwm.howWeMetTitle : undefined,
      }, env),
      env,
      { notifyUser },
    );
    return {
      ok: true,
      type: 'contact',
      contact: verified,
      imageKind,
      hasHeadshot: Boolean(classified.hasHeadshot),
      howWeMet: hwm,
    };
  } catch (e) {
    await notifyIntake(chatId, `Contact failed: ${String(e?.message || e).slice(0, 200)}`, env, {
      notifyUser,
    });
    return { ok: false, error: String(e?.message || e), type: 'contact' };
  }
}

/**
 * Company logo / brand mark → Network organization card.
 * @param {any} message
 * @param {{ buffer: Buffer, filePath?: string, mimeType?: string }} file
 * @param {NodeJS.ProcessEnv} env
 * @param {{ caption?: string, classified?: object | null, notifyUser?: boolean }} [meta]
 */
async function ingestTelegramCompanyFromImage(message, file, env, meta = {}) {
  const chatId = message?.chat?.id;
  const notifyUser = meta.notifyUser !== false;
  const caption = String(meta.caption || message?.caption || message?.text || '').trim();
  const classified = meta.classified && typeof meta.classified === 'object' ? meta.classified : {};
  const co = classified.company && typeof classified.company === 'object' ? classified.company : {};
  const hints = extractContactHintsFromText(caption);

  const name =
    String(co.name || '').trim()
    || hints.displayName
    || caption.split(/[,\n]/)[0]?.replace(/^\/company(?:@\w+)?\s*/i, '').trim()
    || '';

  if (!name) {
    await notifyIntake(
      chatId,
      'Looks like a company logo, but I need a name. Caption with /company Acme Labs.',
      env,
      { notifyUser },
    );
    return { ok: false, error: 'company_name_required', type: 'company' };
  }

  try {
    let org = await upsertOrganizationFromTelegram(
      {
        name,
        notes: String(co.notes || caption || 'Telegram company logo').trim(),
        website: co.website || hints.website || '',
        phone: co.phone || hints.phone || '',
        email: co.email || hints.email || '',
        linkedin: co.linkedin || hints.linkedin || '',
        location: co.location || '',
      },
      env,
    );

    const mime = file.mimeType || 'image/jpeg';
    try {
      let logoBuf = null;
      if (classified.logoCrop) {
        logoBuf = await cropImageRegion(file.buffer, classified.logoCrop, { maxEdge: 512 });
      }
      if (!logoBuf) logoBuf = file.buffer;
      org = await saveOrganizationLogo(
        org.id,
        {
          base64: logoBuf.toString('base64'),
          mimeType: logoBuf === file.buffer ? mime : 'image/jpeg',
        },
        env,
      );
    } catch (e) {
      console.warn('[telegram-events] company logo apply failed', e?.message || e);
    }

    try {
      const er = await enrichOrganization(org.id, {}, env);
      if (er.ok && er.organization) org = er.organization;
    } catch {
      // ignore
    }

    await notifyIntake(
      chatId,
      `Company saved: ${org.name}${org.logoUrl ? ' · logo set' : ''}`,
      env,
      { notifyUser },
    );
    return { ok: true, type: 'company', organization: org };
  } catch (e) {
    await notifyIntake(chatId, `Company failed: ${String(e?.message || e).slice(0, 200)}`, env, {
      notifyUser,
    });
    return { ok: false, error: String(e?.message || e), type: 'company' };
  }
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
  let parsed = await parseInviteText(text, env, { defaultImageUrl: null });
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
    imageUrl: clean(parsed.event.imageUrl) || null,
  });
  if (parsed.event.invitedBy) event.invitedBy = parsed.event.invitedBy;
  await enrichEventPublicUrl(event, { textHint: text });
  if (!event.imageUrl || isTelegramTileImage(event.imageUrl)) {
    const og = await fetchOgImageForEventUrl(event.url);
    if (og) event.imageUrl = og;
    else event.imageUrl = null;
  }
  const upsert = upsertEventsFinderEvents([event], env);
  const verified = requirePersistedEvent(event, env);
  recordLastTelegramEvent(chatId, verified.id, env);
  await telegramSendMessage(chatId, formatIngestReply(verified), env);
  return {
    ok: true,
    type: 'event',
    event: verified,
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
  let imageUrl = null;
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
      const ogImage =
        (html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)
          || html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i)
          || [])[1] || null;
      if (ogImage) {
        try {
          imageUrl = new URL(ogImage, url).href;
        } catch {
          imageUrl = ogImage;
        }
      }
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
      imageUrl,
      invitedBy: null,
    },
  };
}

/**
 * Best-effort og:image from a public event page (text-only intake).
 * @param {unknown} url
 * @returns {Promise<string | null>}
 */
async function fetchOgImageForEventUrl(url) {
  const href = clean(url);
  if (!href || isTelegramPlaceholderUrl(href)) return null;
  try {
    const r = await fetch(href, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 DashbirdTelegramIntake/1.0', Accept: 'text/html' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const ogImage =
      (html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)
        || html.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i)
        || [])[1] || null;
    if (!ogImage) return null;
    return new URL(ogImage, href).href;
  } catch {
    return null;
  }
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
  let imageUrl = null;
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
    const cropped = await saveCroppedFlyerPublic(file.buffer, publicPath, env);
    if (cropped.cropped) {
      imageUrl = cropped.imageUrl;
    }
    // Low flyer-crop score still keeps the real photo — never /assets/tile-telegram.svg.
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
  await enrichEventPublicUrl(event, {
    textHint: [media.caption, media.text].filter(Boolean).join('\n'),
  });
  const upsert = upsertEventsFinderEvents([event], env);
  const verified = requirePersistedEvent(event, env);
  recordLastTelegramEvent(chatId, verified.id, env);
  await telegramSendMessage(chatId, formatIngestReply(verified), env);
  return {
    ok: true,
    type: 'event',
    event: verified,
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
  if (update?.callback_query) {
    return handleHowWeMetCallback(update.callback_query, env);
  }
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
 * Only confirm after a fresh SQLite read — never trust an in-memory upsert result alone.
 * @param {object | null | undefined} contact
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<object>}
 */
async function requirePersistedContact(contact, env) {
  const id = String(contact?.id || '').trim();
  if (!id) {
    const err = new Error('contact_not_persisted');
    err.code = 'contact_not_persisted';
    throw err;
  }
  const fresh = await getContactById(id, env);
  if (!fresh?.id) {
    const err = new Error('contact_not_persisted');
    err.code = 'contact_not_persisted';
    throw err;
  }
  return fresh;
}

/**
 * Only confirm events after a fresh catalog read.
 * @param {object | null | undefined} event
 * @param {NodeJS.ProcessEnv} env
 * @returns {object}
 */
function requirePersistedEvent(event, env) {
  const id = String(event?.id || '').trim();
  if (!id) {
    const err = new Error('event_not_persisted');
    err.code = 'event_not_persisted';
    throw err;
  }
  const fresh = getEventsFinderEventById(id, env);
  if (!fresh?.id) {
    const err = new Error('event_not_persisted');
    err.code = 'event_not_persisted';
    throw err;
  }
  return fresh;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTelegramGetUpdatesConflict(err) {
  const msg = String(/** @type {{ message?: unknown }} */ (err)?.message || err || '');
  return /conflict/i.test(msg) && /getupdates/i.test(msg);
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
    allowed_updates: ['message', 'edited_message', 'callback_query'],
  };
  if (offset != null) params.offset = offset;

  const updates = await tgApi('getUpdates', params, env);
  if (telegramConflictStreak > 0) {
    telegramConflictStreak = 0;
    telegramLastConflictMessage = null;
    console.log('[telegram-events] getUpdates recovered after Conflict streak');
  }
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
      value: !token
        ? 'Off — set TELEGRAM_BOT_TOKEN (+ TELEGRAM_EVENTS_ENABLED=1)'
        : 'Off — TELEGRAM_EVENTS_ENABLED=0 (poller disabled on this host)',
      output: !token
        ? 'Telegram Events intake disabled.'
        : 'Token present but poller disabled here. Cloud should be the sole getUpdates consumer.',
      ingestOk: null,
      ingestTest: !token
        ? 'Not wired — bot token missing'
        : 'Off — poller disabled (expected on LAN)',
      allowedChatIds: allowed,
      openRouter,
      queue: telegramIntakeQueueStats(env),
      conflict: {
        streak: telegramConflictStreak,
        lastAt: telegramLastConflictAt,
        lastMessage: telegramLastConflictMessage,
      },
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
    const conflict = telegramConflictStreak > 0;
    return {
      active: true,
      value: conflict
        ? `Bot ${username} · CONFLICT (another getUpdates poller)`
        : `Bot ${username} · polling`,
      output: conflict
        ? `getUpdates Conflict ×${telegramConflictStreak}. Only one Dashbird instance may poll this bot token (keep cloud on; LAN must set TELEGRAM_EVENTS_ENABLED=0). Last: ${telegramLastConflictAt || 'n/a'}`
        : `Allowlist ${allowed.length} chat(s). Text/voice/photos → event, todo, note, contact, or company. Durable intake queue survives Bot API 24h retention.`,
      ingestOk: !conflict,
      ingestTest: conflict
        ? `Fail — duplicate getUpdates poller (Conflict ×${telegramConflictStreak})`
        : `Pass — ${username} ready (${allowed.length} chat id(s))`,
      bot: me,
      allowedChatIds: allowed,
      openRouter,
      queue: telegramIntakeQueueStats(env),
      conflict: {
        streak: telegramConflictStreak,
        lastAt: telegramLastConflictAt,
        lastMessage: telegramLastConflictMessage,
      },
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
      if (isTelegramGetUpdatesConflict(e)) {
        telegramConflictStreak += 1;
        telegramLastConflictAt = new Date().toISOString();
        telegramLastConflictMessage = String(e?.message || e).slice(0, 240);
        console.warn(
          '[telegram-events] poll failed',
          e?.message || e,
          `(Conflict streak ${telegramConflictStreak} — another instance is polling this bot token)`,
        );
      } else {
        console.warn('[telegram-events] poll failed', e?.message || e);
      }
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
