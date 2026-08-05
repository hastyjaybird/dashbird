/**
 * Local News thumbs feedback → markdown log + LLM concepts (not keyword lists).
 * Keyword white/grey/black lists stay in local-news-criteria.json only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouterChatJson } from './openrouter-chat-json.js';
import { foldTasteText } from './local-news-taste.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_SNOOZED = 100;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function localNewsPreferencesMdPath(env = process.env) {
  const override = String(env.LOCAL_NEWS_PREFERENCES_MD_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/local-news-preferences.md');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function localNewsPreferencesMetaPath(env = process.env) {
  const override = String(env.LOCAL_NEWS_PREFERENCES_META_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/local-news-preferences-meta.json');
}

/**
 * @typedef {{
 *   id: string,
 *   vibe: 'up' | 'down',
 *   title: string,
 *   summary: string,
 *   concepts: string[],
 *   toneFlags: string[],
 *   createdAt: string,
 * }} PreferenceEntry
 *
 * @typedef {{
 *   articleId: string,
 *   title: string,
 *   summary: string,
 *   concepts: string[],
 *   until: string,
 *   createdAt: string,
 * }} SnoozeEntry
 *
 * @typedef {{
 *   entries: PreferenceEntry[],
 *   commonalities: { more: string[], less: string[], updatedAt: string | null },
 *   snoozed: SnoozeEntry[],
 * }} PreferencesMeta
 */

/** @returns {PreferencesMeta} */
function emptyMeta() {
  return {
    entries: [],
    commonalities: { more: [], less: [], updatedAt: null },
    snoozed: [],
  };
}

/**
 * @param {unknown} raw
 * @returns {PreferencesMeta}
 */
