import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildVariablesPayload,
  DASHBOARD_SETTING_VARIABLES,
} from '../lib/dashboard-settings-registry.js';
import { getMonitoringSourcesPayload } from '../lib/dashboard-monitoring-sources.js';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { resolveGoogleCalendarIcalUrl } from '../lib/google-calendar-ical.js';
import { fetchNwsPointsDocument } from '../lib/nws-points.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..', '..');

async function readLastBackupFromFile() {
  try {
    const fp = path.join(projectRoot, 'public/data/last-backup.txt');
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

/**
 * Build resolved values for registry keys (env + a few computed fields).
 */
async function buildResolvedEnv() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const def of DASHBOARD_SETTING_VARIABLES) {
    out[def.key] = process.env[def.key] ?? '';
  }

  const { lat, lon, zip } = await resolveDashboardWeatherLatLon();
  out._resolved_weather_lat = String(lat);
  out._resolved_weather_lon = String(lon);
  if (zip) out._resolved_weather_zip = zip;

  let tz = (process.env.WEATHER_TIME_ZONE || '').trim();
  if (!tz) {
    try {
      const doc = await fetchNwsPointsDocument(lat, lon);
      tz = doc?.properties?.timeZone || '';
    } catch {
      /* ignore */
    }
  }
  if (tz) out._resolved_weather_time_zone = tz;

  const ical = resolveGoogleCalendarIcalUrl();
  if (ical) out._resolved_calendar_ical = '(configured)';

  const backupFile = await readLastBackupFromFile();
  if (!out.LAST_BACKUP_AT?.trim() && backupFile) out.LAST_BACKUP_AT = backupFile;

  return out;
}

router.get('/', async (_req, res) => {
  try {
    const resolved = await buildResolvedEnv();
    const { groups, variables } = buildVariablesPayload(resolved);
    const feeds = getMonitoringSourcesPayload();
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json({
      ok: true,
      groups,
      variables,
      feedGroups: feeds.groups,
      feeds: feeds.items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
