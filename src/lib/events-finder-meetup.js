/**
 * Events finder — Meetup group pins from docs/meetup-group-pins.md.
 * Public /events/ pages → __NEXT_DATA__ / Apollo Event nodes → normalized catalog rows.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const PINS_DOC = path.join(root, 'docs', 'meetup-group-pins.md');

const UA =
  'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function meetupEventsCachePath(env = process.env) {
  const override = String(env.MEETUP_EVENTS_CACHE_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(root, override);
  }
  return path.join(root, 'data', 'meetup-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function meetupCacheTtlMs(env = process.env) {
  const raw = Number(env.MEETUP_EVENTS_CACHE_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  // Default 6h — 50+ group pages are slow to refresh every sidebar open.
  return 6 * 60 * 60 * 1000;
}

/**
 * Normalize a Meetup group URL to https://www.meetup.com/<slug>/
 * @param {string} href
 * @returns {string | null}
 */
export function normalizeMeetupGroupUrl(href) {
  try {
    const u = new URL(String(href || '').trim());
    if (!/^https?:$/i.test(u.protocol)) return null;
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'meetup.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const slug = parts[0];
    if (!slug || slug === 'find' || slug === 'login' || slug === 'apps') return null;
    return `https://www.meetup.com/${slug}/`;
  } catch {
    return null;
  }
}

/**
 * Load pin URLs from docs/meetup-group-pins.md (## Pins section).
 * @param {string} [docPath]
 * @returns {Promise<string[]>}
 */
export async function loadMeetupGroupPins(docPath = PINS_DOC) {
  let md = '';
  try {
    md = await readFile(docPath, 'utf8');
  } catch {
    return [];
  }
  const idx = md.search(/^##\s+Pins\s*$/m);
  const body = idx >= 0 ? md.slice(idx) : md;
  const next = body.slice(3).search(/^##\s+/m);
  const section = next > 0 ? body.slice(0, next + 3) : body;

  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
    const m = trimmed.match(/https?:\/\/[^\s)\]]+/i);
    if (!m) continue;
    const norm = normalizeMeetupGroupUrl(m[0]);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, html: string, err?: string }>}
 */
