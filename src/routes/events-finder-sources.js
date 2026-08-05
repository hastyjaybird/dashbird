/**
 * POST /api/events-finder-sources — add a bookmark to Personal → Events.
 * Body: { label, url, icon? }
 *
 * For venue/community event listing URLs (not Partiful/Luma/etc.), the bookmark
 * is picked up by webpage-listings ingest on the next Events feed refresh.
 */
import { Router } from 'express';
import express from 'express';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEventsFinderSources } from '../lib/events-finder-sources.js';
import {
  isWebpageListingHost,
  webpageListingsCachePath,
} from '../lib/events-finder-webpage-listings.js';

const router = Router();
router.use(express.json({ limit: '64kb' }));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOKMARKS_PERSONAL = path.join(root, 'public/data/bookmarks-personal.json');

/**
 * @param {string} href
 * @returns {string | null}
 */
function normalizeHttpUrl(href) {
  try {
    const u = new URL(String(href || '').trim());
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

router.get('/', async (_req, res) => {
  try {
    const sources = await loadEventsFinderSources();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, sources });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), sources: [] });
  }
});

router.post('/', async (req, res) => {
  try {
    const url = normalizeHttpUrl(req.body?.url || req.body?.href);
    const label = String(req.body?.label || req.body?.word || req.body?.title || '')
      .trim()
      .slice(0, 80);
    const icon =
      typeof req.body?.icon === 'string' && req.body.icon.trim()
        ? req.body.icon.trim().slice(0, 500)
        : null;

    if (!url) {
      res.status(400).json({ ok: false, error: 'url must be http(s)' });
      return;
    }
    if (!label) {
      res.status(400).json({ ok: false, error: 'label is required' });
      return;
    }

    let raw;
    try {
      raw = JSON.parse(await readFile(BOOKMARKS_PERSONAL, 'utf8'));
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: `Could not read bookmarks-personal.json: ${e?.message || e}`,
      });
      return;
    }

    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) {
      res.status(500).json({ ok: false, error: 'bookmarks-personal.json has no sections[]' });
      return;
    }

    let section = raw.sections.find(
      (s) => String(s?.title || '').trim().toLowerCase() === 'events',
    );
    if (!section) {
      section = { title: 'Events', items: [] };
      raw.sections.push(section);
    }
    if (!Array.isArray(section.items)) section.items = [];

    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const dup = section.items.find((it) => {
      try {
        const h = new URL(String(it?.href || '')).hostname.replace(/^www\./, '').toLowerCase();
        const sameHost = h === host;
        const sameLabel =
          String(it?.word || it?.title || '')
            .trim()
            .toLowerCase() === label.toLowerCase();
        const sameUrl =
          String(it?.href || '')
            .trim()
            .replace(/\/+$/, '')
            .toLowerCase() === url.replace(/\/+$/, '').toLowerCase();
        return (sameHost && sameLabel) || sameUrl;
      } catch {
        return false;
      }
    });
    if (dup) {
      res.status(409).json({ ok: false, error: 'Source with that label + host already exists' });
      return;
    }

    /** @type {{ word: string, href: string, icon?: string, title?: string }} */
    const item = { word: label, href: url };
    if (icon) item.icon = icon;
    if (isWebpageListingHost(host)) {
      item.title = `Event listing page — ingested via webpage listings`;
    }
    section.items.push(item);

    await writeFile(BOOKMARKS_PERSONAL, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    // Bust webpage-listings cache so the new URL is fetched on next ingest.
    if (isWebpageListingHost(host)) {
      try {
        await unlink(webpageListingsCachePath(process.env));
      } catch {
        /* no cache yet */
      }
    }

    const sources = await loadEventsFinderSources();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      added: item,
      sources,
      webpageListing: isWebpageListingHost(host),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * DELETE /api/events-finder-sources — remove a Personal → Events bookmark by url or id.
 * Body: { url } or { id } (id is `events-source:<host>` style from loadEventsFinderSources).
 */
router.delete('/', async (req, res) => {
  try {
    const url = normalizeHttpUrl(req.body?.url || req.body?.href);
    const id = String(req.body?.id || '').trim();
    if (!url && !id) {
      res.status(400).json({ ok: false, error: 'url or id required' });
      return;
    }

    let raw;
    try {
      raw = JSON.parse(await readFile(BOOKMARKS_PERSONAL, 'utf8'));
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: `Could not read bookmarks-personal.json: ${e?.message || e}`,
      });
      return;
    }

    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) {
      res.status(500).json({ ok: false, error: 'bookmarks-personal.json has no sections[]' });
      return;
    }

    const section = raw.sections.find(
      (s) => String(s?.title || '').trim().toLowerCase() === 'events',
    );
    if (!section || !Array.isArray(section.items)) {
      res.status(404).json({ ok: false, error: 'events_section_missing' });
      return;
    }

    /** Resolve bookmark URL when client only sent a source id. */
    let removeUrl = url;
    if (!removeUrl && id) {
      const current = await loadEventsFinderSources();
      const match = current.find((s) => s.id === id);
      if (match?.url) removeUrl = normalizeHttpUrl(match.url);
    }

    const before = section.items.length;
    section.items = section.items.filter((it) => {
      const href = String(it?.href || '').trim();
      if (removeUrl) {
        try {
          const a = new URL(href).toString().replace(/\/+$/, '').toLowerCase();
          const b = removeUrl.replace(/\/+$/, '').toLowerCase();
          if (a === b) return false;
        } catch {
          /* keep */
        }
      }
      return true;
    });

    if (section.items.length === before) {
      res.status(404).json({ ok: false, error: 'source_not_found' });
      return;
    }

    await writeFile(BOOKMARKS_PERSONAL, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    try {
      await unlink(webpageListingsCachePath(process.env));
    } catch {
      /* no cache */
    }

    const sources = await loadEventsFinderSources();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, sources });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /api/events-finder-sources/rescrape — bust webpage listings cache so next
 * Events feed refresh re-pulls listing pages.
 */
router.post('/rescrape', async (_req, res) => {
  try {
    try {
      await unlink(webpageListingsCachePath(process.env));
    } catch {
      /* no cache yet */
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, cacheCleared: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
