/**
 * Classify Dashbird Telegram intake messages: event | todo | note | contact.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const DEFAULT_TEXT_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const TEXT_FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
];

const CLASSIFY_SYSTEM = `You classify a short message sent to a personal dashboard Telegram bot.
Return JSON only:
{
  "type": "event" | "todo" | "note" | "contact",
  "confidence": number,
  "reason": string,
  "todoText": string | null,
  "noteText": string | null,
  "contact": {
    "displayName": string | null,
    "aliases": string[],
    "kind": "friend" | "business" | null,
    "notes": string | null,
    "org": string | null,
    "title": string | null,
    "email": string | null,
    "phone": string | null,
    "telegram": string | null,
    "linkedin": string | null
  } | null
}
Rules:
- event: party/meetup/show/invite with a time or clear event framing.
- todo: actionable task the user wants on a to-do list ("remind me to…", "todo:…", "buy…", "call…").
- contact: introducing or saving a person ("met Sam…", "new contact…", "add friend…", name + phone/email/linkedin).
- note: everything else worth keeping as freeform text (ideas, observations) that is not event/todo/contact.
- confidence: 0-1. If under 0.55, still pick best type but be honest about confidence.
- For contact, displayName is required when type=contact.
- For todo, todoText should be a short task title.
- For note, noteText is the cleaned note body.`;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return String(
    env.TELEGRAM_CLASSIFIER_MODEL
      || env.TELEGRAM_EVENTS_TEXT_MODEL
      || env.OPENROUTER_FREE_TEXT_MODEL
      || DEFAULT_TEXT_MODEL,
  ).trim();
}

/**
 * @param {string} primary
 * @param {string[]} fallbacks
 */
function modelChain(primary, fallbacks) {
  return [...new Set([String(primary || '').trim(), ...fallbacks].filter(Boolean))];
}

/**
 * @param {string} text
 */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Explicit command override: /event /todo /note /contact …
 * @param {string} text
 * @returns {{ type: string, rest: string } | null}
 */
export function parseTelegramTypeOverride(text) {
  const s = String(text || '').trim();
  const m = s.match(/^\/(event|todo|note|contact)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), rest: String(m[2] || '').trim() };
}

/**
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: boolean, type?: string, confidence?: number, reason?: string, todoText?: string | null, noteText?: string | null, contact?: object | null, error?: string }>}
 */
export async function classifyTelegramMessage(text, env = process.env) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'empty' };

  const override = parseTelegramTypeOverride(body);
  if (override) {
    const rest = override.rest || body;
    if (override.type === 'todo') {
      return { ok: true, type: 'todo', confidence: 1, reason: 'command_override', todoText: rest, noteText: null, contact: null };
    }
    if (override.type === 'note') {
      return { ok: true, type: 'note', confidence: 1, reason: 'command_override', todoText: null, noteText: rest, contact: null };
    }
    if (override.type === 'contact') {
      return {
        ok: true,
        type: 'contact',
        confidence: 1,
        reason: 'command_override',
        todoText: null,
        noteText: null,
        contact: { displayName: rest.split(/[,\n]/)[0]?.trim() || rest, notes: rest, aliases: [], kind: 'friend' },
      };
    }
    return { ok: true, type: 'event', confidence: 1, reason: 'command_override', todoText: null, noteText: null, contact: null };
  }

  if (!openRouterKey(env)) {
    // Without OpenRouter, default to event path (legacy behavior).
    return { ok: true, type: 'event', confidence: 0.4, reason: 'openrouter_missing_default_event', todoText: null, noteText: null, contact: null };
  }

  const models = modelChain(textModel(env), TEXT_FALLBACK_MODELS);
  let lastError = 'openrouter_failed';
  for (const model of models) {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey(env)}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
        'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-telegram-classifier',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        // Free-tier OpenRouter rejects uncapped completion budgets (defaults to 16k → HTTP 402).
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: body.slice(0, 4000) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!r.ok) {
      lastError = `openrouter_http_${r.status}`;
      if (r.status === 401 || r.status === 403) break;
      if (r.status === 402 || r.status === 429 || r.status >= 500) continue;
      break;
    }
    const j = await r.json();
    const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
    if (!parsed || typeof parsed !== 'object') {
      lastError = 'parse_failed';
      continue;
    }

    const type = String(parsed.type || '').toLowerCase();
    if (!['event', 'todo', 'note', 'contact'].includes(type)) {
      lastError = 'bad_type';
      continue;
    }

    return {
      ok: true,
      type,
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason || '').slice(0, 400) || null,
      todoText: parsed.todoText != null ? String(parsed.todoText).trim() : null,
      noteText: parsed.noteText != null ? String(parsed.noteText).trim() : body,
      contact: parsed.contact && typeof parsed.contact === 'object' ? parsed.contact : null,
    };
  }

  return { ok: false, error: lastError };
}
