/** @param {URL} url */
function isGoogleCalendarEmbedUrl(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const isHost =
    host === 'calendar.google.com' || host === 'www.google.com' || host === 'google.com';
  if (!isHost) return false;
  return path.includes('/calendar/') && path.includes('/embed');
}

/**
 * Match dashbird glass/dark UI: week view, dark canvas, hide duplicate embed title.
 * Always sets bgcolor to the dashboard base (#0a1018) so pasted embed URLs that include
 * Google’s default white canvas are overridden (Google still may render a lighter UI for some accounts).
 * @param {URL} url
 */
function applyGoogleCalendarEmbedDefaults(url) {
  if (!isGoogleCalendarEmbedUrl(url)) return;
  const mode = url.searchParams.get('mode');
  if (mode == null || mode === '') {
    url.searchParams.set('mode', 'WEEK');
  }
  url.searchParams.set('bgcolor', '#0a1018');
  if (!url.searchParams.has('showTitle')) {
    url.searchParams.set('showTitle', '0');
  }
}

/**
 * Normalize CALENDAR_EMBED_URL from .env: trim, strip wrapping quotes,
 * extract src= from a pasted iframe snippet, validate as http(s) URL.
 * For Google Calendar embeds: adds mode=WEEK, forces bgcolor to the dashboard base (#0a1018), and sets showTitle=0 when omitted.
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
