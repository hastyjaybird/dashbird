/**
 * Events finder — dorkbotSF (https://dorkbotsf.org/).
 *
 * Single-org public site: homepage features the next meetup (time, venue,
 * speakers, flyer). Google Calendar embed on /calendar.html is not publicly
 * ICS-exportable (404), so HTML is the source of truth.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicHttpUrl } from './public-http-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

export const DORKBOTSF_SITE_URL = 'https://dorkbotsf.org/';
export const DORKBOTSF_ARCHIVE_BASE = 'https://dorkbotsf.org/archive/';

const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dorkbotsfEventsCachePath(env = process.env) {
  const override = String(env.DORKBOTSF_EVENTS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'dorkbotsf-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheMs(env = process.env) {
  const n = Number(env.DORKBOTSF_EVENTS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 7 * 24 * 60 * 60 * 1000);
  return DEFAULT_CACHE_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(dorkbotsfEventsCachePath(env), 'utf8');
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
  const p = dorkbotsfEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * Strip tags / collapse whitespace for regex windows.
 * @param {string} html
 */
function stripTags(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|td|h\d|li|center)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse "7:00pm" / "7pm" / "19:00" → { hours, minutes }.
 * @param {string} raw
 * @returns {{ hours: number, minutes: number } | null}
 */
export function parseDorkbotsfClock(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] != null ? Number(m[2]) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (minutes < 0 || minutes > 59 || hours < 0 || hours > 23) return null;
  if (ap === 'pm' && hours < 12) hours += 12;
  if (ap === 'am' && hours === 12) hours = 0;
  if (!ap && hours > 23) return null;
  return { hours, minutes };
}

/**
 * Parse "Jun 24 2026" / "June 24, 2026".
 * @param {string} raw
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseDorkbotsfDateToken(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  if (day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  return { year, month, day };
}

/**
 * Local wall time → ISO in America/Los_Angeles (dashboard default).
 * @param {{ year: number, month: number, day: number }} date
 * @param {{ hours: number, minutes: number }} clock
 * @param {string} timeZone
 * @returns {string | null}
 */
function localWallToIso(date, clock, timeZone) {
  const y = date.year;
  const mo = String(date.month).padStart(2, '0');
  const d = String(date.day).padStart(2, '0');
  const h = String(clock.hours).padStart(2, '0');
  const mi = String(clock.minutes).padStart(2, '0');
  // Probe UTC candidates around the wall time until TZ formats match.
  const guessUtc = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
  if (!Number.isFinite(guessUtc)) return null;
  for (const offsetMin of [-7 * 60, -8 * 60, -6 * 60, -9 * 60, -5 * 60]) {
    const ms = guessUtc - offsetMin * 60 * 1000;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(ms));
      const get = (type) => parts.find((p) => p.type === type)?.value;
      if (
        get('year') === String(y)
        && get('month') === mo
        && get('day') === d
        && get('hour') === h
        && get('minute') === mi
      ) {
        return new Date(ms).toISOString();
      }
    } catch {
      /* try next */
    }
  }
  // Fallback: assume PDT (−7).
  return new Date(guessUtc + 7 * 60 * 60 * 1000).toISOString();
}

/**
 * YYYYMM archive slug for a date.
 * @param {{ year: number, month: number, day: number }} date
 */
function archiveSlug(date) {
  return `${date.year}${String(date.month).padStart(2, '0')}`;
}

/**
 * Extract talk titles from featured block h3s.
 * @param {string} html
 * @returns {string[]}
 */
export function parseDorkbotsfTalkTitles(html) {
  const text = String(html || '');
  /** @type {string[]} */
  const talks = [];
  const seen = new Set();
  // Featured block ends before the archives section.
  const cut = text.search(/Archives:\s*&nbsp;/i);
  const window = cut > 0 ? text.slice(0, cut) : text;
  for (const m of window.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)) {
    const raw = stripTags(m[1]).replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    if (/mailing list|speak at a future/i.test(raw)) continue;
    if (seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    talks.push(raw);
  }
  return talks;
}

/**
 * Parse homepage HTML into a single upcoming meetup (or null).
 * @param {string} html
 * @param {{ timeZone?: string, pageUrl?: string }} [opts]
 * @returns {object | null}
 */
