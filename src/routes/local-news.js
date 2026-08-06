import { Router } from 'express';
import express from 'express';
import {
  loadLocalNewsState,
  saveLocalNewsState,
  seedBootstrapArticlesIfNeeded,
  loadFeedDirectory,
  groupFeedsByPublisher,
  findDirectoryFeed,
  rankSuggestedFeeds,
  pickReplacementSuggestedFeed,
  SUGGESTED_FEEDS_LIMIT,
} from '../lib/local-news-store.js';
import { generateSuggestion, localNewsSuggestionsEnabled, promoteDeferredSuggestionIfDue, LOCAL_NEWS_SUGGESTION_INTERVAL_MS } from '../lib/local-news-scheduler.js';
import { fetchLocalNewsFeed } from '../lib/local-news-fetch.js';
import { loadLocalNewsCriteria, saveLocalNewsCriteria } from '../lib/local-news-criteria-store.js';
import {
  scoreArticleTaste,
  compareArticlesByImportanceThenTaste,
} from '../lib/local-news-taste.js';
import {
  attachRelevanceToArticles,
  ensureRelevanceForArticles,
  localNewsRelevanceEnabled,
  queueRelevanceGeneration,
} from '../lib/local-news-relevance.js';
import { applyBdImportance } from '../lib/local-news-bd-importance.js';
import { mergeBdCriteriaSeeds } from '../lib/local-news-bd-criteria.js';
import {
  bdMinPublishedMs,
  bdWatchActive,
  filterBdArticlesByFreshness,
  isBdFeed,
  BD_WATCH_START_YMD,
  articleMeetsBdFreshness,
} from '../lib/local-news-bd-freshness.js';
import {
  applyPreferenceRanking,
  loadPreferencesMeta,
  recordArticleFeedback,
  snoozeArticleTopic,
  sortArticlesByPreferences,
} from '../lib/local-news-preferences.js';

const router = Router();
router.use(express.json({ limit: '32kb' }));

const ARTICLE_CACHE_MS = 15 * 60 * 1000;
const ARTICLE_FEED_LIMIT = 100;
const SUGGESTION_PREVIEW_LIMIT = 10;
/** @type {Map<string, { fetchedAt: number, items: Array<object> }>} */
const articleCache = new Map();

/**
 * @param {Array<object>} subscriptions
 */
async function fetchArticlesFor(subscriptions) {
  const now = Date.now();
  const watchOn = bdWatchActive();
  const minMs = bdMinPublishedMs();
  const results = await Promise.all(
    subscriptions.map(async (feed) => {
      // BD lane: no network pull until watch start day; after that drop stale items.
      if (isBdFeed(feed) && !watchOn) {
        articleCache.delete(feed.id);
        return { feed, items: [] };
      }
      const cached = articleCache.get(feed.id);
      if (cached && now - cached.fetchedAt < ARTICLE_CACHE_MS) {
        const items = isBdFeed(feed)
          ? cached.items.filter((it) => articleMeetsBdFreshness(it, minMs))
          : cached.items;
        return { feed, items };
      }
      const r = await fetchLocalNewsFeed(feed);
      if (r.ok) {
        const items = isBdFeed(feed)
          ? r.items.filter((it) => articleMeetsBdFreshness(it, minMs))
          : r.items;
        articleCache.set(feed.id, { fetchedAt: now, items });
        return { feed, items };
      }
      // Fetch failed — keep serving stale cache (if any) but don't bump fetchedAt,
      // so the next request retries instead of locking in a transient failure for 15min.
      const stale = cached?.items || [];
      const items = isBdFeed(feed)
        ? stale.filter((it) => articleMeetsBdFreshness(it, minMs))
        : stale;
      return { feed, items };
    }),
  );

  const articles = results.flatMap(({ feed, items }) =>
    items.map((it) => ({
      ...it,
      id: it.link || `${feed.id}:${it.title}`,
      feedId: feed.id,
      feedTitle: feed.title,
      category: feed.category,
      tags: feed.tags,
    })),
  );
  return articles;
}

