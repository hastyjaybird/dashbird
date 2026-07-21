/**
 * Events finder — The Multiverse School.
 *
 * Primary: public Google Calendar ICS (embed on /calendar).
 * Enrichment: scrape https://themultiverse.school/calendar (and homepage)
 * for /classes/{id} links so each listing gets a unique event URL.
 * Class detail pages supply suggested price + full/sold-out (checked daily).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRRule, effectiveEndMs } from './ical-recurrence.js';
import { parseIcsEvents } from './ical-parse.js';
import { loadEventsFinderCriteria } from './events-finder-criteria-store.js';
import { eventsIngestWindowDays } from './events-finder-window.js';
import { normalizeEventTitleKey } from './events-finder-store.js';
import { assertPublicHttpUrl } from './public-http-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

/** Public Multiverse School calendar (from /calendar embed `src=`). */
export const MULTIVERSE_CALENDAR_ID =
  'c_e9fbd687c00a0947f9bb561a447d8b98164989ac6d7e58b527ba43097e9d1abe@group.calendar.google.com';

export const MULTIVERSE_SITE_URL = 'https://themultiverse.school/';
export const MULTIVERSE_CALENDAR_PAGE_URL = 'https://themultiverse.school/calendar';
export const MULTIVERSE_CLASSES_PAGE_URL = 'https://themultiverse.school/classes';

const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1000;
/** Re-check class price / full status about once a day. */
const DEFAULT_CLASS_DETAILS_CACHE_MS = 24 * 60 * 60 * 1000;
const CLASS_DETAIL_CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';
/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function multiverseEventsIcalUrl(env = process.env) {
  const override = String(env.MULTIVERSE_SCHOOL_ICAL_URL || '').trim();
  if (override) return override;
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(MULTIVERSE_CALENDAR_ID)}/public/basic.ics`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function multiverseEventsCachePath(env = process.env) {
  const override = String(env.MULTIVERSE_EVENTS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'multiverse-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheMs(env = process.env) {
  const n = Number(env.MULTIVERSE_EVENTS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 7 * 24 * 60 * 60 * 1000);
  return DEFAULT_CACHE_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function multiverseClassDetailsCachePath(env = process.env) {
  const override = String(env.MULTIVERSE_CLASS_DETAILS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'multiverse-class-details-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function classDetailsCacheMs(env = process.env) {
  const n = Number(env.MULTIVERSE_CLASS_DETAILS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 7 * 24 * 60 * 60 * 1000);
  return DEFAULT_CLASS_DETAILS_CACHE_MS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(multiverseEventsCachePath(env), 'utf8');
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
  const p = multiverseEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * Expand RRULE masters to all occurrences in [now - 12h, now + horizonMs].
 * @param {ReturnType<typeof parseIcsEvents>} events
 * @param {number} nowMs
 * @param {number} horizonMs
 */
function expandInWindow(events, nowMs, horizonMs) {
  const windowStart = nowMs - 12 * 60 * 60 * 1000;
  const windowEnd = nowMs + horizonMs;
  /** @type {typeof events} */
  const out = [];
  const seen = new Set();

  /**
   * @param {object} ev
   */
  function push(ev) {
    const key = `${ev.id}|${ev.startMs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ev);
  }

  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    if (ev.recurrenceId || !ev.rrule) {
      if (ev.startMs >= windowStart && ev.startMs <= windowEnd) push(ev);
      continue;
    }
    try {
      const rule = buildRRule(ev.rrule, ev.dtstartKey, ev.dtstartVal, ev.exdates || []);
      const duration =
        ev.endMs != null && ev.endMs > ev.startMs
          ? ev.endMs - ev.startMs
          : ev.allDay
            ? 24 * 60 * 60 * 1000
            : 60 * 60 * 1000;
      const between = rule.between(new Date(windowStart), new Date(windowEnd), true);
      for (const occ of between) {
        const startMs = occ.getTime();
        push({
          ...ev,
          id: `${ev.id}@${startMs}`,
          startMs,
          endMs: startMs + duration,
          seriesId: ev.id,
          rrule: '',
        });
      }
    } catch (err) {
      console.warn('[multiverse] RRULE expand failed:', ev.title, err?.message || err);
      if (ev.startMs >= windowStart && ev.startMs <= windowEnd) push(ev);
    }
  }

  return out;
}

/**
 * @param {string} title
 * @returns {string}
 */
function titleMatchKey(title) {
  return normalizeEventTitleKey(title) || '';
}

/**
 * Parse MM.DD.YY → YYYY-MM-DD (assume 20xx).
 * @param {string} raw
 * @returns {string | null}
 */
