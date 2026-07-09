/**
 * Fetch homepage metadata + best-effort logo/snapshot for Tool Library.
 */
import { saveToolAsset } from './tool-library-store.js';
import { capturePageThumbnail } from './tool-library-screenshot.js';
import { assertPublicHttpUrl } from './public-http-url.js';

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
  const safeUrl = await assertPublicHttpUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(safeUrl, {
      signal: ac.signal,
      redirect: 'manual',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': BROWSER_UA,
      },
    });
    // Follow redirects only to other public http(s) destinations.
    let finalUrl = safeUrl;
    let response = r;
    for (let hop = 0; hop < 5 && [301, 302, 303, 307, 308].includes(response.status); hop += 1) {
      const loc = response.headers.get('location');
      if (!loc) break;
      finalUrl = await assertPublicHttpUrl(new URL(loc, finalUrl).toString());
      response = await fetch(finalUrl, {
        signal: ac.signal,
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': BROWSER_UA,
        },
      });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error('url_not_public');
    }
    const raw = await response.arrayBuffer();
    if (raw.byteLength > 2_000_000) {
      throw new Error('page_too_large');
    }
    const html = Buffer.from(raw).toString('utf8');
    const host = new URL(finalUrl).hostname;
    const title = metaContent(html, 'og:title') || titleFromHtml(html) || host;
    const images = discoverPageImages(html, finalUrl);
    return {
      ok: response.ok,
      status: response.status,
      host,
      title,
      description: metaContent(html, 'og:description') || metaContent(html, 'description'),
      ogImage: resolveUrl(finalUrl, metaContent(html, 'og:image')) || images.snapshot,
      logoImage: images.logo,
      bodyImages: images.bodyImages || [],
      // Larger snippet so pricing/nav heuristics can see footer + mid-page copy.
      htmlSnippet: html.slice(0, 80_000),
      blocked: isBlockedPage({ ok: response.ok, status: response.status, title, html }),
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
 * Score in-page raster URLs for hero / product art (sites with no og:image).
 * @param {string} html
 * @param {string} pageUrl
 */
function discoverBodyImages(html, pageUrl) {
  /** @type {{ url: string, score: number }[]} */
  const scored = [];
  const seen = new Set();

  const push = (raw, bonus = 0) => {
    const abs = resolveUrl(pageUrl, raw);
    if (!abs || seen.has(abs)) return;
    if (!/^https?:\/\//i.test(abs)) return;
    if (/\.svg(\?|$)/i.test(abs)) return;
    if (/sprite|pixel|tracking|1x1|blank|spacer|icon-?font|emoji/i.test(abs)) return;
    seen.add(abs);
    let score = bonus;
    const lower = abs.toLowerCase();
    if (/hero|overview|banner|feature|product|cover|og[-_]?image|social/i.test(lower)) score += 80;
    if (/@2x|retina|xl\.|lg\./i.test(lower)) score += 25;
    if (/\.(jpe?g|webp)(\?|$)/i.test(lower)) score += 15;
    if (/\.png(\?|$)/i.test(lower)) score += 5;
    if (/favicon|logo|icon|avatar|badge|button|arrow|replay|sound-/i.test(lower)) score -= 60;
    scored.push({ url: abs, score });
  };

  const srcsetRe = /\bsrcset=["']([^"']+)["']/gi;
  let m;
  while ((m = srcsetRe.exec(html))) {
    for (const part of m[1].split(',')) {
      const u = part.trim().split(/\s+/)[0];
      if (u) push(u, 10);
    }
  }

  const srcRe = /\b(?:src|data-src)=["']([^"']+\.(?:png|jpe?g|webp)(?:\?[^"']*)?)["']/gi;
  while ((m = srcRe.exec(html))) {
    push(m[1], 5);
  }

  // Absolute CDN URLs embedded in scripts / CSS (Blackmagic, etc.)
  const absRe = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>]*)?/gi;
  while ((m = absRe.exec(html))) {
    push(m[0], 0);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, 8).map((s) => s.url);
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
    const px = sizeMatch
      ? Number(sizeMatch[1]) * Number(sizeMatch[2])
      : /apple-touch-icon/i.test(tag)
        ? 180 * 180
        : 32 * 32;
    candidates.push({ url: abs, px });
  }

  candidates.sort((a, b) => b.px - a.px);
  const logo = candidates[0]?.url || resolveUrl(pageUrl, '/favicon.ico') || '';
  const bodyImages = discoverBodyImages(html, pageUrl);
  const og = resolveUrl(pageUrl, metaContent(html, 'og:image'));
  const snapshot =
    og || bodyImages[0] || candidates.find((c) => c.px >= 120 * 120)?.url || logo;
  return { logo, snapshot, bodyImages };
}