router.get('/', async (_req, res) => {
  try {
    let state = await loadLocalNewsState();
    state = await promoteDeferredSuggestionIfDue(state);
    state = await seedBootstrapArticlesIfNeeded(state);

    const [subscriptionArticles, criteriaRaw, prefMeta] = await Promise.all([
      fetchArticlesFor(state.subscriptions),
      loadLocalNewsCriteria(),
      loadPreferencesMeta(),
    ]);
    const criteria = mergeBdCriteriaSeeds(criteriaRaw);

    const byId = new Map();
    // Bootstrap is historical seed — skip once BD watch is active (new-only mode).
    const bootstrap = bdWatchActive() ? [] : state.bootstrapArticles;
    for (const a of filterBdArticlesByFreshness([...bootstrap, ...subscriptionArticles])) {
      if (a.id) byId.set(a.id, a);
    }

    const hidden = new Set(criteria.hiddenArticleIds);
    const byDateDesc = (a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    };
    const scored = [...byId.values()].map((a) => ({
      ...a,
      ...scoreArticleTasteResult(a, criteria),
      skipped: hidden.has(a.id),
    }));

    /** Most recently skipped first — hiddenArticleIds are appended on each skip. */
    const hiddenOrder = new Map(
      criteria.hiddenArticleIds.map((id, i) => [id, i]),
    );
    const byHiddenDesc = (a, b) => {
      const ra = hiddenOrder.get(a.id) ?? -1;
      const rb = hiddenOrder.get(b.id) ?? -1;
      if (rb !== ra) return rb - ra;
      return byDateDesc(a, b);
    };

    const skippedArticles = scored.filter((a) => a.skipped).sort(byHiddenDesc);

    // Attach cached importance before sort so Important ranking works on refresh.
    const tasteOkRaw = scored.filter((a) => !a.skipped && a.tasteOk);
    const [withRelevance, skippedWithRelevance] = await Promise.all([
      attachRelevanceToArticles(tasteOkRaw),
      attachRelevanceToArticles(skippedArticles),
    ]);

    /** Test/demo cards — bypass freshness/taste; preserve forced Important flags. */
    const demoCards = (Array.isArray(state.demoArticles) ? state.demoArticles : [])
      .filter((a) => a && a.id && !hidden.has(a.id))
      .map((a) => {
        const forcedImportant = a.important === true || Number(a.importance) >= 8;
        const base = {
          ...a,
          tasteOk: true,
          tasteScore: Number(a.tasteScore) || 999,
          preferenceScore: 999,
          skipped: false,
          demo: true,
        };
        if (forcedImportant) {
          return {
            ...base,
            important: true,
            importance: Math.max(Number(a.importance) || 0, 8),
            importantReasons: Array.isArray(a.importantReasons) && a.importantReasons.length
              ? a.importantReasons
              : ['demo:important-alert'],
          };
        }
        return applyBdImportance(base);
      });

    // Reconsider recent thumbs each refresh — preference concepts first, then importance/taste.
    const rankedMain = sortArticlesByPreferences(
      applyPreferenceRanking(
        withRelevance.map((a) => applyBdImportance(a)),
        prefMeta,
      ),
      prefMeta,
      byDateDesc,
    );

    const articles = [
      ...demoCards.sort(compareArticlesByImportanceThenTaste(byDateDesc)),
      ...rankedMain,
    ].slice(0, ARTICLE_FEED_LIMIT);

    const skippedOut = skippedWithRelevance.map((a) => applyBdImportance(a));

    queueRelevanceGeneration(articles, process.env);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      enabled: localNewsSuggestionsEnabled(),
      relevanceEnabled: localNewsRelevanceEnabled(),
      subscriptions: state.subscriptions,
      pendingSuggestion: state.pendingSuggestion,
      criteria: {
        lookFor: criteria.lookFor,
        skip: criteria.skip,
        blacklist: criteria.blacklist,
      },
      preferences: {
        commonalities: prefMeta.commonalities,
        recentCount: prefMeta.entries.length,
        snoozedCount: prefMeta.snoozed.length,
      },
      skippedCount: skippedOut.length,
      skippedArticles: skippedOut,
      articles,
      bdWatch: {
        startYmd: BD_WATCH_START_YMD,
        active: bdWatchActive(),
        sameDayOnly: true,
        timeZone: 'America/Los_Angeles',
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * @param {object} article
 * @param {object} criteria
 */
function scoreArticleTasteResult(article, criteria) {
  const taste = scoreArticleTaste(article, criteria);
  return { tasteOk: taste.ok, tasteScore: taste.score };
}

router.get('/criteria', async (_req, res) => {
  try {
    const criteria = mergeBdCriteriaSeeds(await loadLocalNewsCriteria());
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...criteria });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/criteria', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const saved = await saveLocalNewsCriteria(body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(saved);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/suggestion/respond', async (req, res) => {
  try {
    const response = String(req.body?.response || '').trim().toLowerCase();
    if (response !== 'yes' && response !== 'no' && response !== 'defer') {
      res.status(400).json({ ok: false, error: 'invalid_response' });
      return;
    }

    const state = await loadLocalNewsState();
    const pending = state.pendingSuggestion;
    if (!pending) {
      res.status(400).json({ ok: false, error: 'no_pending_suggestion' });
      return;
    }

    if (response === 'defer') {
      const now = new Date().toISOString();
      state.deferredSuggestion = {
        feed: pending.feed,
        reason: pending.reason,
        createdAt: pending.createdAt,
        deferredAt: now,
        showAfter: new Date(Date.now() + LOCAL_NEWS_SUGGESTION_INTERVAL_MS).toISOString(),
      };
      state.pendingSuggestion = null;
      state.lastSuggestionAt = now;
      await saveLocalNewsState(state);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        ok: true,
        subscriptions: state.subscriptions,
        pendingSuggestion: null,
        deferredSuggestion: state.deferredSuggestion,
      });
      return;
    }

    if (response === 'yes') {
      if (!state.subscriptions.some((f) => f.id === pending.feed.id)) {
        state.subscriptions.push({ ...pending.feed, subscribedAt: new Date().toISOString() });
      }
    } else {
      if (!state.declinedIds.includes(pending.feed.id)) state.declinedIds.push(pending.feed.id);
    }
    // Clear and cool down — do not immediately queue another subscribe prompt.
    // The 4h scheduler (or "Suggest another feed") surfaces the next candidate.
    const now = new Date().toISOString();
    state.pendingSuggestion = null;
    state.lastSuggestionAt = now;
    await saveLocalNewsState(state);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      subscriptions: state.subscriptions,
      pendingSuggestion: null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/suggestion/fresh', async (_req, res) => {
  try {
    const { state, exhausted } = await generateSuggestion('fresh', process.env, { force: true });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, pendingSuggestion: state.pendingSuggestion, exhausted: Boolean(exhausted) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * @param {object} feed
 * @returns {Promise<object>}
 */
async function buildFeedPreviewPayload(feed) {
  if (isBdFeed(feed) && !bdWatchActive()) {
    return {
      ok: true,
      feed: {
        id: feed.id,
        title: feed.title,
        siteUrl: feed.siteUrl || feed.url,
        url: feed.url,
      },
      articles: [],
      bdWatch: {
        startYmd: BD_WATCH_START_YMD,
        active: false,
        sameDayOnly: true,
        timeZone: 'America/Los_Angeles',
      },
    };
  }

  const [fetchResult, criteriaRaw] = await Promise.all([
    fetchLocalNewsFeed(feed),
    loadLocalNewsCriteria(),
  ]);
  if (!fetchResult.ok) {
    const err = new Error(fetchResult.error || 'feed_fetch_failed');
    err.status = 502;
    throw err;
  }
  const criteria = mergeBdCriteriaSeeds(criteriaRaw);
  const minMs = bdMinPublishedMs();

  const byDateDesc = (a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  };

  const tasteFiltered = fetchResult.items
    .filter((it) => !isBdFeed(feed) || articleMeetsBdFreshness(it, minMs))
    .map((it) => ({
      ...it,
      id: it.link || `${feed.id}:${it.title}`,
      feedId: feed.id,
      feedTitle: feed.title,
      category: feed.category,
      tags: feed.tags,
    }))
    .map((a) => ({ ...a, ...scoreArticleTasteResult(a, criteria) }))
    .filter((a) => a.tasteOk);

  const withRelevance = await ensureRelevanceForArticles(tasteFiltered);
  const articles = withRelevance
    .map((a) => applyBdImportance(a))
    .sort(compareArticlesByImportanceThenTaste(byDateDesc))
    .slice(0, SUGGESTION_PREVIEW_LIMIT);

  return {
    ok: true,
    feed: {
      id: feed.id,
      title: feed.title,
      siteUrl: feed.siteUrl || feed.url,
      url: feed.url,
    },
    articles,
  };
}

/**
 * @param {string} feedId
 * @returns {{ articleCount: number | null, latestPublishedAt: string | null, fetchedAt: string | null }}
 */
function feedStatsFromCache(feedId) {
  const cached = articleCache.get(feedId);
  if (!cached) {
    return { articleCount: null, latestPublishedAt: null, fetchedAt: null };
  }
  let latestPublishedAt = null;
  let latestMs = 0;
  for (const it of cached.items || []) {
    const ms = it?.publishedAt ? new Date(it.publishedAt).getTime() : 0;
    if (ms > latestMs) {
      latestMs = ms;
      latestPublishedAt = it.publishedAt;
    }
  }
  return {
    articleCount: Array.isArray(cached.items) ? cached.items.length : 0,
    latestPublishedAt,
    fetchedAt: cached.fetchedAt ? new Date(cached.fetchedAt).toISOString() : null,
  };
}

router.get('/suggestion/preview', async (_req, res) => {
  try {
    const state = await loadLocalNewsState();
    const pending = state.pendingSuggestion;
    if (!pending?.feed?.url) {
      res.status(404).json({ ok: false, error: 'no_pending_suggestion' });
      return;
    }
    const payload = await buildFeedPreviewPayload(pending.feed);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(payload);
  } catch (e) {
    const status = Number(e?.status) || 500;
    res.status(status).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/feeds/:id/preview', async (req, res) => {
  try {
    const feed = await findDirectoryFeed(req.params.id);
    if (!feed?.url) {
      res.status(404).json({ ok: false, error: 'feed_not_found' });
      return;
    }
    const payload = await buildFeedPreviewPayload(feed);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(payload);
  } catch (e) {
    const status = Number(e?.status) || 500;
    res.status(status).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/feeds/:id/decline', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'missing_feed_id' });
      return;
    }
    const excludeIds = Array.isArray(req.body?.excludeIds)
      ? req.body.excludeIds.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const state = await loadLocalNewsState();
    if (!(state.declinedIds || []).includes(id)) {
      state.declinedIds = [...(state.declinedIds || []), id];
    }
    if (state.pendingSuggestion?.feed?.id === id) {
      state.pendingSuggestion = null;
      state.lastSuggestionAt = new Date().toISOString();
    }
    await saveLocalNewsState(state);
    const criteria = mergeBdCriteriaSeeds(await loadLocalNewsCriteria());
    const exclude = new Set([id, ...excludeIds]);
    const replacement = await pickReplacementSuggestedFeed(state, criteria, exclude);
    const suggestedFeeds = await rankSuggestedFeeds(
      state,
      criteria,
      SUGGESTED_FEEDS_LIMIT,
      excludeIds.filter((x) => x !== id),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      declinedIds: state.declinedIds,
      replacement,
      suggestedFeeds,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/feedback', async (req, res) => {
  try {
    const vibe = String(req.body?.vibe || '').trim().toLowerCase();
    if (vibe !== 'up' && vibe !== 'down') {
      res.status(400).json({ ok: false, error: 'invalid_vibe' });
      return;
    }
    const article = req.body?.article && typeof req.body.article === 'object' ? req.body.article : null;
    if (!article?.id || !article?.title) {
      res.status(400).json({ ok: false, error: 'missing_article' });
      return;
    }
    const result = await recordArticleFeedback(article, vibe);
    // Thumbs down still hides this exact headline (not a keyword ban).
    if (vibe === 'down' && article.id) {
      await saveLocalNewsCriteria({ hiddenArticleIds: [String(article.id)] });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = Number(e?.status) || 500;
    res.status(status).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/snooze', async (req, res) => {
  try {
    const article = req.body?.article && typeof req.body.article === 'object' ? req.body.article : null;
    if (!article?.id || !article?.title) {
      res.status(400).json({ ok: false, error: 'missing_article' });
      return;
    }
    const result = await snoozeArticleTopic(article);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = Number(e?.status) || 500;
    res.status(status).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/directory', async (_req, res) => {
  try {
    const state = await loadLocalNewsState();
    const [directory, criteriaRaw] = await Promise.all([
      loadFeedDirectory(),
      loadLocalNewsCriteria(),
    ]);
    const criteria = mergeBdCriteriaSeeds(criteriaRaw);
    const subscribedIds = new Set(state.subscriptions.map((f) => f.id));
    const publishers = groupFeedsByPublisher(directory, {
      subscribedIds,
      declinedIds: state.declinedIds,
    });
    const subscriptions = state.subscriptions.map((feed) => ({
      ...feed,
      stats: feedStatsFromCache(feed.id),
    }));
    // Prefer Anthropic Careers first in the Tuned-in list so it stays visible.
    subscriptions.sort((a, b) => {
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
    const suggestedFeeds = await rankSuggestedFeeds(state, criteria, SUGGESTED_FEEDS_LIMIT);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      publishers,
      subscriptions,
      suggestedFeeds,
      suggestedLimit: SUGGESTED_FEEDS_LIMIT,
      pendingSuggestion: state.pendingSuggestion,
      declinedIds: state.declinedIds,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/subscriptions', async (req, res) => {
  try {
    const feedId = String(req.body?.feedId || req.body?.id || '').trim();
    if (!feedId) {
      res.status(400).json({ ok: false, error: 'missing_feed_id' });
      return;
    }
    const feed = await findDirectoryFeed(feedId);
    if (!feed) {
      res.status(404).json({ ok: false, error: 'feed_not_found' });
      return;
    }
    if (feed.id === 'anthropic-careers-bd') {
      res.status(400).json({
        ok: false,
        error: 'careers_moved_to_job_watch',
        hint: 'Anthropic careers are watched in the Opportunity Watch left-rail panel.',
      });
      return;
    }
    const state = await loadLocalNewsState();
    if (!state.subscriptions.some((f) => f.id === feed.id)) {
      state.subscriptions.push({ ...feed, subscribedAt: new Date().toISOString() });
    }
    state.declinedIds = (state.declinedIds || []).filter((id) => id !== feed.id);
    if (state.pendingSuggestion?.feed?.id === feed.id) {
      state.pendingSuggestion = null;
      state.lastSuggestionAt = new Date().toISOString();
    }
    await saveLocalNewsState(state);
    articleCache.delete(feed.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, subscriptions: state.subscriptions, feed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/subscriptions/:id/unsubscribe', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const state = await loadLocalNewsState();
    state.subscriptions = state.subscriptions.filter((f) => f.id !== id);
    await saveLocalNewsState(state);
    articleCache.delete(id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, subscriptions: state.subscriptions });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
