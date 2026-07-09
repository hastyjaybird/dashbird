/**
 * Reverse geocode lat/lon (Nominatim) for device-location header label.
 */
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

/** @type {Map<string, { shortLabel: string, label: string, timeZone: string }>} */
const cache = new Map();

function cacheKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

/**
 * @param {Record<string, string | undefined>} address
 * @returns {string}
 */
export function shortLabelFromNominatimAddress(address) {
  if (!address || typeof address !== 'object') return '';
  const city =
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.municipality ||
    address.county ||
    '';
  const state = address.state || '';
  const iso = address['ISO3166-2-lvl4'];
  let stateAbbrev =
    typeof iso === 'string' && /^US-[A-Z]{2}$/i.test(iso) ? iso.slice(3).toUpperCase() : '';
  if (!stateAbbrev && typeof state === 'string') {
    const map = {
      Alabama: 'AL',
      Alaska: 'AK',
      Arizona: 'AZ',
      Arkansas: 'AR',
      California: 'CA',
      Colorado: 'CO',
      Connecticut: 'CT',
      Delaware: 'DE',
      Florida: 'FL',
      Georgia: 'GA',
      Hawaii: 'HI',
      Idaho: 'ID',
      Illinois: 'IL',
      Indiana: 'IN',
      Iowa: 'IA',
      Kansas: 'KS',
      Kentucky: 'KY',
      Louisiana: 'LA',
      Maine: 'ME',
      Maryland: 'MD',
      Massachusetts: 'MA',
      Michigan: 'MI',
      Minnesota: 'MN',
      Mississippi: 'MS',
      Missouri: 'MO',
      Montana: 'MT',
      Nebraska: 'NE',
      Nevada: 'NV',
      'New Hampshire': 'NH',
      'New Jersey': 'NJ',
      'New Mexico': 'NM',
      'New York': 'NY',
      'North Carolina': 'NC',
      'North Dakota': 'ND',
      Ohio: 'OH',
      Oklahoma: 'OK',
      Oregon: 'OR',
      Pennsylvania: 'PA',
      'Rhode Island': 'RI',
      'South Carolina': 'SC',
      'South Dakota': 'SD',
      Tennessee: 'TN',
      Texas: 'TX',
      Utah: 'UT',
      Vermont: 'VT',
      Virginia: 'VA',
      Washington: 'WA',
      'West Virginia': 'WV',
      Wisconsin: 'WI',
      Wyoming: 'WY',
      'District of Columbia': 'DC',
    };
    stateAbbrev = map[state] || '';
  }
  const place = String(city).trim();
  if (place && stateAbbrev) return `${place}, ${stateAbbrev}`;
  if (place && state) return `${place}, ${state}`;
  if (place) return place;
  if (stateAbbrev) return stateAbbrev;
  if (state) return state;
  return '';
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string>}
 */
async function fetchTimeZoneForCoords(lat, lon) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current', 'temperature_2m');
  url.searchParams.set('timezone', 'auto');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Dashbird/1.0 (device timezone)' },
    });
    if (!r.ok) return '';
    const j = await r.json();
    const tz = typeof j?.timezone === 'string' ? j.timezone.trim() : '';
    return /^[A-Za-z_/+-]+$/.test(tz) ? tz : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ lat: number, lon: number, shortLabel: string, label: string, timeZone: string } | null>}
 */
export async function reverseGeocodeCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const key = cacheKey(lat, lon);
  if (cache.has(key)) return { lat, lon, ...cache.get(key) };

  const url = new URL(NOMINATIM);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('format', 'json');
  url.searchParams.set('zoom', '14');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Dashbird/1.0 (device reverse geocode; local dashboard)',
      },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const address = j?.address && typeof j.address === 'object' ? j.address : {};
    const fromAddress = shortLabelFromNominatimAddress(address);
    const fromDisplay =
      typeof j?.display_name === 'string'
        ? j.display_name
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)
            .slice(0, 2)
            .join(', ')
        : '';
    const shortLabel = fromAddress || fromDisplay;
    if (!shortLabel) return null;
    const label = typeof j?.display_name === 'string' ? j.display_name : shortLabel;
    const timeZone = await fetchTimeZoneForCoords(lat, lon);
    const out = { shortLabel, label, timeZone };
    cache.set(key, out);
    return { lat, lon, ...out };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