function normalizeMeta(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const entries = Array.isArray(o.entries)
    ? o.entries
      .filter((e) => e && typeof e === 'object')
      .map((e) => {
        const row = /** @type {Record<string, unknown>} */ (e);
        const vibe = row.vibe === 'down' ? 'down' : 'up';
        return {
          id: String(row.id || '').trim().slice(0, 300),
          vibe: /** @type {'up' | 'down'} */ (vibe),
          title: String(row.title || '').trim().slice(0, 400),
          summary: String(row.summary || '').trim().slice(0, 800),
          concepts: (Array.isArray(row.concepts) ? row.concepts : [])
            .map((c) => String(c || '').trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 8),
          toneFlags: (Array.isArray(row.toneFlags) ? row.toneFlags : [])
            .map((c) => String(c || '').trim().slice(0, 60))
            .filter(Boolean)
            .slice(0, 6),
          createdAt: String(row.createdAt || '').trim() || new Date().toISOString(),
        };
      })
      .filter((e) => e.id && e.title)
      .slice(-MAX_ENTRIES)
    : [];
  const com = o.commonalities && typeof o.commonalities === 'object'
    ? /** @type {Record<string, unknown>} */ (o.commonalities)
    : {};
  const now = Date.now();
  const snoozed = Array.isArray(o.snoozed)
    ? o.snoozed
      .filter((e) => e && typeof e === 'object')
      .map((e) => {
        const row = /** @type {Record<string, unknown>} */ (e);
        return {
          articleId: String(row.articleId || '').trim().slice(0, 300),
          title: String(row.title || '').trim().slice(0, 400),
          summary: String(row.summary || '').trim().slice(0, 800),
          concepts: (Array.isArray(row.concepts) ? row.concepts : [])
            .map((c) => String(c || '').trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 8),
          until: String(row.until || '').trim(),
          createdAt: String(row.createdAt || '').trim() || new Date().toISOString(),
        };
      })
      .filter((e) => e.articleId && e.until && new Date(e.until).getTime() > now)
      .slice(-MAX_SNOOZED)
    : [];
  return {
    entries,
    commonalities: {
      more: (Array.isArray(com.more) ? com.more : [])
        .map((c) => String(c || '').trim().slice(0, 160))
        .filter(Boolean)
        .slice(0, 24),
      less: (Array.isArray(com.less) ? com.less : [])
        .map((c) => String(c || '').trim().slice(0, 160))
        .filter(Boolean)
        .slice(0, 24),
      updatedAt: com.updatedAt ? String(com.updatedAt) : null,
    },
    snoozed,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<PreferencesMeta>}
 */
export async function loadPreferencesMeta(env = process.env) {
  try {
    const raw = await fs.readFile(localNewsPreferencesMetaPath(env), 'utf8');
    return normalizeMeta(JSON.parse(raw));
  } catch {
    return emptyMeta();
  }
}

/**
 * @param {PreferencesMeta} meta
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writePreferencesMeta(meta, env = process.env) {
  const target = localNewsPreferencesMetaPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(normalizeMeta(meta), null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

/**
 * @param {PreferenceEntry[]} entries
 * @param {{ more: string[], less: string[] }} commonalities
 */
function renderPreferencesMarkdown(entries, commonalities) {
  const more = entries.filter((e) => e.vibe === 'up').slice(-40).reverse();
  const less = entries.filter((e) => e.vibe === 'down').slice(-40).reverse();
  const fmt = (e) => {
    const concepts = e.concepts.length ? `\n  Concepts: ${e.concepts.join('; ')}` : '';
    const tones = e.toneFlags.length ? `\n  Tone: ${e.toneFlags.join('; ')}` : '';
    const summary = e.summary ? `\n  ${e.summary}` : '';
    return `- **${e.createdAt.slice(0, 10)}** ${e.title}${summary}${concepts}${tones}`;
  };
  const moreConcepts = (commonalities.more || []).map((c) => `- ${c}`).join('\n') || '- (none yet)';
  const lessConcepts = (commonalities.less || []).map((c) => `- ${c}`).join('\n') || '- (none yet)';
  return `# Local News preferences

Learned from thumbs up / thumbs down. Concepts describe *why* Jay liked or disliked
an article (topic framing, tone, style) — not keyword white/grey/black lists.

## Concepts — more like this
${moreConcepts}

## Concepts — less like this
${lessConcepts}

## More like this
${more.length ? more.map(fmt).join('\n') : '- (none yet)'}

## Less like this
${less.length ? less.map(fmt).join('\n') : '- (none yet)'}
`;
}

/**
 * @param {PreferencesMeta} meta
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writePreferencesMarkdown(meta, env = process.env) {
  const target = localNewsPreferencesMdPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(
    staging,
    renderPreferencesMarkdown(meta.entries, meta.commonalities),
    'utf8',
  );
  await fs.rename(staging, target);
}

/**
 * Visible summary line on the card (relevance blurb preferred over RSS summary).
 * @param {object} article
 */
export function articleVisibleSummary(article) {
  return String(article?.relevance || article?.summary || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * @param {object} article
 * @param {'up' | 'down' | 'snooze'} vibe
 * @param {NodeJS.ProcessEnv} [env]
 */
async function extractConceptsWithLlm(article, vibe, env = process.env) {
  const title = String(article?.title || '').trim();
  const summary = articleVisibleSummary(article);
  const feedback =
    vibe === 'up'
      ? 'thumbs up — want more articles like this'
      : vibe === 'down'
        ? 'thumbs down — want fewer articles like this'
        : 'snooze — tired of this topic for ~2 weeks, may still like the broader beat later';

  const res = await openRouterChatJson(
    env,
    [
      {
        role: 'system',
        content: `You extract reusable *concepts* from news feedback for Jay's Local News feed.
Return JSON only:
{
  "concepts": string[],
  "toneFlags": string[]
}

Rules:
- concepts: 2-5 short phrases describing the substance / framing / style Jay is reacting to.
- Do NOT invent keyword search terms. Prefer conceptual labels (e.g. "beneficial deployments careers",
  "constructive climate solutions reporting", "doom-laden climate framing").
- Explicitly consider tone: fear mongering, highly politically charged, outrage bait, calm analytical,
  hopeful solutions-oriented, job/career practical — even when the topic itself is fine.
- toneFlags: subset of ["fear_mongering","politically_charged","outrage_bait","calm_analytical",
  "solutions_oriented","career_practical","hype","sensational"].
- Never quote the full headline as a concept; generalize.`,
      },
      {
        role: 'user',
        content: `Feedback: ${feedback}

Title: ${title || '(untitled)'}
Visible summary: ${summary || '(none)'}
Feed: ${String(article?.feedTitle || '').trim() || '(unknown)'}`,
      },
    ],
    {
      xTitle: 'dashbird-local-news-preferences',
      maxTokens: 500,
      timeoutMs: 45_000,
      backoff429: false,
    },
  );

  if (!res.ok || !res.parsed) {
    return heuristicConcepts(article, vibe);
  }
  const concepts = (Array.isArray(res.parsed.concepts) ? res.parsed.concepts : [])
    .map((c) => String(c || '').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 6);
  const toneFlags = (Array.isArray(res.parsed.toneFlags) ? res.parsed.toneFlags : [])
    .map((c) => String(c || '').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 6);
  if (!concepts.length) return heuristicConcepts(article, vibe);
  return { concepts, toneFlags };
}

/**
 * @param {object} article
 * @param {'up' | 'down' | 'snooze'} vibe
 */
function heuristicConcepts(article, vibe) {
  const title = String(article?.title || '').trim();
  const summary = articleVisibleSummary(article);
  const blob = `${title} ${summary}`.toLowerCase();
  /** @type {string[]} */
  const concepts = [];
  /** @type {string[]} */
  const toneFlags = [];
  if (/\b(fear|catastrophe|doom|apocalyp|terrif|alarm)\b/.test(blob)) {
    concepts.push('fear-mongering framing');
    toneFlags.push('fear_mongering');
  }
  if (/\b(democrat|republican|congress|election|partisan)\b/.test(blob)) {
    concepts.push('politically charged framing');
    toneFlags.push('politically_charged');
  }
  if (/\b(job|career|hiring|greenhouse|role)\b/.test(blob)) {
    concepts.push('career / hiring practical');
    toneFlags.push('career_practical');
  }
  if (vibe === 'snooze' && title) {
    concepts.push(`topic pause: ${title.replace(/\s*[-–—|].*$/, '').slice(0, 60)}`);
  }
  if (!concepts.length) {
    concepts.push(
      vibe === 'up'
        ? 'reporting style similar to recent likes'
        : vibe === 'down'
          ? 'reporting style similar to recent dislikes'
          : 'topic fatigue for now',
    );
  }
  return { concepts: concepts.slice(0, 5), toneFlags };
}

/**
 * @param {PreferencesMeta} meta
 * @param {NodeJS.ProcessEnv} [env]
 */
async function refreshCommonalities(meta, env = process.env) {
  const recentUp = meta.entries.filter((e) => e.vibe === 'up').slice(-12);
  const recentDown = meta.entries.filter((e) => e.vibe === 'down').slice(-12);
  if (!recentUp.length && !recentDown.length) return meta;

  const res = await openRouterChatJson(
    env,
    [
      {
        role: 'system',
        content: `Summarize Jay's Local News taste as concept commonalities.
Return JSON only:
{ "more": string[], "less": string[] }

Rules:
- more / less: 3-8 conceptual phrases each (style, framing, topic angle — not keyword lists).
- Call out tone patterns separately when present (fear mongering, political charge, hype).
- Prefer durable patterns over one-off headlines.`,
      },
      {
        role: 'user',
        content: `Recent thumbs UP:\n${recentUp.map((e) => `- ${e.title} | ${e.concepts.join('; ')}`).join('\n') || '(none)'}

Recent thumbs DOWN:\n${recentDown.map((e) => `- ${e.title} | ${e.concepts.join('; ')}`).join('\n') || '(none)'}`,
      },
    ],
    {
      xTitle: 'dashbird-local-news-preferences',
      maxTokens: 600,
      timeoutMs: 45_000,
      backoff429: false,
    },
  );

  if (!res.ok || !res.parsed) {
    const more = [...new Set(recentUp.flatMap((e) => e.concepts))].slice(0, 12);
    const less = [...new Set(recentDown.flatMap((e) => e.concepts))].slice(0, 12);
    meta.commonalities = { more, less, updatedAt: new Date().toISOString() };
    return meta;
  }
  meta.commonalities = {
    more: (Array.isArray(res.parsed.more) ? res.parsed.more : [])
      .map((c) => String(c || '').trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 12),
    less: (Array.isArray(res.parsed.less) ? res.parsed.less : [])
      .map((c) => String(c || '').trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 12),
    updatedAt: new Date().toISOString(),
  };
  return meta;
}

/**
 * @param {object} article
 * @param {'up' | 'down'} vibe
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function recordArticleFeedback(article, vibe, env = process.env) {
  const id = String(article?.id || '').trim();
  const title = String(article?.title || '').trim();
  if (!id || !title) {
    const err = new Error('missing_article');
    err.status = 400;
    throw err;
  }
  const summary = articleVisibleSummary(article);
  const { concepts, toneFlags } = await extractConceptsWithLlm(article, vibe, env);
  const createdAt = new Date().toISOString();
  const entry = { id, vibe, title, summary, concepts, toneFlags, createdAt };

  let meta = await loadPreferencesMeta(env);
  meta.entries = [...meta.entries.filter((e) => !(e.id === id && e.vibe === vibe)), entry].slice(
    -MAX_ENTRIES,
  );
  meta = await refreshCommonalities(meta, env);
  await writePreferencesMeta(meta, env);
  await writePreferencesMarkdown(meta, env);
  return { entry, commonalities: meta.commonalities };
}

/**
 * Snooze this topic / framing for 2 weeks (not a permanent dislike).
 * @param {object} article
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function snoozeArticleTopic(article, env = process.env) {
  const articleId = String(article?.id || '').trim();
  const title = String(article?.title || '').trim();
  if (!articleId || !title) {
    const err = new Error('missing_article');
    err.status = 400;
    throw err;
  }
  const summary = articleVisibleSummary(article);
  const { concepts } = await extractConceptsWithLlm(article, 'snooze', env);
  const createdAt = new Date().toISOString();
  const until = new Date(Date.now() + SNOOZE_MS).toISOString();
  const row = { articleId, title, summary, concepts, until, createdAt };

  const meta = await loadPreferencesMeta(env);
  meta.snoozed = [
    ...meta.snoozed.filter((s) => s.articleId !== articleId),
    row,
  ].slice(-MAX_SNOOZED);
  await writePreferencesMeta(meta, env);
  return { snooze: row };
}

/**
 * @param {object} article
 * @param {PreferencesMeta} meta
 */
export function isArticleSnoozed(article, meta) {
  const now = Date.now();
  const id = String(article?.id || '').trim();
  const hay = foldTasteText(
    [article?.title, articleVisibleSummary(article), article?.feedTitle].join(' \n '),
  );
  for (const s of meta.snoozed || []) {
    if (new Date(s.until).getTime() <= now) continue;
    if (s.articleId && s.articleId === id) return true;
    for (const c of s.concepts || []) {
      const folded = foldTasteText(c);
      if (folded.length >= 6 && hay.includes(folded)) return true;
      const tokens = folded.split(/\s+/).filter((t) => t.length >= 4);
      if (tokens.length >= 2 && tokens.every((t) => hay.includes(t))) return true;
    }
  }
  return false;
}

/**
 * Score how well an article matches learned more/less concepts.
 * Higher = more like recent likes; negative = like recent dislikes / bad tone.
 * @param {object} article
 * @param {PreferencesMeta} meta
 */
export function scoreArticleByPreferences(article, meta) {
  const hay = foldTasteText(
    [article?.title, articleVisibleSummary(article), article?.feedTitle].join(' \n '),
  );
  if (!hay) return 0;

  /**
   * @param {string} concept
   */
  function conceptHit(concept) {
    const folded = foldTasteText(concept);
    if (!folded || folded.length < 4) return 0;
    if (hay.includes(folded)) return 1;
    const tokens = folded.split(/\s+/).filter((t) => t.length >= 4);
    if (tokens.length >= 2) {
      const hits = tokens.filter((t) => hay.includes(t)).length;
      return hits / tokens.length;
    }
    return 0;
  }

  let score = 0;
  for (const c of meta.commonalities?.more || []) score += conceptHit(c) * 3;
  for (const c of meta.commonalities?.less || []) score -= conceptHit(c) * 4;

  // Recent individual entries weigh more than older commonalities.
  const recent = (meta.entries || []).slice(-16);
  for (const e of recent) {
    const weight = e.vibe === 'up' ? 2 : -2.5;
    for (const c of e.concepts || []) score += conceptHit(c) * weight;
    for (const flag of e.toneFlags || []) {
      if (e.vibe !== 'down') continue;
      if (flag === 'fear_mongering' || flag === 'politically_charged' || flag === 'outrage_bait') {
        if (conceptHit(flag.replace(/_/g, ' ')) > 0 || conceptHit(flag) > 0) score -= 2;
        // Soft tone proxies in haystack
        if (flag === 'fear_mongering' && /\b(fear|doom|catastroph|terrif|alarm)\b/.test(hay)) {
          score -= 2;
        }
        if (flag === 'politically_charged' && /\b(democrat|republican|partisan|congress)\b/.test(hay)) {
          score -= 1.5;
        }
      }
    }
  }

  return Math.round(score * 10) / 10;
}

/**
 * Re-rank articles using recent thumbs + commonalities (after keyword taste filter).
 * @param {Array<object>} articles
 * @param {PreferencesMeta} meta
 * @param {(a: object, b: object) => number} [tieBreak]
 */
export function sortArticlesByPreferences(articles, meta, tieBreak) {
  return [...articles].sort((a, b) => {
    const sa = Number(a?.preferenceScore);
    const sb = Number(b?.preferenceScore);
    const aHas = Number.isFinite(sa);
    const bHas = Number.isFinite(sb);
    if (aHas && bHas && sb !== sa) return sb - sa;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    const ia = Number(a?.importance) || 0;
    const ib = Number(b?.importance) || 0;
    if (ib !== ia) return ib - ia;
    const ta = Number(a?.tasteScore) || 0;
    const tb = Number(b?.tasteScore) || 0;
    if (tb !== ta) return tb - ta;
    return typeof tieBreak === 'function' ? tieBreak(a, b) : 0;
  });
}

/**
 * Apply preference scores + drop snoozed articles.
 * @param {Array<object>} articles
 * @param {PreferencesMeta} meta
 */
export function applyPreferenceRanking(articles, meta) {
  const scored = [];
  for (const a of articles) {
    if (isArticleSnoozed(a, meta)) continue;
    scored.push({
      ...a,
      preferenceScore: scoreArticleByPreferences(a, meta),
    });
  }
  return scored;
}
