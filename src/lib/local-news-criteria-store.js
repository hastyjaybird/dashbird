/**
 * Local News taste criteria — Look for / grey (skip) / blacklist keyword lists, plus
 * ids of thumbs-downed articles to hide going forward. Mirrors the events-finder
 * criteria store's taste fields (src/lib/events-finder-criteria-store.js).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTasteLineArray, removeTasteLines } from './taste-lines.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function localNewsCriteriaPath(env = process.env) {
  const override = String(env.LOCAL_NEWS_CRITERIA_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/local-news-criteria.json');
}

const DEFAULT_CRITERIA = {
  lookFor: '',
  skip: '',
  blacklist: '',
  hiddenArticleIds: /** @type {string[]} */ ([]),
  hiddenArticleTaste: /** @type {Record<string, { lookFor?: string[], grey?: string[], black?: string[] }>} */ ({}),
};

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeHiddenArticleIds(raw) {
  const ids = (Array.isArray(raw) ? raw : [])
    .map((id) => String(id || '').trim().slice(0, 300))
    .filter(Boolean);
  // Keep the newest ids when over the cap — ids are appended in hide order, so drop
  // from the front (oldest) rather than the back.
  return [...new Set(ids)].slice(-2000);
}

function normalizeHiddenArticleTaste(raw) {
  if (!raw || typeof raw !== 'object') return {};
  /** @type {Record<string, { lookFor?: string[], grey?: string[], black?: string[] }>} */
  const out = {};
  for (const [id, row] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const key = String(id || '').trim().slice(0, 300);
    if (!key || !row || typeof row !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (row);
    const entry = {
      ...(normalizeTasteLineArray(o.lookFor) ? { lookFor: normalizeTasteLineArray(o.lookFor) } : {}),
      ...(normalizeTasteLineArray(o.grey) ? { grey: normalizeTasteLineArray(o.grey) } : {}),
      ...(normalizeTasteLineArray(o.black) ? { black: normalizeTasteLineArray(o.black) } : {}),
    };
    if (entry.lookFor || entry.grey || entry.black) out[key] = entry;
  }
  return out;
}

/**
 * @param {unknown} raw
 */
function normalize(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    lookFor: String(o.lookFor ?? '').slice(0, 8000),
    skip: String(o.skip ?? '').slice(0, 8000),
    blacklist: String(o.blacklist ?? '').slice(0, 8000),
    hiddenArticleIds: normalizeHiddenArticleIds(o.hiddenArticleIds),
    hiddenArticleTaste: normalizeHiddenArticleTaste(o.hiddenArticleTaste),
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<typeof DEFAULT_CRITERIA>}
 */
export async function loadLocalNewsCriteria(env = process.env) {
  try {
    const raw = await fs.readFile(localNewsCriteriaPath(env), 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CRITERIA };
  }
}

/**
 * @param {typeof DEFAULT_CRITERIA} criteria
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCriteria(criteria, env) {
  const target = localNewsCriteriaPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(criteria, null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

/**
 * lookFor/skip/blacklist are full-text replaces (the client already merges lines before
 * saving); hiddenArticleIds are unioned onto the existing list so a save never drops ids.
 * @param {{ lookFor?: string, skip?: string, blacklist?: string, hiddenArticleIds?: string[], hiddenArticleTaste?: Record<string, { lookFor?: string[], grey?: string[], black?: string[] }>, unhideArticleIds?: string[] }} patch
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: true } & typeof DEFAULT_CRITERIA>}
 */
export async function saveLocalNewsCriteria(patch, env = process.env) {
  const current = await loadLocalNewsCriteria(env);
  let lookFor = patch.lookFor !== undefined ? patch.lookFor : current.lookFor;
  let skip = patch.skip !== undefined ? patch.skip : current.skip;
  let blacklist = patch.blacklist !== undefined ? patch.blacklist : current.blacklist;
  const next = normalize({
    lookFor,
    skip,
    blacklist,
    hiddenArticleIds: (() => {
      let ids = [...current.hiddenArticleIds];
      if (Array.isArray(patch.unhideArticleIds) && patch.unhideArticleIds.length) {
        const drop = new Set(
          patch.unhideArticleIds.map((id) => String(id || '').trim()).filter(Boolean),
        );
        for (const id of drop) {
          const taste = current.hiddenArticleTaste?.[id];
          if (taste) {
            lookFor = removeTasteLines(lookFor, taste.lookFor || []);
            skip = removeTasteLines(skip, taste.grey || []);
            blacklist = removeTasteLines(blacklist, taste.black || []);
          }
        }
        ids = ids.filter((id) => !drop.has(id));
      }
      if (Array.isArray(patch.hiddenArticleIds) && patch.hiddenArticleIds.length) {
        ids = [...ids, ...patch.hiddenArticleIds];
      }
      return normalizeHiddenArticleIds(ids);
    })(),
    hiddenArticleTaste: (() => {
      const taste = { ...current.hiddenArticleTaste };
      if (Array.isArray(patch.unhideArticleIds) && patch.unhideArticleIds.length) {
        for (const id of patch.unhideArticleIds) {
          const key = String(id || '').trim();
          if (key) delete taste[key];
        }
      }
      if (patch.hiddenArticleTaste && typeof patch.hiddenArticleTaste === 'object') {
        for (const [id, row] of Object.entries(patch.hiddenArticleTaste)) {
          const key = String(id || '').trim().slice(0, 300);
          if (!key || !row || typeof row !== 'object') continue;
          const entry = {
            ...(normalizeTasteLineArray(row.lookFor) ? { lookFor: normalizeTasteLineArray(row.lookFor) } : {}),
            ...(normalizeTasteLineArray(row.grey) ? { grey: normalizeTasteLineArray(row.grey) } : {}),
            ...(normalizeTasteLineArray(row.black) ? { black: normalizeTasteLineArray(row.black) } : {}),
          };
          if (entry.lookFor || entry.grey || entry.black) taste[key] = entry;
        }
      }
      // Drop taste entries for articles no longer hidden.
      const hidden = new Set(
        (() => {
          let ids = [...current.hiddenArticleIds];
          if (Array.isArray(patch.unhideArticleIds) && patch.unhideArticleIds.length) {
            const drop = new Set(
              patch.unhideArticleIds.map((id) => String(id || '').trim()).filter(Boolean),
            );
            ids = ids.filter((id) => !drop.has(id));
          }
          if (Array.isArray(patch.hiddenArticleIds) && patch.hiddenArticleIds.length) {
            ids = [...ids, ...patch.hiddenArticleIds];
          }
          return normalizeHiddenArticleIds(ids);
        })(),
      );
      for (const key of Object.keys(taste)) {
        if (!hidden.has(key)) delete taste[key];
      }
      return taste;
    })(),
  });
  await writeCriteria(next, env);
  return { ok: true, ...next };
}
