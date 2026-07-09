/**
 * Watch poller for catalog resources (~50): up/down + optional change fingerprint.
 */
import { createHash } from 'node:crypto';
import { listResources, patchResource } from './web-catalog-store.js';

const UA = 'dashbird-web-catalog-watch/1.0';

function fingerprintFromResponse(status, etag, lastModified, titleSnippet) {
  const raw = [status, etag || '', lastModified || '', titleSnippet || ''].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * @param {object} resource
 */
export async function checkResourceWatch(resource) {
  const mode = resource.watch_mode || 'off';
  if (!resource.watch_enabled && mode === 'off') {
    return null;
  }
  const url = resource.url;
  const started = Date.now();
  let ok = false;
  let statusCode = 0;
  let etag = '';
  let lastModified = '';
  let titleSnippet = '';
  try {
    const method = mode === 'change' ? 'GET' : 'HEAD';
    let res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
      signal: AbortSignal.timeout(12000),
    });
    // Some hosts reject HEAD
    if (method === 'HEAD' && (res.status === 405 || res.status === 501)) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
        signal: AbortSignal.timeout(12000),
      });
    }
    statusCode = res.status;
    ok = res.status >= 200 && res.status < 400;
    etag = res.headers.get('etag') || '';
    lastModified = res.headers.get('last-modified') || '';
    if (mode === 'change' && res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (/html/i.test(ct)) {
        const text = await res.text();
        const m = text.match(/<title[^>]*>([^<]*)<\/title>/i);
        titleSnippet = (m?.[1] || '').trim().slice(0, 200);
      } else {
        // drain body lightly
        await res.arrayBuffer().catch(() => null);
      }
    }
  } catch (e) {
    ok = false;
    statusCode = 0;
    titleSnippet = String(e?.message || e).slice(0, 120);
  }

  const latencyMs = Date.now() - started;
  const status = ok ? 'up' : 'down';
  const fp =
    mode === 'change'
      ? fingerprintFromResponse(statusCode, etag, lastModified, titleSnippet)
      : null;
  const changed =
    mode === 'change' &&
    fp &&
    resource.content_fingerprint &&
    fp !== resource.content_fingerprint;

  const patch = {
    last_status: status,
    last_checked_at: new Date().toISOString(),
    ...(fp
      ? {
          content_fingerprint: fp,
          ...(changed ? { last_changed_at: new Date().toISOString() } : {}),
        }
      : {}),
  };
  // Preserve url/title via patchResource merge
  const updated = await patchResource(resource.id, {
    ...resource,
    ...patch,
    url: resource.url,
  });
  return { resource: updated, status, latencyMs, changed: Boolean(changed) };
}

export async function runWatchPass() {
  const watched = await listResources({ watch_enabled: true });
  const results = [];
  for (const r of watched.slice(0, 60)) {
    try {
      const result = await checkResourceWatch(r);
      if (result) results.push(result);
    } catch (e) {
      console.warn('[web-catalog-watch] fail', r.url, e?.message || e);
    }
  }
  return { checked: results.length, results };
}

let timer = null;

export function startWebCatalogWatchPoller(env = process.env) {
  if (String(env.WEB_CATALOG_WATCH || '1').trim() === '0') {
    console.log('[web-catalog-watch] disabled');
    return;
  }
  const ms = Math.max(60_000, Number(env.WEB_CATALOG_WATCH_MS) || 15 * 60_000);
  const tick = () => {
    runWatchPass()
      .then((r) => {
        if (r.checked) console.log(`[web-catalog-watch] checked ${r.checked}`);
      })
      .catch((e) => console.warn('[web-catalog-watch]', e?.message || e));
  };
  // Delay first pass so boot stays snappy
  setTimeout(tick, 20_000);
  timer = setInterval(tick, ms);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[web-catalog-watch] interval ${Math.round(ms / 1000)}s`);
}
