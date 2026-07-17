/**
 * Research + 2-month heads-up cards for user-added big conferences / festivals.
 */
import { searchWeb } from './events-finder-event-url.js';
import {
  loadConferenceWatchlistStore,
  slugFromQuery,
  upsertConferenceWatchlistRecords,
} from './events-finder-conference-watchlist-store.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** ~2 months before the event. */
export const CONFERENCE_HEADS_UP_MS = 60 * 24 * 60 * 60 * 1000;
const RESEARCH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 24 * 60 * 60 * 1000;

const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'openai/gpt-4o-mini',
];

const EXTRACT_SYSTEM = `You extract structured facts about a conference or festival from web page text.
Return JSON only:
{
  "name": string,
  "url": string | null,
  "eventStart": "YYYY-MM-DD" | null,
  "eventEnd": "YYYY-MM-DD" | null,
  "venue": string | null,
  "city": string | null,
  "ticketPrice": string | null,
  "earlyBirdStart": "YYYY-MM-DD" | null,
  "earlyBirdEnd": "YYYY-MM-DD" | null,
  "notes": string | null
}
Use ISO dates only. ticketPrice should be a short human label like "$299" or "$149–$399 early bird".
If unsure, use null. Prefer the official event site over aggregators.`;

/** @type {Set<string>} */
const researchInFlight = new Set();

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeConferenceWatchlist(raw) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/\r?\n/)
      : [];
  for (const item of items) {
    const s = String(item || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 30) break;
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

/**
 * @param {string | null | undefined} ymd
 * @returns {number | null}
 */
function parseYmd(ymd) {
  const s = String(ymd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T12:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPageText(url) {
  const href = String(url || '').trim();
  if (!href) return '';
  try {
    const r = await fetch(href, {
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return '';
    return htmlToText(await r.text());
  } catch {
    return '';
  }
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
 * @param {string} query
 * @param {Array<{ url: string, title: string, text: string }>} pages
 * @param {NodeJS.ProcessEnv} [env]
 */
async function extractWithOpenRouter(query, pages, env = process.env) {
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (!key || !pages.length) return null;

  const model = String(
    env.EVENTS_FINDER_CONFERENCE_MODEL
      || env.OPENROUTER_FREE_TEXT_MODEL
      || env.OPENROUTER_MODEL
      || 'openai/gpt-4o-mini',
  ).trim();
  const models = [model, ...TEXT_FALLBACK_MODELS.filter((m) => m !== model)];

  const payload = {
    query,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.title.slice(0, 200),
      text: p.text.slice(0, 6000),
    })),
  };

  for (const m of models) {
    let r;
    try {
      r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
          'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-events-conference',
        },
        body: JSON.stringify({
          model: m,
          temperature: 0.2,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: JSON.stringify(payload) },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      continue;
    }
    if (!r.ok) continue;
    const j = await r.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(typeof content === 'string' ? content : '');
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

/**
 * Lightweight regex fallback when OpenRouter is unavailable.
 * @param {string} query
 * @param {Array<{ url: string, title: string, text: string }>} pages
 */
function extractHeuristic(query, pages) {
  const blob = pages.map((p) => `${p.title}\n${p.text}`).join('\n');
  /** @type {Record<string, string | null>} */
  const out = {
    name: query,
    url: pages[0]?.url || null,
    eventStart: null,
    eventEnd: null,
    venue: null,
    city: null,
    ticketPrice: null,
    earlyBirdStart: null,
    earlyBirdEnd: null,
    notes: null,
  };

  const price = blob.match(/\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*[-–—]\s*\$\s?\d[\d,]*(?:\.\d{2})?)?/);
  if (price) out.ticketPrice = price[0].replace(/\s+/g, '');

  const earlyBird = blob.match(/early\s+bird[^.\n]{0,120}/i);
  if (earlyBird) out.notes = earlyBird[0].trim().slice(0, 200);

  const isoDates = [...blob.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)]
    .map((m) => {
      const y = m[1];
      const mo = String(m[2]).padStart(2, '0');
      const d = String(m[3]).padStart(2, '0');
      return `${y}-${mo}-${d}`;
    })
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .sort();
  if (isoDates.length) {
    out.eventStart = isoDates[0];
    if (isoDates.length > 1) out.eventEnd = isoDates[isoDates.length - 1];
  }

  const monthDates = [...blob.matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?,?\s+(20\d{2})\b/gi,
  )];
  if (!out.eventStart && monthDates.length) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const m = monthDates[0];
    const monKey = String(m[1]).slice(0, 3).toLowerCase();
    const mon = months[/** @type {keyof typeof months} */ (monKey)];
    if (mon != null) {
      const y = Number(m[4]);
      const d1 = Number(m[2]);
      const start = new Date(Date.UTC(y, mon, d1));
      if (Number.isFinite(start.getTime())) {
        out.eventStart = start.toISOString().slice(0, 10);
        const d2 = m[3] ? Number(m[3]) : null;
        if (d2) {
          const end = new Date(Date.UTC(y, mon, d2));
          if (Number.isFinite(end.getTime())) out.eventEnd = end.toISOString().slice(0, 10);
        }
      }
    }
  }

  return out;
}

/**
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function researchConferenceQuery(query, env = process.env) {
  const q = String(query || '').trim().slice(0, 120);
  const slug = slugFromQuery(q);
  if (!slug) return { ok: false, error: 'invalid_query' };

  if (researchInFlight.has(slug)) return { ok: true, slug, skipped: true };
  researchInFlight.add(slug);
  const nowIso = new Date().toISOString();

  await upsertConferenceWatchlistRecords({
    [slug]: {
      slug,
      query: q,
      name: q,
      researching: true,
      researchedAt: nowIso,
    },
  }, env);

  try {
    const year = new Date().getFullYear();
    const queries = [
      `"${q}" conference festival official tickets ${year}`,
      `"${q}" festival dates early bird tickets`,
      `${q} conference ${year + 1} tickets`,
    ];
    /** @type {Array<{ url: string, title: string }>} */
    const hits = [];
    for (const searchQ of queries) {
      const batch = await searchWeb(searchQ);
      for (const h of batch) {
        if (!hits.some((x) => x.url === h.url)) hits.push(h);
      }
      if (hits.length >= 8) break;
    }

    const follow = hits.slice(0, 4);
    /** @type {Array<{ url: string, title: string, text: string }>} */
    const pages = [];
    for (const h of follow) {
      const text = await fetchPageText(h.url);
      if (text.length > 120) pages.push({ url: h.url, title: h.title || q, text });
      if (pages.length >= 3) break;
    }

    const ai = pages.length ? await extractWithOpenRouter(q, pages, env) : null;
    const parsed = ai && typeof ai === 'object' ? ai : extractHeuristic(q, pages);

    const pickUrl = String(parsed?.url || pages[0]?.url || hits[0]?.url || '').trim() || null;
    const record = {
      slug,
      query: q,
      name: String(parsed?.name || q).trim().slice(0, 160) || q,
      url: pickUrl,
      eventStart: normalizeYmd(parsed?.eventStart),
      eventEnd: normalizeYmd(parsed?.eventEnd),
      venue: String(parsed?.venue || '').trim().slice(0, 160) || null,
      city: String(parsed?.city || '').trim().slice(0, 80) || null,
      ticketPrice: String(parsed?.ticketPrice || '').trim().slice(0, 120) || null,
      earlyBirdStart: normalizeYmd(parsed?.earlyBirdStart),
      earlyBirdEnd: normalizeYmd(parsed?.earlyBirdEnd),
      notes: String(parsed?.notes || '').trim().slice(0, 400) || null,
      researching: false,
      error: pages.length ? null : 'no_pages_found',
      researchedAt: nowIso,
    };

    await upsertConferenceWatchlistRecords({ [slug]: record }, env);
    return { ok: true, slug, record };
  } catch (e) {
    await upsertConferenceWatchlistRecords({
      [slug]: {
        slug,
        query: q,
        name: q,
        researching: false,
        error: String(e?.message || e || 'research_failed').slice(0, 200),
        researchedAt: nowIso,
      },
    }, env);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    researchInFlight.delete(slug);
  }
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeYmd(raw) {
  const s = String(raw || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isFinite(Date.parse(`${s}T12:00:00Z`)) ? s : null;
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function buildEarlyBirdLine(record, now = new Date()) {
  const t = now.getTime();
  const ebStart = parseYmd(record.earlyBirdStart);
  const ebEnd = parseYmd(record.earlyBirdEnd);
  if (ebStart && t < ebStart) {
    return { kind: 'upcoming', text: `Early bird tickets start ${formatMd(record.earlyBirdStart)}` };
  }
  if (ebStart && ebEnd && t >= ebStart && t < ebEnd) {
    return { kind: 'active', text: `Early bird ends ${formatMd(record.earlyBirdEnd)}` };
  }
  if (ebEnd && t >= ebEnd) {
    return { kind: 'ended', text: record.ticketPrice ? String(record.ticketPrice) : 'Early bird ended' };
  }
  if (record.ticketPrice) {
    return { kind: 'price', text: String(record.ticketPrice) };
  }
  return null;
}

/**
 * @param {string | null | undefined} ymd
 */
function formatMd(ymd) {
  const ms = parseYmd(ymd);
  if (!ms) return String(ymd || '');
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return String(ymd);
  }
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function isConferenceHeadsUpActive(record, now = new Date()) {
  if (record.researching) return true;
  const t = now.getTime();
  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd) || startMs;
  if (startMs) {
    const windowStart = startMs - CONFERENCE_HEADS_UP_MS;
    const windowEnd = (endMs || startMs) + 24 * 60 * 60 * 1000;
    if (t >= windowStart && t <= windowEnd) return true;
    return false;
  }
  // No event date yet — keep visible while we research / user just added it.
  const researchedAt = Date.parse(String(record.researchedAt || ''));
  if (!Number.isFinite(researchedAt)) return true;
  return t - researchedAt < 14 * 24 * 60 * 60 * 1000;
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function conferenceRecordToHeadsUp(record, now = new Date()) {
  const eb = buildEarlyBirdLine(record, now);
  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd);
  /** @type {string[]} */
  const whenBits = [];
  if (record.eventStart) {
    whenBits.push(
      endMs && endMs !== startMs
        ? `${formatMd(record.eventStart)} – ${formatMd(record.eventEnd)}`
        : formatMd(record.eventStart),
    );
  } else {
    whenBits.push('Dates TBD');
  }
  const placeBits = [record.venue, record.city].filter(Boolean);
  return {
    id: `conference-watch:${record.slug}`,
    slug: record.slug,
    query: record.query,
    title: record.name || record.query,
    url: record.url || '',
    start: record.eventStart ? `${record.eventStart}T12:00:00.000Z` : null,
    end: record.eventEnd ? `${record.eventEnd}T12:00:00.000Z` : null,
    venue: record.venue || null,
    city: record.city || null,
    whenLabel: whenBits.join(' · '),
    placeLabel: placeBits.join(' · ') || null,
    ticketPrice: record.ticketPrice || null,
    earlyBirdStart: record.earlyBirdStart || null,
    earlyBirdEnd: record.earlyBirdEnd || null,
    earlyBirdLine: eb?.text || null,
    earlyBirdKind: eb?.kind || null,
    notes: record.notes || null,
    researching: record.researching === true,
    error: record.error || null,
    researchedAt: record.researchedAt || null,
    source: 'conference-watch',
    headsUp: true,
    conferenceWatch: true,
  };
}

/**
 * @param {string[]} watchlist
 * @param {Date} [now]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConferenceHeadsUp(watchlist, now = new Date(), env = process.env) {
  const names = normalizeConferenceWatchlist(watchlist);
  const store = await loadConferenceWatchlistStore(env);
  /** @type {object[]} */
  const active = [];
  /** @type {string[]} */
  const needResearch = [];

  for (const name of names) {
    const slug = slugFromQuery(name);
    const rec = store.bySlug[slug];
    if (!rec) {
      needResearch.push(name);
      active.push(conferenceRecordToHeadsUp({
        slug,
        query: name,
        name,
        researching: true,
        researchedAt: null,
      }, now));
      continue;
    }
    if (isConferenceHeadsUpActive(rec, now)) {
      active.push(conferenceRecordToHeadsUp(rec, now));
    }
    const researchedAt = Date.parse(String(rec.researchedAt || ''));
    const stale = !Number.isFinite(researchedAt) || now.getTime() - researchedAt > RESEARCH_STALE_MS;
    const incomplete = !rec.url || !rec.eventStart;
    const retry = Number.isFinite(researchedAt) && now.getTime() - researchedAt > RETRY_MS;
    if ((stale || (incomplete && retry)) && !rec.researching && !researchInFlight.has(slug)) {
      needResearch.push(name);
    }
  }

  return { active, needResearch, watchlist: names };
}

/**
 * Kick off background research for stale / new watchlist names.
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} [env]
 */
export function scheduleConferenceWatchlistResearch(names, env = process.env) {
  const list = normalizeConferenceWatchlist(names);
  if (!list.length) return;
  setImmediate(() => {
    void (async () => {
      for (const name of list.slice(0, 4)) {
        await researchConferenceQuery(name, env);
      }
    })().catch((e) => {
      console.warn('[conference-watch] research failed:', e?.message || e);
    });
  });
}
