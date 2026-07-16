/**
 * Local News taste criteria — Look for / grey (skip) / blacklist keyword lists, plus
 * ids of thumbs-downed articles to hide going forward. Mirrors the events-finder
 * criteria store's taste fields (src/lib/events-finder-criteria-store.js).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * @param {{ lookFor?: string, skip?: string, blacklist?: string, hiddenArticleIds?: string[] }} patch
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ok: true } & typeof DEFAULT_CRITERIA>}
 */
export async function saveLocalNewsCriteria(patch, env = process.env) {
  const current = await loadLocalNewsCriteria(env);
  const next = normalize({
    lookFor: patch.lookFor !== undefined ? patch.lookFor : current.lookFor,
    skip: patch.skip !== undefined ? patch.skip : current.skip,
    blacklist: patch.blacklist !== undefined ? patch.blacklist : current.blacklist,
    hiddenArticleIds: Array.isArray(patch.hiddenArticleIds)
      ? [...current.hiddenArticleIds, ...patch.hiddenArticleIds]
      : current.hiddenArticleIds,
  });
  await writeCriteria(next, env);
  return { ok: true, ...next };
}
