/**
 * OpenRouter JSON enrichment for Tool Library entries.
 */
import { normalizeToolUrl, SEED_CATEGORIES } from './tool-library-store.js';

/** @type {Record<string, string>} */
const KNOWN_TOOL_HOMEPAGES = {
  'fusion 360': 'https://www.autodesk.com/products/fusion-360/overview',
  fusion360: 'https://www.autodesk.com/products/fusion-360/overview',
  'autodesk fusion 360': 'https://www.autodesk.com/products/fusion-360/overview',
};

/**
 * @param {string} system
 * @param {string} user
 */
async function chatJson(system, user) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('openrouter_not_configured');

  const model = process.env.TOOL_LIBRARY_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
      'X-Title': 'dashbird-tool-library',
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`openrouter_http_${r.status}: ${text.slice(0, 200)}`);
  }

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('openrouter_empty');
  return JSON.parse(content);
}

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

  const resolved = await chatJson(
    `You resolve software product names to their official marketing homepage. Reply with JSON only: { "url": string }.
Rules: HTTPS URL only; must be the vendor's primary product page (not app stores, Wikipedia, or review sites).`,
    `Product name: ${raw}`,
  );
  const url = String(resolved?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`could_not_resolve_url for "${raw}"`);
  }
  return normalizeToolUrl(url);
}

/**
 * @param {{ url: string, title: string, description: string, host: string }} scrape
 */
export async function enrichToolFromScrape(scrape) {
  const categories = SEED_CATEGORIES.join(', ');
  const system = `You research software tools for a personal tool library. Reply with JSON only.
Schema:
{
  "name": string,
  "bestUsedFor": string (1-2 sentences: what this tool is best used for — primary use case, ideal user, when to pick it over similar tools),
  "pricing": { "model": "free"|"freemium"|"subscription"|"one-time"|"enterprise"|"unknown", "lowestTier": string, "summary": string },
  "features": string[],
  "pros": string[],
  "cons": string[],
  "rating": number (0-5, one decimal),
  "operatingSystems": string[] (e.g. Web, macOS, Windows, Linux, iOS, Android),
  "categories": string[] (pick 1-4 from: ${categories}; add a new short label only if none fit)
}
Base ratings on public reputation and the site's positioning. Be concise.`;

  const user = `URL: ${scrape.url}
Host: ${scrape.host}
Page title: ${scrape.title}
Description: ${scrape.description || '(none)'}`;

  const raw = await chatJson(system, user);
  const rating = Number(raw.rating);
  return {
    name: String(raw.name || scrape.title || scrape.host).trim(),
    bestUsedFor: String(raw.bestUsedFor || '').trim().slice(0, 320),
    pricing: {
      model: String(raw.pricing?.model || 'unknown'),
      lowestTier: String(raw.pricing?.lowestTier || 'Unknown'),
      summary: String(raw.pricing?.summary || ''),
    },
    features: Array.isArray(raw.features) ? raw.features.map(String).slice(0, 12) : [],
    pros: Array.isArray(raw.pros) ? raw.pros.map(String).slice(0, 8) : [],
    cons: Array.isArray(raw.cons) ? raw.cons.map(String).slice(0, 8) : [],
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, Math.round(rating * 10) / 10)) : 3,
    operatingSystems: Array.isArray(raw.operatingSystems)
      ? raw.operatingSystems.map(String).slice(0, 8)
      : ['Web'],
    categories: Array.isArray(raw.categories)
      ? raw.categories.map((c) => String(c).trim()).filter(Boolean).slice(0, 5)
      : ['utilities'],
  };
}

/**
 * @param {object} tool
 */
export async function findAlternatives(tool) {
  const system = `You find software alternatives. Reply with JSON only.
Schema:
{
  "alternatives": [
    { "name": string, "url": string (homepage https URL), "bestUsedFor": string,
      "pricing": { "model": string, "lowestTier": string, "summary": string },
      "features": string[], "pros": string[], "cons": string[], "rating": number (0-5), "operatingSystems": string[], "categories": string[] }
  ]
}
Return exactly 5 well-known alternatives. Ratings reflect community consensus. URLs must be official product homepages.`;

  const user = `Tool: ${tool.name}
URL: ${tool.url}
Categories: ${(tool.categories || []).join(', ')}
Rating: ${tool.rating}
Pricing: ${tool.pricing?.summary || tool.pricing?.lowestTier}
Features: ${(tool.features || []).slice(0, 8).join('; ')}`;

  const raw = await chatJson(system, user);
  const alts = Array.isArray(raw.alternatives) ? raw.alternatives : [];
  return alts.slice(0, 5).map((a, i) => ({
    tempId: `alt-${i}`,
    name: String(a.name || '').trim(),
    bestUsedFor: String(a.bestUsedFor || '').trim().slice(0, 320),
    url: String(a.url || '').trim(),
    pricing: {
      model: String(a.pricing?.model || 'unknown'),
      lowestTier: String(a.pricing?.lowestTier || ''),
      summary: String(a.pricing?.summary || ''),
    },
    features: Array.isArray(a.features) ? a.features.map(String).slice(0, 10) : [],
    pros: Array.isArray(a.pros) ? a.pros.map(String).slice(0, 6) : [],
    cons: Array.isArray(a.cons) ? a.cons.map(String).slice(0, 6) : [],
    rating: Math.min(5, Math.max(0, Number(a.rating) || 3)),
    operatingSystems: Array.isArray(a.operatingSystems) ? a.operatingSystems.map(String) : [],
    categories: Array.isArray(a.categories) ? a.categories.map(String) : tool.categories || [],
    isOriginal: false,
  }));
}

/**
 * @param {object} tool
 * @param {object[]} alternatives
 */
export function rankToolAmongAlternatives(tool, alternatives) {
  const original = {
    tempId: 'original',
    name: tool.name,
    bestUsedFor: tool.bestUsedFor,
    url: tool.url,
    pricing: tool.pricing,
    features: tool.features,
    pros: tool.pros,
    cons: tool.cons,
    rating: tool.rating,
    operatingSystems: tool.operatingSystems,
    categories: tool.categories,
    logoUrl: tool.logoUrl,
    snapshotUrl: tool.snapshotUrl,
    isOriginal: true,
    toolId: tool.id,
  };

  const rows = [original, ...alternatives];
  rows.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return rows;
}
