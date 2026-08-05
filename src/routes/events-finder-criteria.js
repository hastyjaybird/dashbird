import { Router } from 'express';
import express from 'express';
import {
  loadEventsFinderCriteria,
  saveEventsFinderCriteria,
} from '../lib/events-finder-criteria-store.js';
import {
  BAY_AREA_HOME_CITIES,
  resolveEventsFinderGeo,
} from '../lib/events-finder-geo.js';
import { resolveEventsFinderGoogleCalendar } from '../lib/events-finder-google-calendar.js';
import { getFacebookBillingMonthSummary } from '../lib/events-finder-facebook-billing.js';
import { eventsIngestWindowDays } from '../lib/events-finder-window.js';

const router = Router();
router.use(express.json({ limit: '512kb' }));

/**
 * @param {Awaited<ReturnType<typeof resolveEventsFinderGeo>>} geo
 */
function geoPayload(geo) {
  return {
    mode: geo.geoMode,
    bayArea: geo.bayArea,
    zip: geo.zip,
    city: geo.city,
    place: geo.place,
    stateAbbrev: geo.stateAbbrev,
    lat: geo.lat,
    lon: geo.lon,
    locationSlug: geo.locationSlug,
    locationSlugs: geo.locationSlugs,
    homeCities: geo.homeCities,
    bayAreaHomeCities: BAY_AREA_HOME_CITIES,
    locationMode: geo.locationMode || 'home',
    maxMiles: geo.maxMiles ?? null,
  };
}

router.get('/', async (_req, res) => {
  try {
    const [criteria, geo, facebookBilling] = await Promise.all([
      loadEventsFinderCriteria(),
      resolveEventsFinderGeo(),
      getFacebookBillingMonthSummary(),
    ]);
    /** @type {Record<string, unknown>} */
    const out = { ...criteria };
    // Away preview/auto: expose NYC (etc.) filter cities for the UI without
    // permanently overwriting saved Bay criteria on disk.
    if (
      (geo.locationMode === 'preview' || geo.locationMode === 'away') &&
      Array.isArray(geo.homeCities) &&
      geo.homeCities.length
    ) {
      const filters =
        out.filters && typeof out.filters === 'object'
          ? { .../** @type {object} */ (out.filters) }
          : {};
      filters.cities = [...geo.homeCities];
      if (geo.maxMiles != null && Number.isFinite(geo.maxMiles)) {
        filters.maxMiles = geo.maxMiles;
      }
      out.filters = filters;
      out.awayFiltersActive = true;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...out,
      googleCalendar: resolveEventsFinderGoogleCalendar(),
      geo: geoPayload(geo),
      facebookBilling,
      ingestWindow: eventsIngestWindowDays(process.env, { scrape: criteria.scrape }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const saved = await saveEventsFinderCriteria(body);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    const skipMutated =
      Array.isArray(body.skippedEvents)
      || Array.isArray(body.unskipEventIds)
      || Array.isArray(body.hiddenEventIds);
    const [geo, facebookBilling] = await Promise.all([
      resolveEventsFinderGeo(),
      getFacebookBillingMonthSummary(),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    /** @type {Record<string, unknown>} */
    const payload = {
      ok: true,
      lookFor: saved.lookFor,
      skip: saved.skip,
      blacklist: saved.blacklist,
      filters: saved.filters,
      scrape: saved.scrape,
      favoriteEventIds: saved.favoriteEventIds,
      calendarAddedEventIds: saved.calendarAddedEventIds,
      conferenceWatchlist: saved.conferenceWatchlist,
      googleCalendar: resolveEventsFinderGoogleCalendar(),
      geo: geoPayload(geo),
      facebookBilling,
      ingestWindow: eventsIngestWindowDays(process.env, { scrape: saved.scrape }),
      skippedCount: Array.isArray(saved.skippedEvents) ? saved.skippedEvents.length : 0,
    };
    // Filter-only saves omit the bulky skip list — client keeps its cached copy.
    if (skipMutated) {
      payload.hiddenEventIds = saved.hiddenEventIds;
      payload.skippedEvents = saved.skippedEvents;
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
