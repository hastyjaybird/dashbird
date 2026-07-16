/**
 * Aggregated Events finder feed (Gmail + Facebook + public pages).
 * Live sources upsert into local SQLite; the feed is served from the catalog.
 */
import { Router } from 'express';
import { loadEventsFinderCriteria } from '../lib/events-finder-criteria-store.js';
import {
  fetchFacebookEvents,
  filterEventsByIngestWindow,
} from '../lib/events-finder-facebook.js';
import {
  compareEventsByGeo,
  eventCityLabel,
  eventPassesFeedFilters,
  resolveEventLatLon,
  resolveEventsFinderGeo,
  uniqueEventCities,
} from '../lib/events-finder-geo.js';
import { fetchGmailEventAnnouncements } from '../lib/events-finder-gmail.js';
import { fetchGcalIcsPinnedEvents } from '../lib/events-finder-gcal-ics.js';
import { fetchLumaPinnedEvents } from '../lib/events-finder-luma.js';
import { fetchMeetupPinnedEvents } from '../lib/events-finder-meetup.js';
import { fetchMultiverseSchoolEvents } from '../lib/events-finder-multiverse.js';
import { withEventPrice } from '../lib/events-finder-price.js';
import { fetchPublicPageEvents } from '../lib/events-finder-public-pages.js';
import {
  annotateEventsWithSeriesInfo,
  countEventSeriesKeys,
  dedupeEventsByNameAndDate,
  deleteEventsFinderMatchingSkipped,
  getEventsFinderStoreStats,
  listEventsFinderEvents,
  pruneEventsFinderEvents,
  upsertEventsFinderEvents,
} from '../lib/events-finder-store.js';
import {
  eventMatchesGoogleCalendar,
  loadGoogleCalendarOccupancyKeys,
} from '../lib/events-finder-calendar-occupancy.js';
import {
  buildSkippedEventsIndex,
  findSkippedEventMatch,
  isEventSkipped,
} from '../lib/events-finder-skipped.js';
import { scoreEventTaste } from '../lib/events-finder-taste.js';
import { geocodeUsZip5 } from '../lib/zip-geocode.js';
import { eventsIngestWindowDays } from '../lib/events-finder-window.js';
import {
  eventsFinderIngestCooldownMs,
  eventsFinderIngestQuietHours,
  eventsFinderScheduleTz,
  isEventsFinderIngestQuietHours,
} from '../lib/events-finder-ingest-schedule.js';

const router = Router();

/** @type {Promise<object> | null} */
let eventsFinderIngestInflight = null;
/** @type {object | null} */
let lastEventsFinderIngest = null;
/** @type {number} */
let lastEventsFinderIngestAt = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let eventsFinderIngestTimer = null;

/**
 * Filter + upsert one source batch into the catalog (yields before sync SQLite).
 * @param {object[]} events
 * @param {object} criteria
 * @param {string} timeZone
 * @param {ReturnType<typeof buildSkippedEventsIndex> | object[]} skipped
 */
async function upsertLiveBatch(events, criteria, timeZone, skipped) {
  const batchAll = filterEventsByIngestWindow(
    Array.isArray(events) ? events : [],
    criteria.scrape || {},
    timeZone,
  );
  const batch = batchAll.filter((ev) => !isEventSkipped(ev, skipped, timeZone));
  const ingestSkipped = batchAll.length - batch.length;
  let upserted = 0;
  let skippedCount = 0;
  try {
    await new Promise((r) => setImmediate(r));
    const result = upsertEventsFinderEvents(batch, process.env);
    upserted = result.upserted;
    skippedCount = result.skipped;
  } catch (storeErr) {
    console.warn('[events-finder] sqlite upsert failed:', storeErr?.message || storeErr);
  }
  return { upserted, skipped: skippedCount, ingestSkipped, batch };
}

