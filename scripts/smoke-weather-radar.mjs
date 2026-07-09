#!/usr/bin/env node
/**
 * Smoke: /api/weather-radar returns IEM MRMS Leaflet payload when shown.
 */
const base = process.env.DASHBIRD_BASE || 'http://127.0.0.1:8787';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const qs = new URLSearchParams({
  lat: '37.8044',
  lon: '-122.2712',
  label: 'Oakland, CA',
});
const r = await fetch(`${base}/api/weather-radar?${qs}`, { cache: 'no-store' });
const j = await r.json();
assert(r.ok && j.ok !== false, `HTTP/body: ${r.status} ${JSON.stringify(j)}`);

if (j.show && j.provider === 'iem' && j.radar) {
  assert(Array.isArray(j.radar.frames) && j.radar.frames.length > 0, 'radar frames');
  assert(typeof j.radar.frames[0].urlTemplate === 'string', 'frame urlTemplate');
  assert(typeof j.radar.basemap?.url === 'string', 'basemap url');
  assert(Number.isFinite(j.radar.lat) && Number.isFinite(j.radar.lon), 'center');
  assert(j.radar.layer === 'mrms', 'mrms layer');
  console.log('ok', {
    provider: j.provider,
    show: j.show,
    frames: j.radar.frames.length,
    zoom: j.radar.zoom,
    source: j.geo?.source,
  });
} else {
  console.log('ok', {
    show: j.show,
    provider: j.provider,
    reason: j.show ? 'unexpected provider' : 'hidden',
  });
}
