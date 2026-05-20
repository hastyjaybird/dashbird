import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineMiles } from './dashboard-geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', '..', 'public', 'data', 'diablo-tarantula-season.json');

/**
 * @param {string} wallYmd YYYY-MM-DD
 * @param {{ startMonth: number, startDay: number, endMonth: number, endDay: number }} rec
 */
export function isWallYmdInTarantulaRecurrence(wallYmd, rec) {
  if (!rec || typeof wallYmd !== 'string' || wallYmd.length < 10) return false;
  const y = Number.parseInt(wallYmd.slice(0, 4), 10);
  const sm = Number(rec.startMonth);
  const sd = Number(rec.startDay);
  const em = Number(rec.endMonth);
  const ed = Number(rec.endDay);
  if (!Number.isFinite(y) || !Number.isFinite(sm) || !Number.isFinite(sd) || !Number.isFinite(em) || !Number.isFinite(ed)) {
    return false;
  }
  const cur = new Date(Date.UTC(y, sm - 1, sd));
  const end = new Date(Date.UTC(y, em - 1, ed));
  const today = new Date(Date.UTC(y, Number.parseInt(wallYmd.slice(5, 7), 10) - 1, Number.parseInt(wallYmd.slice(8, 10), 10)));
  return today.getTime() >= cur.getTime() && today.getTime() <= end.getTime();
}

/**
 * @returns {Promise<object | null>}
 */
export async function loadDiabloTarantulaSeasonConfig() {
  try {
    const raw = await readFile(DATA_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * @param {object} p
 * @param {number} p.lat
 * @param {number} p.lon
 * @param {object} p.cfg
 * @param {number} p.radiusMiles
 */
export function isDashboardInDiabloTarantulaRegion(p) {
  const latA = Number(p.cfg?.anchorLat);
  const lonA = Number(p.cfg?.anchorLon);
  if (!Number.isFinite(latA) || !Number.isFinite(lonA)) return false;
  const d = haversineMiles(p.lat, p.lon, latA, lonA);
  return Number.isFinite(d) && d <= p.radiusMiles;
}
