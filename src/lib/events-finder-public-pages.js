/**
 * Events finder — public HTML ingest (Eventbrite listings + Partiful explore/SF + Secret Party watchlist).
 * Luma calendars/events live in events-finder-luma.js (pinned hubs + api.lu.ma).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventbriteLocationSlug, resolveEventsFinderGeo, bayAreaCityCoords } from './events-finder-geo.js';
import { normalizeEventImageUrl } from './events-finder-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const SAMPLE_URLS_DOC = path.join(root, 'docs', 'events-sample-urls.md');

const UA =
  'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

/** Built-in fixtures if the sample doc is missing. */
const FALLBACK_PARTIFUL = [
  'https://partiful.com/e/sNG4KUUrbwYskFZtXVUm',
  'https://partiful.com/e/IIlhGomgXdZiH0o64FrT',
  'https://partiful.com/e/rFuJxDXFtkGVUWOq8reK',
  'https://partiful.com/e/hgFB26jigU4DfLaqU3wn',
  'https://partiful.com/e/r6rIrHJEYDzTtfcexyRO',
  'https://partiful.com/e/JqsqeIT0qcfGa6ole785',
  'https://partiful.com/e/DMRUVpMFWsuxbTLn1kHB',
];
/** Optional public Secret Party event subdomains (no city explore exists). */
const FALLBACK_SECRETPARTY = [
  'https://bass-barley-block-party.secretparty.io/',
];

/** Partiful Explore region slug for Bay Area (covers SF / Oakland / Berkeley public discovery). */
const PARTIFUL_EXPLORE_REGION = 'sf';

/**
 * @param {string} html
 * @returns {object[]}
 */
function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      /* ignore bad JSON-LD */
    }
  }
  return blocks;
}

/**
 * @param {unknown} node
 * @param {object[]} out
 */
