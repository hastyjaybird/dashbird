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
import { resolveActiveLocation } from '../lib/resolve-active-location.js';
import { loadAwayBase, getActiveAwayProfile } from '../lib/away-base-store.js';
import { fetchNwsPointsDocument, mapClickUrlForLatLon } from '../lib/nws-points.js';
import { reverseGeocodeCoords } from '../lib/reverse-geocode.js';
import { resolveSecondaryWatchLocation } from '../lib/secondary-watch-location.js';

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
  const homeLoc = await resolveDashboardWeatherLatLon();
  const awayState = await loadAwayBase();
  const active = await resolveActiveLocation({
    forceMode: awayState.autoAway ? 'away' : awayState.preview ? 'preview' : 'home',
  });
  const useAway = active.mode === 'preview' || active.mode === 'away';
  const lat = useAway ? active.lat : homeLoc.lat;
  const lon = useAway ? active.lon : homeLoc.lon;
  const weatherZip = useAway ? active.zip : homeLoc.zip;
  const weatherPlace = useAway ? active.place : homeLoc.place;
  const stateAbbrev = useAway ? active.stateAbbrev : homeLoc.stateAbbrev;

  // Second hero weather tile: Settings → Secondary ZIP when set; else SF_WEATHER_* env.
  let sfLat = parseFloat(process.env.SF_WEATHER_LAT ?? '37.7749');
  let sfLon = parseFloat(process.env.SF_WEATHER_LON ?? '-122.4194');
  let sfWeatherPlace = 'San Francisco';
  let sfWeatherZip = null;
  if (String(process.env.SECONDARY_WATCH || '').trim() !== '0') {
    try {
      const secondary = await resolveSecondaryWatchLocation();
      if (secondary && Number.isFinite(secondary.lat) && Number.isFinite(secondary.lon)) {
        sfLat = secondary.lat;
        sfLon = secondary.lon;
        sfWeatherZip = secondary.zip || null;
        if (typeof secondary.place === 'string' && secondary.place.trim()) {
          sfWeatherPlace = secondary.place.trim();
        }
      }
    } catch {
      /* keep SF_WEATHER_* fallback */
    }
  }

  let weatherTimeZone = useAway
    ? (active.timeZone || '').trim()
    : (process.env.WEATHER_TIME_ZONE || '').trim();
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

  const awayProfile = getActiveAwayProfile(awayState);
  const locationMode = active.mode;
  const effectiveLabel = useAway
    ? active.label
    : envLabel || `${placeLabel}${weatherZip ? ` · ${weatherZip}` : ''}`;

  // Preview: secondary tile shows home. Auto-away: client hides secondary.
  let outSfLat = Number.isFinite(sfLat) ? sfLat : 37.7749;
  let outSfLon = Number.isFinite(sfLon) ? sfLon : -122.4194;
  let outSfPlace = sfWeatherPlace;
  let outSfZip = sfWeatherZip;
  if (locationMode === 'preview') {
    outSfLat = homeLoc.lat;
    outSfLon = homeLoc.lon;
    outSfPlace = homeLoc.place || envLabel || 'Home';
    outSfZip = homeLoc.zip;
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
    weatherPlace: useAway ? (active.place || active.label || placeLabel) : placeLabel,
    weatherTimeZone,
    nwsMapClickUrl,
    sfWeatherLat: outSfLat,
    sfWeatherLon: outSfLon,
    sfWeatherPlace: outSfPlace,
    sfWeatherZip: outSfZip,
    locationLabel: effectiveLabel,
    locationMode,
    homeBase: {
      lat: homeLoc.lat,
      lon: homeLoc.lon,
      zip: homeLoc.zip,
      place: homeLoc.place,
      label: envLabel || homeLoc.place || 'Home',
      timeZone: (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles',
    },
    awayBase: awayProfile
      ? {
          id: awayProfile.id,
          label: awayProfile.label,
          zip: awayProfile.zip,
          timeZone: awayProfile.timeZone,
          radiusMi: awayProfile.radiusMi,
          preview: awayState.preview === true,
          autoAway: awayState.autoAway === true,
          hideEarth: Array.isArray(awayProfile.hideEarth) ? awayProfile.hideEarth : [],
          events: awayProfile.events || null,
          lat: useAway ? active.lat : null,
          lon: useAway ? active.lon : null,
        }
      : null,
    hideEarth: useAway && Array.isArray(active.hideEarth) ? active.hideEarth : [],
    awayOnly: locationMode === 'away',
    lastBackupAt,
    vikunjaConfigured,
    vikunjaProjectConfigured: vikunjaConfigured && vikunjaProjectId != null,
    vikunjaPublicUrl,
  });
});

export default router;
