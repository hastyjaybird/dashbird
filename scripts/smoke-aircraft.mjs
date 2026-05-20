#!/usr/bin/env node
/**
 * Smoke: /api/aircraft-nearby (OpenSky ADS-B near rain-alert address).
 */
const base = process.env.DASHBIRD_BASE || 'http://127.0.0.1:8787';

const r = await fetch(`${base}/api/aircraft-nearby`, { cache: 'no-store' });
const j = await r.json();
if (!r.ok || j.ok === false) {
  console.error('fail', r.status, j);
  process.exit(1);
}
if (j.disabled) {
  console.log('ok', { disabled: true });
  process.exit(0);
}
if (j.geocodeError) {
  console.error('geocode failed');
  process.exit(1);
}
if (j.fetchError) {
  console.error('opensky failed', j.fetchError);
  process.exit(1);
}
console.log('ok', {
  radiusMi: j.radiusMi,
  fetchRadiusMi: j.fetchRadiusMi,
  openskyStateCount: j.openskyStateCount,
  aircraft: j.aircraft?.length ?? 0,
  sample: (j.aircraft || []).slice(0, 3).map((a) => ({
    title: `${a.label} ${a.callsign || a.icao24}`,
    distMi: a.distMi,
    category: a.category,
  })),
});
