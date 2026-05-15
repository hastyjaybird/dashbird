import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCalendarEmbedUrl } from '../lib/calendar-embed.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Default: Oakland, CA 94608 (Open-Meteo uses lat/lon)
const DEFAULT_LAT = 37.848;
const DEFAULT_LON = -122.253;

async function readLastBackupFromFile() {
  try {
    const fp = path.join(root, 'public/data/last-backup.txt');
    const raw = await readFile(fp, 'utf8');
    const line = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#'));
    return line || '';
  } catch {
    return '';
  }
}

router.get('/', async (req, res) => {
  const lat = parseFloat(process.env.WEATHER_LAT ?? String(DEFAULT_LAT));
  const lon = parseFloat(process.env.WEATHER_LON ?? String(DEFAULT_LON));
  const sfLat = parseFloat(process.env.SF_WEATHER_LAT ?? '37.7749');
  const sfLon = parseFloat(process.env.SF_WEATHER_LON ?? '-122.4194');

  let lastBackupAt = (process.env.LAST_BACKUP_AT || '').trim();
  if (!lastBackupAt) {
    lastBackupAt = await readLastBackupFromFile();
  }

  const calRaw = (process.env.CALENDAR_EMBED_URL || '').trim();
  const calendarEmbedUrl = normalizeCalendarEmbedUrl(process.env.CALENDAR_EMBED_URL);
  const calendarEmbedMisconfigured = calRaw.length > 0 && !calendarEmbedUrl;

  res.json({
    calendarEmbedUrl,
    calendarEmbedMisconfigured,
    weatherLat: Number.isFinite(lat) ? lat : DEFAULT_LAT,
    weatherLon: Number.isFinite(lon) ? lon : DEFAULT_LON,
    sfWeatherLat: Number.isFinite(sfLat) ? sfLat : 37.7749,
    sfWeatherLon: Number.isFinite(sfLon) ? sfLon : -122.4194,
    locationLabel: process.env.DASHBOARD_LOCATION_LABEL || 'Oakland, CA · 94608',
    openrouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
    lastBackupAt,
  });
});

export default router;
