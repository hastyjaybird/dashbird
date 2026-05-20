const OPEN_METEO_AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/**
 * US EPA AQI category label + glyph fill (no text inside icon; color communicates band).
 * @param {number} usAqi
 * @returns {{ label: string, hex: string }}
 */
export function usAqiCategoryStyle(usAqi) {
  const a = Math.round(Number(usAqi));
  if (!Number.isFinite(a)) return { label: 'Unknown', hex: '#6b7280' };
  if (a <= 50) return { label: 'Good', hex: '#00a84d' };
  if (a <= 100) return { label: 'Moderate', hex: '#e4b422' };
  if (a <= 150) return { label: 'Unhealthy for sensitive groups', hex: '#e85d04' };
  if (a <= 200) return { label: 'Unhealthy', hex: '#dc2626' };
  if (a <= 300) return { label: 'Very unhealthy', hex: '#9333ea' };
  return { label: 'Hazardous', hex: '#7f1d1d' };
}

/**
 * @param {{ lat: number, lon: number, timeZone?: string }}
 * @returns {Promise<{ ok: true, usAqi: number, timeIso: string } | { ok: false, error: string }>}
 */
export async function fetchOpenMeteoCurrentUsAqi({ lat, lon, timeZone }) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return { ok: false, error: 'invalid_lat_lon' };
  }
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'auto';
  const url = new URL(OPEN_METEO_AIR);
  url.searchParams.set('latitude', String(la));
  url.searchParams.set('longitude', String(lo));
  url.searchParams.set('current', 'us_aqi');
  url.searchParams.set('timezone', tz);
  const r = await fetch(url.toString(), {
    headers: { 'User-Agent': 'dashbird/1.0 (dashboard AQI; open-meteo.com)' },
  });
  if (!r.ok) {
    return { ok: false, error: `open_meteo_air_http_${r.status}` };
  }
  const j = await r.json();
  const raw = j?.current?.us_aqi;
  const usAqi = Number(raw);
  if (!Number.isFinite(usAqi)) {
    return { ok: false, error: 'missing_us_aqi' };
  }
  const timeIso = typeof j?.current?.time === 'string' ? j.current.time : '';
  return { ok: true, usAqi: Math.round(usAqi), timeIso };
}
