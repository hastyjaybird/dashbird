/**
 * Detect software pricing from known maps, page HTML, search snippets, and OpenRouter.
 */

import { assertPublicHttpUrl } from './public-http-url.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** @typedef {{ model: string, lowestTier: string, summary: string }} ToolPricing */

/** @type {Record<string, ToolPricing>} */
const KNOWN_TOOL_PRICING = {
  freecad: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free and open source',
  },
  blender: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free and open source',
  },
  openscad: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free and open source',
  },
  shotcut: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free and open source',
  },
  openshot: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free and open source',
  },
  kdenlive: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free and open source',
  },
  onshape: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free plan + paid Professional',
  },
  'fusion 360': {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Personal-use free; paid commercial',
  },
  fusion360: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Personal-use free; paid commercial',
  },
  'autodesk fusion': {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Personal-use free; paid commercial',
  },
  'autodesk fusion 360': {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Personal-use free; paid commercial',
  },
  solidworks: {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Commercial subscription',
  },
  'solid edge': {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Community Edition free; paid commercial',
  },
  solidedge: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Community Edition free; paid commercial',
  },
  inventor: {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Autodesk subscription',
  },
  'autodesk inventor': {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Autodesk subscription',
  },
  catia: {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Enterprise / commercial licensing',
  },
  'rhino 3d': {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Perpetual license + service',
  },
  rhino: {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Perpetual license + service',
  },
  bricscad: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Lite free trial / paid editions',
  },
  sketchup: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free web plan + paid Pro',
  },
  'davinci resolve': {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free edition + paid Studio',
  },
  davinci: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free edition + paid Studio',
  },
  'adobe premiere pro': {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Adobe Creative Cloud subscription',
  },
  premiere: {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'Adobe Creative Cloud subscription',
  },
  'final cut pro': {
    model: 'paid',
    lowestTier: 'Paid',
    summary: 'One-time Mac App Store purchase',
  },
  hitfilm: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free Express + paid Pro',
  },
  figma: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free starter + paid seats',
  },
  notion: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free personal + paid teams',
  },
  slack: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free plan + paid Pro/Business',
  },
  discord: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free + Nitro paid',
  },
  vscode: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  'visual studio code': {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  cursor: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free Hobby + paid Pro',
  },
  github: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free public repos + paid plans',
  },
  gitlab: {
    model: 'freemium',
    lowestTier: 'Free',
    summary: 'Free tier + paid Premium/Ultimate',
  },
};

/**
 * @returns {ToolPricing}
 */
export function unknownPricing(summary = '') {
  return {
    model: 'unknown',
    lowestTier: 'Unknown',
    summary: String(summary || '').trim(),
  };
}

/**
 * @param {ToolPricing | null | undefined} pricing
 */
export function isUnknownPricing(pricing) {
  const model = String(pricing?.model || '').trim().toLowerCase();
  const tier = String(pricing?.lowestTier || '').trim().toLowerCase();
  const summary = String(pricing?.summary || '').trim().toLowerCase();
  if (!pricing || (!model && !tier && !summary)) return true;
  if (model === 'unknown' || model === '') return true;
  if (/^(unknown|--|n\/a|na|none)$/i.test(tier) && !summary) return true;
  if (/pricing not auto-detected|could not auto-detect pricing/i.test(summary)) return true;
  return false;
}

/**
 * @param {Partial<ToolPricing> | null | undefined} raw
 * @returns {ToolPricing}
 */
export function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object') return unknownPricing();
  const model = normalizeModel(raw.model);
  let lowestTier = String(raw.lowestTier || '').trim();
  let summary = String(raw.summary || '').trim();
  if (/^(unknown|--|n\/a|na|none)$/i.test(lowestTier)) lowestTier = '';
  if (/pricing not auto-detected|could not auto-detect pricing/i.test(summary)) summary = '';

  if (model === 'free' && !lowestTier) lowestTier = 'Free';
  if (model === 'freemium' && !lowestTier) lowestTier = 'Free';
  if (model === 'paid' && !lowestTier) lowestTier = 'Paid';
  if (model === 'open_source' && !lowestTier) {
    lowestTier = 'Free';
  }

  const finalModel = model === 'open_source' ? 'free' : model;
  if (!finalModel || finalModel === 'unknown') {
    if (/\bfree\b/i.test(lowestTier) || /\bfree\b/i.test(summary)) {
      return {
        model: /\b(paid|pro|premium|plus|team|business|enterprise)\b/i.test(`${lowestTier} ${summary}`)
          ? 'freemium'
          : 'free',
        lowestTier: lowestTier || 'Free',
        summary: summary || (lowestTier || 'Free'),
      };
    }
    if (lowestTier || summary) {
      return {
        model: 'paid',
        lowestTier: lowestTier || 'Paid',
        summary: summary || lowestTier || 'Paid',
      };
    }
    return unknownPricing();
  }

  return {
    model: finalModel,
    lowestTier: lowestTier || (finalModel === 'paid' ? 'Paid' : 'Free'),
    summary: summary || lowestTier || finalModel,
  };
}

