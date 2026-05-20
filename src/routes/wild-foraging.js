import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { calendarMonthInZone } from '../lib/dashboard-geo.js';
import { isEarthDebugShowInactive } from '../lib/earth-debug.js';
import { nativeEdiblePlantEventsNear } from '../lib/native-edible-plants-near.js';
import { fetchFallingFruitRowsNear } from '../lib/falling-fruit-near.js';
import { wildFoodTypeSubtitleFromLabel } from '../lib/wild-food-type-subtitle.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const tz = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
    const locationLabel =
      (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Dashboard coordinates';

    const rawRad = process.env.EDIBLE_NATIVE_PLANT_RADIUS_MI;
    const radiusMiles =
      rawRad != null && String(rawRad).trim() !== ''
        ? Math.min(200, Math.max(10, Number.parseFloat(String(rawRad))))
        : 75;

    const now = new Date();
    const month = calendarMonthInZone(now, tz);
    const debug = isEarthDebugShowInactive();

    const nativeEvents =
      Number.isFinite(month) && month >= 1 && month <= 12
        ? nativeEdiblePlantEventsNear(
            {
              lat,
              lon,
              month,
              radiusMiles,
            },
            { includeInactive: debug },
          )
        : [];

    const ffKey = (process.env.FALLING_FRUIT_API_KEY || '').trim();
    const rawMaxM = process.env.FALLING_FRUIT_MAX_DISTANCE_M;
    const maxDistanceM =
      rawMaxM != null && String(rawMaxM).trim() !== ''
        ? Math.min(50_000, Math.max(500, Number.parseFloat(String(rawMaxM))))
        : 10_000;

    const rawFfLimit = process.env.FALLING_FRUIT_LOCATION_LIMIT;
    const ffLimit =
      rawFfLimit != null && String(rawFfLimit).trim() !== ''
        ? Math.min(100, Math.max(1, Math.floor(Number(rawFfLimit))))
        : 28;

    const ffRows = ffKey
      ? await fetchFallingFruitRowsNear({
          lat,
          lon,
          apiKey: ffKey,
          maxDistanceM,
          limit: ffLimit,
        })
      : [];

    const maxTotal = debug ? 40 : 12;
    const nativeCap = debug ? 48 : 14;

    /** @type {{ sort: number, item: { earthType: string, label: string, detailLine: string, forecastUrl?: string } }[]} */
    const pairs = [];

    for (const e of nativeEvents.slice(0, nativeCap)) {
      pairs.push({
        sort: e.distanceMi + (e.inMonth ? 0 : 0.0001),
        item: {
          earthType: e.inMonth ? 'wild_edible' : 'wild_edible_offseason',
          label: e.plantLabel,
          detailLine: wildFoodTypeSubtitleFromLabel(e.plantLabel),
          forecastUrl: /^https?:\/\//i.test(e.refUrl) ? e.refUrl : undefined,
        },
      });
    }

    for (const r of ffRows) {
      const { distanceMi, ...rest } = r;
      pairs.push({
        sort: Number.isFinite(distanceMi) ? distanceMi : 999,
        item: rest,
      });
    }

    pairs.sort((a, b) => a.sort - b.sort || a.item.label.localeCompare(b.item.label));
    const items = pairs.slice(0, maxTotal).map((p) => p.item);

    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.json({
      ok: true,
      locationLabel,
      month,
      timeZone: tz,
      nativeRadiusMiles: radiusMiles,
      earthDebugShowInactive: debug,
      fallingFruit: {
        configured: Boolean(ffKey),
        maxDistanceM,
      },
      itemCount: items.length,
      items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