/**
 * Live source fetch + SQLite upsert (single-flight). Each source upserts as soon as it
 * finishes so the catalog (and polling clients) grow progressively.
 * @param {{
 *   forceFacebook?: boolean,
 *   force?: boolean,
 *   criteria: object,
 *   timeZone: string,
 *   skippedRecords: object[],
 * }} opts
 */
function scheduleEventsFinderIngest(opts) {
  if (eventsFinderIngestInflight) return eventsFinderIngestInflight;

  const force = opts.force === true || opts.forceFacebook === true;
  if (!force && isEventsFinderIngestQuietHours(process.env)) {
    return Promise.resolve(
      lastEventsFinderIngest || {
        gmail: { ok: true, events: [], fromCache: true },
        facebook: { ok: true, events: [], fromCache: true },
        publicPages: { ok: true, events: [], sources: {} },
        meetup: { ok: true, events: [], fromCache: true },
        multiverse: { ok: true, events: [], fromCache: true },
        luma: { ok: true, events: [], fromCache: true },
        gcalIcs: { ok: true, events: [], fromCache: true },
        upserted: 0,
        skipped: 0,
        pruned: 0,
        deletedSkipped: 0,
        ingestSkipped: 0,
        batch: [],
        quietHours: true,
      },
    );
  }

  const cooldownMs = eventsFinderIngestCooldownMs(process.env);
  if (
    !force
    && lastEventsFinderIngest
    && Date.now() - lastEventsFinderIngestAt < cooldownMs
  ) {
    return Promise.resolve(lastEventsFinderIngest);
  }

  const { forceFacebook = false, criteria, timeZone, skippedRecords } = opts;
  const skippedIndex = buildSkippedEventsIndex(skippedRecords, timeZone);

  eventsFinderIngestInflight = (async () => {
    /** @type {Record<string, object>} */
    const sources = {};
    let upserted = 0;
    let skipped = 0;
    let ingestSkipped = 0;
    /** @type {object[]} */
    const batch = [];

    /**
     * @param {string} name
     * @param {Promise<object>} promise
     */
    async function take(name, promise) {
      try {
        const result = await promise;
        sources[name] = result;
        const events = Array.isArray(result?.events) ? result.events : [];
        const r = await upsertLiveBatch(events, criteria, timeZone, skippedIndex);
        upserted += r.upserted;
        skipped += r.skipped;
        ingestSkipped += r.ingestSkipped;
        batch.push(...r.batch);
      } catch (e) {
        sources[name] = {
          ok: false,
          events: [],
          error: String(e?.message || e),
        };
      }
    }

    await Promise.all([
      take('gmail', fetchGmailEventAnnouncements(process.env)),
      take(
        'facebook',
        fetchFacebookEvents(process.env, { forceRefresh: forceFacebook }),
      ),
      take(
        'publicPages',
        fetchPublicPageEvents(process.env).catch((e) => ({
          ok: false,
          events: [],
          sources: { error: String(e?.message || e) },
        })),
      ),
      take(
        'meetup',
        fetchMeetupPinnedEvents(process.env).catch((e) => ({
          ok: false,
          fromCache: false,
          stale: false,
          cachedAt: null,
          pins: [],
          groupsOk: 0,
          groupsFailed: 0,
          events: [],
          error: String(e?.message || e),
        })),
      ),
      take(
        'multiverse',
        fetchMultiverseSchoolEvents(process.env).catch((e) => ({
          ok: false,
          events: [],
          fromCache: false,
          error: String(e?.message || e),
        })),
      ),
      take(
        'luma',
        fetchLumaPinnedEvents(process.env).catch((e) => ({
          ok: false,
          fromCache: false,
          stale: false,
          cachedAt: null,
          pins: [],
          pinsOk: 0,
          pinsFailed: 0,
          events: [],
          error: String(e?.message || e),
        })),
      ),
      take(
        'gcalIcs',
        fetchGcalIcsPinnedEvents(process.env).catch((e) => ({
          ok: false,
          fromCache: false,
          cachedAt: null,
          pins: [],
          pinsOk: 0,
          pinsFailed: 0,
          events: [],
          error: String(e?.message || e),
        })),
      ),
    ]);

    let pruned = 0;
    let deletedSkipped = 0;
    try {
      await new Promise((r) => setImmediate(r));
      pruned = pruneEventsFinderEvents({ env: process.env });
      deletedSkipped = deleteEventsFinderMatchingSkipped(skippedRecords, process.env);
    } catch (storeErr) {
      console.warn('[events-finder] sqlite prune failed:', storeErr?.message || storeErr);
    }

    return {
      gmail: sources.gmail || { ok: false, events: [] },
      facebook: sources.facebook || { ok: false, events: [] },
      publicPages: sources.publicPages || { ok: false, events: [], sources: {} },
      meetup: sources.meetup || { ok: false, events: [] },
      multiverse: sources.multiverse || { ok: false, events: [] },
      luma: sources.luma || { ok: false, events: [] },
      gcalIcs: sources.gcalIcs || { ok: false, events: [] },
      upserted,
      skipped,
      pruned,
      deletedSkipped,
      ingestSkipped,
      batch,
    };
  })()
    .then((result) => {
      lastEventsFinderIngest = result;
      lastEventsFinderIngestAt = Date.now();
      // Refresh calendar occupancy off the ingest path (not on Save / catalogOnly).
      void loadGoogleCalendarOccupancyKeys(process.env, timeZone).catch(() => {});
      return result;
    })
    .catch((e) => {
      console.warn('[events-finder] background ingest failed:', e?.message || e);
      throw e;
    })
    .finally(() => {
      eventsFinderIngestInflight = null;
    });

  return eventsFinderIngestInflight;
}

