/**
 * Events finder — optional Google Calendar ICS feeds (e.g. Partiful sync calendar).
 * Paste secret ICS URLs into docs/gcal-ics-pins.md (one-time per calendar).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIcsEvents } from './ical-parse.js';
import { buildRRule } from './ical-recurrence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const PINS_DOC = path.join(root, 'docs', 'gcal-ics-pins.md');

const UA =
  'Mozilla/5.0 (compatible; DashbirdEvents/1.0; +https://github.com/local/dashbird)';

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gcalIcsCachePath(env = process.env) {
  const override = String(env.GCAL_ICS_EVENTS_CACHE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, 'data', 'gcal-ics-events-cache.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function cacheTtlMs(env = process.env) {
  const n = Number(env.GCAL_ICS_EVENTS_CACHE_MS);
  if (Number.isFinite(n) && n >= 60_000) return n;
  return 60 * 60 * 1000;
}

/**
 * Normalize calendar feed URLs (webcal → https; allow Partiful + Google ICS).
 * @param {string} href
 * @returns {string | null}
 */
export function normalizeCalendarIcsUrl(href) {
  let s = String(href || '').trim();
  if (!s) return null;
  if (/^webcal:\/\//i.test(s)) s = `https://${s.slice('webcal://'.length)}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/i.test(u.protocol)) return null;
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.toLowerCase();
    const okHost =
      host === 'calendars.partiful.com'
      || host.endsWith('.partiful.com')
      || (host.includes('google.com') && path.includes('/calendar/ical/'));
    if (!okHost) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Load ICS URLs from docs/gcal-ics-pins.md + EVENTS_FINDER_EXTRA_ICAL_URLS.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ url: string, label: string }>>}
 */
