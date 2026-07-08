#!/usr/bin/env node
/**
 * Smoke: /api/weather-radar returns RainViewer tile payload when shown.
 */
const base = process.env.DASHBIRD_BASE || 'http://127.0.0.1:8787';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const r = await fetch(`${base}/api/weather-radar`, { cache: 'no-store' });
const j = await r.json();
assert(r.ok && j.ok !== false, `HTTP/body: ${r.status} ${JSON.stringify(j)}`);

if (j.show && j.provider === 'rainviewer' && j.radar) {
  assert(Array.isArray(j.radar.frames) && j.radar.frames.length > 0, 'radar frames');
  assert(Array.isArray(j.radar.tiles) && j.radar.tiles.length > 0, 'radar tiles');
  assert(typeof j.radar.host === 'string' && j.radar.host.length > 0, 'tile host');
  console.log('ok', { provider: j.provider, show: j.show, frames: j.radar.frames.length });
} else {
  console.log('ok', { show: j.show, provider: j.provider, reason: j.show ? 'link fallback' : 'hidden' });
}
