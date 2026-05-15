/**
 * Connectivity checks for dashbird (Run checks button → POST /api/dashboard-check).
 *
 * **When you add a new outbound integration, API route, or data file:** register a check
 * here (and a short label) so the sidebar can surface failures. Prefer calling the same
 * URLs/handlers the UI uses (internal `/api/...` via loopback) or the same third-party
 * endpoints as the feature code.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCalendarEmbedUrl } from './calendar-embed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

const SKIP_PREFIX = /^(cursor:|signal:|mailto:|tel:|file:|javascript:)/i;

function internalOrigin() {
  const port = process.env.PORT || '3000';
  return `http://127.0.0.1:${port}`;
}

/**
 * @param {string} path
 * @returns {Promise<{ status: number, json?: any, err?: string }>}
 */
async function probeInternal(path) {
  const url = `${internalOrigin()}${path}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25_000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe an external HTTPS URL (bookmark reachability, calendar embed, etc.).
 * Uses `redirect: 'manual'` so we only evaluate the **first** HTTP response.
 * Some sites (e.g. Kaiser / BigIP) return **302 to the same URL** to seed cookies;
 * following redirects with `fetch` hits **redirect count exceeded** even though the
 * link works in a real browser.
 *
 * Some hosts (e.g. messages.google.com) return **400** for non-browser User-Agents; use a
 * minimal Chromium-style UA so reachability matches “opens in a normal browser”.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, err?: string }>}
 */
async function probeExternalHttp(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15_000);
  /** Realistic UA — many sites reject bare bot strings with 400 while still allowing automated checks. */
  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 dashbird-check/1.0';
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    const reader = r.body?.getReader?.();
    if (reader) {
      try {
        await reader.read();
      } catch {
        /* ignore */
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    const status = r.status;
    const ok =
      (status >= 300 && status < 400) ||
      status === 401 ||
      status === 403 ||
      (status >= 200 && status < 400 && ![404, 410, 429].includes(status));
    return {
      ok: ok && status > 0,
      status,
      err: ok && status > 0 ? undefined : `HTTP ${status}`,
    };
  } catch (e) {
    const msg = e?.cause?.message ? `${e.message}: ${e.cause.message}` : String(e?.message || e);
    return { ok: false, status: 0, err: msg };
  } finally {
    clearTimeout(t);
  }
}

async function collectBookmarkHttpUrls() {
  const files = [
    path.join(root, 'public/data/bookmarks-personal.json'),
    path.join(root, 'public/data/bookmarks-work.json'),
  ];
  const urls = new Set();
  for (const fp of files) {
    let raw;
    try {
      raw = await readFile(fp, 'utf8');
    } catch {
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const sec of data.sections || []) {
      for (const item of sec.items || []) {
        const h = typeof item.href === 'string' ? item.href.trim() : '';
        if (!h || SKIP_PREFIX.test(h)) continue;
        if (!/^https?:\/\//i.test(h)) continue;
        urls.add(h);
      }
    }
  }
  return [...urls];
}

async function probeBookmarksBatch(urls) {
  const broken = [];
  const chunk = 5;
  for (let i = 0; i < urls.length; i += chunk) {
    const slice = urls.slice(i, i + chunk);
    const part = await Promise.all(
      slice.map(async (u) => {
        const r = await probeExternalHttp(u);
        return { u, ...r };
      }),
    );
    for (const { u, ok, status, err } of part) {
      if (!ok) broken.push({ u, status, err });
    }
  }
  return broken;
}

function openMeteoForecastUrl(lat, lon) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(lat));
  u.searchParams.set('longitude', String(lon));
  u.searchParams.set('current', 'temperature_2m');
  u.searchParams.set('temperature_unit', 'fahrenheit');
  return u.toString();
}

/**
 * @returns {Promise<{ ok: boolean, results: Array<{ id: string, label: string, ok: boolean, detail?: string }> }>}
 */
export async function runDashboardChecks() {
  /** @type {Array<{ id: string, label: string, ok: boolean, detail?: string }>} */
  const results = [];

  const push = (id, label, ok, detail = '') => {
    results.push({ id, label, ok, detail: detail || undefined });
  };

  /* --- Internal APIs (loopback) --- */
  const cfg = await probeInternal('/api/config');
  if (cfg.status === 200 && cfg.json) {
    push('config', 'Dashboard config (/api/config)', true);
  } else {
    push(
      'config',
      'Dashboard config (/api/config)',
      false,
      cfg.err || `HTTP ${cfg.status || 'error'}`,
    );
  }

  const or = await probeInternal('/api/openrouter/summary');
  if (or.status === 200 && or.json && or.json.ok !== false) {
    push('openrouter', 'OpenRouter API (key + /summary)', true);
  } else if (or.status === 503) {
    push(
      'openrouter',
      'OpenRouter API (key + /summary)',
      false,
      'OPENROUTER_API_KEY missing or OpenRouter returned unavailable',
    );
  } else {
    const msg =
      or.json?.error?.message ||
      or.json?.error ||
      or.err ||
      `HTTP ${or.status || 'error'}`;
    push('openrouter', 'OpenRouter API (key + /summary)', false, String(msg).slice(0, 240));
  }

  const sky = await probeInternal('/api/sky-events?windowHours=24');
  if (sky.status === 200 && sky.json?.ok === true) {
    push('sky_events', 'Sky events (/api/sky-events + upstream feeds)', true);
  } else {
    const msg = sky.json?.error || sky.err || `HTTP ${sky.status || 'error'}`;
    push('sky_events', 'Sky events (/api/sky-events + upstream feeds)', false, String(msg).slice(0, 240));
  }

  const net = await probeInternal('/api/network-health');
  if (net.status === 200 && net.json) {
    push('network_health', 'Network health probe (/api/network-health)', true);
  } else {
    push(
      'network_health',
      'Network health probe (/api/network-health)',
      false,
      net.err || `HTTP ${net.status || 'error'}`,
    );
  }

  const host = await probeInternal('/api/host-health');
  if (host.status === 200 && host.json) {
    push('host_health', 'Host stats (/api/host-health)', true);
  } else {
    push('host_health', 'Host stats (/api/host-health)', false, host.err || `HTTP ${host.status || 'error'}`);
  }

  /* --- Open-Meteo (hero weather) --- */
  const lat = parseFloat(process.env.WEATHER_LAT ?? '37.848');
  const lon = parseFloat(process.env.WEATHER_LON ?? '-122.253');
  const sfLat = parseFloat(process.env.SF_WEATHER_LAT ?? '37.7749');
  const sfLon = parseFloat(process.env.SF_WEATHER_LON ?? '-122.4194');
  const w1 = await probeExternalHttp(openMeteoForecastUrl(lat, lon));
  const w2 = await probeExternalHttp(openMeteoForecastUrl(sfLat, sfLon));
  if (w1.ok && w2.ok) {
    push('open_meteo', 'Open-Meteo (hero weather, both cities)', true);
  } else {
    const parts = [];
    if (!w1.ok) parts.push(`primary ${w1.err || w1.status}`);
    if (!w2.ok) parts.push(`SF ${w2.err || w2.status}`);
    push('open_meteo', 'Open-Meteo (hero weather, both cities)', false, parts.join('; '));
  }

  /* --- Google Calendar embed URL --- */
  const calRaw = (process.env.CALENDAR_EMBED_URL || '').trim();
  const calUrl = normalizeCalendarEmbedUrl(process.env.CALENDAR_EMBED_URL);
  if (!calRaw) {
    push('calendar', 'Google Calendar embed', true, 'CALENDAR_EMBED_URL not set (optional)');
  } else if (!calUrl) {
    push(
      'calendar',
      'Google Calendar embed',
      false,
      'CALENDAR_EMBED_URL could not be parsed (use the iframe src URL only, or wrap values with & in double quotes in .env)',
    );
  } else {
    const c = await probeExternalHttp(calUrl);
    push(
      'calendar',
      'Google Calendar embed (reachable URL)',
      c.ok,
      c.ok ? '' : c.err || `HTTP ${c.status}`,
    );
  }

  /* --- Notes file --- */
  try {
    await readFile(path.join(root, 'public/data/notes.md'), 'utf8');
    push('notes', 'Notes file (public/data/notes.md)', true);
  } catch (e) {
    push('notes', 'Notes file (public/data/notes.md)', false, String(e?.message || e));
  }

  /* --- Bookmarks (HTTP(S) only) --- */
  const bUrls = await collectBookmarkHttpUrls();
  if (bUrls.length === 0) {
    push('bookmarks', 'Bookmark links (HTTP reachability)', true, 'No http(s) links to probe');
  } else {
    const broken = await probeBookmarksBatch(bUrls);
    if (broken.length === 0) {
      push('bookmarks', 'Bookmark links (HTTP reachability)', true, `${bUrls.length} URL(s) checked`);
    } else {
      const lines = broken.slice(0, 12).map((b) => `${b.u} → ${b.err || b.status}`);
      const more = broken.length > 12 ? ` (+${broken.length - 12} more)` : '';
      push(
        'bookmarks',
        'Bookmark links (HTTP reachability)',
        false,
        `${broken.length} of ${bUrls.length} failed: ${lines.join(' | ')}${more}`,
      );
    }
  }

  /* --- v2 stubs: only warn if env suggests user expects them --- */
  if (process.env.VIKUNJA_BASE_URL?.trim() || process.env.VIKUNJA_TOKEN?.trim()) {
    const v = await probeInternal('/api/vikunja/');
    const bad = v.status === 501 || v.json?.error === 'not_implemented';
    push(
      'vikunja',
      'Vikunja API (/api/vikunja)',
      !bad,
      bad ? 'VIKUNJA_BASE_URL is set but the proxy is still not implemented (v2).' : '',
    );
  }

  if (process.env.HASS_BASE_URL?.trim() && process.env.HASS_TOKEN?.trim()) {
    const h = await probeInternal('/api/home-assistant/');
    const bad = h.status === 501;
    push(
      'home_assistant',
      'Home Assistant proxy (/api/home-assistant)',
      !bad,
      bad ? 'HASS_* env set but proxy is not implemented (v2).' : '',
    );
  }

  const ok = results.every((r) => r.ok);
  return { ok, checkedAt: new Date().toISOString(), results };
}
