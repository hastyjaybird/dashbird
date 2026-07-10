import { Router } from 'express';
import express from 'express';
import {
  loadEventsFinderCriteria,
  saveEventsFinderCriteria,
} from '../lib/events-finder-criteria-store.js';
import {
  BAY_AREA_HOME_CITIES,
  citiesWithinRadius,
  resolveEventsFinderGeo,
} from '../lib/events-finder-geo.js';
import { geocodeUsZip5 } from '../lib/zip-geocode.js';

const router = Router();
router.use(express.json({ limit: '64kb' }));

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
    const [criteria, geo] = await Promise.all([
      loadEventsFinderCriteria(),
      resolveEventsFinderGeo(),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...criteria,
      geo: geoPayload(geo),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * ZIP + miles → cities in the Bay catalog within that radius (for filter auto-check).
 * GET /api/events-finder-criteria/cities-in-radius?zip=94608&miles=25
 */
router.get('/cities-in-radius', async (req, res) => {
  try {
    const zip = String(req.query.zip || '').replace(/\D/g, '');
    const miles = Number(req.query.miles);
    if (zip.length !== 5) {
      res.status(400).json({ ok: false, error: 'invalid_zip', hint: 'Enter a 5-digit US ZIP' });
      return;
    }
    if (!Number.isFinite(miles) || miles <= 0 || miles > 100) {
      res.status(400).json({
        ok: false,
        error: 'invalid_miles',
        hint: 'Set max miles between 1 and 100',
      });
      return;
    }

    const geo = await geocodeUsZip5(zip);
    if (!geo) {
      res.status(404).json({ ok: false, error: 'zip_not_found', hint: `Could not geocode ZIP ${zip}` });
      return;
    }

    const cities = citiesWithinRadius(geo.lat, geo.lon, miles);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      zip,
      place: geo.place,
      city: geo.city,
      stateAbbrev: geo.stateAbbrev,
      lat: geo.lat,
      lon: geo.lon,
      miles,
      cities,
      cityNames: cities.map((c) => c.name),
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
    const geo = await resolveEventsFinderGeo();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      lookFor: saved.lookFor,
      skip: saved.skip,
      filters: saved.filters,
      scrape: saved.scrape,
      hiddenEventIds: saved.hiddenEventIds,
      geo: geoPayload(geo),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
