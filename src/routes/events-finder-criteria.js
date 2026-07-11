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
  };
}

router.get('/', async (_req, res) => {
  try {
    const [criteria, geo, facebookBilling] = await Promise.all([
      loadEventsFinderCriteria(),
      resolveEventsFinderGeo(),
      getFacebookBillingMonthSummary(),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...criteria,
      googleCalendar: resolveEventsFinderGoogleCalendar(),
      geo: geoPayload(geo),
      facebookBilling,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/', async (req, res) => {
  try {
    const saved = await saveEventsFinderCriteria(req.body);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    const [geo, facebookBilling] = await Promise.all([
      resolveEventsFinderGeo(),
      getFacebookBillingMonthSummary(),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      lookFor: saved.lookFor,
      skip: saved.skip,
      filters: saved.filters,
      scrape: saved.scrape,
      hiddenEventIds: saved.hiddenEventIds,
      skippedEvents: saved.skippedEvents,
      favoriteEventIds: saved.favoriteEventIds,
      calendarAddedEventIds: saved.calendarAddedEventIds,
      googleCalendar: resolveEventsFinderGoogleCalendar(),
      geo: geoPayload(geo),
      facebookBilling,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
