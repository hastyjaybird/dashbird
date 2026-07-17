/**
 * Shared OpenRouter chat/completions helper (JSON mode).
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_TEXT_MODEL = 'openai/gpt-oss-20b:free';
const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-4o-mini',
];

/** @type {number} */
let rateLimitUntilMs = 0;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} keys
 */
function envFirst(env, keys) {
  for (const key of keys) {
    const v = String(env[key] || '').trim();
    if (v) return v;
  }
  return '';
}

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
  return (
    envFirst(env, [
      'GMAIL_DAILY_SUMMARY_MODEL',
      'GMAIL_WEEKLY_SUMMARY_MODEL',
      'OPENROUTER_FREE_TEXT_MODEL',
    ]) || DEFAULT_TEXT_MODEL
  );
}

/**
 * @param {string} primary
 * @param {string[]} fallbacks
 */
function modelChain(primary, fallbacks) {
  return [...new Set([primary, ...fallbacks].map((m) => String(m || '').trim()).filter(Boolean))];
}

/**
 * @param {unknown} content
 */
function extractJsonObject(content) {
  const raw = String(content || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{ ignoreRateLimit?: boolean, timeoutMs?: number }} [opts]
 */
export async function openRouterChatJson(env, messages, opts = {}) {
  if (!openRouterKey(env)) {
    return { ok: false, error: 'openrouter_not_configured' };
  }
  if (!opts.ignoreRateLimit && Date.now() < rateLimitUntilMs) {
    return { ok: false, error: 'openrouter_http_429' };
  }
  const models = modelChain(textModel(env), TEXT_FALLBACK_MODELS);
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 90_000, 10_000), 120_000);
  let lastError = 'openrouter_failed';
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    let r;
    try {
      r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openRouterKey(env)}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
          'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-daily-summary',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 2500,
          response_format: { type: 'json_object' },
          messages,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastError = String(e?.message || e || 'openrouter_unreachable');
      continue;
    }
    if (!r.ok) {
      lastError = `openrouter_http_${r.status}`;
      if (r.status === 401 || r.status === 403) break;
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after'));
        const waitSec = Number.isFinite(ra) && ra > 0 ? Math.min(Math.max(ra, 2), 45) : 5;
        if (i < models.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
          continue;
        }
        rateLimitUntilMs = Date.now() + Math.max(waitSec, 60) * 1000;
        break;
      }
      if (r.status === 402 || r.status >= 500) continue;
      break;
    }
    const j = await r.json().catch(() => ({}));
    const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
    if (!parsed || typeof parsed !== 'object') {
      lastError = 'parse_failed';
      continue;
    }
    rateLimitUntilMs = 0;
    return { ok: true, parsed, model };
  }
  return { ok: false, error: lastError };
}

/** @returns {number} */
export function openRouterRateLimitUntilMs() {
  return rateLimitUntilMs;
}

/**
 * @param {number} untilMs
 */
export function bumpOpenRouterRateLimit(untilMs) {
  if (Number.isFinite(untilMs) && untilMs > rateLimitUntilMs) {
    rateLimitUntilMs = untilMs;
  }
}
