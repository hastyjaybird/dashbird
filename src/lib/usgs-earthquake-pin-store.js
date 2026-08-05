/**
 * Persist the Earth-strip earthquake row while it remains within 24 hours
 * of the USGS event time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE_VERSION = 1;
const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** How long after the quake occurred the Earth-strip row stays active. */
export const EARTHQUAKE_DISPLAY_MS = 24 * 60 * 60 * 1000;

function storePathFromEnv(env = process.env) {
  const override = String(env.USGS_EARTHQUAKE_PIN_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data', 'usgs-earthquake-pin.json');
}

/**
 * @param {number} lat
 * @param {number} lon
 */
export function earthquakePinLocationKey(lat, lon) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
}

async function ensureDataDir() {
  await fs.mkdir(path.join(PKG_ROOT, 'data'), { recursive: true });
}

async function readStore() {
  const p = storePathFromEnv();
  try {
    const j = JSON.parse(await fs.readFile(p, 'utf8'));
    if (j?.version === STORE_VERSION && j.pins && typeof j.pins === 'object') return j;
  } catch {
    /* empty */
  }
  return { version: STORE_VERSION, pins: {} };
}

/**
 * @param {object} doc
 */
async function writeStore(doc) {
  await ensureDataDir();
  const p = storePathFromEnv();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * @param {string} locationKey
 * @returns {Promise<object | null>}
 */
export async function loadEarthquakePin(locationKey) {
  const doc = await readStore();
  const row = doc.pins[locationKey];
  return row && typeof row === 'object' ? row : null;
}

/**
 * @param {string} locationKey
 * @param {object | null} pin
 */
export async function saveEarthquakePin(locationKey, pin) {
  const doc = await readStore();
  if (pin) doc.pins[locationKey] = pin;
  else delete doc.pins[locationKey];
  await writeStore(doc);
}