function parseMultiverseDateToken(raw) {
  const m = String(raw || '')
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  return `20${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * Scrape Multiverse HTML for class listing cards.
 * @param {string} html
 * @returns {Array<{ title: string, url: string, date: string | null, titleKey: string }>}
 */
export function parseMultiverseClassListings(html) {
  const text = String(html || '');
  /** @type {Array<{ title: string, url: string, date: string | null, titleKey: string }>} */
  const out = [];
  const seen = new Set();

  // <a href="/classes/219">Control AI Spending</a> (07.25.26 | 1:00 PM - 2:00 PM PDT)
  const withDate =
    /href=["'](\/classes\/\d+)["'][^>]*>([^<]+)<\/a>\s*\((\d{2}\.\d{2}\.\d{2})/gi;
  for (const m of text.matchAll(withDate)) {
    const pathPart = m[1];
    const title = m[2].replace(/\s+/g, ' ').trim();
    const date = parseMultiverseDateToken(m[3]);
    const titleKey = titleMatchKey(title);
    if (!title || !titleKey) continue;
    const url = `https://themultiverse.school${pathPart}`;
    const dedupe = `${titleKey}|${date || ''}|${url}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ title, url, date, titleKey });
  }

  // Bare class links without an inline date (still useful as title→url).
  const bare = /href=["'](\/classes\/\d+)["'][^>]*>([^<]+)<\/a>/gi;
  for (const m of text.matchAll(bare)) {
    const pathPart = m[1];
    const title = m[2].replace(/\s+/g, ' ').trim();
    const titleKey = titleMatchKey(title);
    if (!title || !titleKey) continue;
    const url = `https://themultiverse.school${pathPart}`;
    const dedupe = `${titleKey}||${url}`;
    if (seen.has(dedupe) || out.some((x) => x.url === url && x.titleKey === titleKey)) continue;
    // Prefer dated entries; only add bare if no dated row for this title+url.
    if (out.some((x) => x.url === url)) continue;
    seen.add(dedupe);
    out.push({ title, url, date: null, titleKey });
  }

  return out;
}

/**
 * Parse a Multiverse /classes/{id} detail page for suggested price + full badge.
 * @param {string} html
 * @returns {{ suggestedPrice: number | null, isFull: boolean, payWhatYouCan: boolean }}
 */
