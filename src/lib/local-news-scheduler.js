/**
 * Every 4 hours, surface one "subscribe to this feed?" suggestion in Local News.
 * Default mode looks for feeds similar to what's already subscribed; a manual
 * "suggest fresh" request looks at popular feeds instead.
 */
import { loadLocalNewsState, saveLocalNewsState, pickCandidateFeed } from './local-news-store.js';

export const LOCAL_NEWS_SUGGESTION_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INTERVAL_MS = LOCAL_NEWS_SUGGESTION_INTERVAL_MS;
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
/**
 * Move a deferred suggestion back to pending when its showAfter time has passed.
 * @param {object} state
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<object>}
 */
export async function promoteDeferredSuggestionIfDue(state, env = process.env) {
  const deferred = state.deferredSuggestion;
  if (!deferred?.showAfter || !deferred.feed) return state;
  const showAfter = new Date(deferred.showAfter).getTime();
  if (!Number.isFinite(showAfter) || Date.now() < showAfter) return state;
  if (state.pendingSuggestion) return state;

  state.pendingSuggestion = {
    feed: deferred.feed,
    reason: deferred.reason || 'similar',
    createdAt: deferred.createdAt || deferred.deferredAt || new Date().toISOString(),
  };
  state.deferredSuggestion = null;
  await saveLocalNewsState(state, env);
  return state;
}

export async function generateSuggestion(mode, env = process.env, opts = {}) {
  let state = await loadLocalNewsState(env);
  state = await promoteDeferredSuggestionIfDue(state, env);
  if (state.pendingSuggestion && !opts.force) return { state, created: false };

  if (opts.force) state.deferredSuggestion = null;

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
    let state = await loadLocalNewsState(env);
    state = await promoteDeferredSuggestionIfDue(state, env);
    if (state.pendingSuggestion) return; // already waiting on a yes/no
    if (state.deferredSuggestion) return; // waiting to re-surface a deferred feed

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