/**
 * GET /api/events-finder/events — normalized events after geo/feed/taste filters.
 * Serves the SQLite catalog immediately; live sources refresh in the background and
 * upsert per-source so polling clients see events appear progressively.
 * Query: ?refreshFacebook=1 — force a live Apify run (bypasses cache).
 * Query: ?waitIngest=1 — wait for live ingest (manual / cold tooling only).
 * Query: ?catalogOnly=1 — SQLite catalog + saved filters only; no ingest, no live iCal.
 */
router.get('/', async (req, res) => {
  try {
    const criteria = await loadEventsFinderCriteria();
    const geo = await resolveEventsFinderGeo(process.env);
    const timeZone =
      String(process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
      || 'America/Los_Angeles';
    const forceFacebook =
      req.query.refreshFacebook === '1'
      || req.query.refreshFacebook === 'true'
      || String(req.query.refreshFacebook || '').toLowerCase() === 'yes';
    const waitIngest =
      req.query.waitIngest === '1'
      || req.query.waitIngest === 'true'
      || String(req.query.waitIngest || '').toLowerCase() === 'yes';
    const catalogOnly =
      req.query.catalogOnly === '1'
      || req.query.catalogOnly === 'true'
      || String(req.query.catalogOnly || '').toLowerCase() === 'yes';
    const skippedRecords = Array.isArray(criteria.skippedEvents) ? criteria.skippedEvents : [];

    const originZip =
      typeof criteria.filters?.originZip === 'string' && criteria.filters.originZip.length === 5
        ? criteria.filters.originZip
        : null;
    let homeLat = geo.lat;
    let homeLon = geo.lon;
    if (originZip && originZip !== geo.zip) {
      const z = await geocodeUsZip5(originZip);
      if (z && Number.isFinite(z.lat) && Number.isFinite(z.lon)) {
        homeLat = z.lat;
        homeLon = z.lon;
      }
    }

    const home = {
      lat: homeLat,
      lon: homeLon,
      homeCities: geo.homeCities || [],
      city: geo.city,
      place: geo.place,
    };

    const ingestOpts = {
      forceFacebook,
      force: waitIngest || forceFacebook,
      criteria,
      timeZone,
      skippedRecords,
    };

    /** @type {object | null} */
    let ingest = lastEventsFinderIngest;
    let ingestPending = eventsFinderIngestInflight != null;

    if (waitIngest && !catalogOnly) {
      // Synchronous fill for tooling only.
      const ingestPromise = scheduleEventsFinderIngest(ingestOpts);
      const coldMs = Number(process.env.EVENTS_FINDER_COLD_INGEST_MS);
      const waitMs = Number.isFinite(coldMs) && coldMs >= 5000 ? coldMs : 45_000;
      try {
        ingest = await Promise.race([
          ingestPromise,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('ingest_wait_timeout')), waitMs);
          }),
        ]);
        ingestPending = false;
      } catch (e) {
        console.warn('[events-finder] ingest wait ended:', e?.message || e);
        ingestPending = eventsFinderIngestInflight != null;
        ingest = lastEventsFinderIngest;
      }
    } else if (!catalogOnly) {
      // Background ingest: every ~2h outside quiet hours (02:00–07:00 local).
      const cooldownMs = eventsFinderIngestCooldownMs(process.env);
      const quiet = isEventsFinderIngestQuietHours(process.env);
      const onCooldown =
        Boolean(lastEventsFinderIngest)
        && !forceFacebook
        && Date.now() - lastEventsFinderIngestAt < cooldownMs;
      ingestPending =
        eventsFinderIngestInflight != null
        || (!quiet && !onCooldown);
    }

    const gmail = ingest?.gmail || {
      ok: true,
      events: [],
      hint: ingestPending ? 'Refreshing intake…' : null,
      fromCache: true,
      scanned: 0,
    };
    const facebook = ingest?.facebook || {
      ok: true,
      events: [],
      hint: ingestPending ? 'Refreshing sources…' : null,
      fromCache: true,
      refreshing: ingestPending,
    };
    const publicPages = ingest?.publicPages || {
      ok: true,
      events: [],
      sources: ingestPending ? { pending: true } : null,
    };
    const meetup = ingest?.meetup || { ok: true, events: [], fromCache: true, stale: ingestPending };
    const multiverse = ingest?.multiverse || {
      ok: true,
      events: [],
      fromCache: true,
      stale: ingestPending,
    };
    const luma = ingest?.luma || { ok: true, events: [], fromCache: true, stale: ingestPending };
    const gcalIcs = ingest?.gcalIcs || { ok: true, events: [], fromCache: true };
    const upserted = ingest?.upserted || 0;
    const skipped = ingest?.skipped || 0;
    const pruned = ingest?.pruned || 0;
    const deletedSkipped = ingest?.deletedSkipped || 0;
    const ingestSkipped = ingest?.ingestSkipped || 0;
    const batch = ingest?.batch || [];

    let raw;
    try {
      raw = listEventsFinderEvents({ env: process.env });
      if (!raw.length && batch.length) raw = batch;
    } catch (listErr) {
      console.warn('[events-finder] sqlite list failed:', listErr?.message || listErr);
      raw = batch;
    }

    const seriesCounts = countEventSeriesKeys(raw);
    const {
      events: dedupedRaw,
      removed: dedupedRemoved,
      removedSeries = 0,
    } = dedupeEventsByNameAndDate(raw, {
      timeZone,
    });
    const deduped = annotateEventsWithSeriesInfo(dedupedRaw, seriesCounts);

    const calendarAdded = new Set(
      (Array.isArray(criteria.calendarAddedEventIds) ? criteria.calendarAddedEventIds : []).map(
        (id) => String(id || '').trim(),
      ).filter(Boolean),
    );

    // Calendar occupancy: live iCal only on full/panel loads. Save + catalogOnly
    // use the last refreshed set (filled on ingest / non-catalog load).
    const calendarOccupancy = await loadGoogleCalendarOccupancyKeys(process.env, timeZone, {
      fetch: !catalogOnly,
    });

    const skippedIndex = buildSkippedEventsIndex(skippedRecords, timeZone);

    const filtered = [];
    /** @type {object[]} */
    const skippedFeed = [];
    let tasteSkipped = 0;
    let calendarHidden = 0;
    // Apply full browse filters including cities (client also mirrors city checks).
    const filtersBase = { ...(criteria.filters || {}) };
    for (const event of deduped) {
      const eventId = String(event?.id || '').trim();
      // Skipped events never enter the main feed — regardless of filter/taste changes.
      const skipMatch = findSkippedEventMatch(event, skippedIndex);
      if (skipMatch) {
        const mapCoords = resolveEventLatLon(event);
        skippedFeed.push(
          withEventPrice({
            ...event,
            city: eventCityLabel(event),
            lat: mapCoords?.lat ?? null,
            lon: mapCoords?.lon ?? null,
            distanceMiles: null,
            cityMatch: null,
            tasteScore: 0,
            matchedLookFor: [],
            skipped: true,
            skippedAt: skipMatch.skippedAt || null,
          }),
        );
        continue;
      }
      if (eventId && calendarAdded.has(eventId)) {
        calendarHidden += 1;
        continue;
      }
      if (eventMatchesGoogleCalendar(event, calendarOccupancy.keys, timeZone)) {
        calendarHidden += 1;
        continue;
      }
      const gate = eventPassesFeedFilters(event, filtersBase, home, { timeZone });
      // #region agent log
      {
        const t = `${event?.title || ''} ${event?.url || ''}`.toLowerCase();
        if (/climatebase|cohort 10|fellowship info|iug6lflp/.test(t)) {
          const tasteProbe = scoreEventTaste(event, criteria);
          const payload = {
            sessionId: 'ab357a',
            runId: 'pre-fix',
            hypothesisId: 'H1-H3',
            location: 'events-finder-events.js:feed-gate',
            message: 'Climatebase/fellowship candidate feed gate',
            data: {
              id: eventId || null,
              title: event?.title || null,
              start: event?.start || null,
              url: event?.url || null,
              online: event?.online ?? null,
              city: eventCityLabel(event),
              gateOk: gate.ok,
              gateReason: gate.reason || null,
              tasteOk: tasteProbe.ok,
              tasteReason: tasteProbe.reason || null,
              filterDates: filtersBase.dates || null,
              earliestLocalTime: filtersBase.earliestLocalTime || null,
              attendance: filtersBase.attendance || null,
              citiesCount: Array.isArray(filtersBase.cities) ? filtersBase.cities.length : 0,
            },
            timestamp: Date.now(),
          };
          fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'ab357a' },
            body: JSON.stringify(payload),
          }).catch(() => {});
          import('node:fs').then((fs) => {
            try {
              fs.appendFileSync('/home/jaybird/jayprograms/dashbird/.cursor/debug-ab357a.log', `${JSON.stringify(payload)}\n`);
              fs.appendFileSync('/app/data/debug-ab357a.ndjson', `${JSON.stringify(payload)}\n`);
            } catch {
              /* ignore */
            }
          }).catch(() => {});
        }
      }
      // #endregion
      if (!gate.ok) continue;
      const taste = scoreEventTaste(event, criteria);
      if (!taste.ok) {
        tasteSkipped += 1;
        continue;
      }
      {
        const mapCoords = resolveEventLatLon(event);
        filtered.push(
          withEventPrice({
            ...event,
            city: eventCityLabel(event),
            lat: mapCoords?.lat ?? null,
            lon: mapCoords?.lon ?? null,
            distanceMiles: gate.distanceMiles,
            cityMatch: gate.cityMatch,
            tasteScore: taste.score,
            matchedLookFor: taste.matchedLookFor,
            skipped: false,
            skippedAt: null,
          }),
        );
      }
    }

    // Also surface skip records that are no longer in the catalog (for Unskip recovery).
    const seenSkippedIds = new Set(skippedFeed.map((e) => String(e.id || '')));
    for (const rec of skippedRecords) {
      if (!rec?.id || seenSkippedIds.has(rec.id)) continue;
      skippedFeed.push(
        withEventPrice({
          id: rec.id,
          title: rec.title || 'Skipped event',
          start: rec.start,
          url: rec.url || '',
          source: rec.source || 'skipped',
          venue: rec.venue,
          city: eventCityLabel(rec),
          imageUrl: rec.imageUrl,
          seriesKey: rec.seriesKey || null,
          isSeries: Boolean(rec.seriesKey),
          skipped: true,
          fromSkipLog: true,
          skippedAt: rec.skippedAt || null,
        }),
      );
    }

    const availableCities = uniqueEventCities([...filtered, ...skippedFeed]);

    // Closest first; taste score breaks distance ties.
    const byClosest = (a, b) => {
      const geoCmp = compareEventsByGeo(a, b);
      if (geoCmp !== 0) return geoCmp;
      const sa = Number(a?.tasteScore) || 0;
      const sb = Number(b?.tasteScore) || 0;
      return sb - sa;
    };
    /** Most recently skipped first. */
    const bySkippedAtDesc = (a, b) => {
      const ta = Date.parse(String(a?.skippedAt || ''));
      const tb = Date.parse(String(b?.skippedAt || ''));
      const aOk = Number.isFinite(ta);
      const bOk = Number.isFinite(tb);
      if (aOk && bOk && ta !== tb) return tb - ta;
      if (aOk && !bOk) return -1;
      if (!aOk && bOk) return 1;
      return byClosest(a, b);
    };
    filtered.sort(byClosest);
    skippedFeed.sort(bySkippedAtDesc);

    // #region agent log
    {
      const debugEids = ['2179524519500835', '1005106102497320'];
      /** @type {Record<string, object>} */
      const debugEvents = {};
      for (const debugEid of debugEids) {
        const debugId = `facebook:${debugEid}`;
        const inRaw = raw.find((e) => String(e?.id || '').includes(debugEid) || String(e?.url || '').includes(debugEid));
        const inDeduped = deduped.find((e) => String(e?.id || '').includes(debugEid) || String(e?.url || '').includes(debugEid));
        const inFeed = filtered.find((e) => String(e?.id || '').includes(debugEid) || String(e?.url || '').includes(debugEid));
        const inSkipped = skippedFeed.find((e) => String(e?.id || '').includes(debugEid) || String(e?.url || '').includes(debugEid));
        let gateReason = null;
        if (inDeduped) {
          const gate = eventPassesFeedFilters(inDeduped, filtersBase, home, { timeZone });
          const taste = scoreEventTaste(inDeduped, criteria);
          gateReason = {
            gateOk: gate.ok,
            reason: gate.reason || null,
            distanceMiles: gate.distanceMiles,
            tasteOk: taste.ok,
            cityLabel: eventCityLabel(inDeduped),
            start: inDeduped.start || null,
          };
        }
        debugEvents[debugEid] = {
          debugId,
          inCatalog: Boolean(inRaw),
          inDeduped: Boolean(inDeduped),
          inFeed: Boolean(inFeed),
          inSkippedFeed: Boolean(inSkipped),
          catalogTitle: inRaw?.title || null,
          gateReason,
        };
      }
      const potluckInQueries = (facebook.searchQueries || []).some((q) =>
        String(q || '').toLowerCase().includes('potluck'),
      );
      const payload = {
        sessionId: '02a20c',
        runId: 'tiny-garage-pre',
        hypothesisId: 'A-E',
        location: 'events-finder-events.js:feed',
        message: 'debug target event presence',
        data: {
          debugEvents,
          filters: {
            cities: filtersBase.cities || null,
            dates: filtersBase.dates || null,
            maxMiles: filtersBase.maxMiles ?? null,
            earliestLocalTime: filtersBase.earliestLocalTime || null,
          },
          facebook: {
            fromCache: facebook.fromCache === true,
            cachedAt: facebook.cachedAt || null,
            scanned: facebook.scanned ?? null,
            count: Array.isArray(facebook.events) ? facebook.events.length : null,
            potluckInQueries,
            searchQueries: facebook.searchQueries || [],
          },
          feedTotal: filtered.length,
          totalRaw: raw.length,
        },
        timestamp: Date.now(),
      };
      fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '02a20c' },
        body: JSON.stringify(payload),
      }).catch(() => {});
      fetch('http://172.17.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '02a20c' },
        body: JSON.stringify(payload),
      }).catch(() => {});
      import('node:fs').then((fs) => {
        try {
          fs.appendFileSync('/app/data/debug-02a20c.ndjson', `${JSON.stringify(payload)}\n`);
        } catch {
          /* ignore */
        }
      }).catch(() => {});
    }
    // #endregion

    let store = null;
    try {
      store = {
        ...getEventsFinderStoreStats(process.env),
        upserted,
        skipped,
        pruned,
        deletedSkipped,
        ingestSkipped,
        dedupedRemoved,
        removedSeries,
        tasteSkipped,
        calendarHidden,
        calendarOccupancyKeys: calendarOccupancy.count,
      };
    } catch {
      store = {
        upserted,
        skipped,
        pruned,
        deletedSkipped,
        ingestSkipped,
        dedupedRemoved,
        removedSeries,
        tasteSkipped,
        calendarHidden,
        error: 'stats unavailable',
      };
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      sources: {
        gmail: {
          ok: gmail.ok === true,
          email: gmail.email || null,
          emails: gmail.emails || null,
          accounts: gmail.accounts || null,
          error: gmail.error || null,
          hint: gmail.hint || null,
          fromCache: gmail.fromCache === true,
          stale: gmail.stale === true,
          cachedAt: gmail.cachedAt || null,
          scanned: gmail.scanned ?? 0,
          count: Array.isArray(gmail.events) ? gmail.events.length : 0,
        },
        facebook: {
          ok: facebook.ok === true,
          error: facebook.error || null,
          hint: facebook.hint || null,
          fromCache: facebook.fromCache === true,
          stale: facebook.stale === true,
          refreshing: facebook.refreshing === true,
          cachedAt: facebook.cachedAt || null,
          searchQueries: facebook.searchQueries || [],
          startUrls: facebook.startUrls || [],
          scanned: facebook.scanned ?? 0,
          count: Array.isArray(facebook.events) ? facebook.events.length : 0,
        },
        publicPages: publicPages.sources || null,
        meetup: {
          ok: meetup.ok === true,
          error: meetup.error || null,
          fromCache: meetup.fromCache === true,
          stale: meetup.stale === true,
          cachedAt: meetup.cachedAt || null,
          pins: Array.isArray(meetup.pins) ? meetup.pins.length : 0,
          groupsOk: meetup.groupsOk ?? 0,
          groupsFailed: meetup.groupsFailed ?? 0,
          count: Array.isArray(meetup.events) ? meetup.events.length : 0,
        },
        multiverse: {
          ok: multiverse.ok === true,
          error: multiverse.error || null,
          fromCache: multiverse.fromCache === true,
          stale: multiverse.stale === true,
          cachedAt: multiverse.cachedAt || null,
          icalUrl: multiverse.icalUrl || null,
          calendarPage: multiverse.calendarPage || null,
          count: Array.isArray(multiverse.events) ? multiverse.events.length : 0,
        },
        luma: {
          ok: luma.ok === true,
          error: luma.error || null,
          fromCache: luma.fromCache === true,
          stale: luma.stale === true,
          cachedAt: luma.cachedAt || null,
          pins: Array.isArray(luma.pins) ? luma.pins.length : 0,
          pinsOk: luma.pinsOk ?? 0,
          pinsFailed: luma.pinsFailed ?? 0,
          count: Array.isArray(luma.events) ? luma.events.length : 0,
        },
        gcalIcs: {
          ok: gcalIcs.ok === true,
          error: gcalIcs.error || null,
          hint: gcalIcs.hint || null,
          fromCache: gcalIcs.fromCache === true,
          cachedAt: gcalIcs.cachedAt || null,
          pins: Array.isArray(gcalIcs.pins) ? gcalIcs.pins.length : 0,
          pinsOk: gcalIcs.pinsOk ?? 0,
          pinsFailed: gcalIcs.pinsFailed ?? 0,
          count: Array.isArray(gcalIcs.events) ? gcalIcs.events.length : 0,
        },
      },
      store,
      ingestPending,
      filters: criteria.filters,
      geo,
      availableCities,
      ingestWindow: eventsIngestWindowDays(process.env, { scrape: criteria.scrape }),
      events: filtered,
      skippedEvents: skippedFeed,
      skippedCount: skippedRecords.length,
      totalRaw: raw.length,
      totalDeduped: deduped.length,
      total: filtered.length,
    });

    // Start background ingest only after headers/body are on the wire.
    // Quiet hours (default 2–7am) skip non-forced scrapes; Facebook daily Apify is separate.
    if (!catalogOnly && !waitIngest) {
      setImmediate(() => {
        if (
          !forceFacebook
          && isEventsFinderIngestQuietHours(process.env)
        ) {
          return;
        }
        scheduleEventsFinderIngest(ingestOpts).catch((e) => {
          console.warn('[events-finder] deferred ingest failed:', e?.message || e);
        });
      });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), events: [] });
  }
});