export function parseDorkbotsfHomepage(html, opts = {}) {
  const timeZone =
    String(opts.timeZone || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const pageUrl = String(opts.pageUrl || DORKBOTSF_SITE_URL).trim() || DORKBOTSF_SITE_URL;
  const text = String(html || '');
  if (!text) return null;

  const plain = stripTags(text);
  const timeBlock = plain.match(
    /time:\s*\n?\s*([^\n]+)\s*\n\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
  );
  if (!timeBlock) return null;

  const clock = parseDorkbotsfClock(timeBlock[1]);
  const date = parseDorkbotsfDateToken(timeBlock[2]);
  if (!clock || !date) return null;

  const startIso = localWallToIso(date, clock, timeZone);
  if (!startIso) return null;

  const locBlock = plain.match(
    /location:\s*\n?\s*([^\n]+)\s*\n\s*([^\n]+)\s*\n\s*([^\n]+)/i,
  );
  let venue = 'dorkbotSF';
  let city = 'San Francisco';
  if (locBlock) {
    const name = locBlock[1].replace(/\s+/g, ' ').trim();
    const street = locBlock[2].replace(/\s+/g, ' ').trim();
    const cityLine = locBlock[3].replace(/\s+/g, ' ').trim();
    venue = [name, street].filter(Boolean).join(', ');
    const cityMatch = cityLine.match(/^([^,]+)/);
    if (cityMatch) city = cityMatch[1].trim();
  }

  const talks = parseDorkbotsfTalkTitles(text);
  const slug = archiveSlug(date);
  let url = pageUrl;
  const archiveRe = new RegExp(
    `href=["']?(https?:\\/\\/dorkbotsf\\.org\\/archive\\/${slug}\\/?|\\/?archive\\/${slug}\\/?)["']?`,
    'i',
  );
  const archiveHit = text.match(archiveRe);
  if (archiveHit) {
    const href = archiveHit[1];
    url = /^https?:\/\//i.test(href)
      ? href.replace(/\/?$/, '/')
      : `${DORKBOTSF_ARCHIVE_BASE}${slug}/`;
  } else {
    // Homepage always mirrors the next meetup; stable deep link by YYYYMM.
    url = `${DORKBOTSF_ARCHIVE_BASE}${slug}/`;
  }

  let imageUrl = null;
  const imgRe = new RegExp(
    `src=["']?(https?:\\/\\/dorkbotsf\\.org\\/archive\\/${slug}\\/[^"'\\s>]+\\.(?:jpg|jpeg|png|gif|webp))["']?`,
    'i',
  );
  const imgHit = text.match(imgRe);
  if (imgHit) imageUrl = imgHit[1];

  const donationLine = plain.match(/DONATIONS?\s+[^\n]+/i)?.[0]?.trim() || '';
  const priceMatch = donationLine.match(/\$(\d+)\s*[-–—]\s*\$?(\d+)/);
  const priceMin = priceMatch ? Number(priceMatch[1]) : null;
  const priceMax = priceMatch ? Number(priceMatch[2]) : null;

  const dateLabel = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.month - 1]} ${date.day} ${date.year}`;
  const title =
    talks.length > 0
      ? `dorkbotSF — ${talks.slice(0, 2).join('; ')}${talks.length > 2 ? '…' : ''}`
      : `dorkbotSF — ${dateLabel}`;

  const descriptionParts = [];
  if (donationLine) descriptionParts.push(donationLine);
  if (talks.length) descriptionParts.push(`Talks: ${talks.join(' · ')}`);
  descriptionParts.push('People doing strange things with electricity.');

  const dayKey = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;

  return {
    id: `dorkbotsf:${dayKey}`,
    title,
    start: startIso,
    end: null,
    venue,
    city,
    lat: null,
    lon: null,
    url,
    source: 'dorkbotsf',
    online: false,
    isOnline: false,
    location: `${venue}, ${city}, CA`,
    description: descriptionParts.join(' '),
    imageUrl,
    price: priceMin,
    priceMin,
    priceMax,
    ticketPrice: priceMin,
    ticketsInfo: {
      price: priceMin,
      priceMax,
      subtitle: donationLine || 'Donations appreciated — sliding scale',
    },
    raw: {
      date: dayKey,
      clock: timeBlock[1].trim(),
      talks,
      archiveSlug: slug,
      pageUrl,
    },
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function fetchDorkbotsfEvents(env = process.env, opts = {}) {
  const force = opts.forceRefresh === true;
  const cache = await readCache(env);
  if (!force && cache?.cachedAt) {
    const age = Date.now() - Date.parse(cache.cachedAt);
    if (Number.isFinite(age) && age >= 0 && age < cacheMs(env)) {
      return {
        ok: true,
        events: cache.events,
        fromCache: true,
        stale: false,
        cachedAt: cache.cachedAt,
        count: cache.events.length,
        pageUrl: DORKBOTSF_SITE_URL,
        error: null,
      };
    }
  }

  const tz =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';

  let html = '';
  try {
    const safe = await assertPublicHttpUrl(DORKBOTSF_SITE_URL);
    const r = await fetch(safe, {
      headers: { Accept: 'text/html,*/*', 'User-Agent': UA },
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
          pageUrl: DORKBOTSF_SITE_URL,
          error: `http_${r.status}`,
        };
      }
      return {
        ok: false,
        events: [],
        fromCache: false,
        pageUrl: DORKBOTSF_SITE_URL,
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
        pageUrl: DORKBOTSF_SITE_URL,
        error: String(e?.message || e),
      };
    }
    return {
      ok: false,
      events: [],
      fromCache: false,
      pageUrl: DORKBOTSF_SITE_URL,
      error: String(e?.message || e),
    };
  }

  const parsed = parseDorkbotsfHomepage(html, { timeZone: tz, pageUrl: DORKBOTSF_SITE_URL });
  /** @type {object[]} */
  const events = [];
  let featuredPast = false;
  if (parsed) {
    const startMs = Date.parse(parsed.start);
    // Keep if not more than 12h past (same window as Multiverse).
    if (Number.isFinite(startMs) && startMs > Date.now() - 12 * 60 * 60 * 1000) {
      events.push(parsed);
    } else if (Number.isFinite(startMs)) {
      featuredPast = true;
    }
  }

  const cachedAt = new Date().toISOString();
  await writeCache(
    {
      cachedAt,
      pageUrl: DORKBOTSF_SITE_URL,
      count: events.length,
      featuredPast,
      featuredId: parsed?.id || null,
      events,
    },
    env,
  );

  return {
    ok: true,
    events,
    fromCache: false,
    stale: false,
    cachedAt,
    count: events.length,
    pageUrl: DORKBOTSF_SITE_URL,
    featuredPast,
    featuredId: parsed?.id || null,
    error: parsed ? null : 'parse_no_meetup',
  };
}
