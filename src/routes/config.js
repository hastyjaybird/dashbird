import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCalendarEmbedUrl } from '../lib/calendar-embed.js';
import {
  calendarWeekUrlFromEmbed,
  resolveCalendarEmbedUrl,
  resolveGoogleCalendarIcalUrl,
} from '../lib/google-calendar-ical.js';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { fetchNwsPointsDocument, mapClickUrlForLatLon } from '../lib/nws-points.js';
const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

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
  const { lat, lon, zip: weatherZip } = await resolveDashboardWeatherLatLon();
  const sfLat = parseFloat(process.env.SF_WEATHER_LAT ?? '37.7749');
  const sfLon = parseFloat(process.env.SF_WEATHER_LON ?? '-122.4194');

  let weatherTimeZone = (process.env.WEATHER_TIME_ZONE || '').trim();
  let nwsMapClickUrl = mapClickUrlForLatLon(lat, lon);
  if (!weatherTimeZone) {
    try {
      const doc = await fetchNwsPointsDocument(lat, lon);
      const tz = doc?.properties?.timeZone;
      if (typeof tz === 'string' && /^[A-Za-z_/+-]+$/.test(tz)) weatherTimeZone = tz;
    } catch {
      /* fall through */
    }
  }
  if (!weatherTimeZone) weatherTimeZone = 'America/Los_Angeles';

  let lastBackupAt = (process.env.LAST_BACKUP_AT || '').trim();
  if (!lastBackupAt) {
    lastBackupAt = await readLastBackupFromFile();
  }

  const calEmbedRaw = (process.env.CALENDAR_EMBED_URL || '').trim();
  const calendarEmbedUrl = resolveCalendarEmbedUrl();
  const calendarEmbedMisconfigured = calEmbedRaw.length > 0 && !normalizeCalendarEmbedUrl(calEmbedRaw);
  const calendarIcalUrl = resolveGoogleCalendarIcalUrl();
  const calendarWeekUrl = calendarEmbedUrl ? calendarWeekUrlFromEmbed(calendarEmbedUrl) : '';

  res.json({
    calendarEmbedUrl,
    calendarEmbedMisconfigured,
    calendarIcalConfigured: calendarIcalUrl.length > 0,
    calendarWeekUrl,
    weatherLat: lat,
    weatherLon: lon,
    weatherZip,
    weatherTimeZone,
    nwsMapClickUrl,
    sfWeatherLat: Number.isFinite(sfLat) ? sfLat : 37.7749,
    sfWeatherLon: Number.isFinite(sfLon) ? sfLon : -122.4194,
    locationLabel: process.env.DASHBOARD_LOCATION_LABEL || 'Oakland, CA · 94608',
    openrouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',
    lastBackupAt,
  });
});

export default router;
