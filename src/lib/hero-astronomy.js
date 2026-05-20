import { Body, Observer, SearchMoonQuarter, SearchRiseSet, MoonPhase } from 'astronomy-engine';
import { getHeroAstronomyFromNws } from './nws-points.js';

/** If NWS points `astronomicalData.sunset` is still yesterday (stale after local midnight), use next sunset. */
const SUNSET_PAST_SLACK_MS = 60_000;

/*
 * ---------------------------------------------------------------------------
 * Previously: Open-Meteo `api.open-meteo.com/v1/forecast` with `daily=sunrise,sunset`,
 * `timezone=America/Los_Angeles` (hardcoded), and `timeformat=unixtime`.
 * That path is disabled; civil sunset/moon times for the hero now come from the
 * U.S. National Weather Service points API (`api.weather.gov`), the same program
 * family as https://forecast.weather.gov — see `properties.astronomicalData` and
 * `properties.timeZone` in the points response.
 * ---------------------------------------------------------------------------
 */

function clampLatLon(lat, lon) {
  const la = typeof lat === 'number' && Number.isFinite(lat) ? lat : 0;
  const lo = typeof lon === 'number' && Number.isFinite(lon) ? lon : 0;
  return { lat: Math.min(90, Math.max(-90, la)), lon: ((lo + 180) % 360 + 360) % 360 - 180 };
}

/**
 * Next quarter lunar phase instant after `fromDate` (`quarter`: 0 new, 1 first, 2 full, 3 third).
 * @param {*} observer astronomy-engine `Observer`
 * @param {Date} fromDate
 * @param {0|1|2|3} targetQuarter
 * @returns {number | null} epoch ms UTC
 */
function nextMoonQuarterEpochMs(observer, fromDate, targetQuarter) {
  let d = fromDate instanceof Date ? fromDate : new Date();
  for (let i = 0; i < 14; i++) {
    const mq = SearchMoonQuarter(d, observer);
    if (!mq?.time?.date || Number.isNaN(mq.time.date.getTime())) return null;
    if (mq.quarter === targetQuarter) return mq.time.date.getTime();
    d = new Date(mq.time.date.getTime() + 3600000);
  }
  return null;
}

/**
 * Next global full moon (instant) after `fromDate` via astronomy-engine quarters.
 * @param {*} observer astronomy-engine `Observer`
 * @param {Date} [fromDate]
 * @returns {number | null} epoch ms UTC
 */
function nextFullMoonEpochMs(observer, fromDate = new Date()) {
  return nextMoonQuarterEpochMs(observer, fromDate, 2);
}

/**
 * Next global new moon after `fromDate`.
 * @param {*} observer astronomy-engine `Observer`
 * @param {Date} [fromDate]
 * @returns {number | null} epoch ms UTC
 */
function nextNewMoonEpochMs(observer, fromDate = new Date()) {
  return nextMoonQuarterEpochMs(observer, fromDate, 0);
}

/**
 * When true, hero moon caption should show **next new moon** (full or waning now).
 * When false, show **next full moon** (new or waxing now).
 * Uses geocentric Sun–Moon ecliptic longitude difference: ≥180° is full through waning.
 */
function moonCaptionShowsNextNewMoon() {
  try {
    const deg = MoonPhase(new Date());
    return typeof deg === 'number' && Number.isFinite(deg) && deg >= 180;
  } catch {
    return false;
  }
}

/**
 * Sunset from NWS points `astronomicalData` (forecast.weather.gov family) + next
 * moonrise via astronomy-engine (unchanged).
 *
 * @returns {Promise<{
 *   sunsetEpochMs: number,
 *   moonriseEpochMs: number | null,
 *   nextFullMoonEpochMs: number | null,
 *   nextNewMoonEpochMs: number | null,
 *   moonCaptionShowsNextNewMoon: boolean,
 *   timeZone: string,
 *   nwsForecastUrl: string,
 *   nwsMapClickUrl: string,
 *   nwsPointsUrl: string,
 * }>}
 */
export async function computeHeroAstronomy(lat, lon) {
  const { lat: la, lon: lo } = clampLatLon(lat, lon);
  const observer = new Observer(la, lo, 0);

  const {
    sunsetEpochMs: nwsSunsetMs,
    timeZone,
    nwsForecastUrl,
    nwsMapClickUrl,
    nwsPointsUrl,
  } = await getHeroAstronomyFromNws(la, lo);

  let sunsetEpochMs = nwsSunsetMs;
  if (
    typeof sunsetEpochMs === 'number' &&
    Number.isFinite(sunsetEpochMs) &&
    sunsetEpochMs < Date.now() - SUNSET_PAST_SLACK_MS
  ) {
    try {
      const ev = SearchRiseSet(Body.Sun, observer, -1, new Date(), 2);
      if (ev?.date && !Number.isNaN(ev.date.getTime())) sunsetEpochMs = ev.date.getTime();
    } catch {
      /* keep NWS value */
    }
  }
  let moonriseMs = null;
  try {
    const ev = SearchRiseSet(Body.Moon, observer, +1, new Date(), 5);
    if (ev?.date && !Number.isNaN(ev.date.getTime())) moonriseMs = ev.date.getTime();
  } catch {
    /* no rise in search window */
  }

  let nextFullMs = null;
  let nextNewMs = null;
  try {
    nextFullMs = nextFullMoonEpochMs(observer, new Date());
  } catch {
    /* rare ephemeris edge */
  }
  try {
    nextNewMs = nextNewMoonEpochMs(observer, new Date());
  } catch {
    /* rare ephemeris edge */
  }

  let moonCaptionShowsNextNew = false;
  try {
    moonCaptionShowsNextNew = moonCaptionShowsNextNewMoon();
  } catch {
    moonCaptionShowsNextNew = false;
  }

  return {
    sunsetEpochMs,
    moonriseEpochMs: moonriseMs,
    nextFullMoonEpochMs: nextFullMs,
    nextNewMoonEpochMs: nextNewMs,
    moonCaptionShowsNextNewMoon: moonCaptionShowsNextNew,
    timeZone,
    nwsForecastUrl,
    nwsMapClickUrl,
    nwsPointsUrl,
  };
}
