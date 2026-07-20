/**
 * Kīlauea (Hawaiʻi) status for the Earth strip + summit livestream card.
 * Alert/notice: USGS HANS public API. Short fountain updates: HVO volcano-messages HTML.
 * Nearby quakes: USGS FDSNWS (same M / depth / mi format as the local earthquake row).
 * Cameras: USGS short links → YouTube livestream video IDs.
 */
const KILAUEA_VNUM = '332010';
const KILAUEA_LAT = 19.421;
const KILAUEA_LON = -155.287;
const KILAUEA_ELEV_FT = 4091;
const KILAUEA_ELEV_M = 1247;

const USGS_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const HANS_ELEVATED = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes';
const HANS_CAP = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getCapElevated';
const HANS_NEWEST = `https://volcanoes.usgs.gov/hans-public/api/volcano/newestForVolcano/${KILAUEA_VNUM}`;
const HVO_MESSAGES_URL =
  'https://www.usgs.gov/volcanoes/kilauea/volcano-updates/volcano-messages';
const KILAUEA_UPDATES_URL = 'https://www.usgs.gov/volcanoes/kilauea/volcano-updates';
const SUMMIT_WEBCAMS_URL = 'https://www.usgs.gov/volcanoes/kilauea/summit-webcams';

const EARTH_RADIUS_MI = 3958.7613;
const KM_PER_MI = 1.609344;
const QUAKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const QUAKE_RADIUS_MI = 30;
const MIN_MAG_EXCLUSIVE = 3;
const FETCH_TIMEOUT_MS = 16_000;
const UA = 'Dashbird/1.0 (dashboard Kilauea status; https://www.usgs.gov/volcanoes/kilauea)';

function cleanUrl(raw, fallback) {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return fallback;
  return s.replace(/([^:]\/)\/+/g, '$1');
}

/** Stable USGS short links for the three summit livestreams. */
const CAM_SHORT_LINKS = [
  {
    id: 'v1cam',
    label: 'V1cam · west Halemaʻumaʻu',
    shortUrl: 'https://url.usgs.gov/v1cam',
    fallbackVideoId: 'HggWKlZv9yk',
  },
  {
    id: 'v2cam',
    label: 'V2cam · east Halemaʻumaʻu',
    shortUrl: 'https://url.usgs.gov/v2cam',
    fallbackVideoId: 'Tz5tPqRRv1Y',
  },
  {
    id: 'v3cam',
    label: 'V3cam · south Halemaʻumaʻu',
    shortUrl: 'https://url.usgs.gov/v3cam',
    fallbackVideoId: 'gXKuUyKt8mc',
  },
];

/**
 * @param {number} ms
 * @returns {AbortSignal}
 */
