/**
 * Detect software pricing from known maps, page HTML, search snippets, and OpenRouter.
 */

import { assertPublicHttpUrl } from './public-http-url.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** @typedef {{ model: string, lowestTier: string, summary: string }} ToolPricing */

/**
 * @param {string} [paidLabel]
 */
function freeTierLabel(paidLabel = '') {
  const paid = String(paidLabel || '').trim();
  if (!paid || /^free$/i.test(paid)) return 'Free';
  if (/^free\s*\//i.test(paid)) return paid.replace(/\s*\/\s*/, ' / ');
  return `Free / ${paid}`;
}

/** @type {Record<string, ToolPricing>} */
const KNOWN_TOOL_PRICING = {
  freecad: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  blender: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  openscad: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  shotcut: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  openshot: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  kdenlive: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  onshape: {
    model: 'free',
    lowestTier: freeTierLabel('$1,500/yr'),
    summary: freeTierLabel('$1,500/yr'),
  },
  'fusion 360': {
    model: 'free',
    lowestTier: freeTierLabel('$57/mo'),
    summary: freeTierLabel('$57/mo'),
  },
  fusion360: {
    model: 'free',
    lowestTier: freeTierLabel('$57/mo'),
    summary: freeTierLabel('$57/mo'),
  },
  'autodesk fusion': {
    model: 'free',
    lowestTier: freeTierLabel('$57/mo'),
    summary: freeTierLabel('$57/mo'),
  },
  'autodesk fusion 360': {
    model: 'free',
    lowestTier: freeTierLabel('$57/mo'),
    summary: freeTierLabel('$57/mo'),
  },
  solidworks: {
    model: 'paid',
    lowestTier: '$235/mo',
    summary: 'From $235/mo',
  },
  'solid edge': {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  solidedge: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  inventor: {
    model: 'paid',
    lowestTier: '$305/mo',
    summary: 'From $305/mo',
  },
  'autodesk inventor': {
    model: 'paid',
    lowestTier: '$305/mo',
    summary: 'From $305/mo',
  },
  catia: {
    model: 'paid',
    lowestTier: 'Contact for pricing',
    summary: 'Contact for pricing',
  },
  'rhino 3d': {
    model: 'paid',
    lowestTier: '$995',
    summary: 'From $995',
  },
  rhino: {
    model: 'paid',
    lowestTier: '$995',
    summary: 'From $995',
  },
  bricscad: {
    model: 'paid',
    lowestTier: '$625/yr',
    summary: 'From $625/yr',
  },
  sketchup: {
    model: 'free',
    lowestTier: freeTierLabel('$119/yr'),
    summary: freeTierLabel('$119/yr'),
  },
  'davinci resolve': {
    model: 'free',
    lowestTier: freeTierLabel('$295'),
    summary: freeTierLabel('$295'),
  },
  davinci: {
    model: 'free',
    lowestTier: freeTierLabel('$295'),
    summary: freeTierLabel('$295'),
  },
  'adobe premiere pro': {
    model: 'paid',
    lowestTier: '$22.99/mo',
    summary: 'From $22.99/mo',
  },
  premiere: {
    model: 'paid',
    lowestTier: '$22.99/mo',
    summary: 'From $22.99/mo',
  },
  'final cut pro': {
    model: 'paid',
    lowestTier: '$299',
    summary: 'From $299',
  },
  hitfilm: {
    model: 'free',
    lowestTier: 'Free',
    summary: 'Free',
  },
  figma: {
    model: 'free',
    lowestTier: freeTierLabel('$12/mo'),
    summary: freeTierLabel('$12/mo'),
  },
  notion: {
    model: 'free',
    lowestTier: freeTierLabel('$10/mo'),
    summary: freeTierLabel('$10/mo'),
  },
  slack: {
    model: 'free',
    lowestTier: freeTierLabel('$7.25/mo'),
    summary: freeTierLabel('$7.25/mo'),
  },
  discord: {
    model: 'free',
    lowestTier: freeTierLabel('$2.99/mo'),
    summary: freeTierLabel('$2.99/mo'),
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
    model: 'free',
    lowestTier: freeTierLabel('$20/mo'),
    summary: freeTierLabel('$20/mo'),
  },
  github: {
    model: 'free',
    lowestTier: freeTierLabel('$4/mo'),
    summary: freeTierLabel('$4/mo'),
  },
  gitlab: {
    model: 'free',
    lowestTier: freeTierLabel('$29/mo'),
    summary: freeTierLabel('$29/mo'),
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
 * True when stored pricing uses legacy freemium wording or needs display cleanup.
 * @param {ToolPricing | null | undefined} pricing
 * @param {{ name?: string, url?: string, host?: string, description?: string }} [ctx]
 */
export function needsPricingRewrite(pricing, ctx = {}) {
  if (isUnknownPricing(pricing)) return true;
  const model = String(pricing?.model || '').trim().toLowerCase();
  const tier = String(pricing?.lowestTier || '');
  const summary = String(pricing?.summary || '');
  if (model === 'freemium') return true;
  if (/\bfreemium\b/i.test(tier) || /\bfreemium\b/i.test(summary)) return true;
  // Bare "Paid" with no dollar amount — rewrite when we can find a lowest tier.
  if (model === 'paid' && (/^paid$/i.test(tier.trim()) || (!tier.trim() && /^paid$/i.test(summary.trim())))) {
    return true;
  }
  if (
    model === 'free' &&
    summary &&
    !/^free(\s*\/\s*\$[\d,.]+)?$/i.test(summary.trim()) &&
    /paid|professional|pro\b|commercial/i.test(summary)
  ) {
    return true;
  }
  // Bare "Free" when known map / sync has a second-tier price.
  if (model === 'free' && /^free$/i.test(tier.trim()) && (ctx.name || ctx.url)) {
    const known = resolveToolPricingSync({
      name: ctx.name,
      url: ctx.url,
      host: ctx.host,
      description: ctx.description,
    });
    if (known?.model === 'free' && /^free\s*\//i.test(String(known.lowestTier || ''))) return true;
  }
  return false;
}

/**
 * @param {Partial<ToolPricing> | null | undefined} raw
 * @returns {ToolPricing}
 */
export function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object') return unknownPricing();
  let model = normalizeModel(raw.model);
  let lowestTier = String(raw.lowestTier || '').trim();
  let summary = String(raw.summary || '').trim();
  if (/^(unknown|--|n\/a|na|none)$/i.test(lowestTier)) lowestTier = '';
  if (/pricing not auto-detected|could not auto-detect pricing/i.test(summary)) summary = '';
  // Never surface "freemium" — ongoing free tier counts as Free.
  if (model === 'freemium' || model === 'open_source') model = 'free';
  if (/\bfreemium\b/i.test(lowestTier)) lowestTier = freeTierLabel(extractPaidFromFreeLabel(lowestTier));
  if (/\bfreemium\b/i.test(summary)) summary = freeTierLabel(extractPaidFromFreeLabel(summary));

  if (model === 'free' && !lowestTier) lowestTier = 'Free';
  // Prefer leaving lowestTier empty over the bare word "Paid" so the UI can
  // show a real price once detection finds one.
  if (model === 'paid' && (!lowestTier || /^paid$/i.test(lowestTier))) {
    const fromSummary = String(summary || '').match(
      /\$\s*[\d,.]+(?:\s*\/\s*(?:mo|month|yr|year|user|seat))?/i,
    );
    lowestTier = fromSummary
      ? fromSummary[0].replace(/\s+/g, '').replace(/\/month/i, '/mo').replace(/\/year/i, '/yr')
      : '';
  }
  if (model === 'paid' && !summary) {
    summary = lowestTier ? `From ${lowestTier}` : '';
  }

  if (!model || model === 'unknown') {
    if (/^free\s*\/\s*\$/i.test(lowestTier) || /^free\s*\/\s*\$/i.test(summary)) {
      const label = freeTierLabel(extractPaidFromFreeLabel(lowestTier || summary));
      return { model: 'free', lowestTier: label, summary: label };
    }
    if (/^\$/.test(lowestTier) || /^from\s+\$/i.test(summary)) {
      return {
        model: 'paid',
        lowestTier: lowestTier || summary.replace(/^from\s+/i, '') || '',
        summary: summary || (lowestTier ? `From ${lowestTier}` : ''),
      };
    }
    if (/\bfree\b/i.test(lowestTier) || /\bfree\b/i.test(summary)) {
      const paid = extractPaidFromFreeLabel(lowestTier) || extractPaidFromFreeLabel(summary) || '';
      const label = freeTierLabel(paid);
      return { model: 'free', lowestTier: label, summary: label };
    }
    if (lowestTier || summary) {
      const dollarBit = String(lowestTier || summary).match(
        /\$\s*[\d,.]+(?:\s*\/\s*(?:mo|month|yr|year|user|seat))?/i,
      );
      const tier = dollarBit
        ? dollarBit[0].replace(/\s+/g, '').replace(/\/month/i, '/mo').replace(/\/year/i, '/yr')
        : /^paid$/i.test(lowestTier)
          ? ''
          : lowestTier;
      return {
        model: 'paid',
        lowestTier: tier,
        summary: summary || (tier ? `From ${tier}` : ''),
      };
    }
    return unknownPricing();
  }

  if (model === 'free') {
    const paid =
      extractPaidFromFreeLabel(lowestTier) ||
      extractPaidFromFreeLabel(summary) ||
      (String(/** @type {{ paidTier?: string }} */ (raw).paidTier || '').trim());
    const label = freeTierLabel(paid);
    return { model: 'free', lowestTier: label, summary: label };
  }

  return {
    model: 'paid',
    lowestTier: lowestTier || '',
    summary: summary || (lowestTier ? `From ${lowestTier}` : ''),
  };
}

/**
 * @param {string} text
 */
function extractPaidFromFreeLabel(text) {
  const s = String(text || '').trim();
  const m = s.match(/^free\s*\/\s*(\$\s*[\d,.]+(?:\s*\/\s*(?:mo|month|yr|year|user|seat))?)/i);
  if (m) return m[1].replace(/\s+/g, '').replace(/\/month/i, '/mo').replace(/\/year/i, '/yr');
  if (/^\$/.test(s)) return s;
  return '';
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
 * Ongoing free tier (personal/community/plan), not a time-limited trial.
 * @param {string} lower
 */
function hasOngoingFreeOffer(lower) {
  if (/\bfreemium\b/.test(lower)) return true;
  if (/\bopen[-\s]?source\b/.test(lower) || /\bgpl\b/.test(lower) || /\bmit license\b/.test(lower)) {
    return true;
  }
  if (/\bfree (plan|tier|edition|version|forever)\b/.test(lower)) return true;
  if (/\bfree for (personal|hobby|individuals|students|community|non[-\s]?commercial)\b/.test(lower)) {
    return true;
  }
  if (/\b(personal|hobby|community)[-\s]?(use|edition)\b.{0,24}\bfree\b/.test(lower)) return true;
  if (/\bfree\b.{0,24}\b(personal|hobby|community)[-\s]?(use|edition)\b/.test(lower)) return true;
  if (/\bcommunity edition\b/.test(lower)) return true;
  // Bare "free" that is not only a trial mention
  if (/\bfree\b/.test(lower) && !isTrialOnlyOffer(lower)) return true;
  return false;
}

/**
 * Free only as a trial — use paid lowest tier instead.
 * @param {string} lower
 */
function isTrialOnlyOffer(lower) {
  if (/\bfree (plan|tier|edition|version|forever)\b/.test(lower)) return false;
  if (/\bfree for (personal|hobby|individuals|students|community|non[-\s]?commercial)\b/.test(lower)) {
    return false;
  }
  if (/\bfreemium\b/.test(lower) || /\bopen[-\s]?source\b/.test(lower)) return false;
  return (
    /\bfree trial\b/.test(lower) ||
    /\b\d+[-\s]?day(?:s)? (?:free )?trial\b/.test(lower) ||
    /\bfree for \d+ days?\b/.test(lower) ||
    /\btry (it |for )?free\b/.test(lower) ||
    (/\btrial\b/.test(lower) && /\bfree\b/.test(lower) && !/\bfree (plan|tier|edition)\b/.test(lower))
  );
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
  const ongoingFree = hasOngoingFreeOffer(lower);
  const trialOnly = isTrialOnlyOffer(lower);
  const hasPaid =
    /\b(paid|subscription|per seat|per user|per month|\/mo\b|\/month\b|pricing starts|starting at)\b/.test(
      lower,
    ) || Boolean(dollar);
  const hasEnterpriseOnly =
    /\benterprise only\b/.test(lower) || /\bcontact (us )?for pricing\b/.test(lower);

  // Personal / community / free plan → Free, plus cheapest paid tier when known.
  if (ongoingFree) {
    return normalizePricing({
      model: 'free',
      lowestTier: freeTierLabel(dollar || ''),
      summary: freeTierLabel(dollar || ''),
      paidTier: dollar || '',
    });
  }

  // Trial-only → cheapest paid tier when known.
  if (trialOnly) {
    if (dollar) {
      return normalizePricing({
        model: 'paid',
        lowestTier: dollar,
        summary: `From ${dollar}`,
      });
    }
    return normalizePricing({
      model: 'paid',
      lowestTier: '',
      summary: '',
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
      lowestTier: '',
      summary: hasEnterpriseOnly ? 'Contact for pricing' : '',
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
            'Return JSON only: { "model": "free"|"paid"|"unknown", "lowestTier": string, "summary": string }. ' +
            'Rules: If there is an ongoing free plan/edition/personal-use tier, model is "free". ' +
            'When free AND a paid tier exists, lowestTier must be "Free / $X/mo" (or /yr) using the cheapest paid tier — never say freemium. ' +
            'If free with no paid tier (open source only), lowestTier is "Free". ' +
            'If the only free option is a time-limited trial, model is "paid" and lowestTier is the cheapest paid price (e.g. "$12/mo"). ' +
            'If unsure, model "unknown" with empty strings.',
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
  if (s === 'open_source' || s === 'opensource' || s === 'oss') return 'free';
  if (s === 'free' || s === 'freeware') return 'free';
  // Legacy / AI "freemium" → free (ongoing free tier).
  if (s === 'freemium' || s === 'free_tier' || s === 'free_plan') return 'free';
  if (s === 'paid' || s === 'subscription' || s === 'commercial' || s === 'premium') return 'paid';
  return 'unknown';
}
