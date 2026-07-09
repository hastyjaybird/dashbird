/**
 * Local Tool Library enrichment helpers (no external AI calls).
 */
import { normalizeToolUrl } from './tool-library-store.js';
import { loadToolLibrary } from './tool-library-store.js';
import { fetchPageMeta, isBlockedPage } from './tool-library-scrape.js';
import { fetchToolRating } from './tool-library-ratings.js';
import { cleanToolName, inferToolCategories } from './tool-library-categories.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** @type {{ title: string, url: string }[]} */
const CAD_TOOL_SEEDS = [
  { title: 'Autodesk Fusion', url: 'https://www.autodesk.com/products/fusion-360/overview' },
  { title: 'SOLIDWORKS', url: 'https://www.solidworks.com/' },
  { title: 'Onshape', url: 'https://www.onshape.com/' },
  { title: 'FreeCAD', url: 'https://www.freecad.org/' },
  { title: 'Solid Edge', url: 'https://solidedge.siemens.com/en-US' },
  { title: 'Autodesk Inventor', url: 'https://www.autodesk.com/products/inventor/overview' },
  { title: 'CATIA', url: 'https://www.3ds.com/products/catia' },
  { title: 'Rhino 3D', url: 'https://www.rhino3d.com/' },
  { title: 'BricsCAD', url: 'https://www.bricsys.com/bricscad' },
  { title: 'Blender', url: 'https://www.blender.org/' },
  { title: 'SketchUp', url: 'https://www.sketchup.com/' },
  { title: 'OpenSCAD', url: 'https://openscad.org/' },
];

/** @type {{ title: string, url: string }[]} */
const VIDEO_TOOL_SEEDS = [
  { title: 'DaVinci Resolve', url: 'https://www.blackmagicdesign.com/products/davinciresolve' },
  { title: 'Shotcut', url: 'https://shotcut.org/' },
  { title: 'OpenShot', url: 'https://www.openshot.org/' },
  { title: 'Adobe Premiere Pro', url: 'https://www.adobe.com/products/premiere.html' },
  { title: 'Final Cut Pro', url: 'https://www.apple.com/final-cut-pro/' },
  { title: 'HitFilm', url: 'https://fxhome.com/product/hitfilm' },
];

/** @type {Record<string, string>} */
const KNOWN_TOOL_HOMEPAGES = {
  'fusion 360': 'https://www.autodesk.com/products/fusion-360/overview',
  fusion360: 'https://www.autodesk.com/products/fusion-360/overview',
  'autodesk fusion 360': 'https://www.autodesk.com/products/fusion-360/overview',
};

/**
 * @param {string} input
 */
function looksLikeHomepageUrl(input) {
  const s = String(input || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/\s/.test(s)) return false;
  return /^[a-z0-9][-a-z0-9.]*\.[a-z]{2,}(\/|$)/i.test(s);
}

/**
 * Resolve a product name or partial URL to an official homepage (HTTPS).
 * @param {string} input
 */
export async function resolveToolHomepageUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('url_required');

  if (looksLikeHomepageUrl(raw)) {
    return normalizeToolUrl(raw);
  }

  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const compact = key.replace(/\s+/g, '');
  const known = KNOWN_TOOL_HOMEPAGES[key] || KNOWN_TOOL_HOMEPAGES[compact];
  if (known) return normalizeToolUrl(known);

  throw new Error(`could_not_resolve_url for "${raw}" (provide full https URL)`);
}

/**
 * @param {{ url: string, title: string, description: string, host: string }} scrape
 */
export async function enrichToolFromScrape(scrape) {
  const name = cleanToolName(scrape.title || scrape.host || 'Tool');
  const desc = String(scrape.description || '').trim();
  const categories = inferToolCategories({
    name,
    description: desc,
    url: scrape.url,
    host: scrape.host,
  });
  const rated = await fetchToolRating(name).catch(() => null);
  return {
    name,
    bestUsedFor: desc.slice(0, 320),
    pricing: {
      model: 'unknown',
      lowestTier: 'Unknown',
      summary: 'Pricing not auto-detected',
    },
    features: [],
    pros: [],
    cons: [],
    rating: rated?.rating ?? null,
    ratingSource: rated?.source || '',
    operatingSystems: inferOperatingSystems(desc, scrape.url, scrape.host),
    categories,
  };
}