function timeoutSignal(ms) {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

/**
 * @param {string} url
 * @param {{ accept?: string, timeoutMs?: number }} [opts]
 */
async function fetchText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const res = await fetch(url, {
    signal: timeoutSignal(timeoutMs),
    redirect: 'follow',
    headers: {
      Accept: opts.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
      'User-Agent': UA,
    },
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return { text: await res.text(), finalUrl: res.url };
}

/**
 * @param {string} url
 */
async function fetchJson(url) {
  const { text } = await fetchText(url, { accept: 'application/json' });
  return JSON.parse(text);
}

function stripHtml(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|div|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1);
  const dLon = r(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MI * c;
}

function formatDepthKmShort(depthKm) {
  if (typeof depthKm !== 'number' || !Number.isFinite(depthKm)) return null;
  const rounded = Math.round(depthKm * 10) / 10;
  const s = rounded === Math.round(rounded) ? String(Math.round(rounded)) : String(rounded);
  return `${s} km`;
}

/**
 * @param {string} text
 */
function parseEruptionStats(text) {
  const s = String(text || '');
  const episodeMatch = s.match(/\bEpisode\s+(\d+)\b/i);
  const startedMatch =
    s.match(
      /\bbegan\s+at\s+(?:about\s+)?(\d{1,2}:\d{2}\s*(?:a\.m\.|p\.m\.)\s*HST(?:\s+on\s+[A-Za-z]+\s+\d{1,2})?)/i,
    ) ||
    s.match(
      /\bbegan\s+at\s+(?:about\s+)?([^.]{8,60}?(?:a\.m\.|p\.m\.)\s*HST[^.]{0,40})/i,
    );
  const heightMatch =
    s.match(
      /(?:fountain(?:\s+has\s+grown\s+to|\s+is)?|reaching\s+heights?\s+of(?:\s+about)?)\s+(\d+)\s*(?:feet|ft)\s*(?:\((\d+)\s*m(?:eters?)?\))?/i,
    ) || s.match(/\b(\d+)\s*feet?\s*\((\d+)\s*meters?\)/i);

  let fountainFt = null;
  let fountainM = null;
  if (heightMatch) {
    fountainFt = Number.parseInt(heightMatch[1], 10);
    fountainM = heightMatch[2]
      ? Number.parseInt(heightMatch[2], 10)
      : Number.isFinite(fountainFt)
        ? Math.round(fountainFt * 0.3048)
        : null;
  }

  const startedRaw = startedMatch?.[1] ? startedMatch[1].replace(/\s+/g, ' ').trim() : null;
  let startedShort = startedRaw;
  if (startedRaw) {
    const compact = startedRaw
      .replace(/\s*a\.m\./i, 'a')
      .replace(/\s*p\.m\./i, 'p')
      .replace(/\s+HST/i, ' HST')
      .replace(/\s+on\s+/i, ' ')
      .trim();
    startedShort = compact.length > 28 ? compact.slice(0, 28).trim() : compact;
  }

  return {
    episode: episodeMatch ? Number.parseInt(episodeMatch[1], 10) : null,
    startedRaw,
    startedShort,
    fountainFt: Number.isFinite(fountainFt) ? fountainFt : null,
    fountainM: Number.isFinite(fountainM) ? fountainM : null,
  };
}

/**
 * Detect a forecast for the NEXT Kīlauea eruption / episode in the update text.
 * USGS episodic-eruption updates usually include a sentence like
 * "The next episode … is likely to begin between …" or a precursory-activity window.
 * @param {string} text
 * @returns {{ hasForecast: boolean, forecast: string | null, forecastWhen: string | null }}
 */
function parseNextEruptionForecast(text) {
  const blob = String(text || '').replace(/\s+/g, ' ').trim();
  if (!blob) return { hasForecast: false, forecast: null, forecastWhen: null };

  // Split into sentences and look for one describing the next episode/eruption timing.
  const sentences = blob.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const keyword = /\bnext\s+(?:episode|eruption|eruptive\s+episode)\b|\bnext\s+episode\b/i;
  const timing =
    /\b(?:likely|expected|anticipated|forecast(?:ed)?|could|may|projected|estimated)\b[^.]*\b(?:begin|start|resume|occur|erupt)/i;
  const windowRe =
    /\b(?:between|by|before|on|around|as early as|within the next)\b[^.]*\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.|hst)|[A-Z][a-z]+\.?\s+\d{1,2}|\d+\s*(?:hours?|days?|weeks?))/i;

  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (keyword.test(s) && (timing.test(s) || windowRe.test(s))) {
      const forecast = s.replace(/\s+/g, ' ').trim().slice(0, 220);
      const whenMatch = s.match(windowRe);
      return {
        hasForecast: true,
        forecast,
        forecastWhen: whenMatch ? whenMatch[0].replace(/\s+/g, ' ').trim().slice(0, 80) : null,
      };
    }
  }

  // Secondary: explicit forecast phrasing even without the word "next".
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (/\bforecast(?:ed)?\s+to\s+(?:begin|resume|erupt|start)\b/i.test(s)) {
      return {
        hasForecast: true,
        forecast: s.replace(/\s+/g, ' ').trim().slice(0, 220),
        forecastWhen: null,
      };
    }
  }

  return { hasForecast: false, forecast: null, forecastWhen: null };
}

