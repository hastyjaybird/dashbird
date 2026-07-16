/**
 * Every 4 hours, surface one "subscribe to this feed?" suggestion in Local News.
 * Default mode looks for feeds similar to what's already subscribed; a manual
 * "suggest fresh" request looks at popular feeds instead.
 */
import { loadLocalNewsState, saveLocalNewsState, pickCandidateFeed } from './local-news-store.js';

const INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 20_000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
let tickInFlight = false;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function localNewsSuggestionsEnabled(env = process.env) {
  return String(env.LOCAL_NEWS_SUGGESTIONS ?? '1').trim() !== '0';
}

/**
 * @param {'similar' | 'fresh'} mode
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ state: object, created: boolean, exhausted?: boolean }>}
 */
export async function generateSuggestion(mode, env = process.env, opts = {}) {
  const state = await loadLocalNewsState(env);
  if (state.pendingSuggestion && !opts.force) return { state, created: false };

  const feed = await pickCandidateFeed(state, mode);
  if (!feed) return { state, created: false, exhausted: true };

  const createdAt = new Date().toISOString();
  state.pendingSuggestion = { feed, reason: mode, createdAt };
  state.lastSuggestionAt = createdAt;
  await saveLocalNewsState(state, env);
  return { state, created: true };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function tick(env = process.env) {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const state = await loadLocalNewsState(env);
    if (state.pendingSuggestion) return; // already waiting on a yes/no

    const last = state.lastSuggestionAt ? new Date(state.lastSuggestionAt).getTime() : 0;
    if (Number.isFinite(last) && Date.now() - last < INTERVAL_MS) return;

    const mode = state.subscriptions.length ? 'similar' : 'fresh';
    const { created } = await generateSuggestion(mode, env);
    if (created) console.log(`[local-news] new suggestion queued (${mode})`);
  } catch (e) {
    console.warn('[local-news] scheduler tick failed', e?.message || e);
  } finally {
    tickInFlight = false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function startLocalNewsScheduler(env = process.env) {
  if (!localNewsSuggestionsEnabled(env)) {
    console.log('[local-news] suggestion scheduler disabled');
    return;
  }
  if (timer) return;

  console.log('[local-news] suggestion scheduler: every 4h');
  timer = setInterval(() => {
    void tick(env);
  }, 60_000);
  if (typeof timer.unref === 'function') timer.unref();

  setTimeout(() => {
    void tick(env);
  }, STARTUP_DELAY_MS);
}
