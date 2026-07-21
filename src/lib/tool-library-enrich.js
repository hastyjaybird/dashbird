/**
 * Add a tool: scrape → images → local metadata.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  addTool,
  loadToolLibrary,
  newToolId,
  saveToolLibrary,
  toolLibraryAssetsDir,
} from './tool-library-store.js';
import { enrichToolFromScrape, resolveToolHomepageUrl } from './tool-library-ai.js';
import { inferToolCategories } from './tool-library-categories.js';
import { fetchToolRating } from './tool-library-ratings.js';
import { fetchPageMeta, importToolImages } from './tool-library-scrape.js';
import { toolRecordToResource, upsertResource } from './web-catalog-store.js';
import { isUnknownPricing, needsPricingRewrite, resolveToolPricing, resolveToolPricingSync, unknownPricing } from './tool-library-pricing.js';
import { openRouterChatJson } from './openrouter-chat-json.js';

/**
 * @param {string} urlInput
 */
export async function createToolFromUrl(urlInput) {
  const url = await resolveToolHomepageUrl(urlInput);
  const existing = await loadToolLibrary();
  if (existing.tools.some((t) => t.url === url)) {
    throw new Error('tool_already_exists');
  }
  const id = newToolId();
  const meta = await fetchPageMeta(url);
  const [ai, images] = await Promise.all([
    enrichToolFromScrape({
      url,
      title: meta.title,
      description: meta.description,
      host: meta.host,
      html: meta.htmlSnippet,
    }).catch((e) => {
      console.warn('[tool-library] enrich failed:', e?.message || e);
      return {
        name: meta.title || meta.host,
        bestUsedFor: meta.description || '',
        pricing: unknownPricing(),
        features: [],
        pros: [],
        cons: [],
        rating: null,
        ratingSource: '',
        operatingSystems: ['Web'],
        categories: inferToolCategories({
          name: meta.title,
          description: meta.description,
          url,
          host: meta.host,
        }),
      };
    }),
    importToolImages(id, url, meta).catch(() => ({ logoPath: '', snapshotPath: '' })),
  ]);

  const tool = {
    id,
    url,
    website: url,
    name: ai.name,
    bestUsedFor: ai.bestUsedFor || '',
    pricing: ai.pricing,
    features: ai.features,
    pros: ai.pros,
    cons: ai.cons,
    rating: ai.rating ?? null,
    ratingSource: ai.ratingSource || '',
    operatingSystems: ai.operatingSystems,
    categories: ai.categories,
    logoUrl: images.logoPath || '',
    snapshotUrl: images.snapshotPath || '',
    addedAt: new Date().toISOString(),
  };

  await addTool(tool);
  try {
    await upsertResource(toolRecordToResource(tool), { project: 'dashbird', section: 'Tools' });
  } catch (e) {
    console.warn('[tool-library] catalog sync failed:', e?.message || e);
  }
  return tool;
}

/**
 * Refresh metadata, categories, ratings, and images for an existing tool.
 * @param {string} toolId
 */
export async function refreshToolAssets(toolId) {
  const data = await loadToolLibrary();
  const idx = data.tools.findIndex((t) => t.id === toolId);
  if (idx < 0) throw new Error('not_found');
  const current = data.tools[idx];
  const url = current.url;
  const meta = await fetchPageMeta(url);
  const [ai, images] = await Promise.all([
    enrichToolFromScrape({
      url,
      title: meta.title,
      description: meta.description,
      host: meta.host,
      html: meta.htmlSnippet,
    }).catch(async () => {
      const g2 = await fetchToolRating(current.name).catch(() => null);
      return {
        name: current.name,
        bestUsedFor: meta.description || current.bestUsedFor || '',
        pricing: current.pricing,
        features: current.features || [],
        pros: current.pros || [],
        cons: current.cons || [],
        rating: g2?.rating ?? null,
        ratingSource: g2?.source || '',
        operatingSystems: current.operatingSystems || ['Web'],
        categories: inferToolCategories({
          name: current.name,
          description: meta.description || current.bestUsedFor,
          url,
          host: meta.host,
        }),
      };
    }),
    importToolImages(toolId, url, meta).catch(() => ({
      logoPath: current.logoUrl || '',
      snapshotPath: current.snapshotUrl || '',
    })),
  ]);

  const nextPricing =
    ai.pricing && !isUnknownPricing(ai.pricing)
      ? ai.pricing
      : current.pricing && !isUnknownPricing(current.pricing)
        ? current.pricing
        : ai.pricing || current.pricing || unknownPricing();

  const updated = {
    ...current,
    name: ai.name || current.name,
    bestUsedFor: ai.bestUsedFor || current.bestUsedFor || '',
    pricing: nextPricing,
    features: Array.isArray(ai.features) && ai.features.length ? ai.features : current.features || [],
    pros: Array.isArray(ai.pros) && ai.pros.length ? ai.pros : current.pros || [],
    cons: Array.isArray(ai.cons) && ai.cons.length ? ai.cons : current.cons || [],
    rating: ai.rating ?? null,
    ratingSource: ai.ratingSource || '',
    operatingSystems: ai.operatingSystems?.length ? ai.operatingSystems : current.operatingSystems,
    categories: ai.categories?.length ? ai.categories : current.categories,
    logoUrl: images.logoPath || current.logoUrl || '',
    snapshotUrl: images.snapshotPath || current.snapshotUrl || '',
  };
  data.tools[idx] = updated;
  await saveToolLibrary(data);
  try {
    await upsertResource(toolRecordToResource(updated), { project: 'dashbird', section: 'Tools' });
  } catch (e) {
    console.warn('[tool-library] catalog sync failed:', e?.message || e);
  }
  return updated;
}

