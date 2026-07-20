/**
 * GET/POST /api/device-place — a single last-known device location so the phone's
 * live GPS fix can seed weather/aircraft on a laptop that has no geolocation of
 * its own. Single-user dashboard, so one record is enough.
 */
import { Router } from 'express';
import express from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEVICE_PLACE_PATH = path.join(root, 'data', 'device-place.json');

// Ignore stale fixes so a laptop does not resurrect a location from days ago.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

const router = Router();
router.use(express.json({ limit: '16kb' }));

/** @returns {Promise<{ lat:number, lon:number, shortLabel:string, timeZone:string, savedAt:number } | null>} */
async function readPlace() {
  try {
    const j = JSON.parse(await readFile(DEVICE_PLACE_PATH, 'utf8'));
    const lat = Number(j?.lat);
    const lon = Number(j?.lon);
    const savedAt = Number(j?.savedAt) || 0;
    const shortLabel = typeof j?.shortLabel === 'string' ? j.shortLabel.trim() : '';
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !shortLabel) return null;
    return {
      lat,
      lon,
      shortLabel,
      timeZone: typeof j?.timeZone === 'string' ? j.timeZone : '',
      savedAt,
    };
  } catch {
    return null;
  }
}

router.get('/', async (_req, res) => {
  const place = await readPlace();
  res.setHeader('Cache-Control', 'private, no-store');
  if (!place || (place.savedAt && Date.now() - place.savedAt > MAX_AGE_MS)) {
    res.json({ ok: true, place: null });
    return;
  }
  res.json({ ok: true, place });
});

router.post('/', async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lon = Number(req.body?.lon);
    const shortLabel = String(req.body?.shortLabel || '').trim();
    const timeZone = String(req.body?.timeZone || '').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !shortLabel) {
      res.status(400).json({ ok: false, error: 'lat, lon and shortLabel are required' });
      return;
    }
    if (shortLabel === 'Locating…' || shortLabel === 'Location unavailable') {
      res.status(400).json({ ok: false, error: 'placeholder label rejected' });
      return;
    }
    const record = { lat, lon, shortLabel, timeZone, savedAt: Date.now() };
    await mkdir(path.dirname(DEVICE_PLACE_PATH), { recursive: true });
    await writeFile(DEVICE_PLACE_PATH, JSON.stringify(record, null, 2));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, place: record });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
