import { getMoonTimes } from '../lib/suncalc.js';

const WMO = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Drizzle',
  61: 'Rain',
  71: 'Snow',
  80: 'Rain showers',
  95: 'Thunderstorm',
};

export function describeWeather(code) {
  return WMO[code] ?? 'Weather';
}

/**
 * @returns {Promise<{ tempF: number, apparentF: number | null, code: number, windMph: number | null, windDirectionFromDeg: number | null }>}
 */
export async function fetchCurrentWeather(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
  );
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const cur = data.current;
  if (!cur) throw new Error('No current weather in response');

  return {
    tempF: cur.temperature_2m,
    apparentF: cur.apparent_temperature ?? null,
    code: cur.weather_code,
    windMph: cur.wind_speed_10m ?? null,
    windDirectionFromDeg:
      typeof cur.wind_direction_10m === 'number' ? cur.wind_direction_10m : null,
  };
}

/** Next moonrise strictly after `now`, as ISO string (SunCalc); null if none in range. */
function nextMoonriseIso(lat, lon, now = new Date()) {
  const t0 = now.getTime();
  const anchor = new Date(now);
  anchor.setUTCHours(0, 0, 0, 0);
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  for (let i = 0; i < 64; i++) {
    const probe = new Date(
      Date.UTC(
        anchor.getUTCFullYear(),
        anchor.getUTCMonth(),
        anchor.getUTCDate() + i,
        0,
        0,
        0,
        0,
      ),
    );
    const mt = getMoonTimes(probe, lat, lon, true);
    const rise = mt.rise;
    if (rise instanceof Date && !Number.isNaN(rise.getTime()) && rise.getTime() > t0) {
      return rise.toISOString();
    }
  }
  return null;
}

/**
 * Sunset today + next moonrise after “now” (may be tomorrow or later).
 * Sun/moon civil times from Open-Meteo; moonrise instant from SunCalc (Open-Meteo rejects moonrise in daily).
 */
export async function fetchAstronomyForHero(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('daily', 'sunrise,sunset');
  url.searchParams.set('timezone', 'America/Los_Angeles');
  url.searchParams.set('forecast_days', '16');

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(String(data.reason || 'Open-Meteo error'));
  const d = data.daily;
  if (!d?.sunset?.[0]) throw new Error('Astronomy data unavailable');

  return {
    sunrise: d.sunrise?.[0] ?? null,
    sunset: d.sunset[0] ?? null,
    moonrise: nextMoonriseIso(lat, lon, new Date()),
  };
}
