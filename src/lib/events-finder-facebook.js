/**
 * Events finder — Facebook via Apify `facebook-events-scraper`.
 * Disk cache avoids a paid Actor run on every sidebar refresh.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEventsFinderCriteria, saveEventsFinderCriteria, facebookHostSlugKey } from './events-finder-criteria-store.js';
import { resolveEventsFinderGeo } from './events-finder-geo.js';
import { appendFacebookBillingRun } from './events-finder-facebook-billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

const DEFAULT_ACTOR = 'apify/facebook-events-scraper';
const DEFAULT_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 30;
const DEFAULT_WAIT_SECS = 180;

/** @type {Promise<object> | null} */
let inflightFetch = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function apifyToken(env = process.env) {
  return String(env.APIFY_TOKEN || env.APIFY_API_TOKEN || '').trim();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function apifyFacebookActorId(env = process.env) {
  const raw = String(env.APIFY_FACEBOOK_ACTOR_ID || DEFAULT_ACTOR).trim() || DEFAULT_ACTOR;
  return raw.includes('~') ? raw : raw.replace('/', '~');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function facebookEventsCachePath(env = process.env) {
  const override = String(env.FACEBOOK_EVENTS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'facebook-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function facebookEventsCacheMs(env = process.env) {
  const n = Number(env.FACEBOOK_EVENTS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 7 * 24 * 60 * 60 * 1000);
  return DEFAULT_CACHE_MS;
}

/**
 * Effective cache TTL: criteria scrape.cacheHours wins unless env override is set.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ cacheHours?: number }} [scrape]
 */
function effectiveCacheMs(env = process.env, scrape = {}) {
  const envOverride = String(env.FACEBOOK_EVENTS_CACHE_MS || '').trim();
  if (envOverride) return facebookEventsCacheMs(env);
  const hours = Number(scrape.cacheHours);
  if (Number.isFinite(hours) && hours >= 1) {
    return Math.min(Math.round(hours * 60 * 60 * 1000), 7 * 24 * 60 * 60 * 1000);
  }
  return facebookEventsCacheMs(env);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function facebookEventsMaxEvents(env = process.env) {
  const n = Number(env.FACEBOOK_EVENTS_MAX_EVENTS);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.round(n), 100);
  return DEFAULT_MAX_EVENTS;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function facebookWaitSecs(env = process.env) {
  const n = Number(env.FACEBOOK_EVENTS_WAIT_SECS);
  if (Number.isFinite(n) && n >= 30) return Math.min(Math.round(n), 300);
  return DEFAULT_WAIT_SECS;
}

/**
 * Cap Apify pay-per-event spend for one Actor run (Free plan is $5/mo).
 * @param {NodeJS.ProcessEnv} [env]
 */
function facebookMaxChargeUsd(env = process.env) {
  const n = Number(env.FACEBOOK_EVENTS_MAX_CHARGE_USD);
  if (Number.isFinite(n) && n >= 0.05) return Math.min(n, 20);
  return 1.5;
}

/**
 * @param {string} token
 * @param {string} apiPath
 * @param {RequestInit} [init]
 */
async function apifyFetch(token, apiPath, init = {}) {
  const url = apiPath.startsWith('http')
    ? apiPath
    : `https://api.apify.com/v2${apiPath}${apiPath.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: r.ok, status: r.status, json, text };
}

/**
 * Build searchQueries for Apify.
 * Prefer explicit scrape.searchQueries (editable in Settings). Env override wins.
 * Legacy fallback: first N Look for lines.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   city?: string | null,
 *   lookFor?: string,
 *   maxQueries?: number,
 *   searchQueries?: string[] | string,
 * }} [opts]
 * @returns {string[]}
 */
export function buildFacebookSearchQueries(env = process.env, opts = {}) {
  const maxQueries = Math.min(
    Math.max(Number(opts.maxQueries) || 3, 1),
    12,
  );

  const explicit = String(env.FACEBOOK_EVENTS_SEARCH_QUERIES || '')
    .split(/[\n,|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit.slice(0, maxQueries);

  const place = String(opts.city || env.FACEBOOK_EVENTS_LOCATION || 'San Francisco').trim()
    || 'San Francisco';

  /** @type {string[]} */
  let seeds = [];
  if (Array.isArray(opts.searchQueries) && opts.searchQueries.length) {
    seeds = opts.searchQueries.map((s) => String(s || '').trim()).filter(Boolean);
  } else if (typeof opts.searchQueries === 'string' && opts.searchQueries.trim()) {
    seeds = opts.searchQueries.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else {
    seeds = String(opts.lookFor || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  seeds = seeds.slice(0, maxQueries);

  if (!seeds.length) {
    return [
      `startup ${place}`,
      `hackathon ${place}`,
      `AI ${place}`,
      `community ${place}`,
    ].slice(0, maxQueries);
  }

  return seeds.map((line) => {
    const lower = line.toLowerCase();
    if (
      lower.includes('san francisco')
      || lower.includes('oakland')
      || lower.includes('berkeley')
      || lower.includes('emeryville')
      || lower.includes('bay area')
    ) {
      return line;
    }
    return `${line} ${place}`;
  });
}

/**
 * Normalize pinned hosts into Apify-compatible startUrls.
 * Prefer upcoming_hosted_events / groups/.../events (logged-out friendly).
 * When includePast is true, also add past_hosted_events for pages (for 6‑month avg stats).
 * @param {string | Array<{ url?: string } | string>} [pinnedHosts]
 * @param {{ includePast?: boolean }} [opts]
 * @returns {string[]}
 */
export function buildFacebookStartUrls(pinnedHosts = '', opts = {}) {
  const includePast = opts.includePast === true;
  /** @type {string[]} */
  const lines = [];
  if (typeof pinnedHosts === 'string') {
    for (const line of pinnedHosts.split('\n')) {
      const s = line.trim();
      if (s) lines.push(s);
    }
  } else if (Array.isArray(pinnedHosts)) {
    for (const item of pinnedHosts) {
      if (typeof item === 'string') {
        if (item.trim()) lines.push(item.trim());
      } else if (item && typeof item === 'object' && item.url) {
        const s = String(item.url).trim();
        if (s) lines.push(s);
      }
    }
  }

  /** @type {string[]} */
  const out = [];
  const seen = new Set();

  /**
   * @param {string} url
   */
  function pushUrl(url) {
    if (!url) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(url);
  }

  for (const line of lines.slice(0, 40)) {
    const bare = line.replace(/^https?:\/\//i, '').replace(/^www\./i, '');

    if (/^groups\//i.test(line) || /^groups\//i.test(bare)) {
      const slug = bare.replace(/^groups\//i, '').split('/')[0];
      if (slug) pushUrl(`https://www.facebook.com/groups/${slug}/events`);
    } else if (/facebook\.com\//i.test(line) || /^fb\.com\//i.test(bare)) {
      try {
        const href = /^https?:\/\//i.test(line) ? line : `https://${bare}`;
        const u = new URL(href);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'groups' && parts[1]) {
          pushUrl(`https://www.facebook.com/groups/${parts[1]}/events`);
        } else if (parts[0] === 'events' && parts[1] && /^\d+$/.test(parts[1])) {
          pushUrl(`https://www.facebook.com/events/${parts[1]}`);
        } else if (parts[0] && parts[0] !== 'events') {
          const page = parts[0];
          if (parts[1] === 'upcoming_hosted_events' || parts[1] === 'past_hosted_events') {
            pushUrl(`https://www.facebook.com/${page}/${parts[1]}`);
            if (includePast && parts[1] === 'upcoming_hosted_events') {
              pushUrl(`https://www.facebook.com/${page}/past_hosted_events`);
            }
          } else {
            pushUrl(`https://www.facebook.com/${page}/upcoming_hosted_events`);
            if (includePast) {
              pushUrl(`https://www.facebook.com/${page}/past_hosted_events`);
            }
          }
        }
      } catch {
        /* ignore bad URL */
      }
    } else if (/^[A-Za-z0-9._-]+$/.test(line)) {
      pushUrl(`https://www.facebook.com/${line}/upcoming_hosted_events`);
      if (includePast) {
        pushUrl(`https://www.facebook.com/${line}/past_hosted_events`);
      }
    }
  }

  return out;
}

/**
 * Stable fingerprint for cache invalidation when pins change.
 * @param {unknown} pinnedHosts
 */
function pinnedHostsFingerprint(pinnedHosts) {
  if (typeof pinnedHosts === 'string') return pinnedHosts.trim();
  if (!Array.isArray(pinnedHosts)) return '';
  return pinnedHosts
    .map((h) => {
      if (typeof h === 'string') return h.trim().toLowerCase();
      if (h && typeof h === 'object') return String(h.url || '').trim().toLowerCase();
      return '';
    })
    .filter(Boolean)
    .sort()
    .join('\n');
}

/**
 * Keep events inside the ingestion rolling window (+ optional earliest local time).
 * @param {object[]} events
 * @param {{ windowWeeks?: number, earliestLocalTime?: string | null }} scrape
 * @param {string} [timeZone]
 */
export function filterEventsByIngestWindow(events, scrape = {}, timeZone = 'America/Los_Angeles') {
  // Allow up to ~5 weeks so a 30-day first pass fits; default 4 weeks (~28–30d).
  const weeks = Math.min(Math.max(Number(scrape.windowWeeks) || 4, 1), 5);
  const horizonMs = weeks * 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const earliest = String(scrape.earliestLocalTime || '').trim();
  const earliestMatch = earliest.match(/^(\d{1,2}):(\d{2})$/);
  const earliestMinutes = earliestMatch
    ? Number(earliestMatch[1]) * 60 + Number(earliestMatch[2])
    : null;

  return (Array.isArray(events) ? events : []).filter((ev) => {
    const start = ev?.start;
    if (!start || !Number.isFinite(Date.parse(start))) return true;
    const t = Date.parse(start);
    if (t < now - 12 * 60 * 60 * 1000) return false;
    if (t > now + horizonMs) return false;
    if (earliestMinutes == null) return true;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(t));
      const hour = Number(parts.find((p) => p.type === 'hour')?.value);
      const minute = Number(parts.find((p) => p.type === 'minute')?.value);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true;
      return hour * 60 + minute >= earliestMinutes;
    } catch {
      return true;
    }
  });
}

