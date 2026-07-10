#!/usr/bin/env node
/**
 * Core API smoke checks.
 * Run: npm run smoke:core
 */

const base = String(process.env.DASHBIRD_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');

/**
 * @param {string} url
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 */
async function getJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const retries = opts.retries ?? 1;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Keep raw text in error surface when response is non-JSON.
      }
      return { res, json, text };
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastErr || new Error('request_failed');
}

/**
 * @param {string} label
 * @param {() => Promise<string>} fn
 */
async function runCheck(label, fn) {
  try {
    const detail = await fn();
    console.log(`PASS ${label} - ${detail}`);
    return true;
  } catch (err) {
    const msg = String(err?.message || err);
    console.error(`FAIL ${label} - ${msg}`);
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const checks = [
  () =>
    runCheck('/api/openrouter/health', async () => {
      const { res, json, text } = await getJson(`${base}/api/openrouter/health`);
      assert(res.ok, `http_${res.status}`);
      assert(json && json.ok === true, `expected ok=true; body=${text}`);
      assert(json.provider === 'openrouter', `provider=${String(json?.provider || '')}`);
      return `configured=${Boolean(json.configured)}`;
    }),
  () =>
    runCheck('/api/tool-library/ratings?name=Notion', async () => {
      const qs = new URLSearchParams({ name: 'Notion' });
      const { res, json, text } = await getJson(`${base}/api/tool-library/ratings?${qs}`);
      assert(res.ok, `http_${res.status}`);
      assert(json && json.ok === true, `expected ok=true; body=${text}`);
      assert(typeof json.name === 'string' && json.name.length > 0, 'name missing');
      assert('rating' in json, 'rating field missing');
      return `rating=${json.rating ?? 'null'} source=${String(json.source || '') || 'n/a'}`;
    }),
  () =>
    runCheck('/api/atlantic-storm-watch', async () => {
      const { res, json, text } = await getJson(`${base}/api/atlantic-storm-watch`, {
        timeoutMs: 20000,
      });
      assert(res.ok, `http_${res.status}`);
      assert(json && json.ok === true, `expected ok=true; body=${text}`);
      assert(Array.isArray(json.items), 'items must be an array');
      // Healthy response can legitimately contain zero items outside active-storm periods.
      assert(Number.isFinite(json.scanned), 'scanned missing or non-numeric');
      return `items=${json.items.length} scanned=${json.scanned}`;
    }),
  () =>
    runCheck('/api/weather-radar?lat=37.8044&lon=-122.2712', async () => {
      const qs = new URLSearchParams({
        lat: '37.8044',
        lon: '-122.2712',
        label: 'Oakland, CA',
      });
      const { res, json, text } = await getJson(`${base}/api/weather-radar?${qs}`, {
        timeoutMs: 20000,
      });
      assert(res.ok, `http_${res.status}`);
      assert(json && json.ok === true, `expected ok=true; body=${text}`);
      assert(typeof json.show === 'boolean', 'show missing');
      if (json.show) {
        assert(json.provider === 'iem', `provider=${String(json.provider || '')}`);
        assert(Array.isArray(json.radar?.frames), 'radar.frames missing');
      }
      return `show=${json.show} provider=${String(json.provider || 'n/a')}`;
    }),
  () =>
    runCheck('/api/vikunja/health', async () => {
      const { res, json, text } = await getJson(`${base}/api/vikunja/health`);
      // Fail closed when unset (503); when configured, expect ok upstream.
      if (res.status === 503) {
        assert(json && json.error === 'vikunja_not_configured', `body=${text}`);
        return 'not_configured';
      }
      assert(res.ok, `http_${res.status}`);
      assert(json && json.ok === true && json.configured === true, `body=${text}`);
      return `configured version=${String(json.version || 'n/a')}`;
    }),
];

const results = [];
for (const check of checks) {
  results.push(await check());
}

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`RESULT core smoke: ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
