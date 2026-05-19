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

/** Liquid-equivalent hourly total (mm); ignore trace drizzle. */
const PRECIP_HOURLY_MM_MIN = 0.05;

/**
 * @param {Date} date
 * @param {string} timeZone
 */
function formatNextPrecipWhen(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const dStr = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
  const tStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
  return `${dStr} · ${tStr}`;
}

/**
 * Next forecast hour with meaningful precipitation within ~10 days (Open-Meteo hourly).
 * @returns {Promise<string>} Human-readable when in `timeZone`, or empty string if none / error.
 */
export async function fetchNextPrecipCaption(lat, lon, timeZone) {
  const tz =
    typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'precipitation');
  url.searchParams.set('forecast_days', '10');
  url.searchParams.set('timezone', tz);

  let r;
  try {
    r = await fetch(url.toString(), {
      headers: { 'User-Agent': 'dashbird/1.0 (hero next precip; open-meteo.com)' },
    });
  } catch {
    return '';
  }
  if (!r.ok) return '';

  let data;
  try {
    data = await r.json();
  } catch {
    return '';
  }

  const times = data?.hourly?.time;
  const prec = data?.hourly?.precipitation;
  if (!Array.isArray(times) || !Array.isArray(prec) || times.length !== prec.length) return '';

  const nowMs = Date.now();
  const horizonMs = nowMs + 10 * 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;

  for (let i = 0; i < times.length; i++) {
    const start = new Date(times[i]).getTime();
    if (!Number.isFinite(start) || start >= horizonMs) break;
    if (start + hourMs <= nowMs) continue;
    const p = Number(prec[i]);
    if (!Number.isFinite(p) || p < PRECIP_HOURLY_MM_MIN) continue;
    return formatNextPrecipWhen(new Date(times[i]), tz);
  }
  return '';
}

/**
 * @returns {Promise<{ tempF: number, apparentF: number | null, code: number, windMph: number | null, windDirectionFromDeg: number | null, uvIndex: number | null, usAqi: number | null }>}
 */
export async function fetchCurrentWeather(lat, lon) {
  const la = String(lat);
  const lo = String(lon);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', la);
  url.searchParams.set('longitude', lo);
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,uv_index',
  );
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');

  const airUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
  airUrl.searchParams.set('latitude', la);
  airUrl.searchParams.set('longitude', lo);
  airUrl.searchParams.set('current', 'us_aqi');
  airUrl.searchParams.set('timezone', 'auto');

  const [r1, r2] = await Promise.all([
    fetch(url.toString()),
    fetch(airUrl.toString(), {
      headers: { 'User-Agent': 'dashbird/1.0 (hero city AQI; open-meteo.com)' },
    }).catch(() => null),
  ]);
  if (!r1 || !r1.ok) throw new Error(`HTTP ${r1?.status ?? '?'}`);
  const data = await r1.json();
  const cur = data.current;
  if (!cur) throw new Error('No current weather in response');

  const uvRaw = cur.uv_index;
  const uvIndex = typeof uvRaw === 'number' && Number.isFinite(uvRaw) ? uvRaw : null;

  let usAqi = null;
  if (r2 && r2.ok) {
    try {
      const aq = await r2.json();
      const raw = aq?.current?.us_aqi;
      const n = Number(raw);
      if (Number.isFinite(n)) usAqi = Math.round(n);
    } catch {
      /* ignore */
    }
  }

  return {
    tempF: cur.temperature_2m,
    apparentF: cur.apparent_temperature ?? null,
    code: cur.weather_code,
    windMph: cur.wind_speed_10m ?? null,
    windDirectionFromDeg:
      typeof cur.wind_direction_10m === 'number' ? cur.wind_direction_10m : null,
    uvIndex,
    usAqi,
  };
}