export function parseMultiverseClassPage(html) {
  const text = String(html || '');
  const isFull =
    /class=["'][^"']*full-badge[^"']*["'][^>]*>\s*(?:This class is full|Full)\s*</i.test(text)
    || /\bThis class is full\b/i.test(text);
  const payWhatYouCan = /pay\s*what\s*you\s*can/i.test(text);
  let suggestedPrice = null;
  const priceNearSuggested = text.match(
    /Suggested:\s*<\/span>\s*(?:<span[^>]*>\s*\$?\s*<\/span>\s*)?<span[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>\s*(\d+(?:\.\d{1,2})?)\s*</i,
  );
  if (priceNearSuggested) {
    suggestedPrice = Number(priceNearSuggested[1]);
  } else {
    const priceSpan = text.match(
      /<span[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>\s*(\d+(?:\.\d{1,2})?)\s*</i,
    );
    if (priceSpan) suggestedPrice = Number(priceSpan[1]);
  }
  if (suggestedPrice != null && !Number.isFinite(suggestedPrice)) suggestedPrice = null;
  return {
    suggestedPrice,
    isFull,
    payWhatYouCan,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Record<string, {
 *   fetchedAt: string,
 *   isFull: boolean,
 *   suggestedPrice: number | null,
 *   payWhatYouCan: boolean,
 *   error?: string | null,
 * }>>}
 */
async function readClassDetailsCache(env = process.env) {
  try {
    const raw = await readFile(multiverseClassDetailsCachePath(env), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.classes || typeof data.classes !== 'object') {
      return {};
    }
    return /** @type {Record<string, any>} */ (data.classes);
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, object>} classes
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeClassDetailsCache(classes, env = process.env) {
  const p = multiverseClassDetailsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(
    p,
    `${JSON.stringify({ cachedAt: new Date().toISOString(), classes }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 */
async function fetchOneClassDetail(url, env = process.env) {
  const safe = await assertPublicHttpUrl(url);
  const host = new URL(safe).hostname.replace(/^www\./, '');
  if (host !== 'themultiverse.school') {
    throw new Error('multiverse_host_mismatch');
  }
  const r = await fetch(safe, {
    headers: { Accept: 'text/html,*/*', 'User-Agent': UA },
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`class_http_${r.status}`);
  const html = await r.text();
  const parsed = parseMultiverseClassPage(html);
  return {
    fetchedAt: new Date().toISOString(),
    isFull: parsed.isFull,
    suggestedPrice: parsed.suggestedPrice,
    payWhatYouCan: parsed.payWhatYouCan,
    error: null,
  };
}

/**
 * Refresh class detail cache for the given /classes/{id} URLs (stale or missing).
 * @param {string[]} classUrls
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
async function ensureMultiverseClassDetails(classUrls, env = process.env, opts = {}) {
  const force = opts.forceRefresh === true;
  const ttl = classDetailsCacheMs(env);
  const now = Date.now();
  const classes = await readClassDetailsCache(env);
  const unique = [
    ...new Set(
      (Array.isArray(classUrls) ? classUrls : [])
        .map((u) => String(u || '').trim())
        .filter((u) => /\/classes\/\d+\/?$/i.test(u) || /\/classes\/\d+/i.test(u)),
    ),
  ];

  /** @type {string[]} */
  const need = [];
  for (const url of unique) {
    const row = classes[url];
    if (force || !row?.fetchedAt) {
      need.push(url);
      continue;
    }
    const age = now - Date.parse(row.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age >= ttl) need.push(url);
  }

  for (let i = 0; i < need.length; i += CLASS_DETAIL_CONCURRENCY) {
    const slice = need.slice(i, i + CLASS_DETAIL_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (url) => {
        try {
          const detail = await fetchOneClassDetail(url, env);
          return { url, detail };
        } catch (err) {
          console.warn('[multiverse] class detail fetch failed:', url, err?.message || err);
          const prev = classes[url] || {};
          return {
            url,
            detail: {
              fetchedAt: new Date().toISOString(),
              isFull: prev.isFull === true,
              suggestedPrice:
                typeof prev.suggestedPrice === 'number' ? prev.suggestedPrice : null,
              payWhatYouCan: prev.payWhatYouCan === true,
              error: String(err?.message || err),
            },
          };
        }
      }),
    );
    for (const { url, detail } of results) {
      classes[url] = detail;
    }
  }

  if (need.length) {
    await writeClassDetailsCache(classes, env);
  }

  return {
    classes,
    refreshed: need.length,
    checked: unique.length,
  };
}

/**
 * Attach price fields and drop full classes.
 * @param {object[]} events
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
async function enrichMultiverseEventsWithClassDetails(events, env = process.env, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const classUrls = list
    .map((e) => String(e?.url || '').trim())
    .filter((u) => /themultiverse\.school\/classes\/\d+/i.test(u));
  const { classes, refreshed, checked } = await ensureMultiverseClassDetails(classUrls, env, opts);

  /** @type {object[]} */
  const kept = [];
  /** @type {string[]} */
  const removedFullIds = [];
  /** @type {string[]} */
  const fullClassUrls = [];

  for (const ev of list) {
    const url = String(ev?.url || '').trim();
    const detail = classes[url];
    if (!detail) {
      kept.push(ev);
      continue;
    }
    if (detail.isFull) {
      removedFullIds.push(String(ev.id || ''));
      if (url) fullClassUrls.push(url);
      continue;
    }
    const next = { ...ev };
    if (typeof detail.suggestedPrice === 'number' && detail.suggestedPrice >= 0) {
      next.price = detail.suggestedPrice;
      next.ticketPrice = detail.suggestedPrice;
    }
    if (detail.payWhatYouCan) {
      const amt =
        typeof detail.suggestedPrice === 'number' && detail.suggestedPrice > 0
          ? `suggested $${detail.suggestedPrice}`
          : 'suggested amount varies';
      next.description = `Pay what you can — ${amt}. Multiverse School.`;
      // So resolveEventPrice labels these as "$N donation" (PWYC).
      next.ticketsInfo = {
        price: detail.suggestedPrice,
        subtitle: 'Pay what you can',
      };
    } else if (typeof detail.suggestedPrice === 'number' && detail.suggestedPrice > 0) {
      next.description = `$${detail.suggestedPrice}. Multiverse School.`;
    }
    kept.push(next);
  }

  return {
    events: kept,
    removedFullIds: removedFullIds.filter(Boolean),
    fullClassUrls: [...new Set(fullClassUrls)],
    classDetailsRefreshed: refreshed,
    classDetailsChecked: checked,
    droppedFull: removedFullIds.length,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ title: string, url: string, date: string | null, titleKey: string }>>}
 */
async function fetchMultiverseClassIndex(env = process.env) {
  /** @type {Array<{ title: string, url: string, date: string | null, titleKey: string }>} */
  const merged = [];
  const seenUrl = new Set();
  for (const pageUrl of [
    MULTIVERSE_CALENDAR_PAGE_URL,
    MULTIVERSE_SITE_URL,
    MULTIVERSE_CLASSES_PAGE_URL,
  ]) {
    try {
      const r = await fetch(pageUrl, {
        headers: { Accept: 'text/html,*/*', 'User-Agent': UA },
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) continue;
      const html = await r.text();
      for (const row of parseMultiverseClassListings(html)) {
        if (seenUrl.has(row.url) && row.date == null) continue;
        const key = `${row.url}|${row.date || ''}`;
        if (seenUrl.has(key)) continue;
        seenUrl.add(key);
        if (row.date) seenUrl.add(row.url);
        merged.push(row);
      }
    } catch (err) {
      console.warn('[multiverse] class index fetch failed:', pageUrl, err?.message || err);
    }
  }
  return merged;
}

/**
 * Local YYYY-MM-DD in dashboard TZ.
 * @param {number} startMs
 * @param {string} timeZone
 */
function localDateKey(startMs, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(startMs));
  } catch {
    return new Date(startMs).toISOString().slice(0, 10);
  }
}

/**
 * @param {object} ev
 * @param {Array<{ title: string, url: string, date: string | null, titleKey: string }>} classIndex
 * @param {string} timeZone
 * @returns {string}
 */
function resolveMultiverseEventUrl(ev, classIndex, timeZone) {
  const titleKey = titleMatchKey(ev.title);
  const day = localDateKey(ev.startMs, timeZone);
  if (titleKey && classIndex.length) {
    const dated = classIndex.find((c) => c.titleKey === titleKey && c.date === day);
    if (dated?.url) return dated.url;
    // Title prefix / containment (ICS titles sometimes add subtitles).
    const datedLoose = classIndex.find(
      (c) =>
        c.date === day
        && (titleKey.startsWith(c.titleKey) || c.titleKey.startsWith(titleKey) || titleKey.includes(c.titleKey)),
    );
    if (datedLoose?.url) return datedLoose.url;
    const byTitle = classIndex.find((c) => c.titleKey === titleKey && c.date == null);
    if (byTitle?.url) return byTitle.url;
    const loose = classIndex.find(
      (c) =>
        titleKey.startsWith(c.titleKey)
        || c.titleKey.startsWith(titleKey)
        || titleKey.includes(c.titleKey),
    );
    if (loose?.url) return loose.url;
  }
  // Unique deep-link so skip/dedupe never collapses the whole calendar hub.
  const uid = Buffer.from(String(ev.id)).toString('base64url').slice(0, 48);
  return `${MULTIVERSE_CALENDAR_PAGE_URL}?uid=${uid}`;
}

/**
 * @param {object} ev ical event
 * @param {Array<{ title: string, url: string, date: string | null, titleKey: string }>} classIndex
 * @param {string} timeZone
 * @returns {object}
 */
function toFinderEvent(ev, classIndex, timeZone) {
  const loc = String(ev.location || '').trim();
  const locIsUrl = /^https?:\/\//i.test(loc);
  const url = locIsUrl ? loc : resolveMultiverseEventUrl(ev, classIndex, timeZone);
  // Multiverse School classes are online; standups/meetups may list a meet URL in LOCATION.
  const online = true;
  return {
    id: `multiverse:${Buffer.from(String(ev.id)).toString('base64url').slice(0, 48)}`,
    title: String(ev.title || 'Multiverse School').trim(),
    start: new Date(ev.startMs).toISOString(),
    end: ev.endMs != null ? new Date(ev.endMs).toISOString() : null,
    venue: locIsUrl ? 'Online — Multiverse School' : loc || 'Online — Multiverse School',
    city: null,
    lat: null,
    lon: null,
    url,
    source: 'multiverse',
    online,
    isOnline: online,
    location: locIsUrl ? 'Online — Multiverse School' : loc || 'Online — Multiverse School',
    description: null,
    imageUrl: null,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
/**
 * @param {object[]} rawEvents
 * @param {object} base
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean, fromCache?: boolean, stale?: boolean, error?: string | null }} [opts]
 */
async function finalizeMultiverseEvents(rawEvents, base, env = process.env, opts = {}) {
  const enriched = await enrichMultiverseEventsWithClassDetails(rawEvents, env, {
    forceRefresh: opts.forceRefresh === true,
  });
  const withClassUrl = enriched.events.filter((e) =>
    /\/classes\/\d+/.test(String(e.url || '')),
  ).length;
  return {
    ok: true,
    events: enriched.events,
    fromCache: opts.fromCache === true,
    stale: opts.stale === true,
    cachedAt: base.cachedAt || null,
    count: enriched.events.length,
    icalUrl: base.icalUrl,
    calendarPage: MULTIVERSE_CALENDAR_PAGE_URL,
    classIndexCount: base.classIndexCount ?? null,
    withClassUrl,
    droppedFull: enriched.droppedFull,
    removedFullIds: enriched.removedFullIds,
    fullClassUrls: enriched.fullClassUrls,
    classDetailsRefreshed: enriched.classDetailsRefreshed,
    classDetailsChecked: enriched.classDetailsChecked,
    error: opts.error || null,
  };
}

export async function fetchMultiverseSchoolEvents(env = process.env, opts = {}) {
  const force = opts.forceRefresh === true;
  const icalUrl = multiverseEventsIcalUrl(env);
  const cache = await readCache(env);
  if (!force && cache?.cachedAt) {
    const age = Date.now() - Date.parse(cache.cachedAt);
    if (Number.isFinite(age) && age >= 0 && age < cacheMs(env)) {
      const finalized = await finalizeMultiverseEvents(cache.events, cache, env, {
        fromCache: true,
        forceRefresh: false,
      });
      // Keep ICS cache in sync when classes fill up or prices change.
      if (
        finalized.droppedFull > 0
        || finalized.classDetailsRefreshed > 0
        || finalized.count !== cache.events.length
      ) {
        await writeCache(
          {
            ...cache,
            cachedAt: cache.cachedAt,
            count: finalized.events.length,
            withClassUrl: finalized.withClassUrl,
            events: finalized.events,
            droppedFull: finalized.droppedFull,
          },
          env,
        );
      }
      return finalized;
    }
  }

  let text = '';
  try {
    const r = await fetch(icalUrl, {
      headers: { Accept: 'text/calendar,text/plain,*/*', 'User-Agent': UA },
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      if (cache?.events?.length) {
        return finalizeMultiverseEvents(cache.events, cache, env, {
          fromCache: true,
          stale: true,
          error: `ical_http_${r.status}`,
        });
      }
      return {
        ok: false,
        events: [],
        fromCache: false,
        icalUrl,
        error: `ical_http_${r.status}`,
        removedFullIds: [],
        fullClassUrls: [],
        droppedFull: 0,
      };
    }
    text = await r.text();
  } catch (e) {
    if (cache?.events?.length) {
      return finalizeMultiverseEvents(cache.events, cache, env, {
        fromCache: true,
        stale: true,
        error: String(e?.message || e),
      });
    }
    return {
      ok: false,
      events: [],
      fromCache: false,
      icalUrl,
      error: String(e?.message || e),
      removedFullIds: [],
      fullClassUrls: [],
      droppedFull: 0,
    };
  }

  if (!/BEGIN:VCALENDAR/i.test(text)) {
    return {
      ok: false,
      events: [],
      fromCache: false,
      icalUrl,
      error: 'ical_not_calendar',
      removedFullIds: [],
      fullClassUrls: [],
      droppedFull: 0,
    };
  }

  const tz =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  let scrape = /** @type {{ windowWeeks?: number } | null} */ (null);
  try {
    const criteria = await loadEventsFinderCriteria();
    scrape = criteria.scrape || null;
  } catch {
    /* defaults */
  }
  const { futureDays, windowWeeks } = eventsIngestWindowDays(env, { scrape });
  const horizonMs = futureDays * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const parsed = parseIcsEvents(text, tz);
  const expanded = expandInWindow(parsed, nowMs, horizonMs);
  const upcoming = expanded
    .filter((ev) => effectiveEndMs(ev, nowMs) > nowMs - 12 * 60 * 60 * 1000)
    .filter((ev) => ev.startMs <= nowMs + horizonMs)
    .sort((a, b) => a.startMs - b.startMs);

  const classIndex = await fetchMultiverseClassIndex(env);
  const rawEvents = upcoming.map((ev) => toFinderEvent(ev, classIndex, tz));
  const finalized = await finalizeMultiverseEvents(
    rawEvents,
    {
      cachedAt: new Date().toISOString(),
      icalUrl,
      classIndexCount: classIndex.length,
    },
    env,
    { fromCache: false, forceRefresh: force },
  );

  await writeCache(
    {
      cachedAt: finalized.cachedAt || new Date().toISOString(),
      icalUrl,
      weeks: windowWeeks,
      futureDays,
      classIndexCount: classIndex.length,
      withClassUrl: finalized.withClassUrl,
      count: finalized.events.length,
      droppedFull: finalized.droppedFull,
      events: finalized.events,
    },
    env,
  );

  return finalized;
}