async function fetchHtml(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } catch (e) {
    return { ok: false, status: 0, html: '', err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} html
 * @returns {Record<string, any> | null}
 */
function extractApolloState(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i,
  );
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    const apollo = data?.props?.pageProps?.__APOLLO_STATE__;
    return apollo && typeof apollo === 'object' ? apollo : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Meetup Apollo photo field (string URL, inline PhotoInfo, or {__ref}).
 * Prefer featuredEventPhoto; callers should also pass displayPhoto as fallback —
 * listing pages often set featuredEventPhoto null while displayPhoto still points
 * at the event graphic.
 * @param {unknown} photo
 * @param {Record<string, any>} apollo
 * @returns {string | null}
 */
function resolveMeetupPhotoUrl(photo, apollo) {
  if (!photo) return null;
  if (typeof photo === 'string') {
    return /^https?:\/\//i.test(photo) ? photo.slice(0, 2000) : null;
  }
  if (typeof photo !== 'object') return null;

  const ref = /** @type {{ __ref?: unknown }} */ (photo).__ref;
  const P =
    typeof ref === 'string' && apollo && apollo[ref] && typeof apollo[ref] === 'object'
      ? apollo[ref]
      : photo;

  // Do not use baseUrl alone — Meetup's classic-events base is a directory prefix
  // and 404s without a concrete photo path (highResUrl / standardUrl carry the file).
  const url = String(
    P.highResUrl || P.standardUrl || P.url || P.source || '',
  )
    .trim()
    .slice(0, 2000);
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * @param {Record<string, any>} apollo
 * @param {string} groupUrl
 * @returns {object[]}
 */
export function eventsFromMeetupApollo(apollo, groupUrl) {
  if (!apollo || typeof apollo !== 'object') return [];
  const groupSlug =
    normalizeMeetupGroupUrl(groupUrl)?.replace(/^https:\/\/www\.meetup\.com\//, '').replace(/\/$/, '')
    || '';

  /** @type {object[]} */
  const events = [];
  const now = Date.now();

  for (const [key, node] of Object.entries(apollo)) {
    if (!key.startsWith('Event:') || !node || typeof node !== 'object') continue;
    if (node.__typename && node.__typename !== 'Event') continue;
    if (node.status && String(node.status).toUpperCase() !== 'ACTIVE') continue;

    const title = String(node.title || '').trim();
    const eventUrl = String(node.eventUrl || '').trim();
    const id = String(node.id || key.replace(/^Event:/, '')).trim();
    if (!title || (!eventUrl && !id)) continue;

    const startRaw = node.dateTime || node.startTime || null;
    const endRaw = node.endTime || null;
    const startMs = startRaw ? Date.parse(String(startRaw)) : NaN;
    if (Number.isFinite(startMs) && startMs < now - 2 * 24 * 60 * 60 * 1000) continue;

    let venue = null;
    let city = null;
    let lat = null;
    let lon = null;
    const venueRef = node.venue?.__ref || (typeof node.venue === 'string' ? node.venue : null);
    if (venueRef && apollo[venueRef]) {
      const V = apollo[venueRef];
      venue = String(V.name || V.address || '').trim() || null;
      city = String(V.city || '').trim() || null;
      const vLat = Number(V.lat ?? V.latitude);
      const vLon = Number(V.lon ?? V.longitude);
      if (Number.isFinite(vLat) && Number.isFinite(vLon)) {
        lat = vLat;
        lon = vLon;
      }
    }

    const groupRef = node.group?.__ref;
    if ((!city || lat == null) && groupRef && apollo[groupRef]) {
      const G = apollo[groupRef];
      if (!city) city = String(G.city || '').trim() || null;
      const gLat = Number(G.lat);
      const gLon = Number(G.lon);
      if (lat == null && Number.isFinite(gLat) && Number.isFinite(gLon)) {
        lat = gLat;
        lon = gLon;
      }
      if (!venue && G.name) venue = String(G.name).trim();
    }

    const online =
      node.isOnline === true
      || String(node.eventType || '').toUpperCase() === 'ONLINE'
      || /online event/i.test(String(venue || ''));

    const url =
      eventUrl
      || (groupSlug && id ? `https://www.meetup.com/${groupSlug}/events/${id}/` : '')
      || (id ? `https://www.meetup.com/events/${id}/` : '');

    let imageUrl = resolveMeetupPhotoUrl(
      node.featuredEventPhoto
        || node.displayPhoto
        || node.image
        || node.photo
        || node.coverPhoto
        || null,
      apollo,
    );

    events.push({
      id: `meetup:${id}`,
      title: title.slice(0, 500),
      start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
      end: endRaw && Number.isFinite(Date.parse(String(endRaw)))
        ? new Date(String(endRaw)).toISOString()
        : null,
      venue: venue ? venue.slice(0, 200) : null,
      city,
      lat,
      lon,
      url,
      source: 'meetup',
      online,
      isOnline: online,
      location: venue ? venue.slice(0, 200) : null,
      description: String(node.description || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400) || null,
      imageUrl,
      groupUrl: groupUrl,
      groupSlug: groupSlug || null,
      raw: { meetupId: id, status: node.status, eventType: node.eventType },
    });
  }
  return events;
}

/**
 * @param {string} groupUrl
 * @returns {Promise<{ ok: boolean, groupUrl: string, events: object[], error?: string }>}
 */
async function fetchMeetupGroupEvents(groupUrl) {
  const base = normalizeMeetupGroupUrl(groupUrl);
  if (!base) return { ok: false, groupUrl, events: [], error: 'bad_url' };
  const eventsUrl = `${base}events/`;
  const page = await fetchHtml(eventsUrl);
  if (!page.ok) {
    return {
      ok: false,
      groupUrl: base,
      events: [],
      error: page.err || `HTTP ${page.status}`,
    };
  }
  const apollo = extractApolloState(page.html);
  if (!apollo) {
    return { ok: false, groupUrl: base, events: [], error: 'no_apollo_state' };
  }
  return {
    ok: true,
    groupUrl: base,
    events: eventsFromMeetupApollo(apollo, base),
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function readCache(env = process.env) {
  try {
    const raw = await readFile(meetupEventsCachePath(env), 'utf8');
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
  const p = meetupEventsCachePath(env);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {object | null} cache
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheFresh(cache, env = process.env) {
  if (!cache?.cachedAt) return false;
  const age = Date.now() - Date.parse(cache.cachedAt);
  return Number.isFinite(age) && age >= 0 && age < meetupCacheTtlMs(env);
}

/**
 * Fetch upcoming events for all pinned Meetup groups.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean, concurrency?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   fromCache: boolean,
 *   stale: boolean,
 *   cachedAt: string | null,
 *   pins: string[],
 *   groupsOk: number,
 *   groupsFailed: number,
 *   events: object[],
 *   error?: string | null,
 * }>}
 */
export async function fetchMeetupPinnedEvents(env = process.env, opts = {}) {
  const pins = await loadMeetupGroupPins();
  if (!pins.length) {
    return {
      ok: false,
      fromCache: false,
      stale: false,
      cachedAt: null,
      pins: [],
      groupsOk: 0,
      groupsFailed: 0,
      events: [],
      error: 'no_pins',
    };
  }

  const force = opts.forceRefresh === true;
  const cache = await readCache(env);
  if (!force && cacheFresh(cache, env)) {
    return {
      ok: true,
      fromCache: true,
      stale: false,
      cachedAt: cache.cachedAt || null,
      pins: cache.pins || pins,
      groupsOk: cache.groupsOk ?? 0,
      groupsFailed: cache.groupsFailed ?? 0,
      events: cache.events || [],
      error: null,
    };
  }

  const concurrency = Math.min(Math.max(Number(opts.concurrency) || 4, 1), 8);
  const queue = [...pins];
  /** @type {object[]} */
  const events = [];
  let groupsOk = 0;
  let groupsFailed = 0;

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      const result = await fetchMeetupGroupEvents(url);
      if (result.ok) {
        groupsOk += 1;
        events.push(...result.events);
      } else {
        groupsFailed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Dedupe by meetup id within this batch
  const seen = new Set();
  const unique = [];
  for (const ev of events) {
    const id = String(ev.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(ev);
  }

  const payload = {
    cachedAt: new Date().toISOString(),
    pins,
    groupsOk,
    groupsFailed,
    count: unique.length,
    events: unique,
  };
  try {
    await writeCache(payload, env);
  } catch {
    /* ignore cache write errors */
  }

  return {
    ok: unique.length > 0 || groupsOk > 0,
    fromCache: false,
    stale: false,
    cachedAt: payload.cachedAt,
    pins,
    groupsOk,
    groupsFailed,
    events: unique,
    error: null,
  };
}
