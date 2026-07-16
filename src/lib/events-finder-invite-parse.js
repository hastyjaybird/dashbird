/**
 * Parse messy human invites (text, voice transcript, flyer screenshot) into
 * Events finder fields via OpenRouter (JSON + optional vision).
 */
import {
  extractPlatformUrls,
  sourceFromPlatformUrls,
} from './events-finder-gmail.js';
import {
  extractHttpUrls,
  isTelegramPlaceholderUrl,
  normalizeEventPageUrl,
} from './events-finder-event-url.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Default card art when the invite has no flyer graphic. */
export const TELEGRAM_EVENT_LOGO_PATH = '/assets/tile-telegram.svg';

const PARSE_SYSTEM = `You extract calendar events from messy human invites (text messages, voice transcripts, or flyer screenshots).
Return JSON only with this shape:
{
  "isEvent": boolean,
  "title": string | null,
  "start": string | null,
  "end": string | null,
  "venue": string | null,
  "city": string | null,
  "url": string | null,
  "invitedBy": string | null,
  "description": string | null,
  "online": boolean,
  "confidence": number
}
Rules:
- isEvent=true only when this is clearly an event/party/meetup/invite (not random chat).
- title: short event name (required when isEvent). Prefer explicit "called X" / "named X".
- start/end: ISO 8601 with timezone offset when possible. Assume America/Los_Angeles if only a local date/time is given. If year is missing/ambiguous, use the soonest FUTURE occurrence (never a past year unless the flyer explicitly shows that year AND the event is still ongoing).
- Today's reference date is provided in the user message — prefer dates on or after that day.
- invitedBy: person who invited / host when mentioned ("invited by Sam", "from Maya").
- url: public event / tickets page if visible. Read browser URL bars, QR captions, "Tickets" links, and ticket-platform domains (Luma, Partiful, Eventbrite, Meetup, Panic Booking, Dice, venue sites). Never use telegram / t.me links. If no public page is visible, set url to null (do not invent telegram).
- confidence: 0-1.
- If not an event, set isEvent=false and null fields.`;