/**
 * @param {string} url
 */
export function faviconUrlForPage(url) {
  const host = new URL(url).hostname;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
}

/**
 * @param {Buffer} buf
 * @param {string} contentType
 */
function sniffImageKind(buf, contentType) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg' };
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp' };
  }
  // Windows ICO — browsers often won't render these when served as .webp
  if (buf.length >= 6 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return { ext: 'ico' };
  }
  if (contentType.includes('png')) return { ext: 'png' };
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return { ext: 'jpg' };
  if (contentType.includes('webp')) return { ext: 'webp' };
  if (contentType.includes('icon') || contentType.includes('x-icon')) return { ext: 'ico' };
  if (contentType.includes('image')) return { ext: 'png' };
  return null;
}

/**
 * @param {string} imageUrl
 */
async function downloadImage(imageUrl) {
  let safeUrl;
  try {
    safeUrl = await assertPublicHttpUrl(imageUrl);
  } catch {
    return null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(safeUrl, {
      signal: ac.signal,
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA },
    });
    let finalUrl = safeUrl;
    let response = r;
    for (let hop = 0; hop < 3 && [301, 302, 303, 307, 308].includes(response.status); hop += 1) {
      const loc = response.headers.get('location');
      if (!loc) break;
      finalUrl = await assertPublicHttpUrl(new URL(loc, finalUrl).toString());
      response = await fetch(finalUrl, {
        signal: ac.signal,
        redirect: 'manual',
        headers: { 'User-Agent': BROWSER_UA },
      });
    }
    if (!response.ok || [301, 302, 303, 307, 308].includes(response.status)) return null;
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length < 200 || buf.length > 4_000_000) return null;

    const kind = sniffImageKind(buf, ct);
    if (!kind) return null;
    return { buf, ext: kind.ext };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} toolId
 * @param {string} pageUrl
 * @param {{ ogImage?: string, logoImage?: string, bodyImages?: string[] }} meta
 */
export async function importToolImages(toolId, pageUrl, meta) {
  let logoPath = '';
  let snapshotPath = '';

  const bodyImages = Array.isArray(meta.bodyImages) ? meta.bodyImages : [];
  const logoSources = [meta.logoImage, faviconUrlForPage(pageUrl)].filter(Boolean);
  for (const src of logoSources) {
    const img = await downloadImage(src);
    if (!img || img.buf.length < 400) continue;
    // Skip tiny ICO-only logos when we can still get a real snapshot
    if (img.ext === 'ico' && img.buf.length < 2_000) continue;
    logoPath = await saveToolAsset(toolId, 'logo', img.buf, img.ext);
    break;
  }

  const snapSources = [
    meta.ogImage,
    ...bodyImages,
    meta.logoImage,
    faviconUrlForPage(pageUrl),
  ].filter(Boolean);
  for (const src of snapSources) {
    const img = await downloadImage(src);
    if (!img || img.buf.length < 800) continue;
    if (img.ext === 'ico') continue;
    snapshotPath = await saveToolAsset(toolId, 'snapshot', img.buf, img.ext);
    break;
  }

  if (!snapshotPath) {
    const shot = await capturePageThumbnail(pageUrl);
    if (shot) {
      snapshotPath = await saveToolAsset(toolId, 'snapshot', shot, 'png');
      if (!logoPath) {
        logoPath = await saveToolAsset(toolId, 'logo', shot, 'png');
      }
    }
  }

  // Prefer a real snapshot over a tiny ICO favicon for the card logo.
  if (!logoPath && snapshotPath) {
    logoPath = snapshotPath;
  }
  if (!logoPath) {
    for (const src of logoSources) {
      const img = await downloadImage(src);
      if (!img || img.buf.length < 200) continue;
      logoPath = await saveToolAsset(toolId, 'logo', img.buf, img.ext);
      break;
    }
  }

  return { logoPath, snapshotPath };
}
