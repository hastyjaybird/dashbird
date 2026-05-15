import { Router } from 'express';
import {
  loadSkyCalendar,
  filterActiveEvents,
  filterSupermoonForHeroStrip,
} from '../lib/sky-events.js';
import { mergeGeomagneticWithGoes10Mev } from '../lib/goes-proton.js';
import { mergeAuroraWithSwpc } from '../lib/swpc-aurora.js';
import { mergeNakedEyePlanetsWithComputed } from '../lib/naked-eye-planets.js';
import { planetIconUrl } from '../lib/planet-icons.js';

const HERO_TZ = 'America/Los_Angeles';
const DEFAULT_WEATHER_LAT = 37.848;
const DEFAULT_WEATHER_LON = -122.253;

const router = Router();

/**
 * GET /api/sky-events?windowHours=24
 * Calendar + event types live in src/data/sky-events-calendar.json (server-side only).
 */
router.get('/', async (req, res) => {
  try {
    const wh = Number.parseInt(String(req.query.windowHours ?? '24'), 10);
    const windowHours = Number.isFinite(wh) ? Math.min(168, Math.max(1, wh)) : 24;
    const windowMs = windowHours * 60 * 60 * 1000;

    const data = await loadSkyCalendar();
    const now = new Date();
    let active = filterSupermoonForHeroStrip(
      filterActiveEvents(data.events, now, windowMs),
      now,
      HERO_TZ,
    );
    active = await mergeGeomagneticWithGoes10Mev(active, now, windowMs);

    const lat = Number.parseFloat(String(process.env.WEATHER_LAT ?? DEFAULT_WEATHER_LAT));
    const lon = Number.parseFloat(String(process.env.WEATHER_LON ?? DEFAULT_WEATHER_LON));
    const auroraLat = Number.isFinite(lat) ? lat : DEFAULT_WEATHER_LAT;
    const auroraLon = Number.isFinite(lon) ? lon : DEFAULT_WEATHER_LON;
    const locationLabel = (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Oakland, CA · 94608';
    active = await mergeAuroraWithSwpc(
      active,
      auroraLat,
      auroraLon,
      now,
      windowMs,
      HERO_TZ,
      locationLabel,
    );
    active = mergeNakedEyePlanetsWithComputed(
      active,
      auroraLat,
      auroraLon,
      now,
      windowMs,
      HERO_TZ,
    );

    const typeById = Object.fromEntries(
      (data.eventTypes || []).map((t) => [t.id, t]),
    );

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      now: now.toISOString(),
      windowHours,
      sources: data.sources || [],
      eventTypes: data.eventTypes || [],
      active: active.map((ev) => {
        const baseMeta = typeById[ev.type] || { id: ev.type, label: ev.type, icon: '' };
        let typeMeta = baseMeta;
        if (ev.type === 'planet' && typeof ev.planetKey === 'string') {
          const pk = ev.planetKey.toLowerCase().trim();
          const mapped = planetIconUrl(pk);
          const icon = mapped ?? baseMeta.icon;
          const label =
            typeof ev.planetLabel === 'string' && ev.planetLabel.trim() !== ''
              ? ev.planetLabel.trim()
              : baseMeta.label;
          typeMeta = { ...baseMeta, icon, label };
        }
        return {
          id: ev.id,
          type: ev.type,
          title: ev.title,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt ?? null,
          peakAt: ev.peakAt ?? null,
          source: ev.source ?? null,
          detailLine: typeof ev.detailLine === 'string' ? ev.detailLine : null,
          auroraLikelihood: ev.auroraLikelihood ?? null,
          planetKey: ev.type === 'planet' ? ev.planetKey ?? null : null,
          typeMeta,
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
