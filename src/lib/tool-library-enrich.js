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
