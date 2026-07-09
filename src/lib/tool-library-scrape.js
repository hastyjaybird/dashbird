/**
 * Fetch homepage metadata + best-effort logo/snapshot for Tool Library.
 */
import { saveToolAsset } from './tool-library-store.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
        'User-Agent': BROWSER_UA,
      },
    });
    const html = await r.text();
    const host = new URL(url).hostname;
    const title = metaContent(html, 'og:title') || titleFromHtml(html) || host;
    const images = discoverPageImages(html, url);
    return {
      ok: r.ok,
      status: r.status,
      host,
      title,
      description: metaContent(html, 'og:description') || metaContent(html, 'description'),
      ogImage: resolveUrl(url, metaContent(html, 'og:image')) || images.snapshot,
      logoImage: images.logo,
      htmlSnippet: html.slice(0, 12000),
      blocked: isBlockedPage({ ok: r.ok, status: r.status, title, html }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ ok?: boolean, status?: number, title?: string, html?: string }} meta
 */
export function isBlockedPage(meta) {
  const title = String(meta?.title || '').trim().toLowerCase();
  const html = String(meta?.html || '').toLowerCase();
  if (meta?.status === 401 || meta?.status === 403) return true;
  if (/access denied|forbidden|request blocked|just a moment|attention required/i.test(title)) return true;
  if (/access denied|errors\.edgesuite\.net|cf-browser-verification/i.test(html.slice(0, 4000))) return true;
  return false;
}

/**
 * @param {string} html
 * @param {string} pageUrl
 */
export function discoverPageImages(html, pageUrl) {
  const candidates = [];
  const iconRe = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi;
  let m;
  while ((m = iconRe.exec(html))) {
    const tag = m[0];
    const href = tag.match(/\shref=["']([^"']+)["']/i)?.[1];
    if (!href || href.endsWith('.svg')) continue;
    const abs = resolveUrl(pageUrl, href);
    if (!abs) continue;
    const sizes = tag.match(/\bsizes=["']([^"']+)["']/i)?.[1] || '';
    const sizeMatch = sizes.match(/(\d+)\s*x\s*(\d+)/i);
    const px = sizeMatch ? Number(sizeMatch[1]) * Number(sizeMatch[2]) : /apple-touch-icon/i.test(tag) ? 180 * 180 : 32 * 32;
    candidates.push({ url: abs, px });
  }

  candidates.sort((a, b) => b.px - a.px);
  const logo = candidates[0]?.url || resolveUrl(pageUrl, '/favicon.ico') || '';
  const snapshot = resolveUrl(pageUrl, metaContent(html, 'og:image')) || candidates.find((c) => c.px >= 120 * 120)?.url || logo;
  return { logo, snapshot };
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
      headers: { 'User-Agent': BROWSER_UA },
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

  const logoSources = [meta.logoImage, faviconUrlForPage(pageUrl)].filter(Boolean);
  for (const src of logoSources) {
    const img = await downloadImage(src);
    if (!img || img.buf.length < 400) continue;
    logoPath = await saveToolAsset(toolId, 'logo', img.buf, img.ext);
    break;
  }

  const snapSources = [meta.ogImage, meta.logoImage, faviconUrlForPage(pageUrl)].filter(Boolean);
  for (const src of snapSources) {
    const img = await downloadImage(src);
    if (!img || img.buf.length < 800) continue;
    snapshotPath = await saveToolAsset(toolId, 'snapshot', img.buf, img.ext);
    break;
  }

  return { logoPath, snapshotPath };
}