function isBlankStr(value) {
  return !String(value || '').trim();
}

function isEmptyArr(value) {
  return !Array.isArray(value) || value.length === 0;
}

/**
 * True only for real finite numbers (or numeric strings). Guards against the
 * `Number(null) === 0` / `Number('') === 0` trap that treats a blank rating as present.
 */
function isFiniteNum(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') return Number.isFinite(Number(value));
  return false;
}

function cleanStrArray(value, max = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Resolve to `fallback` if the promise rejects or does not settle within `ms`. */
function withSoftTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

/**
 * LLM-backed research for the fields the scrape/heuristics could not resolve.
 * Returns {} when OpenRouter is unavailable so callers degrade to scrape-only.
 * @param {{ name: string, url: string, description?: string }} input
 * @param {number} [timeoutMs]
 */
async function llmEnrichTool(input, timeoutMs = 30_000) {
  const sys =
    'You are a software-tool research assistant. Respond ONLY with a strict JSON object. ' +
    'Base answers on well-known public facts; when unsure use null or an empty array rather than guessing specifics.';
  const user = [
    'Research this software tool and return JSON.',
    `Name: ${input.name || '(unknown)'}`,
    `Website: ${input.url}`,
    input.description ? `Known description: ${input.description}` : '',
    '',
    'Return exactly this shape:',
    '{',
    '  "description": string,   // one sentence on what it is best used for (<=280 chars)',
    '  "pricing": { "model": "free"|"freemium"|"paid"|"unknown", "lowestTier": string, "summary": string },',
    '  "rating": number|null,   // approximate 0-5 rating for well-known tools (best estimate ok); null only if truly unknown',
    '  "ratingSource": string,  // "G2"/"Capterra" if from a known aggregator, otherwise "estimate"',
    '  "operatingSystems": string[],',
    '  "categories": string[],',
    '  "features": string[],    // up to 6 concise features',
    '  "pros": string[],        // up to 4',
    '  "cons": string[]         // up to 4',
    '}',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const res = await openRouterChatJson(
    process.env,
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    {
      timeoutMs: Math.min(timeoutMs, 15_000),
      // Interactive "Search deeper": a full multi-field JSON is too slow on the free
      // models, so lead with the cheap+fast gpt-4o-mini and keep a free fallback.
      models: ['openai/gpt-4o-mini', 'google/gemma-4-26b-a4b-it:free'],
      backoff429: false,
      ignoreRateLimit: true,
    },
  ).catch((e) => ({ ok: false, error: String(e?.message || e) }));

  if (!res?.ok || !res.parsed || typeof res.parsed !== 'object') {
    if (res?.error && res.error !== 'openrouter_not_configured') {
      console.warn('[tool-library] enrich-missing LLM failed:', res.error);
    }
    return {};
  }
  const p = res.parsed;
  const model = ['free', 'freemium', 'paid', 'unknown'].includes(
    String(p.pricing?.model || '').toLowerCase(),
  )
    ? String(p.pricing.model).toLowerCase()
    : 'unknown';
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  return {
    bestUsedFor: description,
    pricing:
      p.pricing && typeof p.pricing === 'object'
        ? {
            model,
            lowestTier: String(p.pricing.lowestTier || '').trim(),
            summary: String(p.pricing.summary || '').trim(),
          }
        : null,
    rating: Number.isFinite(Number(p.rating)) ? Math.max(0, Math.min(5, Number(p.rating))) : null,
    ratingSource: typeof p.ratingSource === 'string' ? p.ratingSource.trim() : '',
    operatingSystems: cleanStrArray(p.operatingSystems),
    categories: cleanStrArray(p.categories),
    features: cleanStrArray(p.features, 6),
    pros: cleanStrArray(p.pros, 4),
    cons: cleanStrArray(p.cons, 4),
  };
}

/**
 * Deep research using a tool's current (possibly just-edited) info, filling ONLY the
 * fields that are still blank. Prioritizes rating, pricing, and description, and falls
 * back to an LLM for gaps the scrape/heuristics cannot resolve. Does not persist —
 * returns the merged record plus the list of fields filled so the caller can let the
 * user review before saving.
 * @param {object} current Current tool values (saved record overlaid with in-progress edits).
 * @returns {Promise<{ tool: object, filled: string[] }>}
 */
export async function fillMissingToolFields(current = {}) {
  const url = String(current.url || current.website || '').trim();
  if (!url) throw new Error('url_required');

  const stubMeta = { title: '', description: '', host: '', htmlSnippet: '' };
  const meta = await withSoftTimeout(fetchPageMeta(url), 8_000, stubMeta);
  const research =
    (await withSoftTimeout(
      enrichToolFromScrape({
        url,
        title: current.name || meta.title,
        description: current.bestUsedFor || meta.description,
        host: meta.host,
        html: meta.htmlSnippet,
      }),
      12_000,
      null,
    )) || {};

  // Rating is a priority field: fall back to the dedicated ratings service using the
  // updated name when the scrape enrichment could not resolve a numeric rating.
  let scrapeRating = research.rating;
  let scrapeRatingSource = research.ratingSource;
  if (!isFiniteNum(scrapeRating)) {
    const nameForRating = current.name || research.name || '';
    if (nameForRating) {
      const rated = await withSoftTimeout(fetchToolRating(nameForRating), 6_000, null);
      if (rated && isFiniteNum(rated.rating)) {
        scrapeRating = rated.rating;
        scrapeRatingSource = rated.source || scrapeRatingSource;
      }
    }
  }

  // Which blanks remain after the scrape pass? Only then is the LLM worth calling.
  const pricingMissing =
    !current.pricing ||
    isUnknownPricing(current.pricing) ||
    (isBlankStr(current.pricing.lowestTier) && isBlankStr(current.pricing.summary));
  const scrapePricingOk = research.pricing && !isUnknownPricing(research.pricing);
  const needsLlm =
    (isBlankStr(current.bestUsedFor) && isBlankStr(research.bestUsedFor) && isBlankStr(meta.description)) ||
    (pricingMissing && !scrapePricingOk) ||
    (!isFiniteNum(current.rating) && !isFiniteNum(scrapeRating)) ||
    (isEmptyArr(current.categories) && isEmptyArr(research.categories)) ||
    (isEmptyArr(current.operatingSystems) && isEmptyArr(research.operatingSystems)) ||
    (isEmptyArr(current.features)) ||
    (isEmptyArr(current.pros)) ||
    (isEmptyArr(current.cons));

  const ai = needsLlm
    ? await withSoftTimeout(
        llmEnrichTool({
          name: current.name || research.name || meta.title,
          url,
          description: current.bestUsedFor || research.bestUsedFor || meta.description,
        }),
        16_000,
        {},
      )
    : {};

  // Resolve each field: prefer the scrape value, then the LLM value.
  const resolvedRatingFromScrape = isFiniteNum(scrapeRating);
  const resolvedRating = resolvedRatingFromScrape ? scrapeRating : ai.rating;
  const resolvedRatingSource = resolvedRatingFromScrape
    ? scrapeRatingSource
    : ai.ratingSource || (isFiniteNum(ai.rating) ? 'estimate' : '');
  const resolvedPricing = scrapePricingOk
    ? research.pricing
    : ai.pricing && !isUnknownPricing(ai.pricing)
      ? ai.pricing
      : null;

  const merged = { ...current };
  /** @type {string[]} */
  const filled = [];
  const fill = (field, missing, value, valid = (v) => v != null) => {
    if (!missing || !valid(value)) return;
    merged[field] = value;
    filled.push(field);
  };
  const nonEmptyStr = (v) => Boolean(String(v || '').trim());
  const nonEmptyArr = (v) => Array.isArray(v) && v.length > 0;
  const firstArr = (...arrs) => arrs.find((a) => Array.isArray(a) && a.length) || [];

  // Priority fields first: description, pricing, rating.
  fill(
    'bestUsedFor',
    isBlankStr(current.bestUsedFor),
    research.bestUsedFor || meta.description || ai.bestUsedFor,
    nonEmptyStr,
  );
  fill('pricing', pricingMissing, resolvedPricing, (v) => v && !isUnknownPricing(v));
  fill('rating', !isFiniteNum(current.rating), resolvedRating, isFiniteNum);
  // Only attribute a source when we actually resolved a numeric rating.
  fill(
    'ratingSource',
    isBlankStr(current.ratingSource) && isFiniteNum(merged.rating),
    resolvedRatingSource,
    nonEmptyStr,
  );

  // Secondary fields.
  fill('name', isBlankStr(current.name), research.name || meta.title || ai.name, nonEmptyStr);
  fill(
    'categories',
    isEmptyArr(current.categories),
    firstArr(research.categories, ai.categories),
    nonEmptyArr,
  );
  fill(
    'operatingSystems',
    isEmptyArr(current.operatingSystems),
    firstArr(research.operatingSystems, ai.operatingSystems),
    nonEmptyArr,
  );
  fill('features', isEmptyArr(current.features), firstArr(research.features, ai.features), nonEmptyArr);
  fill('pros', isEmptyArr(current.pros), firstArr(research.pros, ai.pros), nonEmptyArr);
  fill('cons', isEmptyArr(current.cons), firstArr(research.cons, ai.cons), nonEmptyArr);

  return { tool: merged, filled };
}

/**
 * Repair tools missing images, ratings, categories, or pricing.
 */
export async function repairToolLibraryAssets() {
  const data = await loadToolLibrary();
  /** @type {object[]} */
  const repaired = [];
  for (const tool of data.tools) {
    const needsImages =
      !tool.logoUrl ||
      !tool.snapshotUrl ||
      (await assetTooSmall(tool.logoUrl)) ||
      (await assetTooSmall(tool.snapshotUrl));
    const needsRating = !tool.ratingSource || (Number(tool.rating) === 3 && !tool.ratingSource);
    const needsCategories =
      !tool.categories?.length ||
      (tool.categories.length === 1 && tool.categories[0] === 'utilities');
    const needsPricing = needsPricingRewrite(tool.pricing, {
      name: tool.name,
      url: tool.url,
      description: tool.bestUsedFor || '',
    });
    if (!needsImages && !needsRating && !needsCategories && !needsPricing) continue;
    try {
      if (needsPricing && !needsImages && !needsRating && !needsCategories) {
        const light = await repairToolPricingOnly(tool);
        if (light) {
          const idx = data.tools.findIndex((t) => t.id === tool.id);
          if (idx >= 0) data.tools[idx] = light;
          await saveToolLibrary(data);
          repaired.push(light);
          continue;
        }
      }
      repaired.push(await refreshToolAssets(tool.id));
    } catch (e) {
      console.warn('[tool-library] repair skip', tool.id, e?.message || e);
    }
  }
  return { repaired: repaired.length, tools: repaired };
}

/**
 * @param {object} tool
 */
async function repairToolPricingOnly(tool) {
  // Prefer sync known-map first (fast, no network).
  let pricing = resolveToolPricingSync({
    name: tool.name,
    description: tool.bestUsedFor || '',
    url: tool.url,
  });
  if (isUnknownPricing(pricing)) {
    let html = '';
    try {
      const meta = await fetchPageMeta(tool.url);
      html = meta.htmlSnippet || '';
    } catch {
      /* search / AI can still work without HTML */
    }
    pricing = await resolveToolPricing({
      name: tool.name,
      description: tool.bestUsedFor || '',
      url: tool.url,
      html,
    }).catch(() => null);
  }
  if (!pricing || isUnknownPricing(pricing)) return null;
  const updated = { ...tool, pricing };
  try {
    await upsertResource(toolRecordToResource(updated), { project: 'dashbird', section: 'Tools' });
  } catch (e) {
    console.warn('[tool-library] catalog sync failed:', e?.message || e);
  }
  return updated;
}

/**
 * @param {string} assetUrl
 */
async function assetTooSmall(assetUrl) {
  const rel = String(assetUrl || '').trim();
  if (!rel) return true;
  const file = path.basename(rel);
  const fp = path.join(toolLibraryAssetsDir(), file);
  try {
    const st = await fs.stat(fp);
    return st.size < 500;
  } catch {
    return true;
  }
}
