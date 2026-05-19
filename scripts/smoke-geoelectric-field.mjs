#!/usr/bin/env node
/**
 * Smoke: /api/geoelectric-field + NOAA map image.
 */
const base = process.env.DASHBIRD_BASE || 'http://127.0.0.1:8787';
const imgUrl =
  'https://services.swpc.noaa.gov/images/animations/geoelectric/US-Canada/EmapGraphics_1m/latest.png';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ir = await fetch(imgUrl);
assert(ir.ok, `NOAA image HTTP ${ir.status}`);
const buf = await ir.arrayBuffer();
assert(buf.byteLength > 5000, `image too small (${buf.byteLength} bytes)`);

const r = await fetch(`${base}/api/geoelectric-field`, { cache: 'no-store' });
const j = await r.json();
assert(r.ok && j.ok !== false, `API ${r.status} ${JSON.stringify(j)}`);

if (j.active && j.imageSrc) {
  assert(j.imageUrl?.includes('geoelectric'), j.imageUrl);
  console.log('ok', { active: j.active, forceShow: j.forceShow, stormActive: j.stormActive });
} else {
  console.log('ok', {
    active: j.active,
    hidden: !j.active,
    label: j.storm?.label,
    hint: 'Set SKY_DEBUG_GEOMAGNETIC_ACTIVE=1 to preview, or wait for NOAA G≥2 (above G1)',
  });
}