/**
 * Resolve pricing for a tool using known map → HTML → pricing page → search → OpenRouter.
 * @param {{
 *   name?: string,
 *   description?: string,
 *   url?: string,
 *   host?: string,
 *   html?: string,
 * }} input
 * @returns {Promise<ToolPricing>}
 */
export async function resolveToolPricing(input) {
  const name = String(input?.name || '').trim();
  const description = String(input?.description || '').trim();
  const url = String(input?.url || '').trim();
  const html = String(input?.html || '');

  const known = lookupKnownPricing(name, url, input?.host);
  if (known) return known;

  const fromHome = detectPricingFromText(`${description}\n${html}`, { preferHtml: Boolean(html) });
  if (fromHome && !isUnknownPricing(fromHome)) return fromHome;

  const pricingPageHtml = url ? await fetchPricingPageHtml(url, html).catch(() => '') : '';
  if (pricingPageHtml) {
    const fromPricing = detectPricingFromText(pricingPageHtml, { preferHtml: true });
    if (fromPricing && !isUnknownPricing(fromPricing)) return fromPricing;
  }

  const fromSearch = name ? await fetchPricingViaSearch(name).catch(() => null) : null;
  if (fromSearch && !isUnknownPricing(fromSearch)) return fromSearch;

  const fromAi = name
    ? await fetchPricingViaOpenRouter(name, {
        description,
        url,
        htmlExcerpt: (pricingPageHtml || html).slice(0, 6000),
      }).catch(() => null)
    : null;
  if (fromAi && !isUnknownPricing(fromAi)) return fromAi;

  return unknownPricing();
}

/**
 * Sync/heuristic-only path for fast alternative rows.
 * @param {{ name?: string, description?: string, url?: string, host?: string, html?: string }} input
 * @returns {ToolPricing}
 */
export function resolveToolPricingSync(input) {
  const name = String(input?.name || '').trim();
  const known = lookupKnownPricing(name, input?.url, input?.host);
  if (known) return known;
  const blob = `${input?.description || ''}\n${input?.html || ''}`;
  const detected = detectPricingFromText(blob, { preferHtml: Boolean(input?.html) });
  if (detected && !isUnknownPricing(detected)) return detected;
  return unknownPricing();
}

/**
 * @param {string} name
 * @param {string} [url]
 * @param {string} [host]
 * @returns {ToolPricing | null}
 */
function lookupKnownPricing(name, url = '', host = '') {
  const keys = pricingLookupKeys(name, url, host);
  for (const key of keys) {
    const hit = KNOWN_TOOL_PRICING[key];
    if (hit) return normalizePricing(hit);
  }
  return null;
}

/**
 * @param {string} name
 * @param {string} [url]
 * @param {string} [host]
 */
