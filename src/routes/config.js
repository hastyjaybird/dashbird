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
import { resolveEventsFinderGoogleCalendar } from '../lib/events-finder-google-calendar.js';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { fetchNwsPointsDocument, mapClickUrlForLatLon } from '../lib/nws-points.js';
import { reverseGeocodeCoords } from '../lib/reverse-geocode.js';
const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function readLanOriginFromFile() {
  try {
    const fp = path.join(root, 'public/data/phone-lan-url.txt');
    const raw = (await readFile(fp, 'utf8')).trim();
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return raw.replace(/\/+$/, '');
    }
  } catch {
    /* missing or unreadable */
  }
  return '';
}

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
  const { lat, lon, zip: weatherZip, place: weatherPlace, stateAbbrev } =
    await resolveDashboardWeatherLatLon();
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
  const { authuser: googleCalendarAuthuser } = resolveEventsFinderGoogleCalendar();

  const lanRaw = (process.env.DASHBOARD_LAN_ORIGIN || '').trim();
  let lanOrigin =
    lanRaw.startsWith('http://') || lanRaw.startsWith('https://') ? lanRaw.replace(/\/+$/, '') : '';
  if (!lanOrigin) {
    lanOrigin = await readLanOriginFromFile();
  }

  const envLabel = String(process.env.DASHBOARD_LOCATION_LABEL || '').trim();
  let placeLabel =
    (typeof weatherPlace === 'string' && weatherPlace.trim()) ||
    (envLabel ? envLabel.split('·')[0].trim() : '') ||
    '';
  if (!placeLabel) {
    try {
      const rev = await reverseGeocodeCoords(lat, lon);
      if (rev?.shortLabel) placeLabel = rev.shortLabel;
    } catch {
      /* fall through */
    }
  }
  if (!placeLabel) {
    placeLabel =
      (weatherZip && stateAbbrev ? `${weatherZip}, ${stateAbbrev}` : '') ||
      envLabel ||
      'Oakland, CA';
  }

  const vikunjaBase = String(process.env.VIKUNJA_BASE_URL || '').trim();
  const vikunjaToken = String(process.env.VIKUNJA_TOKEN || '').trim();
  const vikunjaProject = String(process.env.VIKUNJA_PROJECT_ID || '').trim();
  const vikunjaConfigured = Boolean(vikunjaBase && vikunjaToken);
  const vikunjaProjectId =
    vikunjaProject && /^\d+$/.test(vikunjaProject) ? Number(vikunjaProject) : null;

  let vikunjaPublicUrl = String(process.env.VIKUNJA_SERVICE_PUBLICURL || '').trim();
  if (vikunjaPublicUrl) {
    vikunjaPublicUrl = vikunjaPublicUrl.replace(/\/+$/, '') + '/';
  } else if (vikunjaConfigured) {
    // Fall back: host-facing URL when PUBLICURL unset (Docker hostname is not browser-reachable).
    const hostPort = String(process.env.VIKUNJA_HOST_PORT || '3456').trim() || '3456';
    if (lanOrigin) {
      try {
        const u = new URL(lanOrigin);
        vikunjaPublicUrl = `${u.protocol}//${u.hostname}:${hostPort}/`;
      } catch {
        vikunjaPublicUrl = `http://127.0.0.1:${hostPort}/`;
      }
    } else {
      vikunjaPublicUrl = `http://127.0.0.1:${hostPort}/`;
    }
  }

  res.json({
    lanOrigin,
    calendarEmbedUrl,
    calendarEmbedMisconfigured,
    calendarIcalConfigured: calendarIcalUrl.length > 0,
    calendarWeekUrl,
    googleCalendarAuthuser,
    weatherLat: lat,
    weatherLon: lon,
    weatherZip,
    weatherPlace: placeLabel,
    weatherTimeZone,
    nwsMapClickUrl,
    sfWeatherLat: Number.isFinite(sfLat) ? sfLat : 37.7749,
    sfWeatherLon: Number.isFinite(sfLon) ? sfLon : -122.4194,
    locationLabel: envLabel || `${placeLabel}${weatherZip ? ` · ${weatherZip}` : ''}`,
    lastBackupAt,
    vikunjaConfigured,
    vikunjaProjectConfigured: vikunjaConfigured && vikunjaProjectId != null,
    vikunjaPublicUrl,
  });
});

export default router;