/**
 * Reduce the full volcano-updates page HTML to its readable activity text.
 * @param {string} html
 */
function extractKilaueaUpdateText(html) {
  const raw = String(html || '');
  // Prefer the Volcanic Activity Summary / activity region when present, else whole page.
  const region =
    raw.match(/Volcanic\s+Activity\s+Summary[\s\S]{0,4000}/i)?.[0] ||
    raw.match(/Activity\s+Summary[\s\S]{0,4000}/i)?.[0] ||
    raw;
  return stripHtml(region).slice(0, 6000);
}

/**
 * @param {string} html
 */
function parseHvoMessages(html) {
  const out = [];
  const re =
    /class="volcano-message-single[^"]*"[\s\S]*?volcano-message-title[^>]*>\s*([^<]+?)\s*<[\s\S]*?field-content[^>]*>\s*([^<]+?)\s*</gi;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    const title = m[1].replace(/\s+/g, ' ').trim();
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (title && body) out.push({ title, body });
  }
  return out;
}

function youtubeIdFromUrl(url) {
  const s = String(url || '');
  const m =
    s.match(/[?&]v=([A-Za-z0-9_-]{6,})/) ||
    s.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/) ||
    s.match(/youtube\.com\/live\/([A-Za-z0-9_-]{6,})/) ||
    s.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/);
  return m?.[1] || null;
}

/**
 * @param {{ id: string, label: string, shortUrl: string, fallbackVideoId: string }} cam
 */
async function resolveCamera(cam) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(cam.shortUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': UA },
    });
    clearTimeout(timer);
    const videoId = youtubeIdFromUrl(res.url) || cam.fallbackVideoId;
    return {
      id: cam.id,
      label: cam.label,
      videoId,
      watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`,
    };
  } catch {
    return {
      id: cam.id,
      label: cam.label,
      videoId: cam.fallbackVideoId,
      watchUrl: `https://www.youtube.com/watch?v=${cam.fallbackVideoId}`,
      embedUrl: `https://www.youtube.com/embed/${cam.fallbackVideoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`,
    };
  }
}

async function fetchStrongestKilaueaQuake() {
  const end = new Date();
  const start = new Date(end.getTime() - QUAKE_WINDOW_MS);
  const maxradiuskm = (QUAKE_RADIUS_MI * KM_PER_MI).toFixed(2);

  const url = new URL(USGS_QUERY);
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('latitude', String(KILAUEA_LAT));
  url.searchParams.set('longitude', String(KILAUEA_LON));
  url.searchParams.set('maxradiuskm', maxradiuskm);
  url.searchParams.set('starttime', `${start.toISOString().split('.')[0]}Z`);
  url.searchParams.set('endtime', `${end.toISOString().split('.')[0]}Z`);
  url.searchParams.set('minmagnitude', '3');
  url.searchParams.set('orderby', 'magnitude');
  url.searchParams.set('limit', '100');

  const doc = await fetchJson(url.toString());
  const features = Array.isArray(doc?.features) ? doc.features : [];
  let best = null;

  for (const f of features) {
    const props = f?.properties;
    const coords = f?.geometry?.coordinates;
    if (!props || !Array.isArray(coords) || coords.length < 2) continue;
    const mag = Number(props.mag);
    if (!Number.isFinite(mag) || mag <= MIN_MAG_EXCLUSIVE) continue;
    const evLon = Number(coords[0]);
    const evLat = Number(coords[1]);
    if (!Number.isFinite(evLon) || !Number.isFinite(evLat)) continue;
    const depthFromZ = coords.length >= 3 ? Number(coords[2]) : NaN;
    const depthKm = Number.isFinite(depthFromZ)
      ? depthFromZ
      : typeof props.depth === 'number' && Number.isFinite(props.depth)
        ? props.depth
        : null;
    const distMi = haversineMiles(KILAUEA_LAT, KILAUEA_LON, evLat, evLon);
    if (!Number.isFinite(distMi) || distMi > QUAKE_RADIUS_MI + 0.25) continue;
    if (!best || mag > best.mag) {
      best = {
        mag,
        depthKm,
        distMi,
        timeMs: Number(props.time),
        url:
          typeof props.url === 'string' && /^https?:\/\//i.test(props.url.trim())
            ? props.url.trim()
            : 'https://earthquake.usgs.gov/earthquakes/map/',
        title: typeof props.title === 'string' ? props.title.trim() : '',
      };
    }
  }
  return best;
}

