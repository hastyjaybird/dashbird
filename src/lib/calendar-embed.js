/** @param {URL} url */
function isGoogleCalendarEmbedUrl(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const isHost =
    host === 'calendar.google.com' || host === 'www.google.com' || host === 'google.com';
  if (!isHost) return false;
  return path.includes('/calendar/') && path.includes('/embed');
}

/** Light canvas for embed; `.calendar-frame--google` inverts it to match `#0a1018`. */
const GOOGLE_EMBED_CANVAS = '#ffffff';

/**
 * Match dashbird glass/dark UI: week view, light embed canvas (inverted in CSS), hide duplicate title.
 * @param {URL} url
 */
function applyGoogleCalendarEmbedDefaults(url) {
  if (!isGoogleCalendarEmbedUrl(url)) return;
  const mode = url.searchParams.get('mode');
  if (mode == null || mode === '') {
    url.searchParams.set('mode', 'WEEK');
  }
  url.searchParams.set('bgcolor', GOOGLE_EMBED_CANVAS);
  if (!url.searchParams.has('showTitle')) {
    url.searchParams.set('showTitle', '0');
  }
}

/**
 * Normalize CALENDAR_EMBED_URL from .env: trim, strip wrapping quotes,
 * extract src= from a pasted iframe snippet, validate as http(s) URL.
 * For Google Calendar embeds: adds mode=WEEK, forces a light bgcolor (inverted to dark in CSS), and sets showTitle=0 when omitted.
 * @param {string|undefined} raw
 * @returns {string} usable iframe src or ''
 */
export function normalizeCalendarEmbedUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/&amp;/g, '&');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  const iframeSrc = s.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (iframeSrc) s = iframeSrc[1].trim();
  else {
    const loose = s.match(/src\s*=\s*["']([^"']+)["']/i);
    if (loose) s = loose[1].trim();
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    applyGoogleCalendarEmbedDefaults(u);
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * Extra Google Calendar IDs to layer onto the embed (Partiful sync, Random Events, …).
 * From CALENDAR_EMBED_EXTRA_SRCS + EVENTS_FINDER_GOOGLE_CALENDAR_SRC.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function resolveCalendarEmbedExtraSrcs(env = process.env) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();

  /**
   * @param {unknown} raw
   */
  function push(raw) {
    const s = String(raw || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  }

  for (const part of String(env.CALENDAR_EMBED_EXTRA_SRCS || '').split(/[\n,|]/)) {
    push(part);
  }
  push(env.EVENTS_FINDER_GOOGLE_CALENDAR_SRC);

  return out;
}

/**
 * Append calendar IDs as extra `src` query params (Google multi-calendar embed).
 * @param {string} embedUrl
 * @param {string[]} srcs
 * @returns {string}
 */
export function appendCalendarEmbedSrcs(embedUrl, srcs) {
  const base = String(embedUrl || '').trim();
  if (!base) return '';
  const list = Array.isArray(srcs) ? srcs.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!list.length) return base;
  try {
    const u = new URL(base);
    if (!isGoogleCalendarEmbedUrl(u)) return base;
    const existing = new Set(
      u.searchParams.getAll('src').map((s) => decodeURIComponent(String(s || '')).toLowerCase()),
    );
    for (const src of list) {
      const key = src.toLowerCase();
      if (existing.has(key)) continue;
      u.searchParams.append('src', src);
      existing.add(key);
    }
    applyGoogleCalendarEmbedDefaults(u);
    return u.toString();
  } catch {
    return base;
  }
}
