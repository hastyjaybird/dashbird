/**
 * Parse messy human invites (text, voice transcript, flyer screenshot) into
 * Events finder fields via OpenRouter (JSON + optional vision).
 */
import {
  extractPlatformUrls,
  sourceFromPlatformUrls,
} from './events-finder-gmail.js';
import { eventsIngestWindowDays, eventStartInIngestWindow } from './events-finder-window.js';

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
- start/end: ISO 8601 with timezone offset when possible. Assume America/Los_Angeles if only a local date/time is given and year is missing use the soonest future occurrence (or current year if still upcoming).
- invitedBy: person who invited / host when mentioned ("invited by Sam", "from Maya").
- url: event link if present; otherwise null.
- confidence: 0-1.
- If not an event, set isEvent=false and null fields.`;

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
      || env.OPENROUTER_MODEL
      || 'openai/gpt-4o-mini',
  ).trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return String(env.TELEGRAM_EVENTS_TEXT_MODEL || env.OPENROUTER_MODEL || 'openai/gpt-4o-mini').trim();
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
function cleanIso(value) {
  const s = cleanStr(value);
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
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
  const urlsFromText = extractPlatformUrls(
    [textHint, cleanStr(parsed.url) || '', cleanStr(parsed.description) || ''].join('\n'),
  );
  const urlFromModel = cleanStr(parsed.url);
  let url = urlsFromText[0] || null;
  if (urlFromModel) {
    try {
      url = new URL(urlFromModel).href.split('#')[0];
    } catch {
      /* keep text urls */
    }
  }
  if (!url && urlsFromText[0]) url = urlsFromText[0];

  const invitedBy = cleanStr(parsed.invitedBy ?? parsed.invited_by);
  const descriptionBits = [];
  const desc = cleanStr(parsed.description);
  if (desc) descriptionBits.push(desc);
  if (invitedBy) descriptionBits.push(`Invited by ${invitedBy}`);

  const platformSource = sourceFromPlatformUrls(urlsFromText.length ? urlsFromText : url ? [url] : [], 'telegram');

  /** @type {Record<string, unknown>} */
  const event = {
    title,
    start: cleanIso(parsed.start),
    end: cleanIso(parsed.end),
    venue: cleanStr(parsed.venue ?? parsed.location),
    city: cleanStr(parsed.city),
    url: url || 'https://t.me/',
    source: platformSource === 'gmail' ? 'telegram' : platformSource,
    online: parsed.online === true,
    description: descriptionBits.join(' · ') || null,
    imageUrl: opts.defaultImageUrl || TELEGRAM_EVENT_LOGO_PATH,
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

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(env),
    body: JSON.stringify({
      model: textModel(env),
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PARSE_SYSTEM },
        {
          role: 'user',
          content:
            `Timezone hint: America/Los_Angeles.\nInvite text:\n${blob.slice(0, 6000)}`,
        },
      ],
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return {
      ok: false,
      error: `openrouter_http_${r.status}`,
      detail: detail.slice(0, 400),
      event: null,
    };
  }

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(typeof content === 'string' ? content : '');
  return normalizeInviteParse(parsed, {
    textHint: blob,
    defaultImageUrl: opts.defaultImageUrl ?? TELEGRAM_EVENT_LOGO_PATH,
  });
}

/**
 * @param {{ mimeType: string, base64: string, caption?: string }} image
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ defaultImageUrl?: string | null }} [opts]
 */
export async function parseInviteImage(image, env = process.env, opts = {}) {
  const key = openRouterKey(env);
  if (!key) {
    return { ok: false, error: 'openrouter_not_configured', event: null };
  }
  const mime = String(image?.mimeType || 'image/jpeg').trim() || 'image/jpeg';
  const b64 = String(image?.base64 || '').trim();
  if (!b64) {
    return { ok: false, error: 'empty_image', event: null };
  }
  const caption = String(image?.caption || '').trim();
  const dataUrl = `data:${mime};base64,${b64}`;

  /** @type {Array<{ type: string, text?: string, image_url?: { url: string } }>} */
  const userContent = [
    {
      type: 'text',
      text:
        `Timezone hint: America/Los_Angeles.\nExtract the event from this flyer/screenshot.`
        + (caption ? `\nCaption from sender:\n${caption.slice(0, 2000)}` : ''),
    },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];

  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(env),
    body: JSON.stringify({
      model: visionModel(env),
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PARSE_SYSTEM },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return {
      ok: false,
      error: `openrouter_http_${r.status}`,
      detail: detail.slice(0, 400),
      event: null,
    };
  }

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(typeof content === 'string' ? content : '');
  return normalizeInviteParse(parsed, {
    textHint: caption,
    defaultImageUrl: opts.defaultImageUrl ?? TELEGRAM_EVENT_LOGO_PATH,
  });
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

/**
 * Drop parses whose start is outside the Events ingest window.
 * @param {{ ok: boolean, event?: Record<string, unknown> | null, error?: string | null }} result
 * @param {NodeJS.ProcessEnv} [env]
 */
export function enforceInviteIngestWindow(result, env = process.env) {
  if (!result?.ok || !result.event) return result;
  const { pastDays, futureDays } = eventsIngestWindowDays(env);
  const start = /** @type {{ start?: string | null }} */ (result.event).start;
  if (!eventStartInIngestWindow(start, { pastDays, futureDays, allowMissingStart: false })) {
    return {
      ok: false,
      error: start ? 'outside_ingest_window' : 'missing_start',
      event: result.event,
      confidence: result.confidence,
    };
  }
  return result;
}