/** Free-tier-safe defaults (paid gpt-4o-mini 402s when OpenRouter credits are empty). */
const DEFAULT_VISION_MODEL = 'google/gemma-4-26b-a4b-it:free';
const DEFAULT_TEXT_MODEL = 'google/gemma-4-31b-it:free';
const VISION_FALLBACK_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl:free',
];
const TEXT_FALLBACK_MODELS = [
  'openai/gpt-oss-20b:free',
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function visionModel(env = process.env) {
  return String(
    env.TELEGRAM_EVENTS_VISION_MODEL
      || env.OPENROUTER_FREE_VISION_MODEL
      || DEFAULT_VISION_MODEL,
  ).trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return String(
    env.TELEGRAM_EVENTS_TEXT_MODEL
      || env.OPENROUTER_FREE_TEXT_MODEL
      || DEFAULT_TEXT_MODEL,
  ).trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function whisperModel(env = process.env) {
  return String(env.TELEGRAM_EVENTS_WHISPER_MODEL || 'openai/whisper-1').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterHeaders(env = process.env) {
  return {
    Authorization: `Bearer ${openRouterKey(env)}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
    'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-events-telegram',
  };
}

/**
 * Chat completion with max_tokens cap + free-model fallback on HTTP 402.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   models: string[],
 *   maxTokens?: number,
 *   messages: unknown[],
 *   temperature?: number,
 * }} args
 * @returns {Promise<{ ok: true, content: string, model: string } | { ok: false, error: string, detail?: string }>}
 */
async function openRouterChatJson(args) {
  const env = args.env || process.env;
  const models = [...new Set((args.models || []).map((m) => String(m || '').trim()).filter(Boolean))];
  if (!models.length) return { ok: false, error: 'no_model' };
  const maxTokens = Math.max(64, Math.min(8192, Number(args.maxTokens) || 2048));
  let lastError = 'openrouter_failed';
  let lastDetail = '';

  for (const model of models) {
    let r;
    try {
      r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: openRouterHeaders(env),
        body: JSON.stringify({
          model,
          temperature: args.temperature ?? 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: args.messages,
        }),
      });
    } catch (e) {
      lastError = String(e?.message || e);
      continue;
    }
    if (!r.ok) {
      lastDetail = await r.text().catch(() => '');
      lastError = `openrouter_http_${r.status}`;
      // Retry next model on credit/payment errors; stop on auth failures.
      if (r.status === 401 || r.status === 403) break;
      if (r.status === 429) {
        // Shared free-model pools: waiting then trying another free model usually 429s again.
        const ra = Number(r.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(Math.max(ra, 2), 30) * 1000 : 2000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        break;
      }
      if (r.status === 402 || r.status >= 500) continue;
      break;
    }
    const j = await r.json().catch(() => ({}));
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      return { ok: true, content, model: String(j?.model || model) };
    }
    lastError = 'empty_completion';
  }

  return { ok: false, error: lastError, detail: lastDetail.slice(0, 400) };
}

/**
 * @param {string} primary
 * @param {string[]} fallbacks
 */
function modelChain(primary, fallbacks) {
  return [...new Set([String(primary || '').trim(), ...fallbacks].filter(Boolean))];
}

/**
 * @param {string} content
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(content) {
  const raw = String(content || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanStr(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function parseIsoRaw(value) {
  const s = cleanStr(value);
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanIso(value) {
  return preferUpcomingIso(parseIsoRaw(value));
}

/**
 * Flyer OCR often emits a past year; bump year until the instant is not long-gone.
 * Keeps events from being upserted then immediately pruned.
 * @param {string | null} iso
 * @param {number} [nowMs]
 * @returns {string | null}
 */
export function preferUpcomingIso(iso, nowMs = Date.now()) {
  if (!iso) return null;
  let ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // Allow ~12h of "already started" slack (matches catalog prune window).
  const horizon = nowMs - 12 * 60 * 60 * 1000;
  let guard = 0;
  while (ms < horizon && guard < 6) {
    const d = new Date(ms);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    ms = d.getTime();
    guard += 1;
  }
  return new Date(ms).toISOString();
}

/**
 * Normalize model JSON into a partial event + meta.
 * @param {Record<string, unknown> | null} parsed
 * @param {{ textHint?: string, defaultImageUrl?: string | null }} [opts]
 */
export function normalizeInviteParse(parsed, opts = {}) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'parse_empty', event: null };
  }
  const isEvent = parsed.isEvent === true || parsed.is_event === true;
  if (!isEvent) {
    return { ok: false, error: 'not_an_event', event: null, confidence: Number(parsed.confidence) || 0 };
  }

  const title = cleanStr(parsed.title);
  if (!title) {
    return { ok: false, error: 'missing_title', event: null };
  }

  const textHint = String(opts.textHint || '');
  const blobForUrls = [textHint, cleanStr(parsed.url) || '', cleanStr(parsed.description) || ''].join('\n');
  const urlsFromText = extractPlatformUrls(blobForUrls);
  const urlsAny = extractHttpUrls(blobForUrls).filter((u) => !isTelegramPlaceholderUrl(u));
  const urlFromModel = normalizeEventPageUrl(cleanStr(parsed.url));
  let url = urlFromModel || urlsFromText[0] || urlsAny[0] || null;
  if (url && isTelegramPlaceholderUrl(url)) url = null;

  const invitedBy = cleanStr(parsed.invitedBy ?? parsed.invited_by);
  const descriptionBits = [];
  const desc = cleanStr(parsed.description);
  if (desc) descriptionBits.push(desc);
  if (invitedBy) descriptionBits.push(`Invited by ${invitedBy}`);

  const platformSource = sourceFromPlatformUrls(
    urlsFromText.length ? urlsFromText : url ? [url] : [],
    'telegram',
  );

  const startOrig = parseIsoRaw(parsed.start);
  const endOrig = parseIsoRaw(parsed.end);
  const startRaw = preferUpcomingIso(startOrig);
  let endRaw = endOrig;
  if (startRaw && endOrig && startOrig && startRaw !== startOrig) {
    endRaw = new Date(Date.parse(endOrig) + (Date.parse(startRaw) - Date.parse(startOrig))).toISOString();
  } else if (endRaw) {
    endRaw = preferUpcomingIso(endRaw);
  }

  /** @type {Record<string, unknown>} */
  const event = {
    title,
    start: startRaw,
    end: endRaw,
    venue: cleanStr(parsed.venue ?? parsed.location),
    city: cleanStr(parsed.city),
    url: url || null,
    source: platformSource === 'gmail' ? 'telegram' : platformSource,
    online: parsed.online === true,
    description: descriptionBits.join(' · ') || null,
    // Never default to the Telegram tile — null lets the UI show a source letter.
    imageUrl: opts.defaultImageUrl || null,
    invitedBy,
  };

  return {
    ok: true,
    error: null,
    confidence: Number(parsed.confidence),
    event,
  };
}

/**
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ defaultImageUrl?: string | null }} [opts]
 */
export async function parseInviteText(text, env = process.env, opts = {}) {
  const key = openRouterKey(env);
  if (!key) {
    return { ok: false, error: 'openrouter_not_configured', event: null };
  }
  const blob = String(text || '').trim();
  if (!blob) {
    return { ok: false, error: 'empty_text', event: null };
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const chat = await openRouterChatJson({
    env,
    models: modelChain(textModel(env), TEXT_FALLBACK_MODELS),
    maxTokens: 2048,
    messages: [
      { role: 'system', content: PARSE_SYSTEM },
      {
        role: 'user',
        content:
          `Timezone hint: America/Los_Angeles.\nToday (America/Los_Angeles): ${today}.\nInvite text:\n${blob.slice(0, 6000)}`,
      },
    ],
  });

  if (!chat.ok) {
    return {
      ok: false,
      error: chat.error,
      detail: chat.detail,
      event: null,
    };
  }

  const parsed = parseJsonObject(chat.content);
  return normalizeInviteParse(parsed, {
    textHint: blob,
    defaultImageUrl: opts.defaultImageUrl ?? null,
  });
}

/** Max flyer screenshots per album vision call (payload size). */
export const INVITE_VISION_MAX_IMAGES = 16;

/**
 * @param {Array<{ mimeType?: string, base64?: string, caption?: string }>} images
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ defaultImageUrl?: string | null }} [opts]
 */
export async function parseInviteImages(images, env = process.env, opts = {}) {
  const key = openRouterKey(env);
  if (!key) {
    return { ok: false, error: 'openrouter_not_configured', event: null };
  }
  const list = (Array.isArray(images) ? images : [])
    .map((img) => ({
      mimeType: String(img?.mimeType || 'image/jpeg').trim() || 'image/jpeg',
      base64: String(img?.base64 || '').trim(),
      caption: String(img?.caption || '').trim(),
    }))
    .filter((img) => img.base64)
    .slice(0, INVITE_VISION_MAX_IMAGES);
  if (!list.length) {
    return { ok: false, error: 'empty_image', event: null };
  }

  const captions = list.map((img) => img.caption).filter(Boolean);
  const captionBlob = [...new Set(captions)].join('\n').slice(0, 2000);
  const multi = list.length > 1;

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  /** @type {Array<{ type: string, text?: string, image_url?: { url: string } }>} */
  const userContent = [
    {
      type: 'text',
      text:
        `Timezone hint: America/Los_Angeles.\nToday (America/Los_Angeles): ${today}.\n`
        + (multi
          ? `These ${list.length} screenshots are parts of the SAME event (flyer, details, map, tickets, etc.). Merge them into one event — do not invent multiple events.`
          : `Extract the event from this flyer/screenshot.`)
        + (captionBlob ? `\nCaption from sender:\n${captionBlob}` : ''),
    },
  ];
  for (const img of list) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }

  const chat = await openRouterChatJson({
    env,
    models: modelChain(visionModel(env), VISION_FALLBACK_MODELS),
    maxTokens: 2048,
    messages: [
      { role: 'system', content: PARSE_SYSTEM },
      { role: 'user', content: userContent },
    ],
  });

  if (!chat.ok) {
    return {
      ok: false,
      error: chat.error,
      detail: chat.detail,
      event: null,
    };
  }

  const parsed = parseJsonObject(chat.content);
  return normalizeInviteParse(parsed, {
    textHint: captionBlob,
    defaultImageUrl: opts.defaultImageUrl ?? null,
  });
}

/**
 * @param {{ mimeType: string, base64: string, caption?: string }} image
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ defaultImageUrl?: string | null }} [opts]
 */
export async function parseInviteImage(image, env = process.env, opts = {}) {
  return parseInviteImages([image], env, opts);
}

/**
 * Transcribe Telegram voice (ogg/opus) via OpenRouter Whisper-compatible API.
 * @param {Buffer} audioBuf
 * @param {{ filename?: string, mimeType?: string }} [meta]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
export async function transcribeInviteAudio(audioBuf, meta = {}, env = process.env) {
  const key = openRouterKey(env);
  if (!key) {
    return { ok: false, error: 'openrouter_not_configured' };
  }
  if (!audioBuf?.length) {
    return { ok: false, error: 'empty_audio' };
  }

  const filename = String(meta.filename || 'voice.ogg');
  const mimeType = String(meta.mimeType || 'audio/ogg');
  const form = new FormData();
  form.append('model', whisperModel(env));
  form.append('file', new Blob([new Uint8Array(audioBuf)], { type: mimeType }), filename);
  form.append('response_format', 'json');

  const r = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
      'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-events-telegram',
    },
    body: form,
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return { ok: false, error: `whisper_http_${r.status}`, detail: detail.slice(0, 400) };
  }

  const j = await r.json().catch(() => ({}));
  const text = cleanStr(j?.text);
  if (!text) {
    return { ok: false, error: 'whisper_empty' };
  }
  return { ok: true, text };
}
