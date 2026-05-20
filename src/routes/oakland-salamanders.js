import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import {
  fetchOpenMeteoSalamanderContext,
  isNearOaklandSalamanderAnchor,
  isOaklandSalamanderCalendarWindow,
  latestHourlyTempF,
  sumRecentHourlyPrecipInches,
} from '../lib/oakland-salamanders.js';
import { wallYmdInTimeZone } from '../lib/yosemite-moonbow.js';

const router = Router();

const REF_URL = 'https://amphibiaweb.org/species/4046';

router.get('/', async (req, res) => {
  try {
    const off = String(process.env.EARTH_OAKLAND_SALAMANDERS || '').trim() === '0';
    if (off) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, disabled: true, items: [] });
      return;
    }

    const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
    const now = new Date();
    const wallYmd = wallYmdInTimeZone(now, timeZone);

    const rawRad = process.env.SALAMANDER_OAKLAND_RADIUS_MI;
    const radiusMiles =
      rawRad != null && String(rawRad).trim() !== ''
        ? Math.min(40, Math.max(5, Number.parseFloat(String(rawRad))))
        : 18;

    const rawRain = process.env.SALAMANDER_OAKLAND_MIN_RAIN_IN;
    const minRainIn =
      rawRain != null && String(rawRain).trim() !== ''
        ? Math.min(3, Math.max(0.05, Number.parseFloat(String(rawRain))))
        : 0.28;

    const rawH = process.env.SALAMANDER_OAKLAND_RAIN_HOURS;
    const rainHours =
      rawH != null && String(rawH).trim() !== ''
        ? Math.min(120, Math.max(24, Math.round(Number.parseFloat(String(rawH)))))
        : 72;

    const rawTf = process.env.SALAMANDER_OAKLAND_AIR_TEMP_F;
    const minAirTempF =
      rawTf != null && String(rawTf).trim() !== ''
        ? Math.min(75, Math.max(35, Number.parseFloat(String(rawTf))))
        : 52;

    const { lat, lon } = await resolveDashboardWeatherLatLon();

    const inCalendar = isOaklandSalamanderCalendarWindow(wallYmd);
    const inOakland = isNearOaklandSalamanderAnchor(lat, lon, radiusMiles);

    if (!inCalendar || !inOakland) {
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.json({
        ok: true,
        timeZone,
        wallYmd,
        radiusMiles,
        inCalendar,
        inOakland,
        itemCount: 0,
        items: [],
      });
      return;
    }

    const wx = await fetchOpenMeteoSalamanderContext(lat, lon);
    if (!wx.ok) {
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.json({
        ok: true,
        timeZone,
        wallYmd,
        radiusMiles,
        weatherError: wx.error,
        itemCount: 0,
        items: [],
      });
      return;
    }

    const rain = sumRecentHourlyPrecipInches(wx.data, rainHours);
    const tempF = latestHourlyTempF(wx.data);
    const sumIn = rain?.sumInches ?? null;
    const wetEnough = rain != null && Number.isFinite(sumIn) && sumIn >= minRainIn;
    const warmEnough = tempF != null && Number.isFinite(tempF) && tempF >= minAirTempF;

    if (!wetEnough || !warmEnough) {
      res.setHeader('Cache-Control', 'private, max-age=1800');
      res.json({
        ok: true,
        timeZone,
        wallYmd,
        radiusMiles,
        rainHours,
        minRainIn,
        minAirTempF,
        sumRainIn72h: sumIn,
        airTempF: tempF,
        wetEnough,
        warmEnough,
        itemCount: 0,
        items: [],
      });
      return;
    }

    const rIn = Math.round(sumIn * 100) / 100;
    const detailLine = `${rIn}" rain / ${rainHours}h · ${Math.round(tempF)}°F air (≥${minAirTempF}°F proxy for ~40°F soil) · Nov 1–Apr 1 wet-season gate · Rain + soaked ground matter more than dates (e.g. CTS breeding often Dec–Mar). Leave wildlife undisturbed.`;

    const items = [
      {
        earthType: 'oakland_salamander_surface',
        label: 'Oakland salamanders',
        detailLine,
        forecastUrl: REF_URL,
        salamander: {
          wallYmd,
          sumRainInches: sumIn,
          rainHours,
          airTempF: tempF,
          minRainIn,
          minAirTempF,
        },
      },
    ];

    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.json({
      ok: true,
      timeZone,
      wallYmd,
      radiusMiles,
      rainHours,
      minRainIn,
      minAirTempF,
      sumRainIn72h: sumIn,
      airTempF: tempF,
      itemCount: items.length,
      items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
