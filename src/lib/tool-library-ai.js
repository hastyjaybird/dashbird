/**
 * Local Tool Library enrichment helpers (no external AI calls).
 */
import { normalizeToolUrl } from './tool-library-store.js';
import { loadToolLibrary } from './tool-library-store.js';
import { fetchPageMeta, importToolImages, isBlockedPage } from './tool-library-scrape.js';
import { assetIdForUrl } from './tool-library-screenshot.js';
import { fetchToolRating } from './tool-library-ratings.js';
import { cleanToolName, inferToolCategories } from './tool-library-categories.js';
import { assertPublicHttpUrl } from './public-http-url.js';
import {
  resolveToolPricing,
  resolveToolPricingSync,
  unknownPricing,
} from './tool-library-pricing.js';

const MAX_SEARCH_ALTERNATIVES = 6;
/** Hard wall-clock budget for Enter-to-search-online (UI preview only). */
const SEARCH_ONLINE_BUDGET_MS = 35_000;

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
  { title: 'HitFilm', url: 'https://fxhome.com/product/hitfilm' },
];

/** @type {{ title: string, url: string }[]} */
const NOTES_TOOL_SEEDS = [
  { title: 'Notion', url: 'https://www.notion.so' },
  { title: 'Obsidian', url: 'https://obsidian.md' },
  { title: 'Coda', url: 'https://coda.io' },
  { title: 'Craft', url: 'https://www.craft.do' },
  { title: 'Evernote', url: 'https://evernote.com' },
  { title: 'Roam Research', url: 'https://roamresearch.com' },
  { title: 'Logseq', url: 'https://logseq.com' },
  { title: 'ClickUp', url: 'https://clickup.com' },
  { title: 'Confluence', url: 'https://www.atlassian.com/software/confluence' },
  { title: 'Airtable', url: 'https://airtable.com' },
];

/** OS labels that are Apple-ecosystem only (no Windows/Linux/Web/Android). */
const APPLE_ONLY_OS = new Set(['macos', 'mac', 'osx', 'ios', 'ipados', 'watchos', 'tvos']);

/** @type {Record<string, string>} */
const KNOWN_TOOL_HOMEPAGES = {
  'fusion 360': 'https://www.autodesk.com/products/fusion-360/overview',
  fusion360: 'https://www.autodesk.com/products/fusion-360/overview',
  'autodesk fusion 360': 'https://www.autodesk.com/products/fusion-360/overview',
  notion: 'https://www.notion.so',
  'notion.so': 'https://www.notion.so',
  blender: 'https://www.blender.org',
  sketchup: 'https://www.sketchup.com',
  onshape: 'https://www.onshape.com',
  kdenlive: 'https://kdenlive.org',
  pinterest: 'https://www.pinterest.com',
  pintrest: 'https://www.pinterest.com',
  pinterst: 'https://www.pinterest.com',
  canva: 'https://www.canva.com',
  figma: 'https://www.figma.com',
  midjourney: 'https://www.midjourney.com',
  chatgpt: 'https://chatgpt.com',
  'openai chatgpt': 'https://chatgpt.com',
};

/**
 * Common single-token typos → canonical product name used for resolve + search.
 * @type {Record<string, string>}
 */
