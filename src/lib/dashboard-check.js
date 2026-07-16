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
import { fetchOpenMeteoCurrentUsAqi } from './dashboard-air-quality.js';
import {
  fetchUpcomingGoogleCalendarEvents,
  resolveCalendarEmbedUrl,
  resolveGoogleCalendarIcalUrl,
} from './google-calendar-ical.js';
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

const SKIP_PREFIX = /^(cursor:|signal:|command:|mailto:|tel:|file:|javascript:)/i;

function internalOrigin() {
  const port = process.env.PORT || '3000';
  return `http://127.0.0.1:${port}`;
}

/**
 * @param {string} path
 * @param {number} [timeoutMs=25000]
 * @returns {Promise<{ status: number, json?: any, err?: string }>}
 */
async function probeInternal(path, timeoutMs = 25_000) {
  const url = `${internalOrigin()}${path}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
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

  const sky = await probeInternal('/api/sky-events?windowHours=24');
  if (sky.status === 200 && sky.json?.ok === true) {
    push('sky_events', 'Sky events (/api/sky-events + upstream feeds)', true);
  } else {
    const msg = sky.json?.error || sky.err || `HTTP ${sky.status || 'error'}`;
    push('sky_events', 'Sky events (/api/sky-events + upstream feeds)', false, String(msg).slice(0, 240));
  }

  const earth = await probeInternal('/api/earth-events');
  if (earth.status === 200 && earth.json?.ok === true && earth.json.summary?.fall && earth.json.summary?.spring) {
    push('earth_events', 'Earth events (/api/earth-events · static monarch phenology lookup)', true);
  } else {
    const msg = earth.json?.error || earth.err || `HTTP ${earth.status || 'error'}`;
    push(
      'earth_events',
      'Earth events (/api/earth-events · static monarch phenology lookup)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const npnSpring = await probeInternal('/api/usa-npn-spring');
  if (npnSpring.status === 200 && npnSpring.json?.ok === true && Array.isArray(npnSpring.json.items)) {
    push(
      'usa_npn_spring',
      'USA-NPN spring (/api/usa-npn-spring · GeoServer WCS SI-x first leaf + anomaly)',
      true,
    );
  } else {
    const msg = npnSpring.json?.error || npnSpring.err || `HTTP ${npnSpring.status || 'error'}`;
    push(
      'usa_npn_spring',
      'USA-NPN spring (/api/usa-npn-spring · GeoServer WCS SI-x first leaf + anomaly)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const yosemiteMoonbow = await probeInternal('/api/yosemite-moonbow');
  if (
    yosemiteMoonbow.status === 200 &&
    yosemiteMoonbow.json?.ok === true &&
    Array.isArray(yosemiteMoonbow.json.items)
  ) {
    push(
      'yosemite_moonbow',
      'Yosemite moonbow (/api/yosemite-moonbow · Sky strip, static windows JSON)',
      true,
    );
  } else {
    const msg =
      yosemiteMoonbow.json?.error || yosemiteMoonbow.err || `HTTP ${yosemiteMoonbow.status || 'error'}`;
    push(
      'yosemite_moonbow',
      'Yosemite moonbow (/api/yosemite-moonbow · Sky strip, static windows JSON)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const diabloTarantula = await probeInternal('/api/diablo-tarantula');
  if (
    diabloTarantula.status === 200 &&
    diabloTarantula.json?.ok === true &&
    Array.isArray(diabloTarantula.json.items)
  ) {
    push(
      'diablo_tarantula',
      'Diablo tarantula mating (/api/diablo-tarantula · static Sep–Oct window + radius)',
      true,
    );
  } else {
    const msg =
      diabloTarantula.json?.error || diabloTarantula.err || `HTTP ${diabloTarantula.status || 'error'}`;
    push(
      'diablo_tarantula',
      'Diablo tarantula mating (/api/diablo-tarantula · static Sep–Oct window + radius)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const oaklandSalamanders = await probeInternal('/api/oakland-salamanders');
  if (
    oaklandSalamanders.status === 200 &&
    oaklandSalamanders.json?.ok === true &&
    Array.isArray(oaklandSalamanders.json.items)
  ) {
    push(
      'oakland_salamanders',
      'Oakland salamanders (/api/oakland-salamanders · Open-Meteo + Nov–Apr window + radius)',
      true,
    );
  } else {
    const msg =
      oaklandSalamanders.json?.error || oaklandSalamanders.err || `HTTP ${oaklandSalamanders.status || 'error'}`;
    push(
      'oakland_salamanders',
      'Oakland salamanders (/api/oakland-salamanders · Open-Meteo + Nov–Apr window + radius)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const salmonRuns = await probeInternal('/api/salmon-runs');
  if (
    salmonRuns.status === 200 &&
    salmonRuns.json?.ok === true &&
    typeof salmonRuns.json.radiusMiles === 'number' &&
    Array.isArray(salmonRuns.json.items)
  ) {
    push(
      'salmon_runs',
      'Salmon runs near dashboard (/api/salmon-runs · static seasonal sites + ZIP radius)',
      true,
    );
  } else {
    const msg = salmonRuns.json?.error || salmonRuns.err || `HTTP ${salmonRuns.status || 'error'}`;
    push(
      'salmon_runs',
      'Salmon runs near dashboard (/api/salmon-runs · static seasonal sites + ZIP radius)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const wildForaging = await probeInternal('/api/wild-foraging');
  if (
    wildForaging.status === 200 &&
    wildForaging.json?.ok === true &&
    typeof wildForaging.json.nativeRadiusMiles === 'number' &&
    wildForaging.json.fallingFruit &&
    Array.isArray(wildForaging.json.items)
  ) {
    push(
      'wild_foraging',
      'Wild foraging (/api/wild-foraging · static phenology + optional Falling Fruit)',
      true,
    );
  } else {
    const msg = wildForaging.json?.error || wildForaging.err || `HTTP ${wildForaging.status || 'error'}`;
    push(
      'wild_foraging',
      'Wild foraging (/api/wild-foraging · static phenology + optional Falling Fruit)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const nasturtium = await probeInternal('/api/nasturtium-bloom');
  if (
    nasturtium.status === 200 &&
    nasturtium.json?.ok === true &&
    typeof nasturtium.json.status === 'string' &&
    Array.isArray(nasturtium.json.items)
  ) {
    push(
      'nasturtium_bloom',
      'Nasturtium bloom (/api/nasturtium-bloom · Apr–Jun + Open-Meteo daily max vs 85°F)',
      true,
    );
  } else {
    const msg = nasturtium.json?.error || nasturtium.err || `HTTP ${nasturtium.status || 'error'}`;
    push(
      'nasturtium_bloom',
      'Nasturtium bloom (/api/nasturtium-bloom · Apr–Jun + Open-Meteo daily max vs 85°F)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const quakeWeek = await probeInternal('/api/dashboard-earthquake-week');
  if (
    quakeWeek.status === 200 &&
    quakeWeek.json?.ok === true &&
    Array.isArray(quakeWeek.json.items)
  ) {
    push(
      'dashboard_earthquake_week',
      'Earthquake week (/api/dashboard-earthquake-week · USGS largest M>3 within 30 mi)',
      true,
    );
  } else {
    const msg = quakeWeek.json?.error || quakeWeek.err || `HTTP ${quakeWeek.status || 'error'}`;
    push(
      'dashboard_earthquake_week',
      'Earthquake week (/api/dashboard-earthquake-week · USGS largest M>3 within 30 mi)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const kilauea = await probeInternal('/api/dashboard-kilauea');
  if (
    kilauea.status === 200 &&
    kilauea.json?.ok === true &&
    Array.isArray(kilauea.json.items) &&
    Array.isArray(kilauea.json.cameras)
  ) {
    push(
      'dashboard_kilauea',
      'Kīlauea (/api/dashboard-kilauea · HVO alert/eruption + summit livestream cams)',
      true,
    );
  } else {
    const msg = kilauea.json?.error || kilauea.err || `HTTP ${kilauea.status || 'error'}`;
    push(
      'dashboard_kilauea',
      'Kīlauea (/api/dashboard-kilauea · HVO alert/eruption + summit livestream cams)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const lightningGlm = await probeInternal('/api/dashboard-lightning-glm', 90_000);
  if (
    lightningGlm.status === 200 &&
    lightningGlm.json?.ok === true &&
    Array.isArray(lightningGlm.json.items)
  ) {
    push(
      'dashboard_lightning_glm',
      'GOES GLM lightning (/api/dashboard-lightning-glm · strongest CFA flash ~200 mi)',
      true,
    );
  } else {
    const msg = lightningGlm.json?.error || lightningGlm.err || `HTTP ${lightningGlm.status || 'error'}`;
    push(
      'dashboard_lightning_glm',
      'GOES GLM lightning (/api/dashboard-lightning-glm · strongest CFA flash ~200 mi)',
      false,
      String(msg).slice(0, 240),
    );
  }

  const superbloom = await probeInternal('/api/superbloom-status');
  if (superbloom.status === 200 && superbloom.json && superbloom.json.ok !== false && superbloom.json.stateAbbrev) {
    push('superbloom_status', 'Superbloom digest (/api/superbloom-status · DesertUSA scrape)', true);
  } else {
    const msg = superbloom.json?.summary || superbloom.json?.error || superbloom.err || `HTTP ${superbloom.status || 'error'}`;
    push(
      'superbloom_status',
      'Superbloom digest (/api/superbloom-status · DesertUSA scrape)',
      false,
      String(msg).slice(0, 240),
    );
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

  const astro = await probeInternal('/api/hero-astronomy');
  if (astro.status === 200 && astro.json?.ok === true && typeof astro.json.sunsetEpochMs === 'number') {
    push('hero_astronomy', 'Hero sunset + moonrise + next full/new moon caption (/api/hero-astronomy)', true);
  } else {
    const msg = astro.json?.error || astro.err || `HTTP ${astro.status || 'error'}`;
    push('hero_astronomy', 'Hero sunset + moonrise + next full/new moon caption (/api/hero-astronomy)', false, String(msg).slice(0, 240));
  }

  /* --- Hero weather (Open-Meteo + NWS fallback, both cities) --- */
  const lat = parseFloat(process.env.WEATHER_LAT ?? '37.848');
  const lon = parseFloat(process.env.WEATHER_LON ?? '-122.253');
  const sfLat = parseFloat(process.env.SF_WEATHER_LAT ?? '37.7749');
  const sfLon = parseFloat(process.env.SF_WEATHER_LON ?? '-122.4194');
  const w1 = await probeInternal(
    `/api/hero-weather?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}`,
  );
  const w2 = await probeInternal(
    `/api/hero-weather?lat=${encodeURIComponent(String(sfLat))}&lon=${encodeURIComponent(String(sfLon))}`,
  );
  const w1Ok = w1.status === 200 && w1.json?.ok === true && typeof w1.json?.tempF === 'number';
  const w2Ok = w2.status === 200 && w2.json?.ok === true && typeof w2.json?.tempF === 'number';
  if (w1Ok && w2Ok) {
    const providers = [w1.json?.provider, w2.json?.provider].filter(Boolean).join('+');
    push(
      'open_meteo',
      'Hero weather both cities (/api/hero-weather · Open-Meteo / NWS)',
      true,
      providers || undefined,
    );
  } else {
    const parts = [];
    if (!w1Ok) parts.push(`primary ${w1.json?.error || w1.err || w1.status}`);
    if (!w2Ok) parts.push(`SF ${w2.json?.error || w2.err || w2.status}`);
    push(
      'open_meteo',
      'Hero weather both cities (/api/hero-weather · Open-Meteo / NWS)',
      false,
      parts.join('; '),
    );
  }

  const { lat: aqiLat, lon: aqiLon } = await resolveDashboardWeatherLatLon();
  const aqiTz = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
  const aqi = await fetchOpenMeteoCurrentUsAqi({ lat: aqiLat, lon: aqiLon, timeZone: aqiTz });
  if (aqi.ok) {
    push(
      'open_meteo_air_quality',
      'Open-Meteo air quality (hero weather tiles · US AQI)',
      true,
      `US AQI ${aqi.usAqi}`,
    );
  } else {
    push(
      'open_meteo_air_quality',
      'Open-Meteo air quality (hero weather tiles · US AQI)',
      false,
      aqi.error || 'fetch_failed',
    );
  }

  /* --- Google Calendar (iCal upcoming + embed) --- */
  const icalUrl = resolveGoogleCalendarIcalUrl();
  if (!icalUrl) {
    push('calendar', 'Calendar upcoming (GOOGLE_CALENDAR_ICAL_URL)', true, 'not set (optional)');
  } else {
    const upcoming = await fetchUpcomingGoogleCalendarEvents();
    push(
      'calendar',
      'Calendar upcoming (iCal feed)',
      upcoming.ok,
      upcoming.ok
        ? `${upcoming.events.length} upcoming event(s)`
        : upcoming.hint || upcoming.error || 'feed failed',
    );
    const embedUrl = resolveCalendarEmbedUrl();
    if (embedUrl) {
      const c = await probeExternalHttp(embedUrl);
      push(
        'calendar',
        'Google Calendar embed (reachable URL)',
        c.ok,
        c.ok ? '' : c.err || `HTTP ${c.status}`,
      );
    }
  }
  const calEmbedRaw = (process.env.CALENDAR_EMBED_URL || '').trim();
  if (calEmbedRaw && !normalizeCalendarEmbedUrl(calEmbedRaw)) {
    push(
      'calendar',
      'CALENDAR_EMBED_URL parse',
      false,
      'could not parse (wrap values with & in double quotes in .env)',
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

  /* --- Vikunja: only check when env suggests the user expects it --- */
  if (process.env.VIKUNJA_BASE_URL?.trim() || process.env.VIKUNJA_TOKEN?.trim()) {
    const v = await probeInternal('/api/vikunja/health');
    const ok = v.status === 200 && v.json?.ok === true;
    const detail = ok
      ? v.json?.version
        ? `ok · ${v.json.version}`
        : 'ok'
      : v.err ||
        v.json?.detail ||
        v.json?.error ||
        (v.status ? `HTTP ${v.status}` : 'unreachable');
    push('vikunja', 'Vikunja API (/api/vikunja)', ok, ok ? detail : String(detail));
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