function buildQuakeStripItem(quake) {
  if (!quake) return null;
  const distWhole = Math.max(0, Math.round(quake.distMi));
  const depthStr = formatDepthKmShort(quake.depthKm);
  const magStr = (Math.round(quake.mag * 10) / 10).toFixed(1);
  const parts = [`M${magStr}`];
  if (depthStr) parts.push(depthStr);
  parts.push(`${distWhole} mi`);
  return {
    earthType: 'kilauea_quake',
    label: 'Kīlauea quake',
    detailLine: parts.join(' · '),
    forecastUrl: quake.url,
    mag: quake.mag,
    depthKm: quake.depthKm,
    distMi: quake.distMi,
  };
}

function isEruptingAlert(alertLevel, colorCode, textBlob) {
  const alert = String(alertLevel || '').toUpperCase();
  const color = String(colorCode || '').toUpperCase();
  if (color === 'ORANGE' || color === 'RED') return true;
  if (alert === 'WATCH' || alert === 'WARNING') return true;
  const t = String(textBlob || '').toLowerCase();
  if (/\b(erupt(?:ion|ing)|fountaining|lava fountain|overflow)\b/.test(t)) return true;
  return false;
}

/**
 * @returns {Promise<{ ok: true, items: object[], cameras: object[], status: object } | { ok: false, error: string }>}
 */