/**
 * @param {object} tool
 */
export async function findAlternatives(tool) {
  const webAlternatives = await findWebAlternatives(tool);
  return dedupeAlternatives(webAlternatives, tool);
}

/**
 * @param {object} tool
 * @param {object[]} alternatives
 */
export function rankToolAmongAlternatives(tool, alternatives) {
  const rows = alternatives.map((alt, i) => ({
    tempId: alt.tempId || `alt-${i + 1}`,
    ...alt,
    isOriginal: false,
  }));
  rows.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return rows;
}

/**
 * @param {object} tool
 */
async function findWebAlternatives(tool) {
  const candidates = await searchAlternativeUrls(tool);
  if (!candidates.length) return [];
  const existing = await loadToolLibrary();
  const existingUrls = new Set(existing.tools.map((t) => safeNormalize(t.url)).filter(Boolean));
  const existingHosts = new Set(existing.tools.map((t) => safeHostname(t.url)).filter(Boolean));
  const existingNames = new Set(
    existing.tools.map((t) => cleanToolName(t.name || '').toLowerCase()).filter(Boolean),
  );
  const out = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const resolvedUrl = normalizeToolUrl(candidate.url);
      const resolvedHost = safeHostname(resolvedUrl);
      if (existingUrls.has(safeNormalize(resolvedUrl))) continue;
      if (resolvedHost && existingHosts.has(resolvedHost)) continue;
      const meta = await fetchPageMeta(resolvedUrl);
      if (isBlockedPage({ ...meta, html: meta.htmlSnippet })) continue;
      const enriched = enrichAlternativeCandidate({
        url: resolvedUrl,
        title: meta.title || candidate.title,
        description: meta.description,
        host: meta.host,
      });
      const displayName = cleanToolName(
        candidate.title || enriched.name || meta.title || candidate.url,
      );
      const resolvedName = displayName.toLowerCase();
      if (!resolvedName || existingNames.has(resolvedName)) continue;
      if (isJunkAlternativeName(displayName)) continue;
      out.push({
        tempId: `web-${i + 1}`,
        name: displayName,
        bestUsedFor: enriched.bestUsedFor || meta.description || '',
        url: resolvedUrl,
        website: resolvedUrl,
        pricing: enriched.pricing,
        features: enriched.features || [],
        pros: enriched.pros || [],
        cons: enriched.cons || [],
        rating: enriched.rating ?? null,
        ratingSource: enriched.ratingSource || '',
        operatingSystems: enriched.operatingSystems || ['Web'],
        categories: enriched.categories || ['utilities'],
        logoUrl: '',
        snapshotUrl: '',
        source: 'web',
      });
    } catch {
      // Skip candidates we cannot resolve or fetch.
    }
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * @param {object} tool
 */
async function searchAlternativeUrls(tool) {
  const seeded = seedAlternativeUrls(tool);
  const searchName = cleanToolName(tool?.name || 'software');
  const [yahoo, ddg] = await Promise.all([
    searchYahooAlternativeUrls(searchName, tool),
    searchDuckDuckGoAlternativeUrls(searchName, tool),
  ]);
  return dedupeUrlCandidates([...seeded, ...yahoo, ...ddg]);
}

/**
 * @param {string} searchName
 * @param {object} sourceTool
 */
async function searchYahooAlternativeUrls(searchName, sourceTool) {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(`${searchName} alternatives`)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return [];
    const html = await r.text();
    return extractMentionedToolSeeds(html, sourceTool);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} searchName
 * @param {object} sourceTool
 */
