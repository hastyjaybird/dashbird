/**
 * Aggregated Events finder feed (Gmail + Facebook/Apify; more sources later).
 * Live sources upsert into local SQLite; the feed is served from the catalog.
 */
import { Router } from 'express';
import { loadEventsFinderCriteria } from '../lib/events-finder-criteria-store.js';
import { fetchFacebookEvents } from '../lib/events-finder-facebook.js';
import {
  compareEventsByGeo,
  eventPassesFeedFilters,
  resolveEventsFinderGeo,
} from '../lib/events-finder-geo.js';
import { fetchGmailEventAnnouncements } from '../lib/events-finder-gmail.js';
import {
  dedupeEventsByNameAndDate,
  getEventsFinderStoreStats,
  listEventsFinderEvents,
  pruneEventsFinderEvents,
  upsertEventsFinderEvents,
} from '../lib/events-finder-store.js';

const router = Router();

/**
 * GET /api/events-finder/events — normalized events after geo/feed filters.
 * Query: ?refreshFacebook=1 — force a live Apify run (bypasses cache).
 */
router.get('/', async (req, res) => {
  try {
    const criteria = await loadEventsFinderCriteria();
    const geo = await resolveEventsFinderGeo(process.env);
    const forceFacebook =
      req.query.refreshFacebook === '1'
      || req.query.refreshFacebook === 'true'
      || String(req.query.refreshFacebook || '').toLowerCase() === 'yes';

    const [gmail, facebook] = await Promise.all([
      fetchGmailEventAnnouncements(process.env),
      fetchFacebookEvents(process.env, { forceRefresh: forceFacebook }),
    ]);

    const home = {
      lat: geo.lat,
      lon: geo.lon,
      homeCities: geo.homeCities || [],
      city: geo.city,
      place: geo.place,
    };

    /** @type {Array<object>} */
    const batch = [
      ...(Array.isArray(gmail.events) ? gmail.events : []),
      ...(Array.isArray(facebook.events) ? facebook.events : []),
    ];

    let upserted = 0;
    let skipped = 0;
    let pruned = 0;
    try {
      const result = upsertEventsFinderEvents(batch, process.env);
      upserted = result.upserted;
      skipped = result.skipped;
      pruned = pruneEventsFinderEvents({ env: process.env });
    } catch (storeErr) {
      // Feed still works from this request's batch if the DB write fails.
      console.warn('[events-finder] sqlite upsert failed:', storeErr?.message || storeErr);
    }

    let raw;
    try {
      raw = listEventsFinderEvents({ env: process.env });
      if (!raw.length && batch.length) raw = batch;
    } catch (listErr) {
      console.warn('[events-finder] sqlite list failed:', listErr?.message || listErr);
      raw = batch;
    }

    const timeZone =
      String(process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
      || 'America/Los_Angeles';
    const { events: deduped, removed: dedupedRemoved } = dedupeEventsByNameAndDate(raw, {
      timeZone,
    });

    const hidden = new Set(
      (Array.isArray(criteria.hiddenEventIds) ? criteria.hiddenEventIds : []).map((id) =>
        String(id || '').trim(),
      ),
    );
    const filtered = [];
    for (const event of deduped) {
      const eventId = String(event?.id || '').trim();
      if (eventId && hidden.has(eventId)) continue;
      const gate = eventPassesFeedFilters(event, criteria.filters || {}, home);
      if (!gate.ok) continue;
      filtered.push({
        ...event,
        distanceMiles: gate.distanceMiles,
        cityMatch: gate.cityMatch,
      });
    }

    filtered.sort(compareEventsByGeo);

    let store = null;
    try {
      store = {
        ...getEventsFinderStoreStats(process.env),
        upserted,
        skipped,
        pruned,
        dedupedRemoved,
      };
    } catch {
      store = { upserted, skipped, pruned, dedupedRemoved, error: 'stats unavailable' };
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      sources: {
        gmail: {
          ok: gmail.ok === true,
          email: gmail.email || null,
          emails: gmail.emails || null,
          accounts: gmail.accounts || null,
          error: gmail.error || null,
          hint: gmail.hint || null,
          scanned: gmail.scanned ?? 0,
          count: Array.isArray(gmail.events) ? gmail.events.length : 0,
        },
        facebook: {
          ok: facebook.ok === true,
          error: facebook.error || null,
          hint: facebook.hint || null,
          fromCache: facebook.fromCache === true,
          stale: facebook.stale === true,
          refreshing: facebook.refreshing === true,
          cachedAt: facebook.cachedAt || null,
          searchQueries: facebook.searchQueries || [],
          startUrls: facebook.startUrls || [],
          scanned: facebook.scanned ?? 0,
          count: Array.isArray(facebook.events) ? facebook.events.length : 0,
        },
      },
      store,
      filters: criteria.filters,
      geo,
      events: filtered,
      totalRaw: raw.length,
      totalDeduped: deduped.length,
      total: filtered.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), events: [] });
  }
});

export default router;