export async function loadGcalIcsPins(env = process.env) {
  /** @type {Array<{ url: string, label: string }>} */
  const out = [];
  const seen = new Set();

  /**
   * @param {string} urlRaw
   * @param {string} [label]
   */
  function push(urlRaw, label = '') {
    const url = normalizeCalendarIcsUrl(urlRaw);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    const inferred =
      /partiful/i.test(url) || /partiful/i.test(label || '')
        ? 'Partiful'
        : String(label || '').trim() || 'Google Calendar';
    out.push({ url, label: String(label || '').trim() || inferred });
  }

  const envList = String(env.EVENTS_FINDER_EXTRA_ICAL_URLS || '')
    .split(/[\n|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const u of envList) push(u);

  try {
    const md = await readFile(PINS_DOC, 'utf8');
    const idx = md.search(/^##\s+Pins\s*$/m);
    const body = idx >= 0 ? md.slice(idx) : md;
    const next = body.slice(3).search(/^##\s+/m);
    const section = next > 0 ? body.slice(0, next + 3) : body;
    for (const line of section.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
      const m = trimmed.match(/(?:webcal|https?):\/\/[^\s)\]]+/i);
      if (!m) continue;
      const label = trimmed.replace(m[0], '').replace(/^[|\-–—:\s]+/, '').trim();
      push(m[0].replace(/[.,;]+$/, ''), label);
    }
  } catch {
    /* no pin doc yet */
  }

  return out;
}

/**
 * @param {string} icalUrl
 * @param {string} label
 * @returns {Promise<{ ok: boolean, events: object[], error?: string }>}
 */
async function fetchOneIcs(icalUrl, label) {
  try {
    const r = await fetch(icalUrl, {
      headers: { Accept: 'text/calendar,text/plain,*/*', 'User-Agent': UA },
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) return { ok: false, events: [], error: `HTTP ${r.status}` };
    const text = await r.text();
    const parsed = parseIcsEvents(text);
    const now = Date.now();
    const windowStart = now - 2 * 24 * 60 * 60 * 1000;
    const windowEnd = now + 45 * 24 * 60 * 60 * 1000;

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
        const urlMatch =
          desc.match(/https?:\/\/(?:www\.)?partiful\.com\/e\/[^\s\\]+/i)
          || desc.match(/https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/[^\s\\]+/i)
          || ( /^https?:\/\//i.test(loc) ? loc : null);
        const url = urlMatch
          ? String(Array.isArray(urlMatch) ? urlMatch[0] : urlMatch).replace(/[.,;)]+$/, '')
          : '';
        const source =
          /partiful\.com/i.test(url) || /partiful/i.test(label) || /partiful/i.test(desc)
            ? 'partiful'
            : 'gcal';
        const gcalEventId = String(ev.id || '').replace(/@google\.com$/i, '').split('@')[0];
        events.push({
          id: `${source}:gcal:${Buffer.from(String(occ.id)).toString('base64url').slice(0, 40)}`,
          title: String(ev.title || label || 'Calendar event').trim().slice(0, 500),
          start: new Date(occ.startMs).toISOString(),
          end: occ.endMs != null ? new Date(occ.endMs).toISOString() : null,
          venue: loc && !/^https?:\/\//i.test(loc) ? loc.slice(0, 200) : null,
          city: null,
          lat: null,
          lon: null,
          url: url || '',
          source,
          online: /^https?:\/\//i.test(loc),
          isOnline: /^https?:\/\//i.test(loc),
          location: loc && !/^https?:\/\//i.test(loc) ? loc.slice(0, 200) : null,
          description: desc.replace(/\s+/g, ' ').slice(0, 400) || null,
          imageUrl: null,
          calendarName: label,
          raw: {
            via: 'gcal_ics',
            gcalUid: String(ev.id || ''),
            gcalEventId: gcalEventId || null,
            icalUrl,
            label,
          },
        });
      }
    }
    return { ok: true, events };
  } catch (e) {
    return { ok: false, events: [], error: String(e?.message || e) };
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function fetchGcalIcsPinnedEvents(env = process.env, opts = {}) {
  const pins = await loadGcalIcsPins(env);
  if (!pins.length) {
    return {
      ok: true,
      fromCache: false,
      cachedAt: null,
      pins: [],
      pinsOk: 0,
      pinsFailed: 0,
      events: [],
      error: null,
      hint: 'Add Partiful (or other) Google Calendar secret ICS URL to docs/gcal-ics-pins.md',
    };
  }

  const force = opts.forceRefresh === true;
  let cache = null;
  try {
    cache = JSON.parse(await readFile(gcalIcsCachePath(env), 'utf8'));
  } catch {
    cache = null;
  }
  if (!force && cache?.cachedAt && Array.isArray(cache.events)) {
    const age = Date.now() - Date.parse(cache.cachedAt);
    if (Number.isFinite(age) && age >= 0 && age < cacheTtlMs(env)) {
      return {
        ok: true,
        fromCache: true,
        cachedAt: cache.cachedAt,
        pins: cache.pins || pins.map((p) => p.url),
        pinsOk: cache.pinsOk ?? pins.length,
        pinsFailed: cache.pinsFailed ?? 0,
        events: cache.events,
        error: null,
      };
    }
  }

  /** @type {object[]} */
  const events = [];
  let pinsOk = 0;
  let pinsFailed = 0;
  for (const pin of pins) {
    const result = await fetchOneIcs(pin.url, pin.label);
    if (result.ok) {
      pinsOk += 1;
      events.push(...result.events);
    } else {
      pinsFailed += 1;
    }
  }

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
    pins: pins.map((p) => p.url),
    pinsOk,
    pinsFailed,
    count: unique.length,
    events: unique,
  };
  try {
    await mkdir(path.dirname(gcalIcsCachePath(env)), { recursive: true });
    await writeFile(gcalIcsCachePath(env), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    /* ignore */
  }

  return {
    ok: unique.length > 0 || pinsOk > 0,
    fromCache: false,
    cachedAt: payload.cachedAt,
    pins: payload.pins,
    pinsOk,
    pinsFailed,
    events: unique,
    error: null,
  };
}
