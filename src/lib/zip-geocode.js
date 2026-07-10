/**
 * US ZIP → lat/lon for dashboard location (Zippopotam open API).
 * Process-lifetime cache + in-flight coalescing so parallel page-load routes
 * do not stampede Zippopotam with identical requests.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, { at: number, value: Awaited<ReturnType<typeof fetchUsZip5Uncached>> }>} */
const cache = new Map();
/** @type {Map<string, Promise<Awaited<ReturnType<typeof fetchUsZip5Uncached>>>>} */
const inFlight = new Map();

/**
 * @param {string} zip5
 * @returns {Promise<{ lat: number, lon: number, city: string, place: string, stateAbbrev: string, stateName: string } | null>}
 */
async function fetchUsZip5Uncached(zip5) {
  const r = await fetch(`https://api.zippopotam.us/us/${zip5}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const p = j?.places?.[0];
  if (!p) return null;
  const lat = parseFloat(p.latitude);
  const lon = parseFloat(p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const city = String(p['place name'] || '').trim();
  const st = String(p['state abbreviation'] || '').trim();
  const stateName = String(p.state || '').trim();
  const place = city && st ? `${city}, ${st}` : st || city || `ZIP ${zip5}`;
  return { lat, lon, city, place, stateAbbrev: st, stateName };
}

/**
 * @param {string} zip5
 * @returns {Promise<{ lat: number, lon: number, city: string, place: string, stateAbbrev: string, stateName: string } | null>}
 */
export async function geocodeUsZip5(zip5) {
  const z = String(zip5).replace(/\D/g, '');
  if (z.length !== 5) return null;

  const now = Date.now();
  const hit = cache.get(z);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;

  const pending = inFlight.get(z);
  if (pending) return pending;

  const promise = fetchUsZip5Uncached(z)
    .then((value) => {
      if (value) cache.set(z, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(z);
    });

  inFlight.set(z, promise);
  return promise;
}