const COMMON_TOOL_TYPOS = {
  pintrest: 'pinterest',
  pinterst: 'pinterest',
  pinteres: 'pinterest',
  notoin: 'notion',
  notoinso: 'notion',
  figam: 'figma',
  midjounrey: 'midjourney',
  chatgbt: 'chatgpt',
  chatgtp: 'chatgpt',
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
 * @param {string} input
 */
function canonicalizeToolQuery(input) {
  const key = String(input || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const compact = key.replace(/\s+/g, '');
  const fixed = COMMON_TOOL_TYPOS[key] || COMMON_TOOL_TYPOS[compact];
  if (fixed) return fixed;
  return key;
}

/**
 * Resolve a product name or partial URL to an official homepage (HTTPS).
 * Falls back to a web search when the name is not in the known map.
 * @param {string} input
 */
export async function resolveToolHomepageUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('url_required');

  if (looksLikeHomepageUrl(raw)) {
    return assertPublicHttpUrl(normalizeToolUrl(raw));
  }

  const canonical = canonicalizeToolQuery(raw);
  const compact = canonical.replace(/\s+/g, '');
  const known = KNOWN_TOOL_HOMEPAGES[canonical] || KNOWN_TOOL_HOMEPAGES[compact];
  if (known) {
    // Known map entries are curated public https URLs — skip DNS (can wedge the long-lived server).
    return normalizeToolUrl(known);
  }

  const fromWeb = await searchOfficialHomepageUrl(canonical);
  if (fromWeb) return assertPublicHttpUrl(normalizeToolUrl(fromWeb));

  // Last resort for single-token product names: try www.<name>.com / .<name>.so
  const guessed = await guessHomepageFromName(canonical);
  if (guessed) return assertPublicHttpUrl(normalizeToolUrl(guessed));

  throw new Error(`could_not_resolve_url for "${raw}" (provide full https URL)`);
}

/**
 * @param {string} productName
 */
async function guessHomepageFromName(productName) {
  const token = String(productName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (!token || token.length < 2 || token.length > 32) return '';
  const candidates = [
    `https://www.${token}.com`,
    `https://${token}.com`,
    `https://www.${token}.so`,
    `https://${token}.io`,
    `https://www.${token}.io`,
  ];
  // Probe in parallel — sequential 6s timeouts made typos feel endless.
  const results = await Promise.all(candidates.map((url) => probeHomepageReachable(url)));
  const hit = candidates.find((_, i) => results[i]);
  return hit || '';
}

/**
 * @param {string} url
 */
async function probeHomepageReachable(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6_000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    return r.ok || (r.status >= 300 && r.status < 400);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search the web for a tool by name; return a preview of the match + alternatives
 * (not yet in the library) so the UI can offer Add.
 * Preview path stays light: no Playwright screenshots, no rating/pricing LLM.
 * Full enrich + images run when the user imports selected rows.
 * @param {string} query
 */
export async function searchToolOnline(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query_required');
  const started = Date.now();
  const deadline = started + SEARCH_ONLINE_BUDGET_MS;

  const homepage = await withDeadline(resolveToolHomepageUrl(q), Math.min(deadline, started + 10_000));
  const host = safeHostname(homepage);
  const displayGuess = cleanToolName(canonicalizeToolQuery(q) || q);

  // Meta fetch is best-effort — known tools must not stall the whole search.
  let meta = {
    title: displayGuess,
    description: '',
    host,
    htmlSnippet: '',
  };
  try {
    meta = await withDeadline(fetchPageMeta(homepage), Math.min(deadline, Date.now() + 8_000));
  } catch {
    /* stub meta */
  }

  const enriched = enrichAlternativeCandidate({
    url: homepage,
    title: meta.title || displayGuess,
    description: meta.description,
    host: meta.host || host,
    html: meta.htmlSnippet,
  });

  const matched = {
    tempId: 'matched',
    name: enriched.name || displayGuess,
    bestUsedFor: enriched.bestUsedFor || '',
    url: homepage,
    website: homepage,
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
    source: 'search',
    isOriginal: false,
  };

  const existing = await loadToolLibrary();
  const alreadyInLibrary = existing.tools.some(
    (t) =>
      safeNormalize(t.url) === safeNormalize(homepage) ||
      safeHostname(t.url) === safeHostname(homepage) ||
      cleanToolName(t.name || '').toLowerCase() === cleanToolName(matched.name).toLowerCase(),
  );
  matched.alreadyInLibrary = alreadyInLibrary;

  /** @type {object[]} */
  let alternatives = [];
  const remainingMs = deadline - Date.now();
  // Prefer returning the match quickly; alternatives are best-effort within budget.
  if (remainingMs > 2_500) {
    const altDeadline = Math.min(deadline, Date.now() + Math.min(remainingMs, 12_000));
    try {
      alternatives = await findAlternatives(matched, {
        skipImages: true,
        deadline: altDeadline,
        maxAlternatives: MAX_SEARCH_ALTERNATIVES,
      });
    } catch {
      alternatives = [];
    }
  }
  const ranked = rankToolAmongAlternatives(matched, alternatives).filter(
    (r) => !isAppleOrMacOnlyTool(r),
  );
  const matchIsAppleOnly = isAppleOrMacOnlyTool(matched);
  const includeMatch = !matchIsAppleOnly && !alreadyInLibrary;
  const rankedOut = includeMatch
    ? [
        matched,
        ...ranked.filter((r) => safeNormalize(r.url) !== safeNormalize(homepage)),
      ]
    : ranked.filter((r) => safeNormalize(r.url) !== safeNormalize(homepage));

  console.info(
    '[tool-library] search-online',
    JSON.stringify({
      query: q,
      ms: Date.now() - started,
      matched: includeMatch ? matched.name : null,
      ranked: rankedOut.length,
    }),
  );

  return {
    query: q,
    matched: includeMatch ? matched : null,
    ranked: rankedOut,
  };
}

/**
 * @param {Promise<any>} promise
 * @param {number} deadline
 */
function withDeadline(promise, deadline) {
  const ms = Math.max(1, deadline - Date.now());
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('search_timeout')), ms);
    }),
  ]);
}

