/**
 * Rolling series watches: keep expanding "every Nth Thursday"-style series for
 * 3 months. When promo mail goes quiet for 3 months, hunt the web for proof the
 * series still exists; if found, extend another 3 months.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertPublicHttpUrl } from './public-http-url.js';
import {
  expandRecurringAndRelativeDates,
} from './events-finder-recurring-dates.js';

/**
 * @returns {string}
 */
function storePath() {
  const fromEnv = String(process.env.EVENTS_FINDER_SERIES_WATCHES_PATH || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), 'data', 'events-finder-series-watches.json');
}

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   patternLabel: string,
 *   kind: string,
 *   weekday?: number,
 *   nth?: number,
 *   url?: string | null,
 *   source?: string | null,
 *   lastPromoAt: string,
 *   horizonUntil: string,
 *   lastHuntAt?: string | null,
 *   lastHuntOk?: boolean | null,
 *   createdAt: string,
 * }} SeriesWatch
 */

/**
 * @returns {{ watches: SeriesWatch[] }}
 */
export function loadSeriesWatches() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    const watches = Array.isArray(raw?.watches) ? raw.watches : [];
    return { watches: watches.filter((w) => w && w.id && w.title) };
  } catch {
    return { watches: [] };
  }
}

/**
 * @param {{ watches: SeriesWatch[] }} doc
 */
function saveSeriesWatches(doc) {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[events-finder] series watches write failed:', e?.message || e);
  }
}

/**
 * @param {string} title
 * @param {string} label
 */
function watchId(title, label) {
  const seed = `${String(title || '').toLowerCase().trim()}|${String(label || '').toLowerCase().trim()}`;
  return `series:${Buffer.from(seed).toString('base64url').slice(0, 48)}`;
}

/**
 * Touch / create watches from freshly parsed Gmail events that look like series.
 * @param {object[]} events
 * @param {{ now?: number }} [opts]
 */
export function noteSeriesPromoFromEvents(events, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const nowIso = new Date(now).toISOString();
  const horizonIso = new Date(now + 90 * 86400000).toISOString();
  const doc = loadSeriesWatches();
  /** @type {Map<string, SeriesWatch>} */
  const byId = new Map(doc.watches.map((w) => [w.id, w]));

  for (const ev of events || []) {
    const blob = `${ev?.title || ''}\n${ev?.description || ''}\n${ev?.raw?.subject || ''}`;
    const expansions = expandRecurringAndRelativeDates(blob, { now, monthsAhead: 3 });
    const seriesLike = expansions.filter(
      (ex) => ex.kind === 'nth_weekday' || ex.kind === 'every_weekday' || ex.kind === 'every_other_weekday',
    );
    if (!seriesLike.length && ev?.raw?.via !== 'link_follow_series' && ev?.raw?.via !== 'dated_blocks') {
      continue;
    }
    for (const ex of seriesLike.length ? seriesLike : [{ label: 'series', kind: 'dated_blocks', days: [] }]) {
      const id = watchId(ev.title || 'event', ex.label || 'series');
      const prev = byId.get(id);
      byId.set(id, {
        id,
        title: String(ev.title || prev?.title || 'Event').slice(0, 240),
        patternLabel: ex.label || prev?.patternLabel || 'series',
        kind: ex.kind || prev?.kind || 'series',
        weekday: ex.weekday ?? prev?.weekday,
        nth: ex.nth ?? prev?.nth,
        url: ev.url || prev?.url || null,
        source: ev.source || prev?.source || null,
        lastPromoAt: nowIso,
        horizonUntil: horizonIso,
        lastHuntAt: prev?.lastHuntAt || null,
        lastHuntOk: prev?.lastHuntOk ?? null,
        createdAt: prev?.createdAt || nowIso,
      });
    }
  }

  const watches = [...byId.values()];
  saveSeriesWatches({ watches });
  return { watches: watches.length };
}

/**
 * Expand active watches into synthetic event cards for the rolling horizon.
 * @param {{
 *   now?: number,
 *   ymdAtLocalNoonIso: (ymd: string, tz?: string) => string | null,
 *   ymdAtLocalTimeIso: (ymd: string, h: number, m: number, tz?: string) => string | null,
 *   timeZone?: string,
 * }} opts
 * @returns {object[]}
 */
