/**
 * Add a tool: scrape → images → OpenRouter metadata.
 */
import {
  addTool,
  loadToolLibrary,
  newToolId,
} from './tool-library-store.js';
import { enrichToolFromScrape, resolveToolHomepageUrl } from './tool-library-ai.js';
import { fetchPageMeta, importToolImages } from './tool-library-scrape.js';

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
    }).catch((e) => {
      console.warn('[tool-library] AI enrich failed:', e?.message || e);
      return {
        name: meta.title || meta.host,
        bestUsedFor: '',
        pricing: { model: 'unknown', lowestTier: 'Unknown', summary: 'Could not auto-detect pricing' },
        features: [],
        pros: [],
        cons: [],
        rating: 3,
        operatingSystems: ['Web'],
        categories: ['utilities'],
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
    rating: ai.rating,
    operatingSystems: ai.operatingSystems,
    categories: ai.categories,
    logoUrl: images.logoPath || '',
    snapshotUrl: images.snapshotPath || '',
    addedAt: new Date().toISOString(),
  };

  await addTool(tool);
  return tool;
}
