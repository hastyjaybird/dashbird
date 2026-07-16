import { Router } from 'express';
import express from 'express';
import {
  loadLocalNewsState,
  saveLocalNewsState,
  seedBootstrapArticlesIfNeeded,
} from '../lib/local-news-store.js';
import { generateSuggestion, localNewsSuggestionsEnabled } from '../lib/local-news-scheduler.js';
import { fetchFeedItems } from '../lib/local-news-rss.js';
import { loadLocalNewsCriteria, saveLocalNewsCriteria } from '../lib/local-news-criteria-store.js';
import { scoreArticleTaste, compareArticlesByTasteThen } from '../lib/local-news-taste.js';

const router = Router();
router.use(express.json({ limit: '32kb' }));

const ARTICLE_CACHE_MS = 15 * 60 * 1000;
/** @type {Map<string, { fetchedAt: number, items: Array<object> }>} */
const articleCache = new Map();

/**
 * @param {Array<object>} subscriptions
 */
async function fetchArticlesFor(subscriptions) {
  const now = Date.now();
  const results = await Promise.all(
    subscriptions.map(async (feed) => {
      const cached = articleCache.get(feed.id);
      if (cached && now - cached.fetchedAt < ARTICLE_CACHE_MS) {
        return { feed, items: cached.items };
      }
      const r = await fetchFeedItems(feed.url);
      if (r.ok) {
        articleCache.set(feed.id, { fetchedAt: now, items: r.items });
        return { feed, items: r.items };
      }
      // Fetch failed — keep serving stale cache (if any) but don't bump fetchedAt,
      // so the next request retries instead of locking in a transient failure for 15min.
      return { feed, items: cached?.items || [] };
    }),
  );

  const articles = results.flatMap(({ feed, items }) =>
    items.map((it) => ({
      ...it,
      id: it.link || `${feed.id}:${it.title}`,
      feedId: feed.id,
      feedTitle: feed.title,
      category: feed.category,
    })),
  );
  return articles;
}

router.get('/', async (_req, res) => {
  try {
    let state = await loadLocalNewsState();
    state = await seedBootstrapArticlesIfNeeded(state);

    const [subscriptionArticles, criteria] = await Promise.all([
      fetchArticlesFor(state.subscriptions),
      loadLocalNewsCriteria(),
    ]);

    const byId = new Map();
    for (const a of [...state.bootstrapArticles, ...subscriptionArticles]) {
      if (a.id) byId.set(a.id, a);
    }

    const hidden = new Set(criteria.hiddenArticleIds);
    const articles = [...byId.values()]
      .filter((a) => !hidden.has(a.id))
      .map((a) => ({ ...a, ...scoreArticleTasteResult(a, criteria) }))
      .filter((a) => a.tasteOk)
      .sort(
        compareArticlesByTasteThen((a, b) => {
          const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          return tb - ta;
        }),
      )
      .slice(0, 60);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      enabled: localNewsSuggestionsEnabled(),
      subscriptions: state.subscriptions,
      pendingSuggestion: state.pendingSuggestion,
      criteria: { lookFor: criteria.lookFor, skip: criteria.skip, blacklist: criteria.blacklist },
      articles,
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
    const criteria = await loadLocalNewsCriteria();
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
    if (response !== 'yes' && response !== 'no') {
      res.status(400).json({ ok: false, error: 'invalid_response' });
      return;
    }

    const state = await loadLocalNewsState();
    const pending = state.pendingSuggestion;
    if (!pending) {
      res.status(400).json({ ok: false, error: 'no_pending_suggestion' });
      return;
    }

    if (response === 'yes') {
      if (!state.subscriptions.some((f) => f.id === pending.feed.id)) {
        state.subscriptions.push({ ...pending.feed, subscribedAt: new Date().toISOString() });
      }
    } else {
      if (!state.declinedIds.includes(pending.feed.id)) state.declinedIds.push(pending.feed.id);
    }
    state.pendingSuggestion = null;
    await saveLocalNewsState(state);

    const nextMode = state.subscriptions.length ? 'similar' : 'fresh';
    const { state: withNext } = await generateSuggestion(nextMode);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      subscriptions: withNext.subscriptions,
      pendingSuggestion: withNext.pendingSuggestion,
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