/**
 * @param {string} productName
 */
async function searchOfficialHomepageUrl(productName) {
  const name = String(productName || '').trim();
  if (!name) return '';
  const queries = [`${name} official site`, `${name} software`];
  for (const q of queries) {
    const [ddg, yahoo] = await Promise.all([
      searchDuckDuckGoHomepageCandidates(q),
      searchYahooHomepageCandidates(q),
    ]);
    const pick = pickBestHomepageCandidate([...ddg, ...yahoo], name);
    if (pick) return pick;
  }
  return '';
}

/**
 * @param {string} query
 */
async function searchDuckDuckGoHomepageCandidates(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return [];
    const html = await r.text();
    return parseHomepageCandidatesFromDdg(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} query
 */
async function searchYahooHomepageCandidates(query) {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return [];
    const html = await r.text();
    return parseHomepageCandidatesFromYahoo(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} html
 */
function parseHomepageCandidatesFromDdg(html) {
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
    if (!host || isAggregatorHost(host) || isLikelyContentPage(normalized, title)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    results.push({ url: normalized, title });
    if (results.length >= 12) break;
  }
  return results;
}

/**
 * @param {string} html
 */
function parseHomepageCandidatesFromYahoo(html) {
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = decodeHtmlEntities(m[1]);
    try {
      const u = new URL(href);
      if (u.hostname.includes('yahoo.') || u.hostname.includes('bing.')) {
        const ru = u.searchParams.get('RU') || u.searchParams.get('u');
        if (ru) href = decodeURIComponent(ru);
      }
    } catch {
      continue;
    }
    const title = decodeHtmlEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    const normalized = safeNormalize(href);
    if (!normalized) continue;
    const host = safeHostname(normalized);
    if (!host || isAggregatorHost(host) || isLikelyContentPage(normalized, title)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    results.push({ url: normalized, title });
    if (results.length >= 12) break;
  }
  return results;
}

/**
 * @param {{url:string,title:string}[]} candidates
 * @param {string} productName
 */
function pickBestHomepageCandidate(candidates, productName) {
  if (!candidates?.length) return '';
  const tokens = String(productName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const compact = tokens.join('');
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const host = safeHostname(c.url);
    const title = String(c.title || '').toLowerCase();
    const hostCore = host.split('.')[0] || '';
    let score = 0;
    if (compact && hostCore.includes(compact)) score += 8;
    if (compact && title.replace(/\s+/g, '').includes(compact)) score += 6;
    // Typo tolerance: "pintrest" ≈ "pinterest"
    if (compact && hostCore && editDistance(compact, hostCore) <= 2) score += 7;
    if (compact && title) {
      const titleCompact = title.replace(/[^a-z0-9]+/g, '');
      if (titleCompact && editDistance(compact, titleCompact.slice(0, compact.length + 2)) <= 2) {
        score += 5;
      }
    }
    for (const t of tokens) {
      if (hostCore.includes(t)) score += 3;
      if (title.includes(t)) score += 2;
    }
    // Prefer short marketing homepages over deep product paths slightly
    try {
      const pathLen = new URL(c.url).pathname.replace(/\/$/, '').length;
      if (pathLen <= 1) score += 2;
      else if (pathLen < 40) score += 1;
    } catch {
      /* ignore */
    }
    if (score > bestScore) {
      bestScore = score;
      best = c.url;
    }
  }
  return bestScore >= 3 ? best : '';
}

/**
 * Levenshtein distance for short product-name / host tokens.
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  if (Math.abs(s.length - t.length) > 3) return 99;
  const rows = s.length + 1;
  const cols = t.length + 1;
  /** @type {number[]} */
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    /** @type {number[]} */
    const cur = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * @param {{ url: string, title: string, description: string, host: string, html?: string }} scrape
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
  const [rated, pricing] = await Promise.all([
    fetchToolRating(name).catch(() => null),
    resolveToolPricing({
      name,
      description: desc,
      url: scrape.url,
      host: scrape.host,
      html: scrape.html || '',
    }).catch(() => unknownPricing()),
  ]);
  return {
    name,
    bestUsedFor: desc.slice(0, 320),
    pricing,
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
 * @param {{
 *   onProgress?: (info: { phase: string, checked?: number, found?: number, total?: number }) => void | Promise<void>,
 *   skipImages?: boolean,
 *   deadline?: number,
 *   maxAlternatives?: number,
 * }} [opts]
 */
export async function findAlternatives(tool, opts = {}) {
  const webAlternatives = await findWebAlternatives(tool, opts);
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
 * @param {{
 *   onProgress?: (info: { phase: string, checked?: number, found?: number, total?: number }) => void | Promise<void>,
 *   skipImages?: boolean,
 *   deadline?: number,
 *   maxAlternatives?: number,
 * }} [opts]
 */
async function findWebAlternatives(tool, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const skipImages = Boolean(opts.skipImages);
  const deadline = Number(opts.deadline) > 0 ? Number(opts.deadline) : 0;
  const maxOut = Math.max(
    1,
    Math.min(MAX_SEARCH_ALTERNATIVES, Number(opts.maxAlternatives) || MAX_SEARCH_ALTERNATIVES),
  );
  await onProgress?.({ phase: 'searching' });
  const candidates = await searchAlternativeUrls(tool);
  if (!candidates.length) {
    await onProgress?.({ phase: 'done', checked: 0, found: 0, total: 0 });
    return [];
  }
  await onProgress?.({ phase: 'checking', checked: 0, found: 0, total: candidates.length });
  const existing = await loadToolLibrary();
  const existingUrls = new Set(existing.tools.map((t) => safeNormalize(t.url)).filter(Boolean));
  const existingHosts = new Set(existing.tools.map((t) => safeHostname(t.url)).filter(Boolean));
  const existingNames = new Set(
    existing.tools.map((t) => cleanToolName(t.name || '').toLowerCase()).filter(Boolean),
  );
  const out = [];
  const seenHosts = new Set();
  let checked = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    if (deadline && Date.now() > deadline) break;
    const candidate = candidates[i];
    try {
      const resolvedUrl = normalizeToolUrl(candidate.url);
      const resolvedHost = safeHostname(resolvedUrl);
      if (existingUrls.has(safeNormalize(resolvedUrl))) continue;
      if (resolvedHost && existingHosts.has(resolvedHost)) continue;
      if (resolvedHost && seenHosts.has(resolvedHost)) continue;
      if (
        resolvedHost === 'apple.com' ||
        resolvedHost.endsWith('.apple.com') ||
        resolvedHost === 'apps.apple.com' ||
        resolvedHost === 'developer.apple.com' ||
        resolvedHost === 'itunes.apple.com'
      ) {
        continue;
      }
      checked += 1;
      await onProgress?.({
        phase: 'checking',
        checked,
        found: out.length,
        total: candidates.length,
      });
      const meta = deadline
        ? await withDeadline(fetchPageMeta(resolvedUrl), deadline)
        : await fetchPageMeta(resolvedUrl);
      if (isBlockedPage({ ...meta, html: meta.htmlSnippet })) continue;
      const enriched = enrichAlternativeCandidate({
        url: resolvedUrl,
        title: meta.title || candidate.title,
        description: meta.description,
        host: meta.host,
        html: meta.htmlSnippet,
      });
      const displayName = cleanToolName(
        candidate.title || enriched.name || meta.title || candidate.url,
      );
      const resolvedName = displayName.toLowerCase();
      if (!resolvedName || existingNames.has(resolvedName)) continue;
      if (isJunkAlternativeName(displayName)) continue;
      const candidateRow = {
        name: displayName,
        url: resolvedUrl,
        bestUsedFor: enriched.bestUsedFor || meta.description || '',
        operatingSystems: enriched.operatingSystems || ['Web'],
      };
      if (isAppleOrMacOnlyTool(candidateRow)) continue;
      let logoUrl = '';
      let snapshotUrl = '';
      if (!skipImages) {
        const images = await importToolImages(assetIdForUrl(resolvedUrl), resolvedUrl, meta).catch(
          () => ({ logoPath: '', snapshotPath: '' }),
        );
        logoUrl = images.logoPath || '';
        snapshotUrl = images.snapshotPath || '';
      }
      if (resolvedHost) seenHosts.add(resolvedHost);
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
        logoUrl,
        snapshotUrl,
        source: 'web',
      });
      await onProgress?.({
        phase: 'checking',
        checked,
        found: out.length,
        total: candidates.length,
      });
    } catch {
      // Skip candidates we cannot resolve or fetch.
    }
    if (out.length >= maxOut) break;
  }
  await onProgress?.({
    phase: 'done',
    checked,
    found: out.length,
    total: candidates.length,
  });
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
  const timer = setTimeout(() => ac.abort(), 8_000);
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
  const timer = setTimeout(() => ac.abort(), 8_000);
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
  const cats = new Set(
    [...(tool?.categories || []), ...(tool?.tags || [])].map((c) => String(c).toLowerCase()),
  );
  const inferred = inferToolCategories({
    name: tool?.name || '',
    description: tool?.bestUsedFor || tool?.summary || '',
    url: tool?.url || tool?.website || '',
  }).map((c) => String(c).toLowerCase());
  for (const c of inferred) cats.add(c);

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
  if (
    cats.has('notes') ||
    cats.has('project mgmt') ||
    cats.has('writing') ||
    /\b(notion|obsidian|evernote|coda|roam|logseq|confluence|clickup|airtable|craft)\b/i.test(name)
  ) {
    return NOTES_TOOL_SEEDS;
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
  const seenUrl = new Set();
  const seenHost = new Set();
  const out = [];
  for (const row of rows) {
    const normalized = safeNormalize(row?.url || '');
    if (!normalized || seenUrl.has(normalized)) continue;
    const host = safeHostname(normalized);
    if (host && seenHost.has(host)) continue;
    seenUrl.add(normalized);
    if (host) seenHost.add(host);
    out.push({ title: String(row?.title || '').trim(), url: normalized });
  }
  return out;
}

/**
 * Category labels for the source tool (tags + inferred from name/url).
 * @param {object} tool
 */
function sourceToolCategories(tool) {
  const fromFields = [
    ...(Array.isArray(tool?.categories) ? tool.categories : []),
    ...(Array.isArray(tool?.tags) ? tool.tags : []),
  ]
    .map((c) => String(c || '').trim().toLowerCase())
    .filter(Boolean);
  const inferred = inferToolCategories({
    name: tool?.name || '',
    description: tool?.bestUsedFor || tool?.summary || '',
    url: tool?.url || tool?.website || '',
  }).map((c) => String(c).toLowerCase());
  return new Set([...fromFields, ...inferred]);
}

/** Categories that count as the same product family for alternatives. */
const CATEGORY_FAMILIES = [
  new Set(['3d modeling']),
  new Set(['video']),
  new Set(['audio', 'audio-only']),
  new Set(['notes', 'writing', 'project mgmt', 'communication']),
  new Set(['design']),
  new Set(['development', 'automation', 'AI']),
];

/**
 * @param {Set<string>} cats
 * @returns {Set<string>}
 */
function familyKeysFor(cats) {
  const keys = new Set();
  for (let i = 0; i < CATEGORY_FAMILIES.length; i += 1) {
    const fam = CATEGORY_FAMILIES[i];
    for (const c of cats) {
      if (fam.has(c)) keys.add(`fam:${i}`);
    }
  }
  for (const c of cats) keys.add(`cat:${c}`);
  return keys;
}

/**
 * Drop alternatives that clearly belong to a different product family
 * (e.g. SOLIDWORKS when searching Notion notes/docs tools).
 * @param {object} alt
 * @param {Set<string>} sourceCats
 */
function isCategoryCompatibleAlternative(alt, sourceCats) {
  if (!sourceCats.size) return true;
  const altCats = new Set(
    (alt.categories || []).map((c) => String(c || '').trim().toLowerCase()).filter(Boolean),
  );
  if (!altCats.size) {
    for (const c of inferToolCategories({
      name: alt.name || '',
      description: alt.bestUsedFor || '',
      url: alt.url || '',
    })) {
      altCats.add(String(c).toLowerCase());
    }
  }
  if (!altCats.size) return true;
  for (const c of altCats) {
    if (sourceCats.has(c)) return true;
  }
  // Exclusive families: CAD and video must not cross into other searches.
  const sourceIsCad = sourceCats.has('3d modeling');
  const altIsCad = altCats.has('3d modeling');
  if (altIsCad !== sourceIsCad) return false;
  const sourceIsVideo = sourceCats.has('video');
  const altIsVideo = altCats.has('video');
  if (altIsVideo !== sourceIsVideo) return false;
  // Related families (notes ↔ writing ↔ project mgmt) count as compatible.
  const sourceFam = familyKeysFor(sourceCats);
  const altFam = familyKeysFor(altCats);
  for (const k of altFam) {
    if (k.startsWith('fam:') && sourceFam.has(k)) return true;
  }
  // Notes/docs/productivity searches: keep generic tools (utilities/AI) that are
  // not in an exclusive CAD/video family — seed lists are already curated.
  if (sourceFam.has('fam:3') && !altIsCad && !altIsVideo) {
    const onlySoft = [...altCats].every((c) =>
      ['utilities', 'ai', 'automation', 'communication', 'notes', 'writing', 'project mgmt'].includes(c),
    );
    if (onlySoft) return true;
  }
  return false;
}

/**
 * @param {object[]} rows
 * @param {object} sourceTool
 */
function dedupeAlternatives(rows, sourceTool) {
  const seenUrls = new Set();
  const seenHosts = new Set();
  const seenNames = new Set();
  const sourceUrl = safeNormalize(sourceTool.url);
  const sourceHost = safeHostname(sourceTool.url);
  const sourceName = String(sourceTool.name || '').trim().toLowerCase();
  const sourceCats = sourceToolCategories(sourceTool);
  /** @type {object[]} */
  const out = [];
  for (const row of rows) {
    const rowUrl = safeNormalize(row.url);
    const rowHost = safeHostname(rowUrl);
    const rowName = String(row.name || '').trim().toLowerCase();
    if (!rowUrl) continue;
    if (sourceUrl && rowUrl === sourceUrl) continue;
    if (sourceHost && rowHost === sourceHost) continue;
    if (sourceName && rowName === sourceName) continue;
    if (seenUrls.has(rowUrl)) continue;
    if (rowHost && seenHosts.has(rowHost)) continue;
    if (rowName && seenNames.has(rowName)) continue;
    if (!isCategoryCompatibleAlternative(row, sourceCats)) continue;
    seenUrls.add(rowUrl);
    if (rowHost) seenHosts.add(rowHost);
    if (rowName) seenNames.add(rowName);
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
 * @param {{ url: string, title?: string, description?: string, host?: string, html?: string }} scrape
 */
function enrichAlternativeCandidate(scrape) {
  const name = cleanToolName(scrape.title || scrape.host || 'Tool');
  const desc = String(scrape.description || '').trim();
  return {
    name,
    bestUsedFor: desc.slice(0, 320),
    pricing: resolveToolPricingSync({
      name,
      description: desc,
      url: scrape.url,
      host: scrape.host,
      html: scrape.html || '',
    }),
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
 * Normalize an OS label for comparison.
 * @param {string} os
 */
function normalizeOsLabel(os) {
  return String(os || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * True when a tool is Apple/macOS-only (no non-Apple platforms).
 * Cross-platform tools that also support macOS are kept.
 * @param {object} tool
 */
export function isAppleOrMacOnlyTool(tool) {
  if (!tool) return false;
  const host = safeHostname(tool.url || tool.website || '');
  if (
    host === 'apple.com' ||
    host.endsWith('.apple.com') ||
    host === 'apps.apple.com' ||
    host === 'developer.apple.com' ||
    host === 'itunes.apple.com'
  ) {
    return true;
  }
  const name = String(tool.name || '').toLowerCase();
  if (
    /\bfinal\s*cut\b/.test(name) ||
    /\blogic\s*pro\b/.test(name) ||
    /\bxcode\b/.test(name) ||
    /\bgarageband\b/.test(name) ||
    /\bapple\s+(keynote|pages|numbers|motion|compressor)\b/.test(name)
  ) {
    return true;
  }
  const oss = (tool.operatingSystems || [])
    .map(normalizeOsLabel)
    .filter(Boolean);
  if (!oss.length) return false;
  const nonApple = oss.filter((o) => !APPLE_ONLY_OS.has(o));
  return nonApple.length === 0;
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
  if (/\bmac\s*os\b|\bmacos\b|\bos\s*x\b|\bmacintosh\b/.test(blob)) out.push('macOS');
  if (/\blinux\b|\bubuntu\b|\bappimage\b/.test(blob)) out.push('Linux');
  if (/\bios\b|\biphone\b|\bipad\b/.test(blob)) out.push('iOS');
  if (/\bandroid\b/.test(blob)) out.push('Android');
  if (host && (host === 'apple.com' || host.endsWith('.apple.com'))) {
    if (!out.includes('macOS') && !out.includes('iOS')) out.push('macOS');
  }
  return out.length ? [...new Set(out)] : ['Web'];
}
