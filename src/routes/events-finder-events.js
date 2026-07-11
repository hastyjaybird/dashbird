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
import { isEventSkipped } from '../lib/events-finder-skipped.js';
import { scoreEventTaste } from '../lib/events-finder-taste.js';
import { geocodeUsZip5 } from '../lib/zip-geocode.js';
import { eventsIngestWindowDays } from '../lib/events-finder-window.js';

const router = Router();

/**
 * GET /api/events-finder/events — normalized events after geo/feed/taste filters.
 * Query: ?refreshFacebook=1 — force a live Apify run (bypasses cache).
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
    const skippedRecords = Array.isArray(criteria.skippedEvents) ? criteria.skippedEvents : [];

    const [gmail, facebook, publicPages, meetup, multiverse, luma, gcalIcs] = await Promise.all([
      fetchGmailEventAnnouncements(process.env),
      fetchFacebookEvents(process.env, { forceRefresh: forceFacebook }),
      fetchPublicPageEvents(process.env).catch((e) => ({
        ok: false,
        events: [],
        sources: { error: String(e?.message || e) },
      })),
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
      fetchMultiverseSchoolEvents(process.env).catch((e) => ({
        ok: false,
        events: [],
        fromCache: false,
        error: String(e?.message || e),
      })),
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
    ]);

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

    /** @type {Array<object>} */
    const batchRaw = [
      ...(Array.isArray(gmail.events) ? gmail.events : []),
      ...(Array.isArray(facebook.events) ? facebook.events : []),
      ...(Array.isArray(publicPages.events) ? publicPages.events : []),
      ...(Array.isArray(meetup.events) ? meetup.events : []),
      ...(Array.isArray(multiverse.events) ? multiverse.events : []),
      ...(Array.isArray(luma.events) ? luma.events : []),
      ...(Array.isArray(gcalIcs.events) ? gcalIcs.events : []),
    ];
    // First-pass horizon: scrape windowWeeks (default ~30d) + optional earliest local time.
    const batchAll = filterEventsByIngestWindow(
      batchRaw,
      criteria.scrape || {},
      timeZone,
    );
    // Do not re-ingest skipped events (saves DB churn; Apify search still runs by query).
    const batch = batchAll.filter((ev) => !isEventSkipped(ev, skippedRecords, timeZone));
    const ingestSkipped = batchAll.length - batch.length;

    let upserted = 0;
    let skipped = 0;
    let pruned = 0;
    let deletedSkipped = 0;
    try {
      const result = upsertEventsFinderEvents(batch, process.env);
      upserted = result.upserted;
      skipped = result.skipped;
      pruned = pruneEventsFinderEvents({ env: process.env });
      // Keep catalog clear of anything designated skipped (id or url).
      deletedSkipped = deleteEventsFinderMatchingSkipped(skippedRecords, process.env);
    } catch (storeErr) {
      console.warn('[events-finder] sqlite upsert failed:', storeErr?.message || storeErr);
    }

    let raw;
    try {
      raw = listEventsFinderEvents({ env: process.env });
      if (!raw.length && batch.length) raw = batch;
    } catch (listErr) {
      console.warn('[events-finder] sqlite list failed:', listErr?.message || listErr);
      raw = batch;
    }

    const {
      events: deduped,
      removed: dedupedRemoved,
      removedSeries = 0,
    } = dedupeEventsByNameAndDate(raw, {
      timeZone,
    });

    const calendarAdded = new Set(
      (Array.isArray(criteria.calendarAddedEventIds) ? criteria.calendarAddedEventIds : []).map(
        (id) => String(id || '').trim(),
      ).filter(Boolean),
    );

    // Static hide: already on Google Calendar (title + local day) — reviewed, not Skip.
    const calendarOccupancy = await loadGoogleCalendarOccupancyKeys(process.env, timeZone);

    const skippedAtById = new Map(
      skippedRecords.map((s) => [String(s.id || '').trim(), String(s.skippedAt || '')]),
    );

    /**
     * @param {object} event
     * @returns {string | null}
     */
    function skippedAtFor(event) {
      const id = String(event?.id || '').trim();
      if (id && skippedAtById.has(id)) return skippedAtById.get(id) || null;
      for (const s of skippedRecords) {
        if (id && s.id === id) return s.skippedAt || null;
        if (
          event?.url
          && s.url
          && String(event.url).toLowerCase().includes(String(s.url).slice(0, 40))
        ) {
          return s.skippedAt || null;
        }
        if (s.id && skippedAtById.has(s.id) && isEventSkipped(event, [s], timeZone)) {
          return s.skippedAt || null;
        }
      }
      for (const s of skippedRecords) {
        if (isEventSkipped(event, [s], timeZone)) return s.skippedAt || null;
      }
      return null;
    }

    const filtered = [];
    /** @type {object[]} */
    const skippedFeed = [];
    let tasteSkipped = 0;
    let calendarHidden = 0;
    const filtersBase = { ...(criteria.filters || {}), cities: [] };
    for (const event of deduped) {
      const eventId = String(event?.id || '').trim();
      // Skipped events never enter the main feed — regardless of filter/taste changes.
      if (isEventSkipped(event, skippedRecords, timeZone)) {
        skippedFeed.push(
          withEventPrice({
            ...event,
            city: eventCityLabel(event),
            distanceMiles: null,
            cityMatch: null,
            tasteScore: 0,
            matchedLookFor: [],
            skipped: true,
            skippedAt: skippedAtFor(event),
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
      if (!gate.ok) continue;
      const taste = scoreEventTaste(event, criteria);
      if (!taste.ok) {
        tasteSkipped += 1;
        continue;
      }
      filtered.push(
        withEventPrice({
          ...event,
          city: eventCityLabel(event),
          distanceMiles: gate.distanceMiles,
          cityMatch: gate.cityMatch,
          tasteScore: taste.score,
          matchedLookFor: taste.matchedLookFor,
          skipped: false,
          skippedAt: null,
        }),
      );
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
      filters: criteria.filters,
      geo,
      availableCities,
      ingestWindow: eventsIngestWindowDays(process.env),
      events: filtered,
      skippedEvents: skippedFeed,
      skippedCount: skippedRecords.length,
      totalRaw: raw.length,
      totalDeduped: deduped.length,
      total: filtered.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), events: [] });
  }
});

export default router;