function pricingLookupKeys(name, url = '', host = '') {
  const keys = [];
  const n = String(name || '')
    .toLowerCase()
    .replace(/®|™/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (n) {
    keys.push(n);
    keys.push(n.replace(/\s+/g, ''));
    // Drop trailing "software", "3d", version-ish tokens for broader match
    const short = n
      .replace(/\b(software|app|suite|pro|studio|edition|cad|cam)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (short && short !== n) {
      keys.push(short);
      keys.push(short.replace(/\s+/g, ''));
    }
  }
  try {
    const h = String(host || new URL(url).hostname || '')
      .replace(/^www\./, '')
      .toLowerCase();
    const core = h.split('.')[0] || '';
    if (core) keys.push(core);
  } catch {
    /* ignore */
  }
  return [...new Set(keys.filter(Boolean))];
}

/**
 * @param {string} text
 * @param {{ preferHtml?: boolean }} [opts]
 * @returns {ToolPricing | null}
 */
export function detectPricingFromText(text, opts = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const plain = opts.preferHtml ? htmlToPlainText(raw) : raw;
  const blob = plain.replace(/\s+/g, ' ').trim();
  if (!blob) return null;
  const lower = blob.toLowerCase();

  const dollar = extractLowestDollarPrice(blob);
  const hasFree = /\bfree\b/.test(lower);
  const hasOpenSource =
    /\bopen[-\s]?source\b/.test(lower) || /\bgpl\b/.test(lower) || /\bmit license\b/.test(lower);
  const hasFreemium =
    /\bfreemium\b/.test(lower) ||
    /\bfree (plan|tier|edition|version|forever)\b/.test(lower) ||
    /\bfree for (personal|hobby|individuals|students|community)\b/.test(lower) ||
    /\b(start|get) (for )?free\b/.test(lower) ||
    /\bno credit card\b/.test(lower);
  const hasPaid =
    /\b(paid|subscription|per seat|per user|per month|\/mo\b|\/month\b|pricing starts|starting at)\b/.test(
      lower,
    ) || Boolean(dollar);
  const hasEnterpriseOnly =
    /\benterprise only\b/.test(lower) || /\bcontact (us )?for pricing\b/.test(lower);

  if (hasOpenSource && hasFree && !dollar) {
    return normalizePricing({
      model: 'free',
      lowestTier: 'Free',
      summary: 'Free and open source',
    });
  }

  if (hasFree && (hasFreemium || hasPaid || dollar)) {
    return normalizePricing({
      model: 'freemium',
      lowestTier: 'Free',
      summary: dollar ? `Free plan; paid from ${dollar}` : 'Free plan available',
    });
  }

  if (hasFree && !hasPaid) {
    return normalizePricing({
      model: 'free',
      lowestTier: 'Free',
      summary: 'Free',
    });
  }

  if (dollar) {
    return normalizePricing({
      model: 'paid',
      lowestTier: dollar,
      summary: `From ${dollar}`,
    });
  }

  if (hasPaid || hasEnterpriseOnly) {
    return normalizePricing({
      model: 'paid',
      lowestTier: 'Paid',
      summary: hasEnterpriseOnly ? 'Contact for pricing' : 'Paid',
    });
  }

  // Schema.org Offer / price meta leftovers in HTML source
  const schemaPrice = raw.match(
    /"price"\s*:\s*"?(0|[0-9]+(?:\.[0-9]+)?)"?/i,
  );
  if (schemaPrice) {
    const n = Number(schemaPrice[1]);
    if (n === 0) {
      return normalizePricing({ model: 'free', lowestTier: 'Free', summary: 'Free' });
    }
    if (Number.isFinite(n) && n > 0) {
      const tier = `$${trimMoney(n)}`;
      return normalizePricing({ model: 'paid', lowestTier: tier, summary: `From ${tier}` });
    }
  }

  return null;
}

/**
 * @param {string} blob
 */
function extractLowestDollarPrice(blob) {
  const re =
    /\$\s*([0-9]{1,4}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:\/\s*(mo|month|yr|year|user|seat|device))?/gi;
  /** @type {{ amount: number, label: string }[]} */
  const hits = [];
  let m;
  while ((m = re.exec(blob))) {
    const amount = Number(String(m[1]).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50000) continue;
    const unit = String(m[2] || '').toLowerCase();
    let label = `$${trimMoney(amount)}`;
    if (unit === 'mo' || unit === 'month') label += '/mo';
    else if (unit === 'yr' || unit === 'year') label += '/yr';
    else if (unit === 'user' || unit === 'seat') label += '/user';
    hits.push({ amount, label });
  }
  if (!hits.length) return '';
  hits.sort((a, b) => a.amount - b.amount);
  return hits[0].label;
}

/**
 * @param {number} n
 */
function trimMoney(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * @param {string} html
 */
function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * @param {string} pageUrl
 * @param {string} homepageHtml
 */
async function fetchPricingPageHtml(pageUrl, homepageHtml) {
  const pricingUrl = findPricingPageUrl(homepageHtml, pageUrl);
  if (!pricingUrl) return '';
  try {
    const homeHost = new URL(pageUrl).hostname.replace(/^www\./, '');
    const priceHost = new URL(pricingUrl).hostname.replace(/^www\./, '');
    if (homeHost !== priceHost) return '';
  } catch {
    return '';
  }
  const safeUrl = await assertPublicHttpUrl(pricingUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(safeUrl, {
      signal: ac.signal,
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return '';
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 2_000_000) return '';
    return Buffer.from(buf).toString('utf8').slice(0, 100_000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} html
 * @param {string} pageUrl
 */
export function findPricingPageUrl(html, pageUrl) {
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  /** @type {{ url: string, score: number }[]} */
  const scored = [];
  while ((m = re.exec(html))) {
    const href = String(m[1] || '').trim();
    const label = htmlToPlainText(m[2] || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      continue;
    }
    let abs = '';
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    const path = abs.toLowerCase();
    let score = 0;
    if (/\/pricing\/?(\?|$)/i.test(path) || /[?&]pricing=/i.test(path)) score += 8;
    if (/\/plans?\/?(\?|$)/i.test(path)) score += 6;
    if (/\/buy\/?(\?|$)|\/store\/?(\?|$)|\/purchase\/?(\?|$)/i.test(path)) score += 4;
    if (/\bpricing\b/.test(label)) score += 7;
    if (/\bplans?\b/.test(label)) score += 4;
    if (/\bbuy\b|\bpurchase\b/.test(label)) score += 3;
    if (score > 0) scored.push({ url: abs, score });
  }
  if (!scored.length) {
    // Only guess /pricing when the homepage already mentions pricing/plans.
    const hint = String(html || '').toLowerCase();
    if (!/\bpricing\b|\bplans?\b|\bfree trial\b|\bfreemium\b/.test(hint)) return '';
    try {
      const base = new URL(pageUrl);
      return new URL('/pricing', `${base.protocol}//${base.host}`).toString();
    } catch {
      return '';
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

/**
 * @param {string} toolName
 * @returns {Promise<ToolPricing | null>}
 */
async function fetchPricingViaSearch(toolName) {
  const queries = [
    `${toolName} pricing free freemium`,
    `${toolName} pricing plans cost`,
    `${toolName} free plan OR open source`,
  ];
  for (const query of queries) {
    const hit = await searchYahooForPricing(query);
    if (hit && !isUnknownPricing(hit)) return hit;
  }
  return null;
}

/**
 * @param {string} query
 */
async function searchYahooForPricing(query) {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) return null;
    const html = await r.text();
    return detectPricingFromText(htmlToPlainText(html).slice(0, 20000));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} toolName
 * @param {{ description?: string, url?: string, htmlExcerpt?: string }} context
 * @returns {Promise<ToolPricing | null>}
 */
async function fetchPricingViaOpenRouter(toolName, context = {}) {
  const provider = String(process.env.TOOL_LIBRARY_AI_PROVIDER || 'openrouter').trim().toLowerCase();
  if (!provider || provider === 'none') return null;
  if (provider !== 'openrouter') return null;

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  const model = process.env.TOOL_LIBRARY_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
      'X-Title': 'dashbird-tool-library-pricing',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Return JSON only: { "model": "free"|"freemium"|"paid"|"unknown", "lowestTier": string, "summary": string }. ' +
            'lowestTier should be short UI text like "Free", "$12/mo", or "Paid". ' +
            'Use widely known public pricing for the software. If unsure, model "unknown" with empty strings.',
        },
        {
          role: 'user',
          content: [
            `Software: ${toolName}`,
            context.url ? `URL: ${context.url}` : '',
            context.description ? `Description: ${context.description.slice(0, 400)}` : '',
            context.htmlExcerpt ? `Page excerpt:\n${context.htmlExcerpt.slice(0, 4000)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    }),
  });

  if (!r.ok) return null;
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return null;
  const parsed = JSON.parse(content);
  const pricing = normalizePricing(parsed);
  return isUnknownPricing(pricing) ? null : pricing;
}

/**
 * @param {unknown} raw
 */
function normalizeModel(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (!s || s === 'unknown' || s === 'n_a' || s === 'na') return 'unknown';
  if (s === 'open_source' || s === 'opensource' || s === 'oss') return 'open_source';
  if (s === 'free' || s === 'freeware') return 'free';
  if (s === 'freemium' || s === 'free_tier' || s === 'free_plan') return 'freemium';
  if (s === 'paid' || s === 'subscription' || s === 'commercial' || s === 'premium') return 'paid';
  return 'unknown';
}