async function searchDuckDuckGoAlternativeUrls(searchName, sourceTool) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${searchName} alternatives`)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return [];
    const html = await r.text();
    return parseAlternativesFromSearchHtml(html, sourceTool);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} html
 * @param {object} sourceTool
 */
function extractMentionedToolSeeds(html, sourceTool) {
  const sourceHost = safeHostname(sourceTool?.url);
  const blob = decodeHtmlEntities(html).toLowerCase();
  const pool = toolSeedPool(sourceTool);
  return pool.filter((seed) => {
    const host = safeHostname(seed.url);
    if (!host || host === sourceHost) return false;
    const title = seed.title.toLowerCase();
    const shortHost = host.replace(/^www\./, '').split('.')[0];
    return blob.includes(title) || blob.includes(shortHost);
  });
}

/**
 * @param {string} html
 * @param {object} sourceTool
 */
function parseAlternativesFromSearchHtml(html, sourceTool) {
  const sourceHost = safeHostname(sourceTool?.url);
  const results = [];
  const seen = new Set();
  const re = /<a([^>]+)class="[^"]*result__a[^"]*"([^>]*)>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = `${m[1]} ${m[2]}`;
    const title = decodeHtmlEntities(stripTags(m[3])).replace(/\s+/g, ' ').trim();
    const href = extractHref(attrs);
    const target = parseDuckDuckGoTarget(href);
    if (!target) continue;
    const normalized = safeNormalize(target);
    if (!normalized) continue;
    const host = safeHostname(normalized);
    if (!host || host === sourceHost) continue;
    if (isAggregatorHost(host) || isLikelyContentPage(normalized, title)) continue;
    const key = host;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ url: normalized, title });
    if (results.length >= 24) break;
  }
  return results;
}

/**
 * @param {object} tool
 */
function seedAlternativeUrls(tool) {
  const sourceHost = safeHostname(tool?.url);
  return toolSeedPool(tool).filter((seed) => safeHostname(seed.url) !== sourceHost);
}

/**
 * @param {object} tool
 */
function toolSeedPool(tool) {
  const name = cleanToolName(tool?.name || '').toLowerCase();
  const cats = new Set((tool?.categories || []).map((c) => String(c).toLowerCase()));

  if (
    cats.has('3d modeling') ||
    /\b(cad|cam|cae|freecad|onshape|solidworks|fusion|blender|inventor|catia|rhino|sketchup|openscad)\b/i.test(
      name,
    )
  ) {
    return CAD_TOOL_SEEDS;
  }
  if (
    cats.has('video') ||
    /\b(kdenlive|davinci|premiere|shotcut|openshot|hitfilm|video edit)\b/i.test(name)
  ) {
    return VIDEO_TOOL_SEEDS;
  }
  return [];
}

/**
 * @param {string} s
 */
function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}

/**
 * @param {string} attrs
 */
function extractHref(attrs) {
  const m = String(attrs || '').match(/\shref="([^"]+)"/i);
  return m?.[1] ? decodeHtmlEntities(m[1]) : '';
}

/**
 * @param {string} href
 */
function parseDuckDuckGoTarget(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, 'https://duckduckgo.com');
    const redirect = u.searchParams.get('uddg');
    return redirect || u.toString();
  } catch {
    return '';
  }
}

/**
 * @param {string} s
 */
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * @param {string} url
 */
function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

const AGGREGATOR_HOST_HINTS = [
  'g2.com',
  'capterra.com',
  'sourceforge.net',
  'slashdot.org',
  'reddit.com',
  'youtube.com',
  'linkedin.com',
  'medium.com',
  'github.com',
  'producthunt.com',
  'wordpress.com',
  'quora.com',
  'wikipedia.org',
  '3dsourced.com',
  'selfcad.com',
  'alternativeto.net',
  'engineeratlas.com',
  'autocadeverything.com',
];

/**
 * @param {string} host
 */
function isAggregatorHost(host) {
  const h = String(host || '').toLowerCase();
  return AGGREGATOR_HOST_HINTS.some((x) => h === x || h.endsWith(`.${x}`));
}

/**
 * @param {string} url
 * @param {string} title
 */
function isLikelyContentPage(url, title = '') {
  const s = String(url || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  return (
    s.includes('/blog/') ||
    s.includes('/news/') ||
    s.includes('/article/') ||
    s.includes('/articles/') ||
    s.includes('/resources/') ||
    s.includes('/guides/') ||
    s.includes('/compare/') ||
    s.includes('/alternatives') ||
    s.includes('-alternatives') ||
    s.includes('/alternative') ||
    /\b(top|best)\s+\d+\b/.test(t) ||
    t.includes('alternatives to')
  );
}

/**
 * @param {{title:string,url:string}[]} rows
 */
function dedupeUrlCandidates(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const normalized = safeNormalize(row?.url || '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ title: String(row?.title || '').trim(), url: normalized });
  }
  return out;
}

/**
 * @param {object[]} rows
 * @param {object} sourceTool
 */
function dedupeAlternatives(rows, sourceTool) {
  const seen = new Set();
  const sourceUrl = safeNormalize(sourceTool.url);
  const sourceName = String(sourceTool.name || '').trim().toLowerCase();
  /** @type {object[]} */
  const out = [];
  for (const row of rows) {
    const rowUrl = safeNormalize(row.url);
    const rowName = String(row.name || '').trim().toLowerCase();
    if (!rowUrl) continue;
    if (sourceUrl && rowUrl === sourceUrl) continue;
    if (sourceName && rowName === sourceName) continue;
    if (seen.has(rowUrl)) continue;
    seen.add(rowUrl);
    out.push(row);
  }
  return out;
}

/**
 * @param {string} maybeUrl
 */
function safeNormalize(maybeUrl) {
  try {
    return normalizeToolUrl(maybeUrl || '');
  } catch {
    return '';
  }
}

/**
 * Fast enrichment for alternative rows (rating fetched when added to toolbox).
 * @param {{ url: string, title?: string, description?: string, host?: string }} scrape
 */
function enrichAlternativeCandidate(scrape) {
  const name = cleanToolName(scrape.title || scrape.host || 'Tool');
  const desc = String(scrape.description || '').trim();
  return {
    name,
    bestUsedFor: desc.slice(0, 320),
    pricing: {
      model: 'unknown',
      lowestTier: 'Unknown',
      summary: 'Pricing not auto-detected',
    },
    features: [],
    pros: [],
    cons: [],
    rating: null,
    ratingSource: '',
    operatingSystems: inferOperatingSystems(desc, scrape.url, scrape.host || ''),
    categories: inferToolCategories({
      name,
      description: desc,
      url: scrape.url,
      host: scrape.host,
    }),
  };
}

/**
 * @param {string} name
 */
function isJunkAlternativeName(name) {
  const n = String(name || '').trim();
  if (!n || n.length < 2) return true;
  if (/access denied|just a moment|attention required|region selector|request blocked|page not found|404 error/i.test(n)) return true;
  if (/^what is\b/i.test(n)) return true;
  if (/^the (solution|ultimate|best|top)\b/i.test(n)) return true;
  if (/alternatives?\b/i.test(n) && !/\b(for|to)\b/i.test(n)) return true;
  if (n.length > 72 && /\b(software|platform|solution|development)\b/i.test(n)) return true;
  return false;
}

/**
 * @param {string} description
 * @param {string} url
 * @param {string} host
 */
function inferOperatingSystems(description, url, host) {
  const blob = `${description} ${url} ${host}`.toLowerCase();
  /** @type {string[]} */
  const out = [];
  if (/\bweb\b|\.io\b|saas|browser/.test(blob)) out.push('Web');
  if (/\bwindows\b|\bwin32\b|\bpc\b/.test(blob)) out.push('Windows');
  if (/\blinux\b|\bubuntu\b|\bappimage\b/.test(blob)) out.push('Linux');
  if (/\bios\b|\biphone\b|\bipad\b/.test(blob)) out.push('iOS');
  if (/\bandroid\b/.test(blob)) out.push('Android');
  return out.length ? [...new Set(out)] : ['Web'];
}