function collectSchemaEvents(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaEvents(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = /** @type {Record<string, unknown>} */ (node);
  const type = obj['@type'];
  const types = Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
  if (types.some((t) => /event$/i.test(t) || t === 'Event')) {
    out.push(obj);
  }
  if (obj['@graph']) collectSchemaEvents(obj['@graph'], out);
  if (obj.itemListElement) collectSchemaEvents(obj.itemListElement, out);
  if (obj.item) collectSchemaEvents(obj.item, out);
}

/**
 * @param {Record<string, unknown>} schema
 * @param {string} source
 * @param {string} [fallbackUrl]
 * @returns {object | null}
 */
function schemaEventToNormalized(schema, source, fallbackUrl = '') {
  const title = String(schema.name || schema.headline || '').trim();
  if (!title) return null;
  const url = String(schema.url || schema['@id'] || fallbackUrl || '').trim();
  const startRaw = schema.startDate || schema.startTime || null;
  const endRaw = schema.endDate || schema.endTime || null;
  const start = startRaw ? new Date(String(startRaw)) : null;
  const end = endRaw ? new Date(String(endRaw)) : null;
  const startIso =
    start && !Number.isNaN(start.getTime()) ? start.toISOString() : null;
  const endIso = end && !Number.isNaN(end.getTime()) ? end.toISOString() : null;

  const loc = schema.location;
  let venue = null;
  let city = null;
  let lat = null;
  let lon = null;
  let online = false;
  if (typeof loc === 'string') {
    venue = loc.slice(0, 200);
  } else if (loc && typeof loc === 'object') {
    const L = /** @type {Record<string, any>} */ (loc);
    const locTypes = Array.isArray(L['@type']) ? L['@type'] : [L['@type']];
    if (locTypes.some((t) => String(t || '').includes('VirtualLocation'))) {
      online = true;
    }
    venue = String(L.name || L.address || '').slice(0, 200) || null;
    const addr = L.address;
    if (typeof addr === 'string') {
      const m = addr.match(/,\s*([^,]+),\s*[A-Z]{2}\b/);
      if (m) city = m[1].trim();
    } else if (addr && typeof addr === 'object') {
      city = String(addr.addressLocality || '').trim() || null;
    }
    const geo = L.geo;
    if (geo && typeof geo === 'object') {
      const gLat = Number(geo.latitude);
      const gLon = Number(geo.longitude);
      if (Number.isFinite(gLat) && Number.isFinite(gLon)) {
        lat = gLat;
        lon = gLon;
      }
    }
  }

  const idSeed = url || `${title}|${startIso || ''}`;
  const id = `${source}:${Buffer.from(idSeed).toString('base64url').slice(0, 48)}`;

  let ticketPrice = null;
  let priceMax = null;
  const offers = schema.offers;
  const offerList = Array.isArray(offers) ? offers : offers ? [offers] : [];
  /** @type {number[]} */
  const amounts = [];
  for (const offer of offerList) {
    if (!offer || typeof offer !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (offer);
    for (const key of ['price', 'lowPrice', 'highPrice']) {
      const n = Number(o[key]);
      if (Number.isFinite(n) && n >= 0) amounts.push(n);
      else {
        const s = String(o[key] ?? '').replace(/[^0-9.]/g, '');
        const p = Number(s);
        if (Number.isFinite(p) && p >= 0) amounts.push(p);
      }
    }
  }
  if (amounts.length) {
    ticketPrice = Math.min(...amounts);
    priceMax = Math.max(...amounts);
  }

  return {
    id,
    title: title.slice(0, 500),
    start: startIso,
    end: endIso,
    venue,
    city,
    lat,
    lon,
    url: url || fallbackUrl || '',
    source,
    online,
    isOnline: online,
    location: venue,
    description: String(schema.description || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400) || null,
    imageUrl: normalizeEventImageUrl(
      Array.isArray(schema.image)
        ? String(schema.image[0] || '') || null
        : typeof schema.image === 'string'
          ? schema.image
          : null,
    ),
    ticketPrice,
    price: ticketPrice,
    priceMax: priceMax != null && priceMax !== ticketPrice ? priceMax : null,
    raw: { schema },
  };
}

/**
 * @param {string} html
 * @param {string} source
 * @param {string} [pageUrl]
 * @returns {object[]}
 */
export function parsePublicEventHtml(html, source, pageUrl = '') {
  const events = [];
  const seen = new Set();
  for (const block of extractJsonLdBlocks(html)) {
    /** @type {object[]} */
    const schemas = [];
    collectSchemaEvents(block, schemas);
    for (const schema of schemas) {
      const norm = schemaEventToNormalized(
        /** @type {Record<string, unknown>} */ (schema),
        source,
        pageUrl,
      );
      if (!norm) continue;
      const key = `${norm.title}|${norm.start || ''}|${norm.url || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(norm);
    }
  }

  // Partiful / Secret Party / thin pages: fall back to <title> + <time datetime>
  if (!events.length && pageUrl) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const timeMatch = html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
    let title = titleMatch
      ? titleMatch[1].replace(/\s*[|\-–].*$/, '').trim()
      : '';
    // Secret Party SSR often leaves a generic "Secret Party" title — use subdomain slug.
    if (!title || /^secret party$/i.test(title)) {
      try {
        const host = new URL(pageUrl).hostname.replace(/^www\./, '').toLowerCase();
        const m = host.match(/^([a-z0-9-]+)\.secretparty\.io$/);
        if (m?.[1] && m[1] !== 'www' && m[1] !== 'api') {
          title = m[1]
            .split('-')
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        }
      } catch {
        /* ignore */
      }
    }
    if (title) {
      const start = timeMatch ? new Date(timeMatch[1]) : null;
      events.push({
        id: `${source}:${Buffer.from(pageUrl).toString('base64url').slice(0, 48)}`,
        title: title.slice(0, 500),
        start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : null,
        end: null,
        venue: null,
        city: null,
        lat: null,
        lon: null,
        url: pageUrl,
        source,
        online: false,
        isOnline: false,
        location: null,
        description: null,
        imageUrl: null,
        raw: { via: 'title_time_fallback' },
      });
    }
  }
  return events;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, html: string, finalUrl?: string, err?: string }>}
 */
export async function fetchHtml(url, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html, finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, html: '', finalUrl: url, err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch one public event page and return the best JSON-LD / title normalized event.
 * Used by Gmail intake to fill venue/city/start when mail only has a thin link.
 * @param {string} url
 * @param {string} [source]
 * @param {number} [timeoutMs]
 * @returns {Promise<object | null>}
 */
export async function fetchNormalizedEventFromUrl(url, source = 'eventbrite', timeoutMs = 12000) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//i.test(href)) return null;
  const page = await fetchHtml(href, timeoutMs);
  if (!page.ok || !page.html) return null;
  const pageUrl = page.finalUrl || href;
  const events = parsePublicEventHtml(page.html, source, pageUrl);
  if (!events.length) return null;
  const withStart = events.find((e) => e?.start);
  const best = withStart || events[0];
  if (best && pageUrl && (!best.url || /eventbrite\.com\/?$/i.test(String(best.url)))) {
    best.url = pageUrl.split('#')[0];
  }
  return best || null;
}

/**
 * Pull https URLs from a markdown section.
 * @param {string} md
 * @param {RegExp} sectionHeading
 * @returns {string[]}
 */
function urlsFromDocSection(md, sectionHeading) {
  const idx = md.search(sectionHeading);
  if (idx < 0) return [];
  const rest = md.slice(idx);
  const next = rest.search(/\n##\s+/);
  const body = next > 0 ? rest.slice(0, next) : rest;
  const urls = [];
  const re = /https?:\/\/[^\s)`"']+/g;
  let m;
  while ((m = re.exec(body))) {
    const u = m[0].replace(/[.,;]+$/, '');
    if (/^https?:\/\//i.test(u)) urls.push(u);
  }
  return [...new Set(urls)];
}

/**
 * @returns {Promise<{ partiful: string[], secretparty: string[] }>}
 */
async function loadSampleWatchUrls() {
  try {
    const md = await readFile(SAMPLE_URLS_DOC, 'utf8');
    const partiful = urlsFromDocSection(md, /##\s+Partiful/i);
    const secretparty = urlsFromDocSection(md, /##\s+Secret Party/i);
    return {
      partiful: partiful.length ? partiful : FALLBACK_PARTIFUL,
      secretparty: secretparty.length ? secretparty : FALLBACK_SECRETPARTY,
    };
  } catch {
    return {
      partiful: FALLBACK_PARTIFUL,
      secretparty: FALLBACK_SECRETPARTY,
    };
  }
}

/**
 * @param {string[]} urls
 * @param {string} source
 * @param {number} [concurrency]
 * @returns {Promise<{ events: object[], fetched: number, errors: number }>}
 */
async function fetchUrlList(urls, source, concurrency = 3) {
  /** @type {object[]} */
  const events = [];
  let fetched = 0;
  let errors = 0;
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      const page = await fetchHtml(url);
      fetched += 1;
      if (!page.ok) {
        errors += 1;
        continue;
      }
      events.push(...parsePublicEventHtml(page.html, source, url));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { events, fetched, errors };
}

/**
 * Extract Partiful event objects from Explore `__NEXT_DATA__` (trending + sections + feed).
 * @param {string} html
 * @returns {object[]}
 */
export function parsePartifulExploreHtml(html) {
  const m = String(html || '').match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!m) return [];
  let pageProps;
  try {
    pageProps = JSON.parse(m[1])?.props?.pageProps;
  } catch {
    return [];
  }
  if (!pageProps || typeof pageProps !== 'object') return [];

  /** @type {Map<string, object>} */
  const byId = new Map();
  /**
   * @param {unknown} ev
   * @param {string} via
   */
  const add = (ev, via) => {
    if (!ev || typeof ev !== 'object') return;
    const e = /** @type {Record<string, unknown>} */ (ev);
    const id = String(e.id || '').trim();
    const title = String(e.title || '').trim();
    if (!id || !title) return;
    if (e.isPublic === false) return;
    if (!byId.has(id)) byId.set(id, { ...e, _via: via });
  };

  const trending = /** @type {Record<string, unknown>} */ (pageProps.trendingSection || {});
  for (const item of /** @type {unknown[]} */ (trending.items || [])) {
    if (item && typeof item === 'object') {
      add(/** @type {Record<string, unknown>} */ (item).event, 'trending');
    }
  }
  for (const sec of /** @type {unknown[]} */ (pageProps.sections || [])) {
    if (!sec || typeof sec !== 'object') continue;
    const s = /** @type {Record<string, unknown>} */ (sec);
    const secId = String(s.id || 'section');
    for (const item of /** @type {unknown[]} */ (s.items || [])) {
      if (item && typeof item === 'object') {
        add(/** @type {Record<string, unknown>} */ (item).event, `section:${secId}`);
      }
    }
  }
  for (const item of /** @type {unknown[]} */ (pageProps.feedItems || [])) {
    if (item && typeof item === 'object') {
      add(/** @type {Record<string, unknown>} */ (item).event, 'feed');
    }
  }

  return [...byId.values()];
}

/**
 * @param {Record<string, unknown>} ev
 * @returns {object | null}
 */
function partifulExploreEventToNormalized(ev) {
  const id = String(ev.id || '').trim();
  const title = String(ev.title || '').trim();
  if (!id || !title) return null;

  const startRaw = ev.startDate ? new Date(String(ev.startDate)) : null;
  const endRaw = ev.endDate ? new Date(String(ev.endDate)) : null;
  const startIso =
    startRaw && !Number.isNaN(startRaw.getTime()) ? startRaw.toISOString() : null;
  const endIso =
    endRaw && !Number.isNaN(endRaw.getTime()) ? endRaw.toISOString() : null;

  const loc = ev.locationInfo && typeof ev.locationInfo === 'object'
    ? /** @type {Record<string, any>} */ (ev.locationInfo)
    : null;
  const maps = loc?.mapsInfo && typeof loc.mapsInfo === 'object' ? loc.mapsInfo : null;
  const venue = String(
    maps?.name || loc?.displayName || (Array.isArray(loc?.displayAddressLines) ? loc.displayAddressLines[0] : '') || '',
  ).slice(0, 200) || null;

  let city = null;
  const approx = String(maps?.approximateLocation || '').trim();
  if (approx) {
    city = approx.split(',')[0].trim() || null;
  } else if (Array.isArray(maps?.addressLines)) {
    const line = String(maps.addressLines.find((l) => /,\s*[A-Z]{2}\b/.test(String(l))) || '');
    const m = line.match(/^([^,]+),/);
    if (m) city = m[1].trim();
  }

  const centroid = bayAreaCityCoords(city);
  let lat = centroid?.lat ?? null;
  let lon = centroid?.lon ?? null;

  let imageUrl = null;
  const img = ev.image;
  if (img && typeof img === 'object') {
    const I = /** @type {Record<string, any>} */ (img);
    // Prefer upload.path → partiful.imgix.net (Firebase Storage URLs are private / 403).
    imageUrl = normalizeEventImageUrl(
      I.upload?.path || I.url || I.upload?.url || '',
    );
  }

  const url = `https://partiful.com/e/${id}`;
  return {
    id: `partiful:${id}`,
    title: title.slice(0, 500),
    start: startIso,
    end: endIso,
    venue,
    city,
    lat,
    lon,
    url,
    source: 'partiful',
    online: false,
    isOnline: false,
    location: venue,
    description: String(ev.description || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400) || null,
    imageUrl,
    ticketPrice: null,
    price: null,
    priceMax: null,
    raw: { via: 'explore', exploreVia: ev._via || null, status: ev.status || null },
  };
}

/**
 * Partiful Explore public listing for Bay Area (`/explore/sf`).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ events: object[], ok: boolean, url: string, error?: string }>}
 */
export async function fetchPartifulExploreListing(env = process.env) {
  const region = String(env.PARTIFUL_EXPLORE_REGION || PARTIFUL_EXPLORE_REGION)
    .trim()
    .toLowerCase() || PARTIFUL_EXPLORE_REGION;
  const url = `https://partiful.com/explore/${region}`;
  const page = await fetchHtml(url, 15000);
  if (!page.ok) {
    return { ok: false, url, events: [], error: page.err || `HTTP ${page.status}` };
  }
  const raw = parsePartifulExploreHtml(page.html);
  /** @type {object[]} */
  const events = [];
  const seen = new Set();
  for (const ev of raw) {
    const norm = partifulExploreEventToNormalized(
      /** @type {Record<string, unknown>} */ (ev),
    );
    if (!norm) continue;
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    events.push(norm);
  }
  return { ok: events.length > 0, url, events };
}

/**
 * Eventbrite listing/browse pages do NOT carry per-event ticket offers in their
 * JSON-LD (the price lives only on each `/e/…` detail page). For events that came
 * off a listing with no price yet, fetch the detail page and copy over the parsed
 * offers so the card can show "$23" / "Free". Bounded + free (plain HTML fetch).
 * @param {object[]} events
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} count enriched with a price
 */
export async function enrichEventbritePricesFromDetail(events, env = process.env) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return 0;
  const capRaw = Number(env.EVENTBRITE_PRICE_ENRICH_MAX);
  const cap = Number.isFinite(capRaw) && capRaw >= 0 ? Math.min(capRaw, 120) : 40;
  if (cap === 0) return 0;

  const isEbEventUrl = (u) => /^https?:\/\/[^/]*eventbrite\.[^/]+\/e\//i.test(String(u || ''));
  const needsPrice = (ev) =>
    ev
    && ev.ticketPrice == null
    && ev.price == null
    && !ev.raw?.schema?.offers
    && isEbEventUrl(ev.url);

  const targets = list.filter(needsPrice).slice(0, cap);
  if (!targets.length) return 0;

  let enriched = 0;
  const concurrency = 3;
  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const ev = queue.shift();
      if (!ev) break;
      const detail = await fetchNormalizedEventFromUrl(ev.url, 'eventbrite', 12000);
      if (!detail) continue;
      if (detail.ticketPrice != null || detail.price != null) {
        ev.ticketPrice = detail.ticketPrice ?? detail.price ?? null;
        ev.price = detail.price ?? detail.ticketPrice ?? null;
        if (detail.priceMax != null) ev.priceMax = detail.priceMax;
        enriched += 1;
      }
      // Opportunistically backfill start/venue/image while we have the page.
      if (!ev.start && detail.start) ev.start = detail.start;
      if (!ev.venue && detail.venue) ev.venue = detail.venue;
      if (!ev.imageUrl && detail.imageUrl) ev.imageUrl = detail.imageUrl;
      if (detail.raw?.schema) {
        ev.raw = { ...(ev.raw && typeof ev.raw === 'object' ? ev.raw : {}), schema: detail.raw.schema };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return enriched;
}

/**
 * Eventbrite public destination listings for dashboard city + category seeds.
 * Uses /d/{slug}/events/ plus /b/{slug}/{category}/ pages (JSON-LD + /e/ fallback).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   events: object[],
 *   ok: boolean,
 *   url: string | null,
 *   urls: string[],
 *   pagesOk: number,
 *   pagesFailed: number,
 *   error?: string,
 * }>}
 */
export async function fetchEventbritePublicListing(env = process.env) {
  const geo = await resolveEventsFinderGeo(env);
  const slug =
    geo.locationSlug
    || eventbriteLocationSlug({ city: geo.city || 'San Francisco', stateAbbrev: geo.stateAbbrev || 'CA' })
    || 'ca--san-francisco';

  /** Category path segments for /b/{slug}/{category}/ (Eventbrite browse). */
  const categories = String(env.EVENTBRITE_CATEGORY_SEEDS || '')
    .split(/[,|\n]/)
    .map((s) => s.trim().toLowerCase().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  const cats = categories.length
    ? categories
    : [
        'science-and-tech',
        'arts',
        'music',
        'film-and-media',
        'food-and-drink',
        'community',
        'fashion',
        'health',
      ];

  /** @type {string[]} */
  const urls = [`https://www.eventbrite.com/d/${slug}/events/`];
  for (const cat of cats.slice(0, 20)) {
    urls.push(`https://www.eventbrite.com/b/${slug}/${cat}/`);
  }
  // Neighbor city listing when Bay Area (Oakland often has distinct inventory).
  if (/san-francisco|oakland|berkeley|emeryville/i.test(slug)) {
    const oakland = 'ca--oakland';
    if (slug !== oakland) urls.push(`https://www.eventbrite.com/d/${oakland}/events/`);
  }

  /** @type {object[]} */
  const events = [];
  const seen = new Set();
  let pagesOk = 0;
  let pagesFailed = 0;

  /**
   * @param {object} ev
   */
  const add = (ev) => {
    if (!ev) return;
    const key = String(ev.url || ev.id || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    events.push(ev);
  };

  const queue = [...urls];
  const concurrency = 3;
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      const page = await fetchHtml(url, 15000);
      if (!page.ok) {
        pagesFailed += 1;
        continue;
      }
      pagesOk += 1;
      let pageEvents = parsePublicEventHtml(page.html, 'eventbrite', url);
      if (pageEvents.length < 3) {
        const linkRe = /https?:\/\/www\.eventbrite\.com\/e\/[a-z0-9-]+-\d+/gi;
        const links = [...new Set((page.html.match(linkRe) || []).slice(0, 60))];
        for (const link of links) {
          const id = `eventbrite:${Buffer.from(link).toString('base64url').slice(0, 48)}`;
          if (pageEvents.some((e) => e.url === link || e.id === id)) continue;
          const slugTitle = link
            .split('/e/')[1]
            ?.replace(/-\d+$/, '')
            ?.replace(/-/g, ' ')
            ?.trim();
          if (!slugTitle) continue;
          pageEvents.push({
            id,
            title: slugTitle.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 500),
            start: null,
            end: null,
            venue: null,
            city: geo.city || null,
            lat: null,
            lon: null,
            url: link,
            source: 'eventbrite',
            online: false,
            isOnline: false,
            location: null,
            description: null,
            imageUrl: null,
            raw: { via: 'listing_link', listingUrl: url },
          });
        }
      }
      for (const ev of pageEvents) {
        add({
          ...ev,
          raw: { ...(ev.raw && typeof ev.raw === 'object' ? ev.raw : {}), listingUrl: url },
        });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Listing pages carry no ticket offers — enrich a bounded set from detail pages.
  let pricesEnriched = 0;
  try {
    pricesEnriched = await enrichEventbritePricesFromDetail(events, env);
  } catch (e) {
    console.warn('[events-finder] eventbrite price enrich failed:', String(e?.message || e).slice(0, 160));
  }

  return {
    ok: events.length > 0 || pagesOk > 0,
    url: urls[0] || null,
    urls,
    pagesOk,
    pagesFailed,
    pricesEnriched,
    events,
    error: events.length || pagesOk ? undefined : 'no_eventbrite_pages',
  };
}

/**
 * Fetch Partiful Explore (SF) + optional watch URLs + Secret Party watchlist + Eventbrite listing.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   ok: boolean,
 *   events: object[],
 *   sources: Record<string, { ok: boolean, count: number, fetched?: number, errors?: number, url?: string | null, error?: string }>,
 * }>}
 */
export async function fetchPublicPageEvents(env = process.env) {
  const samples = await loadSampleWatchUrls();
  const [partifulExplore, partifulWatch, secretparty, eventbrite] = await Promise.all([
    fetchPartifulExploreListing(env),
    fetchUrlList(samples.partiful.slice(0, 16), 'partiful'),
    fetchUrlList(samples.secretparty.slice(0, 24), 'secretparty'),
    fetchEventbritePublicListing(env),
  ]);

  /** Prefer Explore rows; keep watchlist-only URLs that Explore did not return. */
  const partifulByKey = new Map();
  /**
   * @param {object} ev
   */
  const addPartiful = (ev) => {
    if (!ev) return;
    const key = String(ev.url || ev.id || '').trim().toLowerCase();
    if (!key) return;
    if (!partifulByKey.has(key)) partifulByKey.set(key, ev);
  };
  for (const ev of partifulExplore.events || []) addPartiful(ev);
  for (const ev of partifulWatch.events || []) addPartiful(ev);
  const partifulEvents = [...partifulByKey.values()];

  const events = [
    ...partifulEvents,
    ...secretparty.events,
    ...(eventbrite.events || []),
  ];
  return {
    ok:
      partifulEvents.length
        + secretparty.events.length
        + (eventbrite.events?.length || 0)
      > 0,
    events,
    sources: {
      partiful: {
        ok: partifulExplore.ok || partifulWatch.events.length > 0,
        count: partifulEvents.length,
        fetched: (partifulExplore.ok ? 1 : 0) + partifulWatch.fetched,
        errors: (partifulExplore.ok ? 0 : 1) + partifulWatch.errors,
        url: partifulExplore.url,
        error: partifulExplore.error,
      },
      secretparty: {
        ok: secretparty.errors < secretparty.fetched || secretparty.events.length > 0,
        count: secretparty.events.length,
        fetched: secretparty.fetched,
        errors: secretparty.errors,
      },
      eventbrite: {
        ok: eventbrite.ok === true,
        count: eventbrite.events?.length || 0,
        url: eventbrite.url,
        urls: eventbrite.urls,
        pagesOk: eventbrite.pagesOk,
        pagesFailed: eventbrite.pagesFailed,
        pricesEnriched: eventbrite.pricesEnriched ?? 0,
        error: eventbrite.error,
      },
    },
  };
}