export function expandActiveSeriesWatchesToEvents(opts) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const timeZone = opts.timeZone || 'America/Los_Angeles';
  const doc = loadSeriesWatches();
  /** @type {object[]} */
  const events = [];

  for (const w of doc.watches) {
    const horizon = Date.parse(w.horizonUntil || '');
    if (!Number.isFinite(horizon) || horizon < now) continue;
    const blob = `${w.patternLabel} ${w.title}`;
    const expansions = expandRecurringAndRelativeDates(blob, { now, monthsAhead: 3, timeZone });
    for (const ex of expansions) {
      for (const day of ex.days || []) {
        const start =
          day.hours != null && day.minutes != null
            ? opts.ymdAtLocalTimeIso(day.ymd, day.hours, day.minutes, timeZone)
            : opts.ymdAtLocalNoonIso(day.ymd, timeZone);
        if (!start || Date.parse(start) < now - 12 * 3600000) continue;
        if (Date.parse(start) > horizon) continue;
        events.push({
          id: `${w.id}:${day.ymd}`,
          title: w.title,
          start,
          end: null,
          venue: null,
          city: null,
          url: w.url || `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(w.title)}`,
          source: w.source || 'gmail',
          raw: {
            via: 'series_watch',
            seriesWatchId: w.id,
            patternLabel: w.patternLabel,
            lastPromoAt: w.lastPromoAt,
          },
        });
      }
    }
  }
  return events;
}

/**
 * Hunt stale series (no promo in 90d, horizon ending / ended).
 * @param {{ now?: number, timeoutMs?: number }} [opts]
 */
export async function huntStaleSeriesWatches(opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 12000, 2000), 20000);
  const doc = loadSeriesWatches();
  const { searchWeb } = await import('./events-finder-event-url.js');
  const { fetchNormalizedEventFromUrl } = await import('./events-finder-public-pages.js');

  let hunted = 0;
  let renewed = 0;

  for (const w of doc.watches) {
    const lastPromo = Date.parse(w.lastPromoAt || '');
    const horizon = Date.parse(w.horizonUntil || '');
    const quietMs = now - (Number.isFinite(lastPromo) ? lastPromo : 0);
    const needsHunt =
      quietMs >= 90 * 86400000
      && (!Number.isFinite(horizon) || horizon <= now + 14 * 86400000);
    if (!needsHunt) continue;

    const lastHunt = Date.parse(w.lastHuntAt || '');
    if (Number.isFinite(lastHunt) && now - lastHunt < 7 * 86400000) continue;

    hunted += 1;
    w.lastHuntAt = new Date(now).toISOString();
    let ok = false;

    const queries = [
      `"${w.title}" ${w.patternLabel || ''}`.trim(),
      `${w.title} event`,
      w.url ? null : `${w.title} tickets`,
    ].filter(Boolean);

    /** @type {string[]} */
    const urls = [];
    if (w.url) urls.push(w.url);
    for (const q of queries.slice(0, 2)) {
      try {
        const hits = await searchWeb(q);
        for (const hit of hits || []) {
          const href = String(hit?.url || hit?.link || hit || '').trim();
          if (href) urls.push(href);
        }
      } catch {
        /* ignore */
      }
    }

    for (const href of [...new Set(urls)].slice(0, 6)) {
      try {
        const safe = await assertPublicHttpUrl(href);
        const page = await fetchNormalizedEventFromUrl(safe, w.source || 'gmail', timeoutMs);
        if (page?.start && Date.parse(page.start) >= now - 7 * 86400000) {
          ok = true;
          w.url = page.url || href;
          break;
        }
        // Page exists and mentions the series title → soft proof
        if (page?.title && String(page.title).toLowerCase().includes(String(w.title).slice(0, 12).toLowerCase())) {
          ok = true;
          w.url = page.url || href;
          break;
        }
      } catch {
        /* ignore */
      }
    }

    w.lastHuntOk = ok;
    if (ok) {
      renewed += 1;
      w.horizonUntil = new Date(now + 90 * 86400000).toISOString();
    }
  }

  saveSeriesWatches(doc);
  return { hunted, renewed, watches: doc.watches.length };
}
