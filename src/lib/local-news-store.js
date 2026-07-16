/**
 * Local News feed subscriptions + suggestion state (Settings-free, file-backed).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFeedItems } from './local-news-rss.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DIRECTORY_PATH = path.join(PKG_ROOT, 'src/data/local-news-feed-directory.json');

/** One-time initial batch: 2 articles from each of these categories (10 total). Not a
 * recurring seed — `bootstrapSeededAt` guards it so it only ever runs once. */
const BOOTSTRAP_CATEGORIES = ['tech', 'science', 'environment', 'university', 'world'];
const BOOTSTRAP_PER_CATEGORY = 2;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function localNewsStorePath(env = process.env) {
  const override = String(env.LOCAL_NEWS_STORE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/local-news.json');
}

const DEFAULT_STATE = {
  subscriptions: [],
  declinedIds: [],
  pendingSuggestion: null,
  lastSuggestionAt: null,
  bootstrapArticles: [],
  bootstrapSeededAt: null,
};

let directoryCache = null;

/**
 * @returns {Promise<Array<object>>}
 */
export async function loadFeedDirectory() {
  if (directoryCache) return directoryCache;
  try {
    const raw = await fs.readFile(DIRECTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    directoryCache = Array.isArray(parsed?.feeds) ? parsed.feeds : [];
  } catch {
    directoryCache = [];
  }
  return directoryCache;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<typeof DEFAULT_STATE>}
 */
export async function loadLocalNewsState(env = process.env) {
  try {
    const raw = await fs.readFile(localNewsStorePath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      subscriptions: Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [],
      declinedIds: Array.isArray(parsed?.declinedIds) ? parsed.declinedIds : [],
      pendingSuggestion: parsed?.pendingSuggestion || null,
      lastSuggestionAt: parsed?.lastSuggestionAt || null,
      bootstrapArticles: Array.isArray(parsed?.bootstrapArticles) ? parsed.bootstrapArticles : [],
      bootstrapSeededAt: parsed?.bootstrapSeededAt || null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * @param {typeof DEFAULT_STATE} state
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveLocalNewsState(state, env = process.env) {
  const target = localNewsStorePath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

/**
 * Pick a candidate feed from the directory, biased toward tag overlap with
 * current subscriptions ('similar') or raw popularity ('fresh').
 * @param {{ subscriptions: Array<object>, declinedIds: string[] }} state
 * @param {'similar' | 'fresh'} mode
 * @returns {Promise<object | null>}
 */
export async function pickCandidateFeed(state, mode) {
  const directory = await loadFeedDirectory();
  const subscribedIds = new Set(state.subscriptions.map((f) => f.id));
  const declinedIds = new Set(state.declinedIds || []);
  const pool = directory.filter((f) => !subscribedIds.has(f.id) && !declinedIds.has(f.id));
  if (!pool.length) return null;

  if (mode === 'similar' && state.subscriptions.length) {
    const subscribedTags = new Set(state.subscriptions.flatMap((f) => f.tags || []));
    const scored = pool
      .map((f) => ({
        feed: f,
        score: (f.tags || []).filter((t) => subscribedTags.has(t)).length,
      }))
      .sort((a, b) => b.score - a.score || (b.feed.popularity || 0) - (a.feed.popularity || 0));
    if (scored[0]?.score > 0) return scored[0].feed;
    // No tag overlap left in the pool — fall through to popularity pick.
  }

  const byPopularity = [...pool].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return byPopularity[0] || null;
}

/**
 * One-time only: pull the first 2 articles from one feed per category in
 * BOOTSTRAP_CATEGORIES (10 total) so there's something to thumbs up/down before any
 * subscription exists. Runs at most once ever — guarded by bootstrapSeededAt.
 * @param {typeof DEFAULT_STATE} state
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<typeof DEFAULT_STATE>}
 */
export async function seedBootstrapArticlesIfNeeded(state, env = process.env) {
  if (state.bootstrapSeededAt) return state;

  const directory = await loadFeedDirectory();
  const picks = BOOTSTRAP_CATEGORIES.map((cat) =>
    directory
      .filter((f) => f.category === cat)
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0],
  ).filter(Boolean);

  const results = await Promise.all(
    picks.map(async (feed) => {
      const r = await fetchFeedItems(feed.url);
      if (!r.ok) return [];
      return r.items.slice(0, BOOTSTRAP_PER_CATEGORY).map((it) => ({
        ...it,
        id: it.link || `${feed.id}:${it.title}`,
        feedId: feed.id,
        feedTitle: feed.title,
        category: feed.category,
      }));
    }),
  );

  state.bootstrapArticles = results.flat();
  state.bootstrapSeededAt = new Date().toISOString();
  await saveLocalNewsState(state, env);
  return state;
}
