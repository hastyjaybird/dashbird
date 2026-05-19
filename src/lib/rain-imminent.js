/**
 * Rain / precip checks via Open-Meteo (minutely_15 for 2h, hourly for 24h).
 */
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const HORIZON_2H_MS = 2 * 60 * 60 * 1000;
const HORIZON_24H_MS = 24 * 60 * 60 * 1000;
const PRECIP_MM_MIN = 0.05;
const PRECIP_PROB_MIN = 35;

/**
 * @param {number | undefined} p mm
 * @param {number | undefined} pr %
 */
function intervalLooksWet(p, pr) {
  return (
    (Number.isFinite(p) && p >= PRECIP_MM_MIN) ||
    (Number.isFinite(pr) && pr >= PRECIP_PROB_MIN)
  );
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {string} [timeZone]
 * @returns {Promise<{ imminent: boolean, minutesUntil: number | null, message: string, precipMm?: number }>}
 */
export async function rainImminentWithin2Hours(lat, lon, timeZone = 'America/Los_Angeles') {
  const tz =
    typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('minutely_15', 'precipitation,precipitation_probability');
  url.searchParams.set('forecast_minutely_15', '8');
  url.searchParams.set('timezone', tz);
  url.searchParams.set('precipitation_unit', 'mm');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'Dashbird/1.0 (rain imminent; open-meteo.com)' },
    });
    if (!r.ok) return { imminent: false, minutesUntil: null, message: '' };
    const data = await r.json();
    const times = data?.minutely_15?.time;
    const prec = data?.minutely_15?.precipitation;
    const prob = data?.minutely_15?.precipitation_probability;
    if (!Array.isArray(times) || !Array.isArray(prec)) {
      return { imminent: false, minutesUntil: null, message: '' };
    }

    const nowMs = Date.now();
    const endMs = nowMs + HORIZON_2H_MS;

    for (let i = 0; i < times.length; i++) {
      const startMs = new Date(times[i]).getTime();
      if (!Number.isFinite(startMs) || startMs >= endMs) break;
      if (startMs < nowMs - 60_000) continue;

      const p = Number(prec[i]);
      const pr = Number(prob?.[i]);
      if (!intervalLooksWet(p, pr)) continue;

      const minutesUntil = Math.max(0, Math.round((startMs - nowMs) / 60_000));
      const message =
        minutesUntil <= 1
          ? 'rain expected now'
          : `rain expected in ${minutesUntil} minutes`;
      return { imminent: true, minutesUntil, message, precipMm: Number.isFinite(p) ? p : undefined };
    }

    return { imminent: false, minutesUntil: null, message: '' };
  } catch {
    return { imminent: false, minutesUntil: null, message: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Any meaningful precipitation in the next 24 hours (Open-Meteo hourly).
 * Used to show / hide the Weather Radar sidebar card.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} [timeZone]
 * @returns {Promise<{ expected: boolean, hoursUntil: number | null }>}
 */
export async function precipExpectedWithin24Hours(lat, lon, timeZone = 'America/Los_Angeles') {
  const tz =
    typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'precipitation,precipitation_probability');
  url.searchParams.set('forecast_hours', '24');
  url.searchParams.set('timezone', tz);
  url.searchParams.set('precipitation_unit', 'mm');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'Dashbird/1.0 (precip 24h; open-meteo.com)' },
    });
    if (!r.ok) return { expected: false, hoursUntil: null };
    const data = await r.json();
    const times = data?.hourly?.time;
    const prec = data?.hourly?.precipitation;
    const prob = data?.hourly?.precipitation_probability;
    if (!Array.isArray(times) || !Array.isArray(prec)) {
      return { expected: false, hoursUntil: null };
    }

    const nowMs = Date.now();
    const endMs = nowMs + HORIZON_24H_MS;

    for (let i = 0; i < times.length; i++) {
      const startMs = new Date(times[i]).getTime();
      if (!Number.isFinite(startMs) || startMs >= endMs) break;
      if (startMs < nowMs - 60_000) continue;

      const p = Number(prec[i]);
      const pr = Number(prob?.[i]);
      if (!intervalLooksWet(p, pr)) continue;

      const hoursUntil = Math.max(0, Math.round((startMs - nowMs) / 3_600_000));
      return { expected: true, hoursUntil };
    }

    return { expected: false, hoursUntil: null };
  } catch {
    return { expected: false, hoursUntil: null };
  } finally {
    clearTimeout(timer);
  }
}
