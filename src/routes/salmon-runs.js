import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { calendarMonthInZone } from '../lib/dashboard-geo.js';
import { isEarthDebugShowInactive } from '../lib/earth-debug.js';
import { salmonRunEventsNear } from '../lib/salmon-runs-near.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const tz = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
    const locationLabel =
      (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Dashboard coordinates';

    const rawRad = process.env.SALMON_RUN_RADIUS_MI;
    const radiusMiles =
      rawRad != null && String(rawRad).trim() !== ''
        ? Math.min(200, Math.max(5, Number.parseFloat(String(rawRad))))
        : 50;

    const now = new Date();
    const month = calendarMonthInZone(now, tz);
    const debug = isEarthDebugShowInactive();

    const events =
      Number.isFinite(month) && month >= 1 && month <= 12
        ? salmonRunEventsNear(
            {
              lat,
              lon,
              month,
              radiusMiles,
            },
            { includeInactive: debug },
          )
        : [];

    const maxRows = debug ? 36 : 8;
    /** @type {Array<{ earthType: string, label: string, detailLine: string, forecastUrl?: string }>} */
    const items = events.slice(0, maxRows).map((e) => ({
      earthType: e.inMonth ? 'salmon_run' : 'salmon_run_offseason',
      label: 'Salmon',
      detailLine: String(e.siteName || '').replace(/\s+/g, ' ').trim() || '—',
      forecastUrl: e.refUrl || undefined,
    }));

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({
      ok: true,
      locationLabel,
      radiusMiles,
      month,
      timeZone: tz,
      earthDebugShowInactive: debug,
      itemCount: items.length,
      items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
