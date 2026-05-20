/**
 * Garden nasturtium (Tropaeolum majus) seasonal bloom heuristic for the Earth strip.
 * Late spring through early summer until daily highs reach ~85°F (29°C).
 */
import { calendarMonthInZone } from './dashboard-geo.js';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

/** Flowering typically ceases once highs reach this (°F). */
export const NASTURTIUM_BLOOM_STOP_F = 85;
export const NASTURTIUM_BLOOM_STOP_C = 29;

/** Late spring–early summer (calendar months, dashboard timezone). */
export const NASTURTIUM_SEASON_MONTHS = [4, 5, 6];

const REF_URL = 'https://www.rhs.org.uk/plants/nasturtium/growing-guide';

/** Earth strip subtext (culinary use, two words). */
export const NASTURTIUM_CULINARY_SUBTEXT = 'Peppery greens';

/**
 * @param {number} month 1–12
 */
export function isNasturtiumSeasonMonth(month) {
  return NASTURTIUM_SEASON_MONTHS.includes(month);
}

/**
 * @param {object} data Open-Meteo JSON with daily.time + daily.temperature_2m_max
 * @param {string} timeZone
 */
export function dailyMaxTempFByLocalDate(data, timeZone) {
  const daily = data?.daily;
  const times = daily?.time;
  const maxes = daily?.temperature_2m_max;
  if (!Array.isArray(times) || !Array.isArray(maxes) || times.length !== maxes.length) {
    return new Map();
  }
  /** @type {Map<string, number>} */
  const out = new Map();
  for (let i = 0; i < times.length; i++) {
    const raw = String(times[i] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
    const v = Number(maxes[i]);
    if (!Number.isFinite(v)) continue;
    out.set(raw, v);
  }
  return out;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {string} timeZone
 */
export async function fetchOpenMeteoNasturtiumTemps(lat, lon, timeZone) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('timezone', timeZone || 'America/Los_Angeles');
  url.searchParams.set('past_days', '2');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('daily', 'temperature_2m_max');
  url.searchParams.set('temperature_unit', 'fahrenheit');

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { 'User-Agent': 'dashbird/1.0 (nasturtium bloom heuristic; open-meteo.com)' },
    });
    if (!r.ok) return { ok: false, error: `open_meteo_http_${r.status}` };
    const data = await r.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(to);
  }
}

/**
 * @param {Map<string, number>} byDate YYYY-MM-DD → °F
 * @param {string} wallYmd today in local zone
 */
export function relevantDailyMaxF(byDate, wallYmd) {
  const today = byDate.get(wallYmd);
  const parts = wallYmd.split('-').map(Number);
  const prev = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] - 1));
  const prevYmd = prev.toISOString().slice(0, 10);
  const yesterday = byDate.get(prevYmd);
  const vals = [today, yesterday].filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return { todayMaxF: today ?? null, recentMaxF: null };
  return { todayMaxF: today ?? null, recentMaxF: Math.max(...vals) };
}

/**
 * @param {{
 *   lat: number,
 *   lon: number,
 *   now?: Date,
 *   timeZone?: string,
 *   includeInactive?: boolean,
 * }} p
 */
export async function evaluateNasturtiumBloom(p) {
  const lat = p.lat;
  const lon = p.lon;
  const timeZone = (p.timeZone || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const now = p.now instanceof Date && !Number.isNaN(p.now.getTime()) ? p.now : new Date();
  const includeInactive = Boolean(p.includeInactive);

  const month = calendarMonthInZone(now, timeZone);
  const wallYmd = now.toLocaleDateString('en-CA', { timeZone });
  const inSeason = Number.isFinite(month) && isNasturtiumSeasonMonth(month);

  const wx = await fetchOpenMeteoNasturtiumTemps(lat, lon, timeZone);
  if (!wx.ok) {
    return {
      ok: true,
      status: 'weather_error',
      inSeason,
      month,
      wallYmd,
      weatherError: wx.error,
      items: includeInactive
        ? [
            {
              earthType: 'nasturtium_bloom_inactive',
              label: 'Nasturtium bloom — weather unavailable',
              detailLine: `Could not load Open-Meteo daily max (late spring–early summer · stops ≥${NASTURTIUM_BLOOM_STOP_F}°F)`,
              forecastUrl: REF_URL,
            },
          ]
        : [],
    };
  }

  const byDate = dailyMaxTempFByLocalDate(wx.data, timeZone);
  const { todayMaxF, recentMaxF } = relevantDailyMaxF(byDate, wallYmd);
  const heatCeased =
    recentMaxF != null && Number.isFinite(recentMaxF) && recentMaxF >= NASTURTIUM_BLOOM_STOP_F;

  /** @type {Array<{ earthType: string, label: string, detailLine: string, forecastUrl: string }>} */
  const items = [];

  if (inSeason && !heatCeased) {
    items.push({
      earthType: 'nasturtium_bloom',
      label: 'Nasturtium flowers',
      detailLine: NASTURTIUM_CULINARY_SUBTEXT,
      forecastUrl: REF_URL,
    });
  } else if (includeInactive) {
    if (!inSeason) {
      items.push({
        earthType: 'nasturtium_bloom_inactive',
        label: 'Nasturtium flowers — off season',
        detailLine: `Outside Apr–Jun window (month ${month ?? '—'}) · blooms late spring–early summer until heat ≥${NASTURTIUM_BLOOM_STOP_F}°F`,
        forecastUrl: REF_URL,
      });
    } else if (heatCeased) {
      const t =
        recentMaxF != null && Number.isFinite(recentMaxF) ? Math.round(recentMaxF) : '—';
      items.push({
        earthType: 'nasturtium_bloom_inactive',
        label: 'Nasturtium flowers — heat ended bloom',
        detailLine: `Flowering typically ceased · recent daily max ~${t}°F (≥${NASTURTIUM_BLOOM_STOP_F}°F / ${NASTURTIUM_BLOOM_STOP_C}°C)`,
        forecastUrl: REF_URL,
      });
    }
  }

  let status = 'off_season';
  if (inSeason && heatCeased) status = 'heat_ceased';
  else if (inSeason && !heatCeased) status = 'blooming';

  return {
    ok: true,
    status,
    inSeason,
    month,
    wallYmd,
    todayMaxF,
    recentMaxF,
    heatCeased,
    items,
  };
}