/**
 * Avg events/month from host-matched events in the last 6 months.
 * @param {object[]} events
 * @param {Array<{ url: string, name: string, avgEventsPerMonth: number | null, avgComputedAt?: string | null }>} hosts
 */
export function updatePinnedHostAverages(events, hosts) {
  const now = Date.now();
  const sixMonthsMs = 183 * 24 * 60 * 60 * 1000; // ~6 months
  const computedAt = new Date().toISOString();

  return hosts.map((host) => {
    const key = facebookHostSlugKey(host.url);
    if (!key) return host;
    const needle = key.replace(/^groups\//, '').toLowerCase();
    let count = 0;
    for (const ev of events) {
      const startMs = ev?.start ? Date.parse(ev.start) : NaN;
      if (!Number.isFinite(startMs)) continue;
      if (startMs < now - sixMonthsMs || startMs > now + 7 * 24 * 60 * 60 * 1000) continue;
      const blob = JSON.stringify(ev?.raw || ev || {}).toLowerCase();
      if (blob.includes(needle) || blob.includes(key.toLowerCase())) count += 1;
    }
    // Only update when we saw at least one matching event (keep prior avg otherwise).
    if (!count && host.avgEventsPerMonth != null) {
      return host;
    }
    const avg = Math.round((count / 6) * 10) / 10;
    return {
      ...host,
      avgEventsPerMonth: avg,
      avgComputedAt: computedAt,
    };
  });
}

/**
 * @param {unknown} item
 * @returns {object | null}
 */
export function normalizeApifyFacebookItem(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = /** @type {Record<string, any>} */ (item);
  if (raw.isCanceled === true) return null;
  // Keep past events for pinned-host avg/mo (last 6 months); ingest window drops them later.

  const id = String(raw.id || '').trim();
  const url = String(raw.url || '').trim();
  if (!id && !url) return null;

  const title = String(raw.name || raw.title || '').trim();
  if (!title) return null;

  let start = raw.utcStartDate || raw.startTime || raw.start || null;
  if (start && typeof start === 'string' && !Number.isFinite(Date.parse(start))) {
    // Non-ISO display strings — drop start rather than invent a date
    start = raw.utcStartDate || null;
  }
  if (start && Number.isFinite(Date.parse(start))) {
    start = new Date(start).toISOString();
  } else {
    start = null;
  }

  const loc = raw.location && typeof raw.location === 'object' ? raw.location : null;
  const venue =
    (loc && (loc.name || loc.contextualName))
    || raw.address
    || null;
  let city = null;
  if (loc?.city) {
    city = String(loc.city).split(',')[0].trim() || null;
  } else if (typeof raw.address === 'string') {
    const m = raw.address.match(/,\s*([^,]+),\s*[A-Z]{2}\b/);
    if (m) city = m[1].trim();
  }

  const lat = Number(loc?.latitude);
  const lon = Number(loc?.longitude);

  const imageUrl = String(raw.imageUrl || raw.coverUrl || raw.photoUrl || '').trim() || null;
  const description = String(raw.description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400) || null;
  const usersGoing = Number(raw.usersGoing);
  const usersInterested = Number(raw.usersInterested);

  const ticketsInfo =
    raw.ticketsInfo && typeof raw.ticketsInfo === 'object' ? raw.ticketsInfo : null;
  const ticketPriceRaw = ticketsInfo?.price ?? raw.ticketPrice ?? raw.price ?? null;

  return {
    id: `facebook:${id || url}`,
    title,
    start,
    end: null,
    venue: venue ? String(venue).slice(0, 200) : null,
    city,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    url: url || (id ? `https://www.facebook.com/events/${id}` : ''),
    source: 'facebook',
    online: raw.isOnline === true,
    isOnline: raw.isOnline === true,
    isPast: raw.isPast === true,
    location: venue ? String(venue).slice(0, 200) : null,
    imageUrl,
    description,
    usersGoing: Number.isFinite(usersGoing) ? usersGoing : null,
    usersInterested: Number.isFinite(usersInterested) ? usersInterested : null,
    ticketsInfo,
    ticketPrice: ticketPriceRaw != null ? ticketPriceRaw : null,
    paidContent: raw.paidContent === true,
    raw,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(facebookEventsCachePath(env), 'utf8');
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
  const p = facebookEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {object | null} cache
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ cacheHours?: number }} [scrape]
 */
function cacheFresh(cache, env = process.env, scrape = {}) {
  if (!cache?.cachedAt) return false;
  const age = Date.now() - Date.parse(cache.cachedAt);
  if (!(Number.isFinite(age) && age >= 0 && age < effectiveCacheMs(env, scrape))) return false;
  // Invalidate when pinned hosts or keyword searches change.
  const wantPins = pinnedHostsFingerprint(scrape.pinnedHosts);
  const hadPins = pinnedHostsFingerprint(cache.pinnedHosts);
  if (wantPins !== hadPins) return false;
  const wantQ = JSON.stringify(scrape.searchQueries || []);
  const hadQ = JSON.stringify(cache.searchQueries || cache.scrape?.searchQueries || []);
  if (wantQ !== hadQ) return false;
  return true;
}

/**
 * Run Apify actor and normalize dataset items.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ searchQueries?: string[], force?: boolean }} [opts]
 */
async function runApifyFacebookScrape(env = process.env, opts = {}) {
  const token = apifyToken(env);
  if (!token || token.startsWith('REPLACE')) {
    return {
      ok: false,
      error: 'apify_not_configured',
      hint: 'Set APIFY_TOKEN in .env (Apify Console → Integrations)',
      events: [],
      fromCache: false,
    };
  }

  const criteria = await loadEventsFinderCriteria();
  const scrape = criteria.scrape || {};
  const geo = await resolveEventsFinderGeo(env);
  const searchQueries =
    opts.searchQueries
    || buildFacebookSearchQueries(env, {
      city: geo.city || 'San Francisco',
      lookFor: criteria.lookFor,
      maxQueries: scrape.maxQueries,
      searchQueries: scrape.searchQueries,
    });
  const startUrls = buildFacebookStartUrls(scrape.pinnedHosts, { includePast: true });

  // Need at least one discovery source.
  if (!searchQueries.length && !startUrls.length) {
    return {
      ok: false,
      error: 'apify_no_input',
      hint: 'Add Look for terms or Pinned Facebook hosts in Events criteria',
      events: [],
      fromCache: false,
      searchQueries,
      startUrls,
    };
  }

  const envMax = String(env.FACEBOOK_EVENTS_MAX_EVENTS || '').trim();
  const maxEvents = envMax
    ? facebookEventsMaxEvents(env)
    : Math.min(Math.max(Number(scrape.maxEventsPerQuery) || DEFAULT_MAX_EVENTS, 1), 100);

  const actorId = apifyFacebookActorId(env);
  const wait = facebookWaitSecs(env);
  const maxChargeUsd = facebookMaxChargeUsd(env);

  const input = {
    searchQueries,
    startUrls,
    maxEvents,
  };

  // Start a run (so we can read usageTotalUsd), wait, then fetch dataset items.
  const startPath =
    `/acts/${encodeURIComponent(actorId)}/runs`
    + `?waitForFinish=${wait}`
    + `&timeout=${wait + 30}`
    + `&maxTotalChargeUsd=${encodeURIComponent(String(maxChargeUsd))}`
    + `&maxItems=${encodeURIComponent(String(maxEvents))}`;

  const runRes = await apifyFetch(token, startPath, {
    method: 'POST',
    body: JSON.stringify(input),
  });

  const runData = runRes.json?.data && typeof runRes.json.data === 'object'
    ? runRes.json.data
    : runRes.json && typeof runRes.json === 'object' && runRes.json.id
      ? runRes.json
      : null;

  if (!runRes.ok || !runData?.defaultDatasetId) {
    const errMsg =
      runRes.json?.error?.message
      || runRes.json?.error
      || (typeof runRes.json === 'string' ? runRes.json : null)
      || runRes.text?.slice(0, 200)
      || `HTTP ${runRes.status}`;
    return {
      ok: false,
      error: 'apify_run_failed',
      hint: String(errMsg).slice(0, 240),
      events: [],
      fromCache: false,
      searchQueries,
      startUrls,
    };
  }

  const datasetId = String(runData.defaultDatasetId);
  const itemsRes = await apifyFetch(
    token,
    `/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=1`,
  );
  if (!itemsRes.ok) {
    return {
      ok: false,
      error: 'apify_dataset_failed',
      hint: `Could not read Apify dataset (${itemsRes.status})`,
      events: [],
      fromCache: false,
      searchQueries,
      startUrls,
    };
  }

  const items = Array.isArray(itemsRes.json)
    ? itemsRes.json
    : Array.isArray(itemsRes.json?.data)
      ? itemsRes.json.data
      : [];
  /** @type {object[]} */
  const eventsRaw = [];
  const seen = new Set();
  for (const item of items) {
    const norm = normalizeApifyFacebookItem(item);
    if (!norm) continue;
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    eventsRaw.push(norm);
  }

  const timeZone =
    String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const events = filterEventsByIngestWindow(eventsRaw, scrape, timeZone);

  let chargeUsd =
    runData.usageTotalUsd != null && Number.isFinite(Number(runData.usageTotalUsd))
      ? Number(runData.usageTotalUsd)
      : null;
  let estimated = false;
  if (chargeUsd == null && items.length) {
    // Fallback estimate when Apify omits usage on the run object.
    const perEvent = Number(env.FACEBOOK_EVENTS_EST_USD_PER_EVENT);
    const rate = Number.isFinite(perEvent) && perEvent > 0 ? perEvent : 0.04;
    chargeUsd = Math.min(maxChargeUsd, Math.round(items.length * rate * 10000) / 10000);
    estimated = true;
  }

  try {
    await appendFacebookBillingRun(
      {
        runAt: runData.finishedAt || runData.startedAt || new Date().toISOString(),
        chargeUsd,
        runId: runData.id ? String(runData.id) : null,
        eventsBilled: items.length,
        eventsKept: events.length,
        searchQueries,
        startUrls,
        estimated,
      },
      env,
    );
  } catch (billErr) {
    console.warn('[facebook-events] billing log failed:', billErr?.message || billErr);
  }

  // Refresh avg events/month from last-6-months matches (includes past_hosted_events).
  if (Array.isArray(scrape.pinnedHosts) && scrape.pinnedHosts.length) {
    try {
      const updatedHosts = updatePinnedHostAverages(eventsRaw, scrape.pinnedHosts);
      await saveEventsFinderCriteria({
        lookFor: criteria.lookFor,
        skip: criteria.skip,
        scrape: { ...scrape, pinnedHosts: updatedHosts },
      });
      scrape.pinnedHosts = updatedHosts;
    } catch (avgErr) {
      console.warn('[facebook-events] pinned avg update failed:', avgErr?.message || avgErr);
    }
  }

  const payload = {
    cachedAt: new Date().toISOString(),
    searchQueries,
    startUrls,
    pinnedHosts: scrape.pinnedHosts,
    actorId: actorId.replace('~', '/'),
    maxEvents,
    scrape,
    chargeUsd,
    runId: runData.id || null,
    count: events.length,
    events,
  };
  await writeCache(payload, env);

  return {
    ok: true,
    events,
    fromCache: false,
    searchQueries,
    startUrls,
    scanned: items.length,
    count: events.length,
    chargeUsd,
    scrape,
  };
}

/**
 * Cached Facebook events for the sidebar feed.
 * Never blocks the feed on a cold Apify run — scrapes in the background and
 * reuses disk cache / returns empty + refreshing hint until ready.
 * Use forceRefresh=true to wait for a live run (manual / ?refreshFacebook=1).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function fetchFacebookEvents(env = process.env, opts = {}) {
  const force = opts.forceRefresh === true;
  const token = apifyToken(env);
  if (!token || token.startsWith('REPLACE')) {
    return {
      ok: false,
      error: 'apify_not_configured',
      hint: 'Set APIFY_TOKEN in .env (Apify Console → Integrations)',
      events: [],
      fromCache: false,
    };
  }

  const criteria = await loadEventsFinderCriteria();
  const scrape = criteria.scrape || {};
  const cache = await readCache(env);

  if (!force && cacheFresh(cache, env, scrape)) {
    const timeZone =
      String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
    const events = filterEventsByIngestWindow(cache.events, scrape, timeZone);
    return {
      ok: true,
      events,
      fromCache: true,
      cachedAt: cache.cachedAt,
      searchQueries: cache.searchQueries || [],
      startUrls: cache.startUrls || [],
      scanned: cache.count ?? cache.events.length,
      count: events.length,
      scrape,
    };
  }

  const kickoffBackground = () => {
    if (inflightFetch) return inflightFetch;
    inflightFetch = (async () => {
      try {
        return await runApifyFacebookScrape(env);
      } finally {
        inflightFetch = null;
      }
    })();
    return inflightFetch;
  };

  if (force) {
    const result = await kickoffBackground();
    if (!result.ok) {
      if (cache?.events?.length) {
        return {
          ok: true,
          events: cache.events,
          fromCache: true,
          stale: true,
          cachedAt: cache.cachedAt,
          searchQueries: cache.searchQueries || [],
          startUrls: cache.startUrls || [],
          hint: result.hint,
          error: result.error,
          count: cache.events.length,
          scrape,
        };
      }
      return { ...result, scrape };
    }
    return result;
  }

  // Weekly schedule owns paid runs — don't scrape on every sidebar open.
  if (facebookWeeklyEnabled(env) && cache?.events?.length) {
    return {
      ok: true,
      events: cache.events,
      fromCache: true,
      stale: true,
      cachedAt: cache.cachedAt,
      searchQueries: cache.searchQueries || [],
      startUrls: cache.startUrls || [],
      scanned: cache.count ?? cache.events.length,
      count: cache.events.length,
      scrape,
      hint: 'Waiting for Tuesday-night Facebook refresh',
    };
  }

  // Non-blocking: refresh in background; serve stale cache or empty placeholder.
  void kickoffBackground();

  if (cache?.events?.length) {
    return {
      ok: true,
      events: cache.events,
      fromCache: true,
      stale: !cacheFresh(cache, env, scrape),
      refreshing: true,
      cachedAt: cache.cachedAt,
      searchQueries: cache.searchQueries || [],
      startUrls: cache.startUrls || [],
      scanned: cache.count ?? cache.events.length,
      count: cache.events.length,
      scrape,
    };
  }

  return {
    ok: true,
    events: [],
    fromCache: false,
    refreshing: true,
    hint: 'Facebook scrape started — refresh in a minute',
    searchQueries: [],
    startUrls: [],
    count: 0,
    scrape,
  };
}

/**
 * Settings ingest smoke test (cheap: token check + cache; optional live run).
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function probeFacebookEventsIntake(env = process.env) {
  const token = apifyToken(env);
  if (!token || token.startsWith('REPLACE')) {
    return {
      ok: false,
      ingestOk: null,
      active: true,
      value: 'Apify not configured',
      output: 'Public Facebook Events via Apify actor — set APIFY_TOKEN',
      ingestTest: 'Not wired — set APIFY_TOKEN in .env',
      count: 0,
    };
  }

  // Validate token without starting a scrape.
  const me = await apifyFetch(token, '/users/me');
  if (!me.ok) {
    return {
      ok: false,
      ingestOk: false,
      active: false,
      value: 'Apify token invalid',
      output: me.json?.error?.message || `HTTP ${me.status}`,
      ingestTest: `Fail — Apify auth HTTP ${me.status}`,
      count: 0,
    };
  }

  const cache = await readCache(env);
  if (cache && Array.isArray(cache.events)) {
    const criteria = await loadEventsFinderCriteria();
    const fresh = cacheFresh(cache, env, criteria.scrape || {});
    return {
      ok: true,
      ingestOk: cache.events.length > 0,
      active: true,
      value: `Apify ok · ${cache.events.length} cached${fresh ? '' : ' (stale)'}`,
      output: `Token valid · ${apifyFacebookActorId(env).replace('~', '/')} · feed refreshes cache`,
      ingestTest:
        cache.events.length > 0
          ? `Pass — ${cache.events.length} Facebook event(s) in cache${fresh ? '' : ' (stale)'}`
          : 'Weak — cache empty; open Events feed to scrape',
      count: cache.events.length,
      cachedAt: cache.cachedAt,
    };
  }

  // Avoid a paid Actor run from Settings refresh — feed load / weekly schedule scrapes.
  return {
    ok: true,
    ingestOk: null,
    active: true,
    value: 'Apify token ok · no cache yet',
    output: facebookWeeklyEnabled(env)
      ? 'Token valid · weekly Tuesday-night scrape (or ?refreshFacebook=1)'
      : 'Open the Events sidebar (or ?refreshFacebook=1) to run the Actor',
    ingestTest: facebookWeeklyEnabled(env)
      ? 'Ready — token ok; waits for Tuesday night (or force refresh)'
      : 'Ready — token ok; first feed load will scrape',
    count: 0,
  };
}

/**
 * Weekly Apify scrape (default: Tuesday 21:00 America/Los_Angeles).
 * Set FACEBOOK_EVENTS_WEEKLY=0 to disable.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function facebookWeeklyEnabled(env = process.env) {
  return String(env.FACEBOOK_EVENTS_WEEKLY ?? '1').trim() !== '0';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function facebookWeeklyTz(env = process.env) {
  return String(env.FACEBOOK_EVENTS_WEEKLY_TZ || env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dow: number, hour: number, minute: number }}
 *   dow: 0=Sun … 1=Mon … 6=Sat
 */
function facebookWeeklyWhen(env = process.env) {
  const dowRaw = Number(env.FACEBOOK_EVENTS_WEEKLY_DOW);
  const hourRaw = Number(env.FACEBOOK_EVENTS_WEEKLY_HOUR);
  const minuteRaw = Number(env.FACEBOOK_EVENTS_WEEKLY_MINUTE);
  return {
    dow: Number.isFinite(dowRaw) && dowRaw >= 0 && dowRaw <= 6 ? Math.round(dowRaw) : 2,
    hour: Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? Math.round(hourRaw) : 21,
    minute: Number.isFinite(minuteRaw) && minuteRaw >= 0 && minuteRaw <= 59 ? Math.round(minuteRaw) : 0,
  };
}

/**
 * Local calendar parts in the schedule timezone.
 * @param {Date} [now]
 * @param {string} [timeZone]
 */
export function facebookLocalParts(now = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  /** @type {Record<string, string>} */
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: wd[map.weekday] ?? -1,
    year: map.year,
    month: map.month,
    day: map.day,
    hour: Number(map.hour),
    minute: Number(map.minute),
    ymd: `${map.year}-${map.month}-${map.day}`,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Date} [now]
 */
export function shouldRunFacebookWeekly(env = process.env, now = new Date()) {
  if (!facebookWeeklyEnabled(env)) return false;
  if (!apifyToken(env) || apifyToken(env).startsWith('REPLACE')) return false;
  const when = facebookWeeklyWhen(env);
  const local = facebookLocalParts(now, facebookWeeklyTz(env));
  if (local.dow !== when.dow) return false;
  if (local.hour !== when.hour) return false;
  // Fire in the target minute window (poll is ~60s).
  if (local.minute < when.minute || local.minute > when.minute + 1) return false;
  return true;
}

/** @type {string | null} */
let lastWeeklyYmd = null;
/** @type {ReturnType<typeof setInterval> | null} */
let weeklyTimer = null;
let weeklyInFlight = false;

/**
 * Start Tuesday-night (configurable) Facebook Apify refresh.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startFacebookEventsWeeklyScheduler(env = process.env) {
  if (!facebookWeeklyEnabled(env)) {
    console.log('[facebook-events] weekly schedule disabled');
    return;
  }
  if (weeklyTimer) return;

  const when = facebookWeeklyWhen(env);
  const tz = facebookWeeklyTz(env);
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  console.log(
    `[facebook-events] weekly schedule: ${dowNames[when.dow]} ${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')} ${tz}`,
  );

  const tick = async () => {
    if (weeklyInFlight) return;
    if (!shouldRunFacebookWeekly(env)) return;
    const ymd = facebookLocalParts(new Date(), tz).ymd;
    if (lastWeeklyYmd === ymd) return;
    weeklyInFlight = true;
    lastWeeklyYmd = ymd;
    console.log(`[facebook-events] weekly scrape starting (${ymd})`);
    try {
      const result = await fetchFacebookEvents(env, { forceRefresh: true });
      console.log(
        `[facebook-events] weekly scrape done ok=${result.ok} count=${result.count ?? result.events?.length ?? 0}`
          + (result.hint ? ` hint=${result.hint}` : '')
          + (result.error ? ` error=${result.error}` : ''),
      );
    } catch (e) {
      console.warn('[facebook-events] weekly scrape failed', e?.message || e);
      // Allow retry later the same night if the run crashed before finishing.
      lastWeeklyYmd = null;
    } finally {
      weeklyInFlight = false;
    }
  };

  // Seed lastWeeklyYmd from cache so a restart mid-window does not double-bill.
  void readCache(env).then((cache) => {
    if (!cache?.cachedAt) return;
    const cachedLocal = facebookLocalParts(new Date(cache.cachedAt), tz);
    const nowLocal = facebookLocalParts(new Date(), tz);
    if (cachedLocal.ymd === nowLocal.ymd && cachedLocal.dow === facebookWeeklyWhen(env).dow) {
      lastWeeklyYmd = cachedLocal.ymd;
    }
  }).catch(() => {});

  weeklyTimer = setInterval(() => {
    void tick();
  }, 60_000);
  if (typeof weeklyTimer.unref === 'function') weeklyTimer.unref();
  // First check shortly after boot (in case we start during the window).
  setTimeout(() => {
    void tick();
  }, 15_000);
}
