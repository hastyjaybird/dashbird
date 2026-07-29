/**
 * Events finder — Cool Happenings (https://coolstuff.ju.mp/).
 * Richie Rhombus's curated Bay Area arts & culture list (under $30 / free).
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicHttpUrl } from './public-http-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

export const COOLSTUFF_SITE_URL = 'https://coolstuff.ju.mp/';

const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

const SKIP_HOSTS = new Set(['coolstuff.ju.mp', 'richierhombus.space']);

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function coolstuffEventsCachePath(env = process.env) {
  const override = String(env.COOLSTUFF_EVENTS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'coolstuff-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheMs(env = process.env) {
  const n = Number(env.COOLSTUFF_EVENTS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 7 * 24 * 60 * 60 * 1000);
  return DEFAULT_CACHE_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(coolstuffEventsCachePath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object} payload
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCache(payload, env = process.env) {
  const p = coolstuffEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {string} raw
 */
function decodeHtml(raw) {
  return String(raw || '')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} url
 */
function urlKey(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '').split('#')[0];
}

/**
 * @param {string} key
 */
function hashKey(key) {
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/**
 * @param {string} ctx
 * @param {string} timeZone
 * @returns {string | null}
 */
function parseCoolstuffDate(ctx, timeZone) {
  const text = String(ctx || '');
  const year = new Date().getFullYear();

  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let y = slash[3] ? Number(slash[3]) : year;
    if (y < 100) y += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T20:00:00`;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }

  const named = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:\s*[-–]\s*(?:\w+\.?\s+)?(\d{1,2}))?/i);
  if (named) {
    const month = MONTHS[String(named[1]).toLowerCase().replace(/\./g, '')];
    const day = Number(named[2]);
    if (month && day >= 1 && day <= 31) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T20:00:00`;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }

  void timeZone;
  return null;
}

/**
 * @param {string} ctx
 */
function parseCity(ctx) {
  const m = String(ctx || '').match(/\b(Oakland|San Francisco|SF|Berkeley|Richmond|Alameda|Emeryville|Hayward|San Jose|Marin)\b/i);
  if (!m) return null;
  const c = m[1];
  if (/^sf$/i.test(c)) return 'San Francisco';
  return c.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * @param {string} html
 * @param {{ timeZone?: string }} [opts]
 * @returns {object[]}
 */
export function parseCoolstuffHtml(html, opts = {}) {
  const timeZone = String(opts.timeZone || 'America/Los_Angeles');
  const stripped = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  /** @type {object[]} */
  const events = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https?:[^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(stripped))) {
    const rawUrl = m[1].trim();
    let url;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      url = urlKey(u.href);
    } catch {
      continue;
    }
    if (!url) continue;
    let host;
    try {
      host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      continue;
    }
    if (SKIP_HOSTS.has(host)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = decodeHtml(m[2].replace(/<[^>]+>/g, ' '));
    if (!title || title.length < 4) continue;
    if (/^(submit|join|listed by)/i.test(title)) continue;

    const ctxStart = Math.max(0, m.index - 500);
    const ctxEnd = Math.min(stripped.length, m.index + m[0].length + 300);
    const ctx = decodeHtml(stripped.slice(ctxStart, ctxEnd).replace(/<[^>]+>/g, ' '));
    const start = parseCoolstuffDate(ctx, timeZone);
    const city = parseCity(ctx);

    events.push({
      id: `coolstuff:${hashKey(url)}`,
      source: 'coolstuff',
      title: title.slice(0, 200),
      url,
      start,
      city,
      description: ctx.slice(0, 360) || null,
      raw: { listUrl: COOLSTUFF_SITE_URL, context: ctx.slice(0, 500) },
    });
  }
  return events;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function fetchCoolstuffEvents(env = process.env, opts = {}) {
  const cache = await readCache(env);
  const cachedAt = Date.parse(String(cache?.cachedAt || ''));
  const fresh =
    !opts.forceRefresh
    && cache
    && Number.isFinite(cachedAt)
    && Date.now() - cachedAt < cacheMs(env);

  if (fresh) {
    return {
      ok: true,
      events: cache.events,
      fromCache: true,
      stale: false,
      cachedAt: cache.cachedAt,
      count: cache.events.length,
      pageUrl: COOLSTUFF_SITE_URL,
    };
  }

  let html = '';
  try {
    const safeUrl = await assertPublicHttpUrl(COOLSTUFF_SITE_URL);
    const r = await fetch(safeUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) {
      if (cache?.events?.length) {
        return {
          ok: true,
          events: cache.events,
          fromCache: true,
          stale: true,
          cachedAt: cache.cachedAt,
          count: cache.events.length,
          pageUrl: COOLSTUFF_SITE_URL,
          error: `http_${r.status}`,
        };
      }
      return {
        ok: false,
        events: [],
        fromCache: false,
        pageUrl: COOLSTUFF_SITE_URL,
        error: `http_${r.status}`,
      };
    }
    html = await r.text();
  } catch (e) {
    if (cache?.events?.length) {
      return {
        ok: true,
        events: cache.events,
        fromCache: true,
        stale: true,
        cachedAt: cache.cachedAt,
        count: cache.events.length,
        pageUrl: COOLSTUFF_SITE_URL,
        error: String(e?.message || e),
      };
    }
    return {
      ok: false,
      events: [],
      fromCache: false,
      pageUrl: COOLSTUFF_SITE_URL,
      error: String(e?.message || e),
    };
  }

  const tz = String(env.WEATHER_TIME_ZONE || env.EVENTS_FINDER_TIME_ZONE || 'America/Los_Angeles');
  const parsed = parseCoolstuffHtml(html, { timeZone: tz });
  const horizonMs = 120 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const events = parsed.filter((ev) => {
    if (!ev.start) return true;
    const ms = Date.parse(ev.start);
    return Number.isFinite(ms) && ms > now - 12 * 60 * 60 * 1000 && ms < now + horizonMs;
  });

  const payload = {
    cachedAt: new Date().toISOString(),
    pageUrl: COOLSTUFF_SITE_URL,
    count: events.length,
    events,
  };
  await writeCache(payload, env);

  return {
    ok: events.length > 0,
    events,
    fromCache: false,
    stale: false,
    cachedAt: payload.cachedAt,
    count: events.length,
    pageUrl: COOLSTUFF_SITE_URL,
  };
}
