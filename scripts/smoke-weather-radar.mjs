#!/usr/bin/env node
/**
 * Smoke: /api/weather-radar returns Windy embed when shown.
 */
import { buildWindyRadarEmbedUrl } from '../src/lib/weather-radar-windy.js';

const base = process.env.DASHBIRD_BASE || 'http://127.0.0.1:8787';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const url = buildWindyRadarEmbedUrl(37.82, -122.25);
assert(url.includes('embed.windy.com'), 'windy embed host');
assert(url.includes('overlay=radar'), 'radar overlay');

const r = await fetch(`${base}/api/weather-radar`, { cache: 'no-store' });
const j = await r.json();
assert(r.ok && j.ok !== false, `HTTP/body: ${r.status} ${JSON.stringify(j)}`);

if (j.show && j.embed?.url) {
  assert(j.provider === 'windy', `provider ${j.provider}`);
  assert(j.embed.url.includes('embed.windy.com'), j.embed.url);
  assert(j.embed.url.includes('overlay=radar'), j.embed.url);
  const tr = await fetch(j.embed.url);
  assert(tr.ok, `embed page HTTP ${tr.status}`);
  console.log('ok', { provider: j.provider, show: j.show });
} else {
  console.log('ok', { show: j.show, reason: j.imminent === false ? 'not imminent' : 'hidden' });
}
