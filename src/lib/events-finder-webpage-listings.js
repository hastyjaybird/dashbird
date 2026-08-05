/**
 * Events finder — generic public event-listing webpages.
 *
 * Reads Personal bookmarks → Events URLs that are not dedicated platform hosts
 * (Partiful, Luma, Meetup, Cool Happenings, …) and extracts upcoming events via:
 *   1) Google Calendar public ICS embeds on the page
 *   2) Squarespace eventlist HTML (+ optional ?format=json)
 *   3) JSON-LD schema.org Event blocks
 *
 * This is what makes Settings → + Event source actually feed the sidebar for
 * venue/community calendars (Artisans Asylum, Prescott Market, etc.).
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIcsEvents } from './ical-parse.js';
import { buildRRule } from './ical-recurrence.js';
import { parsePublicEventHtml } from './events-finder-public-pages.js';
import { assertPublicHttpUrl } from './public-http-url.js';
import { utcInstantFromOpenMeteoWallClock } from './open-meteo-wall-clock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const BOOKMARKS_PERSONAL = path.join(root, 'public/data/bookmarks-personal.json');

const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

/** Hosts with their own Events finder ingest — skip generic webpage listing. */
export const WEBPAGE_LISTING_SKIP_HOSTS = new Set([
  'partiful.com',
  'secretparty.io',
  'facebook.com',
  'fb.com',
  'lu.ma',
  'luma.com',
  'eventbrite.com',
  'meetup.com',
  'themultiverse.school',
  'dorkbotsf.org',
  'coolstuff.ju.mp',
  'fetlife.com',
  'mail.google.com',
  't.me',
  'telegram.org',
  'telegram.me',
  'calendar.google.com',
  'calendars.partiful.com',
  'google.com',
]);

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function webpageListingsCachePath(env = process.env) {
  const override = String(env.WEBPAGE_LISTINGS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'webpage-listings-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheMs(env = process.env) {
  const n = Number(env.WEBPAGE_LISTINGS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 7 * 24 * 60 * 60 * 1000);
  return DEFAULT_CACHE_MS;
}

/**
 * @param {string} href
 * @returns {string}
 */
function hostnameFromHref(href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.hostname.replace(/^www\./, '').toLowerCase();
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * @param {string} host
 */
export function isWebpageListingHost(host) {
  const h = String(host || '')
    .replace(/^www\./, '')
    .toLowerCase();
  if (!h) return false;
  if (WEBPAGE_LISTING_SKIP_HOSTS.has(h)) return false;
  for (const skip of WEBPAGE_LISTING_SKIP_HOSTS) {
    if (h === skip || h.endsWith(`.${skip}`)) return false;
  }
  return true;
}

/**
 * @param {string} key
 */
function hashKey(key) {
  return createHash('sha1').update(String(key || '')).digest('hex').slice(0, 12);
}

/**
 * @param {string} raw
 */
function decodeHtml(raw) {
  return String(raw || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Load bookmark listing pages (label + url) for generic webpage ingest.
 * @returns {Promise<Array<{ label: string, url: string, host: string }>>}
 */
export async function loadWebpageListingPins() {
  /** @type {Array<{ label: string, url: string, host: string }>} */
  const out = [];
  const seen = new Set();
  try {
    const raw = JSON.parse(await readFile(BOOKMARKS_PERSONAL, 'utf8'));
    /** @type {Array<{ word?: string, href?: string, title?: string }>} */
    let items = [];
    if (Array.isArray(raw?.sections)) {
      const section = raw.sections.find(
        (s) => String(s?.title || '').trim().toLowerCase() === 'events',
      );
      if (section && Array.isArray(section.items)) items = section.items;
    } else if (Array.isArray(raw)) {
      items = raw;
    }
    for (const item of items) {
      const url = typeof item.href === 'string' ? item.href.trim() : '';
      if (!/^https?:\/\//i.test(url)) continue;
      const host = hostnameFromHref(url);
      if (!isWebpageListingHost(host)) continue;
      const key = url.toLowerCase().replace(/\/+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const label = String(item.word || item.title || host || 'Web').trim();
      out.push({ label, url, host });
    }
  } catch {
    /* bookmarks missing — no pins */
  }

  // Away-base seed URLs (e.g. Climate Week NYC) when preview/auto Away is on.
  try {
    const { resolveActiveLocation } = await import('./resolve-active-location.js');
    const active = await resolveActiveLocation();
    if (active.mode === 'preview' || active.mode === 'away') {
      const seedPath = path.join(root, 'src/data/away-events-seed-urls.json');
      const seeds = JSON.parse(await readFile(seedPath, 'utf8'));
      const profileId = active.awayProfile?.id || '';
      const urls = Array.isArray(seeds?.[profileId])
        ? seeds[profileId]
        : Array.isArray(seeds?.['nyc-climate-week'])
          ? seeds['nyc-climate-week']
          : [];
      for (const url of urls) {
        const href = String(url || '').trim();
        if (!/^https?:\/\//i.test(href)) continue;
        const host = hostnameFromHref(href);
        if (!host) continue;
        const key = href.toLowerCase().replace(/\/+$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label: 'Away seed', url: href, host });
      }
    }
  } catch {
    /* no away seeds */
  }
  return out;
}

/**
 * Public Google Calendar ICS URLs from an embed iframe / link on a page.
 * @param {string} html
 * @returns {string[]}
 */
export function extractGoogleCalendarIcsUrls(html) {
  const text = String(html || '');
  /** @type {string[]} */
  const out = [];
  const seen = new Set();

  /**
   * @param {string} emailOrSrc
   */
  function pushCalendarId(emailOrSrc) {
    let id = String(emailOrSrc || '').trim();
    if (!id) return;
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep raw */
    }
    if (!/@group\.calendar\.google\.com$/i.test(id) && !/@gmail\.com$/i.test(id)) {
      // calendar embed src= is often base64 of the calendar id
      try {
        const padded = id + '='.repeat((4 - (id.length % 4)) % 4);
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        if (/@group\.calendar\.google\.com$/i.test(decoded) || /@gmail\.com$/i.test(decoded)) {
          id = decoded;
        }
      } catch {
        /* ignore */
      }
    }
    if (!/@/i.test(id)) return;
    const ics = `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
    if (seen.has(ics)) return;
    seen.add(ics);
    out.push(ics);
  }

  const srcRe =
    /(?:src|href)=["'](https?:\/\/calendar\.google\.com\/calendar\/[^"']+)["']/gi;
  let m;
  while ((m = srcRe.exec(text))) {
    try {
      const u = new URL(m[1]);
      for (const src of u.searchParams.getAll('src')) pushCalendarId(src);
      // Already an ICS URL
      if (/\/calendar\/ical\//i.test(u.pathname)) {
        const href = u.toString();
        if (!seen.has(href)) {
          seen.add(href);
          out.push(href);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Bare cid= / src= in JSON blobs
  const bareSrc = /["']src["']\s*:\s*["']([^"']+@group\.calendar\.google\.com)["']/gi;
  while ((m = bareSrc.exec(text))) pushCalendarId(m[1]);

  return out;
}

/**
 * @param {string} icsText
 * @param {{ label: string, pageUrl: string, source?: string }} meta
 * @returns {object[]}
 */
function eventsFromIcsText(icsText, meta) {
  const parsed = parseIcsEvents(icsText);
  const now = Date.now();
  const windowStart = now - 12 * 60 * 60 * 1000;
  const windowEnd = now + 90 * 24 * 60 * 60 * 1000;
  const source = meta.source || 'webpage';
  /** @type {object[]} */
  const events = [];

  for (const ev of parsed) {
    if (ev.status === 'CANCELLED') continue;
    /** @type {Array<{ startMs: number, endMs: number | null, id: string }>} */
    const occs = [];
    if (ev.rrule && !ev.recurrenceId) {
      try {
        const rule = buildRRule(ev.rrule, ev.dtstartKey, ev.dtstartVal, ev.exdates || []);
        const duration =
          ev.endMs != null && ev.endMs > ev.startMs
            ? ev.endMs - ev.startMs
            : ev.allDay
              ? 24 * 60 * 60 * 1000
              : 60 * 60 * 1000;
        for (const occ of rule.between(new Date(windowStart), new Date(windowEnd), true)) {
          const startMs = occ.getTime();
          occs.push({ startMs, endMs: startMs + duration, id: `${ev.id}@${startMs}` });
        }
      } catch {
        if (ev.startMs >= windowStart && ev.startMs <= windowEnd) {
          occs.push({ startMs: ev.startMs, endMs: ev.endMs ?? null, id: String(ev.id) });
        }
      }
    } else if (ev.startMs >= windowStart && ev.startMs <= windowEnd) {
      occs.push({ startMs: ev.startMs, endMs: ev.endMs ?? null, id: String(ev.id) });
    }

    for (const occ of occs) {
      const loc = String(ev.location || '').trim();
      const desc = String(ev.description || '').trim();
      const title = String(ev.title || meta.label || 'Event').trim().slice(0, 500);
      const idSeed = `${meta.pageUrl}|${title}|${occ.startMs}|${ev.id || ''}`;
      events.push({
        id: `${source}:${hashKey(idSeed)}`,
        title,
        start: new Date(occ.startMs).toISOString(),
        end: occ.endMs != null ? new Date(occ.endMs).toISOString() : null,
        venue: loc && !/^https?:\/\//i.test(loc) ? loc.slice(0, 200) : null,
        city: null,
        lat: null,
        lon: null,
        url: meta.pageUrl,
        source,
        online: /^https?:\/\//i.test(loc),
        isOnline: /^https?:\/\//i.test(loc),
        location: loc && !/^https?:\/\//i.test(loc) ? loc.slice(0, 200) : null,
        description: desc.replace(/\s+/g, ' ').slice(0, 400) || null,
        imageUrl: null,
        calendarName: meta.label,
        raw: {
          via: 'webpage_gcal_ics',
          pageUrl: meta.pageUrl,
          label: meta.label,
          gcalUid: String(ev.id || ''),
        },
      });
    }
  }
  return events;
}

/**
 * Combine a date-only datetime with a wall-clock time label in an IANA zone.
 * @param {string} dateIso  YYYY-MM-DD
 * @param {string} timeLabel e.g. 7:00 PM
 * @param {string} [timeZone]
 * @returns {string | null}
 */
function combineDateAndTimeLabel(dateIso, timeLabel, timeZone = 'America/Los_Angeles') {
  const d = String(dateIso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = String(timeLabel || '')
    .replace(/\u202f/g, ' ')
    .trim();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  let hour = 12;
  let minute = 0;
  if (m) {
    hour = Number(m[1]);
    minute = Number(m[2] || 0);
    const ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && hour < 12) hour += 12;
    if (ap === 'AM' && hour === 12) hour = 0;
  }
  const wall = `${d}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const instant = utcInstantFromOpenMeteoWallClock(wall, timeZone);
  return instant && !Number.isNaN(instant.getTime()) ? instant.toISOString() : null;
}

/**
 * Squarespace /events listing articles.
 * @param {string} html
 * @param {{ label: string, pageUrl: string, source?: string }} meta
 * @returns {object[]}
 */
export function parseSquarespaceEventListHtml(html, meta) {
  const source = meta.source || 'webpage';
  const timeZone = meta.timeZone || 'America/Los_Angeles';
  /** @type {object[]} */
  const events = [];
  const seen = new Set();
  const articles = String(html || '').match(
    /<article[^>]*class="[^"]*eventlist-event[^"]*"[\s\S]*?<\/article>/gi,
  ) || [];

  let baseHost = '';
  try {
    baseHost = new URL(meta.pageUrl).origin;
  } catch {
    baseHost = '';
  }

  for (const article of articles) {
    if (/eventlist-event--past/i.test(article)) continue;
    const hrefMatch =
      article.match(
        /eventlist-title[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
      )
      || article.match(/<a[^>]*href=["']([^"']*\/events\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!hrefMatch) continue;
    let href = hrefMatch[1].trim();
    if (href.startsWith('/')) href = `${baseHost}${href}`;
    if (!/^https?:\/\//i.test(href)) continue;
    const title = decodeHtml(hrefMatch[2].replace(/<[^>]+>/g, ' '));
    if (!title || title.length < 2) continue;

    const times = [
      ...article.matchAll(/<time[^>]*datetime=["']([^"']+)["'][^>]*>([^<]*)<\/time>/gi),
    ].map((x) => ({ datetime: x[1], label: decodeHtml(x[2]) }));

    let startIso = null;
    const dateOnly = times.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.datetime));
    const timeLabel = times.find((t) => /\d{1,2}:\d{2}/.test(t.label) || /[ap]m/i.test(t.label));
    if (dateOnly && timeLabel) {
      startIso = combineDateAndTimeLabel(dateOnly.datetime, timeLabel.label, timeZone);
    } else if (dateOnly) {
      startIso = combineDateAndTimeLabel(dateOnly.datetime, '', timeZone);
    } else if (times[0]) {
      const d = new Date(times[0].datetime);
      if (!Number.isNaN(d.getTime())) startIso = d.toISOString();
    }

    const key = `${title.toLowerCase()}|${startIso || ''}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const imgMatch = article.match(/data-src=["']([^"']+)["']/i) || article.match(/src=["'](https?:\/\/images\.squarespace-cdn\.com[^"']+)["']/i);

    events.push({
      id: `${source}:${hashKey(key)}`,
      title: title.slice(0, 500),
      start: startIso,
      end: null,
      venue: meta.label || null,
      city: null,
      lat: null,
      lon: null,
      url: href.split('?')[0],
      source,
      online: false,
      isOnline: false,
      location: meta.label || null,
      description: null,
      imageUrl: imgMatch ? imgMatch[1] : null,
      calendarName: meta.label,
      raw: { via: 'squarespace_eventlist', pageUrl: meta.pageUrl, label: meta.label },
    });
  }
  return events;
}

/**
 * Squarespace collection JSON (`?format=json`) upcoming items.
 * @param {unknown} data
 * @param {{ label: string, pageUrl: string, source?: string }} meta
 * @returns {object[]}
 */
export function parseSquarespaceEventsJson(data, meta) {
  if (!data || typeof data !== 'object') return [];
  const obj = /** @type {Record<string, unknown>} */ (data);
  const upcoming = Array.isArray(obj.upcoming) ? obj.upcoming : [];
  const source = meta.source || 'webpage';
  let origin = '';
  try {
    origin = new URL(meta.pageUrl).origin;
  } catch {
    origin = '';
  }
  /** @type {object[]} */
  const events = [];
  const now = Date.now();
  const horizon = now + 90 * 24 * 60 * 60 * 1000;

  for (const item of upcoming) {
    if (!item || typeof item !== 'object') continue;
    const it = /** @type {Record<string, any>} */ (item);
    const title = String(it.title || '').trim();
    if (!title) continue;
    const startMs = Number(it.startDate || it.structuredContent?.startDate);
    if (!Number.isFinite(startMs) || startMs < now - 12 * 60 * 60 * 1000 || startMs > horizon) {
      continue;
    }
    let endMs = Number(it.endDate || it.structuredContent?.endDate);
    // Squarespace series often set endDate to the series end (months later) — drop that.
    if (!Number.isFinite(endMs) || endMs - startMs > 7 * 24 * 60 * 60 * 1000) {
      endMs = NaN;
    }
    const pathPart = String(it.fullUrl || it.urlId || '').trim();
    let url = meta.pageUrl;
    if (pathPart.startsWith('http')) url = pathPart;
    else if (pathPart.startsWith('/')) url = `${origin}${pathPart}`;
    else if (pathPart) url = `${origin}/events/${pathPart}`;

    const loc = it.location && typeof it.location === 'object' ? it.location : null;
    const lat = loc && Number.isFinite(Number(loc.markerLat)) ? Number(loc.markerLat) : null;
    const lon = loc && Number.isFinite(Number(loc.markerLng)) ? Number(loc.markerLng) : null;
    const venueBits = [loc?.addressTitle, loc?.addressLine1, loc?.addressLine2]
      .map((s) => String(s || '').trim())
      .filter(Boolean);

    events.push({
      id: `${source}:${hashKey(`${url}|${title}|${startMs}`)}`,
      title: title.slice(0, 500),
      start: new Date(startMs).toISOString(),
      end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
      venue: venueBits.join(', ').slice(0, 200) || meta.label || null,
      city: null,
      lat,
      lon,
      url,
      source,
      online: false,
      isOnline: false,
      location: venueBits.join(', ').slice(0, 200) || meta.label || null,
      description: String(it.excerpt || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400) || null,
      imageUrl: null,
      calendarName: meta.label,
      raw: { via: 'squarespace_json', pageUrl: meta.pageUrl, label: meta.label },
    });
  }
  return events;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function fetchText(url, timeoutMs = 25000) {
  const safe = await assertPublicHttpUrl(url);
  const r = await fetch(safe, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/calendar,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, finalUrl: r.url || safe };
}

/**
 * @param {{ label: string, url: string, host: string }} pin
 * @returns {Promise<{ ok: boolean, events: object[], error?: string, via?: string[] }>}
 */
export async function fetchOneWebpageListing(pin, env = process.env) {
  const tz = String(env.WEATHER_TIME_ZONE || env.EVENTS_FINDER_TIME_ZONE || 'America/Los_Angeles');
  const meta = { label: pin.label, pageUrl: pin.url, source: 'webpage', timeZone: tz };
  /** @type {object[]} */
  const events = [];
  /** @type {string[]} */
  const via = [];
  /** @type {string | undefined} */
  let error;

  let html = '';
  try {
    const page = await fetchText(pin.url);
    if (!page.ok) {
      return { ok: false, events: [], error: `http_${page.status}` };
    }
    html = page.text;
    meta.pageUrl = page.finalUrl || pin.url;
  } catch (e) {
    return { ok: false, events: [], error: String(e?.message || e) };
  }

  // Squarespace eventlist HTML (per-occurrence rows with detail URLs).
  const fromSqHtml = parseSquarespaceEventListHtml(html, meta);
  if (fromSqHtml.length) {
    events.push(...fromSqHtml);
    via.push('squarespace_html');
  }

  // Google Calendar public ICS embeds — often the real upcoming feed when the
  // Squarespace list is thin/stale (Artisans Asylum; sometimes Prescott).
  const icsUrls = extractGoogleCalendarIcsUrls(html);
  for (const icsUrl of icsUrls.slice(0, 4)) {
    try {
      const ics = await fetchText(icsUrl, 45000);
      if (!ics.ok || !/BEGIN:VCALENDAR/i.test(ics.text)) continue;
      const fromIcs = eventsFromIcsText(ics.text, meta);
      if (fromIcs.length) {
        events.push(...fromIcs);
        via.push('gcal_ics');
      }
    } catch (e) {
      error = String(e?.message || e);
    }
  }

  if (!events.length) {
    try {
      const jsonUrl = new URL(meta.pageUrl);
      jsonUrl.searchParams.set('format', 'json');
      const j = await fetchText(jsonUrl.toString());
      if (j.ok) {
        try {
          const data = JSON.parse(j.text);
          const fromJson = parseSquarespaceEventsJson(data, meta);
          if (fromJson.length) {
            events.push(...fromJson);
            via.push('squarespace_json');
          }
        } catch {
          /* not json */
        }
      }
    } catch (e) {
      error = String(e?.message || e);
    }
  }

  if (!events.length) {
    const fromLd = parsePublicEventHtml(html, 'webpage', meta.pageUrl).map((ev) => ({
      ...ev,
      source: 'webpage',
      calendarName: meta.label,
      raw: {
        ...(ev.raw && typeof ev.raw === 'object' ? ev.raw : {}),
        via: 'json_ld',
        pageUrl: meta.pageUrl,
        label: meta.label,
      },
    }));
    if (fromLd.length) {
      events.push(...fromLd);
      via.push('json_ld');
    }
  }

  // Dedupe within page by title + start instant; prefer rows with a detail URL.
  const byKey = new Map();
  const now = Date.now() - 12 * 60 * 60 * 1000;
  const horizon = Date.now() + 90 * 24 * 60 * 60 * 1000;
  for (const ev of events) {
    if (ev.start) {
      const ms = Date.parse(ev.start);
      if (!Number.isFinite(ms) || ms < now || ms > horizon) continue;
    }
    const titleKey = String(ev.title || '')
      .toLowerCase()
      .trim();
    const startKey = String(ev.start || '');
    const key = `${titleKey}|${startKey}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, ev);
      continue;
    }
    const prevUrl = String(prev.url || '');
    const nextUrl = String(ev.url || '');
    const prevDetail = /\/events\//i.test(prevUrl) && prevUrl !== meta.pageUrl;
    const nextDetail = /\/events\//i.test(nextUrl) && nextUrl !== meta.pageUrl;
    if (nextDetail && !prevDetail) byKey.set(key, ev);
  }

  return {
    ok: byKey.size > 0,
    events: [...byKey.values()],
    via,
    error: byKey.size ? undefined : error || 'no_events_parsed',
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(webpageListingsCachePath(env), 'utf8');
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
  const p = webpageListingsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Fetch all bookmarked webpage listing sources.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function fetchWebpageListingEvents(env = process.env, opts = {}) {
  const pins = await loadWebpageListingPins();
  const cache = await readCache(env);
  const cachedAt = Date.parse(String(cache?.cachedAt || ''));
  const fresh =
    !opts.forceRefresh
    && cache
    && Number.isFinite(cachedAt)
    && Date.now() - cachedAt < cacheMs(env)
    && Array.isArray(cache.pinUrls)
    && cache.pinUrls.length === pins.length
    && pins.every((p) => cache.pinUrls.includes(p.url));

  if (fresh) {
    return {
      ok: true,
      events: cache.events,
      fromCache: true,
      stale: false,
      cachedAt: cache.cachedAt,
      count: cache.events.length,
      pins: pins.map((p) => p.url),
      pagesOk: cache.pagesOk ?? pins.length,
      pagesFailed: cache.pagesFailed ?? 0,
    };
  }

  if (!pins.length) {
    const payload = {
      cachedAt: new Date().toISOString(),
      pinUrls: [],
      events: [],
      pagesOk: 0,
      pagesFailed: 0,
    };
    await writeCache(payload, env);
    return {
      ok: true,
      events: [],
      fromCache: false,
      stale: false,
      cachedAt: payload.cachedAt,
      count: 0,
      pins: [],
      pagesOk: 0,
      pagesFailed: 0,
      hint: 'Add a venue/community events URL via Settings → + Event source',
    };
  }

  /** @type {object[]} */
  const all = [];
  let pagesOk = 0;
  let pagesFailed = 0;
  /** @type {Array<{ url: string, label: string, ok: boolean, count: number, via?: string[], error?: string }>} */
  const pageResults = [];

  for (const pin of pins) {
    const result = await fetchOneWebpageListing(pin, env);
    pageResults.push({
      url: pin.url,
      label: pin.label,
      ok: result.ok,
      count: result.events.length,
      via: result.via,
      error: result.error,
    });
    if (result.ok) {
      pagesOk += 1;
      all.push(...result.events);
    } else {
      pagesFailed += 1;
    }
  }

  const payload = {
    cachedAt: new Date().toISOString(),
    pinUrls: pins.map((p) => p.url),
    events: all,
    pagesOk,
    pagesFailed,
    pageResults,
  };
  await writeCache(payload, env);

  return {
    ok: all.length > 0 || pagesOk > 0,
    events: all,
    fromCache: false,
    stale: false,
    cachedAt: payload.cachedAt,
    count: all.length,
    pins: pins.map((p) => p.url),
    pagesOk,
    pagesFailed,
    pageResults,
  };
}
