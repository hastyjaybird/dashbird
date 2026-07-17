/**
 * Generate short "why this matters in the world" blurbs for Local News cards (OpenRouter).
 */
import { loadLocalNewsRelevance, upsertLocalNewsRelevance } from './local-news-relevance-store.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const BATCH_SIZE = 6;
const MAX_PER_TICK = 12;
const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'openai/gpt-4o-mini',
];

const SYSTEM = `You summarize news articles for a personal feed.
Return JSON only: { "items": [ { "id": string, "relevance": string, "importance": number } ] }
For each article write a brief summary in at most 4 complete sentences.
Put the punchline — the main takeaway or conclusion — in the first 1-2 sentences, then add supporting context.
importance: integer 1-10 for human-experience weight (10=war/planet-scale survival, 7-9=major policy/health crises, 4-6=culture/sports, 1-3=niche entertainment).
Plain language, no markdown, no hype. Max 600 characters per relevance field.
Only return ids from the input list.`;

/** @type {Set<string>} */
const inFlightIds = new Set();
let tickInFlight = false;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function localNewsRelevanceEnabled(env = process.env) {
  return String(env.LOCAL_NEWS_RELEVANCE ?? '1').trim() !== '0'
    && Boolean(String(env.OPENROUTER_API_KEY || '').trim());
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function textModel(env = process.env) {
  return String(
    env.LOCAL_NEWS_RELEVANCE_MODEL
      || env.OPENROUTER_FREE_TEXT_MODEL
      || env.OPENROUTER_MODEL
      || 'openai/gpt-4o-mini',
  ).trim();
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
 * @param {object} article
 */
function compactArticle(article) {
  return {
    id: String(article?.id || '').trim(),
    title: String(article?.title || '').trim().slice(0, 200),
    summary: String(article?.summary || '').trim().slice(0, 350),
    source: String(article?.feedTitle || '').trim().slice(0, 80),
    category: String(article?.category || '').trim().slice(0, 40),
  };
}

/**
 * @param {Array<object>} articles
 * @param {NodeJS.ProcessEnv} [env]
 */
async function generateRelevanceBatch(articles, env = process.env) {
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'openrouter_not_configured' };

  const payload = articles.map(compactArticle).filter((a) => a.id && a.title);
  if (!payload.length) return { ok: true, rows: {} };

  const models = [textModel(env), ...TEXT_FALLBACK_MODELS.filter((m) => m !== textModel(env))];
  let lastError = 'openrouter_failed';

  for (const model of models) {
    let r;
    try {
      r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
          'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-local-news',
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 1400,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: JSON.stringify({ articles: payload }) },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      lastError = String(e?.message || e || 'openrouter_unreachable');
      continue;
    }
    if (!r.ok) {
      lastError = `openrouter_http_${r.status}`;
      if (r.status === 401 || r.status === 403) break;
      continue;
    }
    const j = await r.json().catch(() => ({}));
    const parsed = extractJsonObject(j?.choices?.[0]?.message?.content);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    /** @type {Record<string, { relevance: string, importance?: number }>} */
    const rows = {};
    const want = new Set(payload.map((a) => a.id));
    for (const item of items) {
      const id = String(item?.id || '').trim();
      const relevance = String(item?.relevance || '').trim().slice(0, 700);
      const importanceRaw = Number(item?.importance);
      const importance = Number.isFinite(importanceRaw)
        ? Math.min(10, Math.max(1, Math.round(importanceRaw)))
        : 0;
      if (!id || !relevance || !want.has(id)) continue;
      rows[id] = { relevance, ...(importance ? { importance } : {}) };
    }
    if (Object.keys(rows).length) return { ok: true, rows };
    lastError = 'parse_failed';
  }
  return { ok: false, error: lastError };
}

/**
 * Attach cached relevance blurbs to article objects (mutates copies).
 * @param {Array<object>} articles
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function attachRelevanceToArticles(articles, env = process.env) {
  const cache = await loadLocalNewsRelevance(env);
  const enabled = localNewsRelevanceEnabled(env);
  return articles.map((a) => {
    const id = String(a?.id || '').trim();
    const cached = id ? cache.byId[id] : null;
    const importanceRaw = Number(cached?.importance);
    const importance = Number.isFinite(importanceRaw) && importanceRaw > 0
      ? importanceRaw
      : null;
    const needsScore = enabled && (!cached?.relevance || importance == null);
    return {
      ...a,
      relevance: cached?.relevance || null,
      importance,
      relevancePending: needsScore,
    };
  });
}

/**
 * Fill missing summaries synchronously (e.g. suggestion preview modal).
 * @param {Array<object>} articles
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function ensureRelevanceForArticles(articles, env = process.env) {
  let withCached = await attachRelevanceToArticles(articles, env);
  if (!localNewsRelevanceEnabled(env)) return withCached;

  const missing = withCached.filter((a) => a.relevancePending);
  if (!missing.length) return withCached;

  const r = await generateRelevanceBatch(missing, env);
  if (r.ok && r.rows && Object.keys(r.rows).length) {
    await upsertLocalNewsRelevance(r.rows, env);
    withCached = await attachRelevanceToArticles(withCached, env);
  }
  return withCached;
}

/**
 * Background-fill missing blurbs for the current feed (non-blocking).
 * @param {Array<object>} articles
 * @param {NodeJS.ProcessEnv} [env]
 */
export function queueRelevanceGeneration(articles, env = process.env) {
  if (!localNewsRelevanceEnabled(env) || tickInFlight) return;
  void (async () => {
    tickInFlight = true;
    try {
      const cache = await loadLocalNewsRelevance(env);
      const missing = (Array.isArray(articles) ? articles : [])
        .filter((a) => {
          const id = String(a?.id || '').trim();
          if (!id || inFlightIds.has(id)) return false;
          const cached = cache.byId[id];
          const importanceRaw = Number(cached?.importance);
          const hasImportance = Number.isFinite(importanceRaw) && importanceRaw > 0;
          return !cached?.relevance || !hasImportance;
        })
        .slice(0, MAX_PER_TICK);

      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        for (const a of batch) inFlightIds.add(String(a.id));
        try {
          const r = await generateRelevanceBatch(batch, env);
          if (r.ok && r.rows && Object.keys(r.rows).length) {
            await upsertLocalNewsRelevance(r.rows, env);
          }
        } finally {
          for (const a of batch) inFlightIds.delete(String(a.id));
        }
      }
    } catch (e) {
      console.warn('[local-news] relevance generation failed:', e?.message || e);
    } finally {
      tickInFlight = false;
    }
  })();
}