/**
 * Periodic non-Facebook ingest (Gmail, Meetup, Luma, public pages, …).
 * Default every 2 hours; paused 02:00–07:00 local. Facebook Apify is daily 4am separately.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startEventsFinderIngestScheduler(env = process.env) {
  if (eventsFinderIngestTimer) return;

  const cooldownMs = eventsFinderIngestCooldownMs(env);
  const quiet = eventsFinderIngestQuietHours(env);
  const tz = eventsFinderScheduleTz(env);
  const hours = Math.round(cooldownMs / (60 * 60 * 1000) * 10) / 10;
  console.log(
    `[events-finder] ingest schedule: every ${hours}h, quiet ${String(quiet.startHour).padStart(2, '0')}:00–${String(quiet.endHour).padStart(2, '0')}:00 ${tz}`,
  );

  const tick = async () => {
    if (eventsFinderIngestInflight) return;
    if (isEventsFinderIngestQuietHours(env)) return;
    if (
      lastEventsFinderIngest
      && Date.now() - lastEventsFinderIngestAt < eventsFinderIngestCooldownMs(env)
    ) {
      return;
    }
    try {
      const criteria = await loadEventsFinderCriteria();
      const timeZone =
        String(env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
        || 'America/Los_Angeles';
      const skippedRecords = Array.isArray(criteria.skippedEvents)
        ? criteria.skippedEvents
        : [];
      console.log('[events-finder] scheduled ingest starting');
      const result = await scheduleEventsFinderIngest({
        forceFacebook: false,
        criteria,
        timeZone,
        skippedRecords,
      });
      console.log(
        `[events-finder] scheduled ingest done upserted=${result?.upserted ?? 0}`
          + (result?.quietHours ? ' (quiet hours)' : ''),
      );
    } catch (e) {
      console.warn('[events-finder] scheduled ingest failed:', e?.message || e);
    }
  };

  eventsFinderIngestTimer = setInterval(() => {
    void tick();
  }, 60_000);
  if (typeof eventsFinderIngestTimer.unref === 'function') eventsFinderIngestTimer.unref();
  // First check after boot (give Facebook / Telegram a head start).
  setTimeout(() => {
    void tick();
  }, 25_000);
}

export default router;