export async function buildKilaueaDashboardPayload() {
  if (String(process.env.EARTH_KILAUEA || '').trim() === '0') {
    return { ok: true, disabled: true, items: [], cameras: [], status: { disabled: true } };
  }

  const upstream = {};

  const [
    elevatedSettled,
    capSettled,
    newestSettled,
    updatesSettled,
    messagesSettled,
    quakeSettled,
    camerasSettled,
  ] = await Promise.allSettled([
    fetchJson(HANS_ELEVATED),
    fetchJson(HANS_CAP),
    fetchJson(HANS_NEWEST),
    fetchText(KILAUEA_UPDATES_URL, { accept: 'text/html', timeoutMs: 18_000 }),
    fetchText(HVO_MESSAGES_URL, { accept: 'text/html', timeoutMs: 18_000 }),
    fetchStrongestKilaueaQuake(),
    Promise.all(CAM_SHORT_LINKS.map(resolveCamera)),
  ]);

  let alertLevel = null;
  let colorCode = null;
  let noticeUrl = KILAUEA_UPDATES_URL;
  let synopsis = '';
  let noticeSummary = '';
  let elevationFt = KILAUEA_ELEV_FT;
  let elevationM = KILAUEA_ELEV_M;

  if (elevatedSettled.status === 'fulfilled' && Array.isArray(elevatedSettled.value)) {
    const row = elevatedSettled.value.find(
      (v) =>
        String(v?.vnum) === KILAUEA_VNUM ||
        /k[iī]lauea/i.test(String(v?.volcano_name || '')),
    );
    if (row) {
      alertLevel = row.alert_level || alertLevel;
      colorCode = row.color_code || colorCode;
      if (row.notice_url) noticeUrl = cleanUrl(row.notice_url, noticeUrl);
    }
  } else if (elevatedSettled.status === 'rejected') {
    upstream.elevated = String(elevatedSettled.reason?.message || elevatedSettled.reason);
  }

  if (capSettled.status === 'fulfilled' && Array.isArray(capSettled.value)) {
    const row = capSettled.value.find(
      (v) =>
        String(v?.vnum) === KILAUEA_VNUM ||
        /k[iī]lauea/i.test(String(v?.volcano_name_appended || '')),
    );
    if (row) {
      alertLevel = row.alert_level || alertLevel;
      colorCode = row.color_code || colorCode;
      synopsis = String(row.synopsis || '').trim() || synopsis;
      if (row.notice_url) noticeUrl = cleanUrl(row.notice_url, noticeUrl);
      if (Number.isFinite(Number(row.elevation_feet))) {
        elevationFt = Math.round(Number(row.elevation_feet));
      }
      if (Number.isFinite(Number(row.elevation_meters))) {
        elevationM = Math.round(Number(row.elevation_meters));
      }
    }
  } else if (capSettled.status === 'rejected') {
    upstream.cap = String(capSettled.reason?.message || capSettled.reason);
  }

  if (newestSettled.status === 'fulfilled' && newestSettled.value && typeof newestSettled.value === 'object') {
    const n = newestSettled.value;
    alertLevel = n.noticeHighestAlertLevel || alertLevel;
    colorCode = n.noticeHighestColorCode || colorCode;
    if (n.noticeUrl) noticeUrl = cleanUrl(n.noticeUrl, noticeUrl);
    const sections = Array.isArray(n.noticeSections) ? n.noticeSections : [];
    const first = sections[0] || {};
    synopsis = stripHtml(first.synopsis || synopsis);
    noticeSummary = stripHtml(first.summary || '');
  } else if (newestSettled.status === 'rejected') {
    upstream.newest = String(newestSettled.reason?.message || newestSettled.reason);
  }

  // Primary content source: the main volcano-updates page.
  let updatesText = '';
  if (updatesSettled.status === 'fulfilled') {
    updatesText = extractKilaueaUpdateText(updatesSettled.value.text);
  } else {
    upstream.updates = String(updatesSettled.reason?.message || updatesSettled.reason);
  }

  /** @type {{ title: string, body: string }[]} */
  let messages = [];
  if (messagesSettled.status === 'fulfilled') {
    messages = parseHvoMessages(messagesSettled.value.text);
  } else {
    upstream.messages = String(messagesSettled.reason?.message || messagesSettled.reason);
  }

  const latestMessage = messages[0]?.body || '';
  const textBlob = [updatesText, latestMessage, synopsis, noticeSummary].filter(Boolean).join(' · ');
  const statsFromUpdates = parseEruptionStats(updatesText);
  const statsFromMessage = parseEruptionStats(latestMessage);
  const statsFromNotice = parseEruptionStats(`${synopsis} ${noticeSummary}`);
  const stats = {
    episode: statsFromUpdates.episode ?? statsFromMessage.episode ?? statsFromNotice.episode,
    startedRaw: statsFromUpdates.startedRaw || statsFromMessage.startedRaw || statsFromNotice.startedRaw,
    startedShort:
      statsFromUpdates.startedShort || statsFromMessage.startedShort || statsFromNotice.startedShort,
    fountainFt: statsFromUpdates.fountainFt ?? statsFromMessage.fountainFt ?? statsFromNotice.fountainFt,
    fountainM: statsFromUpdates.fountainM ?? statsFromMessage.fountainM ?? statsFromNotice.fountainM,
  };

  const forecast = parseNextEruptionForecast(
    [updatesText, latestMessage, synopsis, noticeSummary].filter(Boolean).join(' '),
  );

  const erupting = isEruptingAlert(alertLevel, colorCode, textBlob);
  const cameras =
    camerasSettled.status === 'fulfilled' && Array.isArray(camerasSettled.value)
      ? camerasSettled.value
      : CAM_SHORT_LINKS.map((c) => ({
          id: c.id,
          label: c.label,
          videoId: c.fallbackVideoId,
          watchUrl: `https://www.youtube.com/watch?v=${c.fallbackVideoId}`,
          embedUrl: `https://www.youtube.com/embed/${c.fallbackVideoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`,
        }));

  let quake = null;
  if (quakeSettled.status === 'fulfilled') {
    quake = quakeSettled.value;
  } else {
    upstream.quake = String(quakeSettled.reason?.message || quakeSettled.reason);
  }

  /** @type {object[]} */
  const items = [];

  if (erupting || alertLevel || colorCode || forecast.hasForecast) {
    const parts = [];
    if (erupting) parts.push('Erupting');
    else if (alertLevel || colorCode) {
      parts.push([alertLevel, colorCode].filter(Boolean).join(' · ') || 'Elevated');
    }
    if (stats.episode != null) parts.push(`Ep ${stats.episode}`);
    if (stats.startedShort) parts.push(`since ${stats.startedShort}`);
    if (stats.fountainFt != null) {
      parts.push(
        stats.fountainM != null
          ? `fountain ${stats.fountainFt} ft (${stats.fountainM} m)`
          : `fountain ${stats.fountainFt} ft`,
      );
    } else if (erupting || alertLevel || colorCode) {
      parts.push(`summit ${elevationFt} ft`);
    }
    if (erupting && (alertLevel || colorCode)) {
      parts.push([alertLevel, colorCode].filter(Boolean).join('/'));
    }
    // 📅 next-eruption forecast segment (shown between episodes and during episodic eruptions).
    if (forecast.hasForecast) {
      parts.push(`📅 next: ${forecast.forecastWhen || forecast.forecast}`);
    }

    // ! when erupting, 📅 when a next-eruption forecast is available.
    const marks = [];
    if (erupting) marks.push('❗');
    if (forecast.hasForecast) marks.push('📅');
    const label = marks.length ? `Kīlauea ${marks.join('')}` : 'Kīlauea';

    items.push({
      earthType: 'kilauea_volcano',
      label,
      detailLine: parts.join(' · '),
      forecastUrl: noticeUrl || KILAUEA_UPDATES_URL,
      erupting,
      eruptingMark: erupting ? '❗' : null,
      forecast: forecast.forecast,
      forecastWhen: forecast.forecastWhen,
      hasEruptionForecast: forecast.hasForecast,
      forecastMark: forecast.hasForecast ? '📅' : null,
      alertLevel: alertLevel || null,
      colorCode: colorCode || null,
      episode: stats.episode,
      started: stats.startedRaw,
      fountainFt: stats.fountainFt,
      fountainM: stats.fountainM,
      summitFt: elevationFt,
      summitM: elevationM,
      latestMessage: latestMessage || null,
      synopsis: synopsis || null,
    });
  }

  const quakeItem = buildQuakeStripItem(quake);
  if (quakeItem) items.push(quakeItem);

  return {
    ok: true,
    items,
    cameras,
    status: {
      erupting,
      eruptingMark: erupting ? '❗' : null,
      forecast: forecast.forecast,
      forecastWhen: forecast.forecastWhen,
      hasEruptionForecast: forecast.hasForecast,
      forecastMark: forecast.hasForecast ? '📅' : null,
      alertLevel: alertLevel || null,
      colorCode: colorCode || null,
      episode: stats.episode,
      started: stats.startedRaw,
      fountainFt: stats.fountainFt,
      fountainM: stats.fountainM,
      summitFt: elevationFt,
      summitM: elevationM,
      noticeUrl,
      updatesUrl: KILAUEA_UPDATES_URL,
      webcamsUrl: SUMMIT_WEBCAMS_URL,
      latestMessage: latestMessage || null,
      synopsis: synopsis || null,
      quake: quake
        ? {
            mag: quake.mag,
            depthKm: quake.depthKm,
            distMi: quake.distMi,
            url: quake.url,
          }
        : null,
      upstream: Object.keys(upstream).length ? upstream : undefined,
    },
  };
}
