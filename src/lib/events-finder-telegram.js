/**
 * Events finder — Telegram bot intake (text, voice, flyer screenshots).
 * Long-polls getUpdates so LAN Docker does not need a public webhook URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertEventsFinderEvents } from './events-finder-store.js';
import {
  TELEGRAM_EVENT_LOGO_PATH,
  enforceInviteIngestWindow,
  parseInviteImage,
  parseInviteText,
  transcribeInviteAudio,
} from './events-finder-invite-parse.js';

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
  let mimeType = 'application/octet-stream';
  if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
  else if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.webp') mimeType = 'image/webp';
  else if (ext === '.ogg' || ext === '.oga') mimeType = 'audio/ogg';
  else if (ext === '.mp3') mimeType = 'audio/mpeg';
  else if (ext === '.mp4') mimeType = 'video/mp4';
  return { buffer: Buffer.from(ab), filePath, mimeType };
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
 * Build a stable event id from a Telegram message.
 * @param {any} message
 */
function eventIdForMessage(message) {
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  return `telegram:${chatId}:${messageId}`;
}

/**
 * @param {Record<string, unknown>} partial
 * @param {any} message
 * @param {{ parseVia: string, transcript?: string | null, imageUrl?: string | null }} meta
 */
function finalizeEvent(partial, message, meta) {
  const id = eventIdForMessage(message);
  const imageUrl = meta.imageUrl || TELEGRAM_EVENT_LOGO_PATH;
  const from = message?.from || {};
  const invitedBy =
    clean(/** @type {{ invitedBy?: unknown }} */ (partial).invitedBy)
    || null;

  return {
    ...partial,
    id,
    source: 'telegram',
    imageUrl,
    url: clean(/** @type {{ url?: unknown }} */ (partial).url) || 'https://t.me/',
    raw: {
      chatId: message?.chat?.id ?? null,
      messageId: message?.message_id ?? null,
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
 * Process one Telegram message into zero or one catalog events.
 * @param {any} message
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function processTelegramEventMessage(message, env = process.env) {
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  const caption = String(message?.caption || '').trim();

  if (text === '/start' || text.startsWith('/start ')) {
    const allowed = chatAllowed(chatId, env);
    await telegramSendMessage(
      chatId,
      allowed
        ? 'Dashbird Events intake is ready. Send a flyer screenshot, voice note, or text like:\n“Event on July 18 called Rooftop Jazz invited by Sam”'
        : `Your Telegram chat id is ${chatId}.\nAdd it to TELEGRAM_ALLOWED_CHAT_IDS in Dashbird .env, then restart.`,
      env,
    );
    return { ok: true, skipped: true, reason: 'start' };
  }

  if (text === '/help') {
    await telegramSendMessage(
      chatId,
      'Send:\n• Photo of a flyer/invite (optional caption)\n• Voice note describing the event\n• Text: “event on DATE called TITLE invited by NAME”\n\nNo flyer graphic → card uses the Telegram logo.',
      env,
    );
    return { ok: true, skipped: true, reason: 'help' };
  }

  if (!chatAllowed(chatId, env)) {
    await telegramSendMessage(
      chatId,
      `Chat ${chatId} is not allowlisted. Add TELEGRAM_ALLOWED_CHAT_IDS=${chatId} in Dashbird .env.`,
      env,
    );
    return { ok: false, error: 'chat_not_allowed' };
  }

  const photoId = largestPhotoFileId(message);
  const voiceId = message?.voice?.file_id
    ? String(message.voice.file_id)
    : message?.audio?.file_id
      ? String(message.audio.file_id)
      : null;
  const doc = message?.document;
  const docIsImage =
    doc?.mime_type && String(doc.mime_type).startsWith('image/') && doc.file_id
      ? String(doc.file_id)
      : null;

  /** @type {{ ok: boolean, error?: string | null, event?: Record<string, unknown> | null, confidence?: number }} */
  let parsed = { ok: false, error: 'unsupported_message', event: null };
  /** @type {string | null} */
  let imageUrl = TELEGRAM_EVENT_LOGO_PATH;
  /** @type {string | null} */
  let transcript = null;
  let parseVia = 'unknown';

  try {
    if (photoId || docIsImage) {
      parseVia = 'photo';
      const file = await downloadTelegramFile(photoId || docIsImage, env);
      const publicPath = saveMediaPublic(
        file.buffer,
        `${message.chat.id}_${message.message_id}${path.extname(file.filePath) || '.jpg'}`,
        env,
      );
      imageUrl = publicPath;
      parsed = await parseInviteImage(
        {
          mimeType: file.mimeType.startsWith('image/') ? file.mimeType : 'image/jpeg',
          base64: file.buffer.toString('base64'),
          caption: caption || text,
        },
        env,
        { defaultImageUrl: publicPath },
      );
    } else if (voiceId) {
      parseVia = 'voice';
      const file = await downloadTelegramFile(voiceId, env);
      const tr = await transcribeInviteAudio(
        file.buffer,
        { filename: path.basename(file.filePath) || 'voice.ogg', mimeType: file.mimeType },
        env,
      );
      if (!tr.ok) {
        await telegramSendMessage(
          chatId,
          `Could not transcribe voice (${tr.error || 'unknown'}). Try text or a screenshot.`,
          env,
        );
        return { ok: false, error: tr.error || 'transcribe_failed' };
      }
      transcript = tr.text || null;
      parsed = await parseInviteText(transcript, env, { defaultImageUrl: TELEGRAM_EVENT_LOGO_PATH });
      imageUrl = TELEGRAM_EVENT_LOGO_PATH;
    } else if (text || caption) {
      parseVia = 'text';
      parsed = await parseInviteText(text || caption, env, { defaultImageUrl: TELEGRAM_EVENT_LOGO_PATH });
      imageUrl = TELEGRAM_EVENT_LOGO_PATH;
    } else {
      await telegramSendMessage(
        chatId,
        'Send a flyer photo, voice note, or text invite. /help for examples.',
        env,
      );
      return { ok: false, error: 'unsupported_message' };
    }
  } catch (e) {
    await telegramSendMessage(chatId, `Ingest error: ${String(e?.message || e).slice(0, 200)}`, env);
    return { ok: false, error: String(e?.message || e) };
  }

  parsed = enforceInviteIngestWindow(parsed, env);

  if (!parsed.ok || !parsed.event) {
    const why = parsed.error || 'parse_failed';
    const hints = {
      not_an_event: 'That did not look like an event invite.',
      missing_title: 'Could not find an event name.',
      missing_start: 'Could not find a date/time.',
      outside_ingest_window: 'Date is outside the ingest window (past few days → ~30 days ahead).',
      openrouter_not_configured: 'OPENROUTER_API_KEY is not set on the server.',
    };
    await telegramSendMessage(
      chatId,
      `Not ingested: ${hints[why] || why}${transcript ? `\nHeard: “${transcript.slice(0, 200)}”` : ''}`,
      env,
    );
    return { ok: false, error: why, transcript };
  }

  const event = finalizeEvent(parsed.event, message, { parseVia, transcript, imageUrl });
  // Keep invitedBy on the top-level for replies / payload.
  if (parsed.event.invitedBy) event.invitedBy = parsed.event.invitedBy;

  const upsert = upsertEventsFinderEvents([event], env);
  await telegramSendMessage(chatId, formatIngestReply(event), env);

  return {
    ok: true,
    event,
    upserted: upsert?.upserted ?? 1,
    parseVia,
    transcript,
  };
}

/**
 * @param {any} update
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function handleTelegramUpdate(update, env = process.env) {
  const message = update?.message || update?.edited_message;
  if (!message) return { ok: true, skipped: true, reason: 'no_message' };
  return processTelegramEventMessage(message, env);
}

/**
 * One long-poll cycle.
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
  let handled = 0;
  for (const update of list) {
    const updateId = Number(update?.update_id);
    if (Number.isFinite(updateId)) {
      saveOffset(updateId + 1, env);
    }
    try {
      await handleTelegramUpdate(update, env);
      handled += 1;
    } catch (e) {
      console.warn('[telegram-events] update failed', e?.message || e);
    }
  }
  return { ok: true, count: list.length, handled };
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
      };
    }
    return {
      active: true,
      value: `Bot ${username} · polling`,
      output: `Allowlist ${allowed.length} chat(s). Text, voice, and flyer screenshots → Events catalog.`,
      ingestOk: true,
      ingestTest: `Pass — ${username} ready (${allowed.length} chat id(s))`,
      bot: me,
      allowedChatIds: allowed,
      openRouter,
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

  console.log('[telegram-events] poller starting (long-poll getUpdates)');

  const tick = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    pollAbort = new AbortController();
    try {
      await pollTelegramEventsOnce(env);
    } catch (e) {
      console.warn('[telegram-events] poll failed', e?.message || e);
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
  try {
    pollAbort?.abort();
  } catch {
    /* ignore */
  }
  pollAbort = null;
  pollInFlight = false;
}
