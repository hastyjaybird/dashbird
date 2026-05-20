/**
 * US ZIP → lat/lon for dashboard location (Zippopotam open API).
 * @param {string} zip5
 * @returns {Promise<{ lat: number, lon: number, place: string } | null>}
 */
export async function geocodeUsZip5(zip5) {
  const z = String(zip5).replace(/\D/g, '');
  if (z.length !== 5) return null;
  const r = await fetch(`https://api.zippopotam.us/us/${z}`, {
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
  const place = city && st ? `${city}, ${st}` : st || city || `ZIP ${z}`;
  return { lat, lon, place, stateAbbrev: st, stateName };
}
