/**
 * POST /api/events-finder-sources — add a bookmark to Personal → Events.
 * Body: { label, url, icon? }
 */
import { Router } from 'express';
import express from 'express';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEventsFinderSources } from '../lib/events-finder-sources.js';

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
        return h === host && String(it?.word || it?.title || '').trim().toLowerCase() === label.toLowerCase();
      } catch {
        return false;
      }
    });
    if (dup) {
      res.status(409).json({ ok: false, error: 'Source with that label + host already exists' });
      return;
    }

    /** @type {{ word: string, href: string, icon?: string }} */
    const item = { word: label, href: url };
    if (icon) item.icon = icon;
    section.items.push(item);

    await writeFile(BOOKMARKS_PERSONAL, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const sources = await loadEventsFinderSources();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, added: item, sources });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
