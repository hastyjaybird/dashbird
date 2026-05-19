/**
 * Fetch homepage metadata + best-effort logo/snapshot for Tool Library.
 */
import { saveToolAsset } from './tool-library-store.js';

/**
 * @param {string} html
 * @param {string} attr
 */
function metaContent(html, attr) {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${attr}["'][^>]+content=["']([^"']+)`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${attr}["']`,
      'i',
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
  }
  return '';
}

/**
 * @param {string} s
 */
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * @param {string} html
 */
function titleFromHtml(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m?.[1] ? decodeHtmlEntities(m[1].trim()) : '';
}

/**
 * @param {string} pageUrl
 * @param {string} maybeRelative
 */
function resolveUrl(pageUrl, maybeRelative) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, pageUrl).toString();
  } catch {
    return '';
  }
}

/**
 * @param {string} url
 */
export async function fetchPageMeta(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'dashbird-tool-library/1.0 (metadata fetch)',
      },
    });
    const html = await r.text();
    const host = new URL(url).hostname;
    return {
      ok: r.ok,
      status: r.status,
      host,
      title: metaContent(html, 'og:title') || titleFromHtml(html) || host,
      description: metaContent(html, 'og:description') || metaContent(html, 'description'),
      ogImage: resolveUrl(url, metaContent(html, 'og:image')),
      htmlSnippet: html.slice(0, 12000),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} url
 */
export function faviconUrlForPage(url) {
  const host = new URL(url).hostname;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
}

/**
 * @param {string} imageUrl
 */
async function downloadImage(imageUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(imageUrl, {
      signal: ac.signal,
      headers: { 'User-Agent': 'dashbird-tool-library/1.0' },
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('image')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200 || buf.length > 4_000_000) return null;
    const ext = ct.includes('png') ? 'png' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'webp';
    return { buf, ext };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} toolId
 * @param {string} pageUrl
 * @param {{ ogImage?: string }} meta
 */
export async function importToolImages(toolId, pageUrl, meta) {
  let logoPath = '';
  let snapshotPath = '';

  const fav = await downloadImage(faviconUrlForPage(pageUrl));
  if (fav) {
    logoPath = await saveToolAsset(toolId, 'logo', fav.buf, fav.ext);
  }

  const snapSrc = meta.ogImage || faviconUrlForPage(pageUrl);
  const snap = snapSrc ? await downloadImage(snapSrc) : null;
  if (snap) {
    snapshotPath = await saveToolAsset(toolId, 'snapshot', snap.buf, snap.ext);
  }

  return { logoPath, snapshotPath };
}
