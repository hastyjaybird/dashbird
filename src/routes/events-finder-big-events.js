/**
 * Big Events — search a name, preview the official site snapshot, then add it to
 * the tracked table (dates, ticket price, early bird, prior-year estimate).
 */
import { Router } from 'express';
import express from 'express';
import {
  loadEventsFinderCriteria,
  saveEventsFinderCriteria,
} from '../lib/events-finder-criteria-store.js';
import {
  loadConferenceWatchlistStore,
  slugFromQuery,
  upsertConferenceWatchlistRecords,
  removeConferenceWatchlistSlugs,
  removeBigEventShot,
  bigEventsShotsDir,
  normalizeLeadDays,
} from '../lib/events-finder-conference-watchlist-store.js';
import {
  previewBigEvent,
  researchConferenceQuery,
  normalizeConferenceWatchlist,
  conferenceRecordToWatchItem,
  loadConferenceHeadsUp,
} from '../lib/events-finder-conference-watchlist.js';

const router = Router();
router.use(express.json({ limit: '256kb' }));

// Serve cached website snapshots.
router.use(
  '/shot',
  express.static(bigEventsShotsDir(process.env), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'private, max-age=300');
    },
  }),
);

/** GET the current tracked Big Events table. */
router.get('/', async (_req, res) => {
  try {
    const criteria = await loadEventsFinderCriteria();
    const pack = await loadConferenceHeadsUp(criteria.conferenceWatchlist, new Date(), process.env);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, items: pack.items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /search { query, deep? } — find the official site URL (no snapshot, no commit). */
router.post('/search', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim().slice(0, 120);
    if (!query) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }
    const deep = req.body?.deep === true;
    const preview = await previewBigEvent(query, process.env, { deep });
    if (!preview.ok) {
      res.status(422).json(preview);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      preview: {
        slug: preview.slug,
        query: preview.query,
        name: preview.name,
        url: preview.url,
        homepageUrl: preview.homepageUrl || preview.url || null,
        ticketUrl: preview.ticketUrl || null,
        urlFound: preview.urlFound === true,
        deep: preview.deep === true,
        confident: preview.confident === true,
        candidates: Array.isArray(preview.candidates)
          ? preview.candidates.map((c) => ({
              url: String(c?.url || '').trim(),
              title: String(c?.title || '').trim().slice(0, 140),
              score: Number(c?.score) || 0,
            })).filter((c) => c.url)
          : [],
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /add { query, url?, homepageUrl?, ticketUrl?, manual? }
 * Commit to the watchlist. `manual: true` is for events that cannot be found
 * via search — locks the record as hand-edited and only runs research when a
 * URL was provided (scrape that page; do not rediscover a wrong site).
 */
router.post('/add', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim().slice(0, 120);
    if (!query) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }
    const url = String(req.body?.url || '').trim().slice(0, 500) || null;
    const homepageUrl = String(req.body?.homepageUrl || '').trim().slice(0, 500) || url || null;
    const ticketUrl = String(req.body?.ticketUrl || '').trim().slice(0, 500) || null;
    const screenshotPath = String(req.body?.screenshotPath || '').trim().slice(0, 200) || null;
    const manual = req.body?.manual === true;
    const slug = slugFromQuery(query);
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_query' });
      return;
    }

    const criteria = await loadEventsFinderCriteria();
    const names = normalizeConferenceWatchlist([
      ...(Array.isArray(criteria.conferenceWatchlist) ? criteria.conferenceWatchlist : []),
      query,
    ]);
    const saved = await saveEventsFinderCriteria({
      lookFor: criteria.lookFor,
      skip: criteria.skip,
      blacklist: criteria.blacklist,
      conferenceWatchlist: names,
    });
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }

    // Seed the record with the chosen URL + snapshot so research keeps them.
    // Preserve any previously researched data (dates, price, etc.) while the
    // background pass runs — a bare stub would blank the card to "TBD" until
    // (and unless) research completes. Only overlay the new url/screenshot.
    const priorStore = await loadConferenceWatchlistStore(process.env);
    const priorRec = priorStore.bySlug[slug] || {};
    const hasSite = Boolean(homepageUrl || url);
    // Manual name-only add: lock so daily research cannot invent a wrong site.
    // Manual + pasted URL: still scrape that page, but keep the manual lock.
    const runResearch = !manual || hasSite;
    await upsertConferenceWatchlistRecords(
      {
        [slug]: {
          ...priorRec,
          slug,
          query,
          name: priorRec.name || query,
          url: homepageUrl || url || priorRec.url || null,
          homepageUrl: homepageUrl || priorRec.homepageUrl || null,
          ticketUrl: ticketUrl || priorRec.ticketUrl || null,
          screenshotPath: screenshotPath || priorRec.screenshotPath || null,
          manualEdit: manual || priorRec.manualEdit === true,
          researching: runResearch,
          researchedAt: new Date().toISOString(),
        },
      },
      process.env,
    );

    if (runResearch) {
      setImmediate(() => {
        void researchConferenceQuery(query, process.env, {
          url,
          homepageUrl,
          ticketUrl,
          screenshotPath,
        }).catch((err) => {
          console.warn('[big-events] research failed:', String(err?.message || err).slice(0, 160));
        });
      });
    }

    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug] || {
      slug,
      query,
      name: query,
      url,
      screenshotPath,
      manualEdit: manual,
      researching: runResearch,
    };
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, item: conferenceRecordToWatchItem(rec, new Date()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /research { query|slug } — re-run research for one tracked event. */
router.post('/research', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim().slice(0, 120);
    if (!query) {
      res.status(400).json({ ok: false, error: 'missing_query' });
      return;
    }
    // An explicit re-research overrides a manual-edit lock (discards hand edits
    // and re-fetches from the web).
    setImmediate(() => {
      void researchConferenceQuery(query, process.env, { force: true }).catch(() => {});
    });
    res.json({ ok: true, slug: slugFromQuery(query) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * PATCH /:slug — update one event. Accepts `reminderLeadDays` and/or any of the
 * editable metadata fields below. Editing metadata sets `manualEdit` so the
 * daily/auto research leaves the hand-corrected record alone (use POST /research
 * to discard edits and re-fetch).
 */
const EDITABLE_STRING_FIELDS = [
  'name',
  'homepageUrl',
  'ticketUrl',
  'venue',
  'city',
  'ticketPrice',
  'earlyBirdPrice',
  'notes',
];
const EDITABLE_DATE_FIELDS = [
  'eventStart',
  'eventEnd',
  'ticketSalesStart',
  'earlyBirdStart',
  'earlyBirdEnd',
];

/** @param {unknown} raw */
function cleanDateInput(raw) {
  const s = String(raw ?? '').trim().slice(0, 10);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`))
    ? s
    : undefined; // undefined → invalid, reject
}

router.patch('/:slug', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const body = req.body || {};
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];
    if (!rec) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }

    /** @type {Record<string, unknown>} */
    const patch = {};
    let metaEdited = false;

    for (const key of EDITABLE_STRING_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const val = String(body[key] ?? '').trim() || null;
      patch[key] = val;
      if (key === 'homepageUrl') patch.url = val; // keep url mirror in sync
      // A hand-typed price is authoritative — drop the "estimated" annotation.
      if (key === 'ticketPrice') {
        patch.ticketPriceEstimated = false;
        patch.estimatedFromYear = null;
      }
      metaEdited = true;
    }
    for (const key of EDITABLE_DATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const val = cleanDateInput(body[key]);
      if (val === undefined) {
        res.status(400).json({ ok: false, error: `invalid_${key}` });
        return;
      }
      patch[key] = val;
      // A hand-typed start date is authoritative — drop the "(est.)" annotation.
      if (key === 'eventStart') patch.nextEditionEstimated = false;
      metaEdited = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'reminderLeadDays')) {
      patch.reminderLeadDays = normalizeLeadDays(body.reminderLeadDays);
    }

    if (!metaEdited && !Object.prototype.hasOwnProperty.call(patch, 'reminderLeadDays')) {
      res.status(400).json({ ok: false, error: 'no_editable_fields' });
      return;
    }

    // Editing metadata locks the record from auto-research; a bare reminder
    // change does not.
    if (metaEdited) {
      patch.manualEdit = true;
      patch.researching = false;
    }

    const updated = await upsertConferenceWatchlistRecords(
      { [slug]: { ...rec, ...patch } },
      process.env,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      item: conferenceRecordToWatchItem(updated.bySlug[slug] || rec, new Date()),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Update one big event's record with a partial patch, returning the fresh
 * watch item. Shared by the snooze / skip / restore feed-card actions.
 * @param {string} slug
 * @param {Record<string, unknown>} patch
 * @param {import('express').Response} res
 */
async function patchBigEventRecord(slug, patch, res) {
  const store = await loadConferenceWatchlistStore(process.env);
  const rec = store.bySlug[slug];
  if (!rec) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  const updated = await upsertConferenceWatchlistRecords(
    { [slug]: { ...rec, ...patch } },
    process.env,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    ok: true,
    item: conferenceRecordToWatchItem(updated.bySlug[slug] || rec, new Date()),
  });
}

/** POST /:slug/snooze { days? } — hide from the feed for a week (default). */
router.post('/:slug/snooze', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const daysRaw = Number(req.body?.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 7;
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await patchBigEventRecord(slug, { snoozedUntil: until, skipped: false }, res);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /:slug/skip — dismiss from the feed (kept in the tracked table). */
router.post('/:slug/skip', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    await patchBigEventRecord(slug, { skipped: true, snoozedUntil: null }, res);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** POST /:slug/restore — clear snooze + skip so it shows in the feed again. */
router.post('/:slug/restore', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    await patchBigEventRecord(slug, { skipped: false, snoozedUntil: null }, res);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** DELETE /:slug — remove from the watchlist + cached research + snapshot. */
router.delete('/:slug', async (req, res) => {
  try {
    const slug = slugFromQuery(String(req.params.slug || ''));
    if (!slug) {
      res.status(400).json({ ok: false, error: 'invalid_slug' });
      return;
    }
    const store = await loadConferenceWatchlistStore(process.env);
    const rec = store.bySlug[slug];

    const criteria = await loadEventsFinderCriteria();
    const names = (Array.isArray(criteria.conferenceWatchlist) ? criteria.conferenceWatchlist : [])
      .filter((name) => slugFromQuery(name) !== slug);
    const saved = await saveEventsFinderCriteria({
      lookFor: criteria.lookFor,
      skip: criteria.skip,
      blacklist: criteria.blacklist,
      conferenceWatchlist: names,
    });
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }

    if (rec?.screenshotPath) await removeBigEventShot(rec.screenshotPath, process.env);
    if (rec?.flierPath) await removeBigEventShot(rec.flierPath, process.env);
    await removeConferenceWatchlistSlugs([slug], process.env);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, slug, conferenceWatchlist: saved.conferenceWatchlist });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
