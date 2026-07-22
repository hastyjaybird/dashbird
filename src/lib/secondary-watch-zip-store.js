/**
 * Second ZIP for the hero’s comparison weather tile and regional phenology
 * (fireflies, fall foliage).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEED_PATH = path.join(PKG_ROOT, 'src/data/secondary-watch-zip.default.json');

const DEFAULT_ZIP = '24066';

export function secondaryWatchZipPath(env = process.env) {
  const override = String(env.SECONDARY_WATCH_ZIP_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/secondary-watch-zip.json');
}

async function ensureFile() {
  const live = secondaryWatchZipPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    try {
      await fs.copyFile(SEED_PATH, live);
    } catch {
      await fs.writeFile(live, `${JSON.stringify({ zip: DEFAULT_ZIP }, null, 2)}\n`, 'utf8');
    }
    return live;
  }
}

/**
 * @returns {Promise<string>} 5-digit ZIP
 */
export async function loadSecondaryWatchZip() {
  const fromEnv = String(process.env.SECONDARY_WATCH_ZIP || '').replace(/\D/g, '');
  if (fromEnv.length === 5) return fromEnv;
  const live = await ensureFile();
  const j = JSON.parse(await fs.readFile(live, 'utf8'));
  const z = String(j?.zip || '').replace(/\D/g, '');
  return z.length === 5 ? z : DEFAULT_ZIP;
}

/**
 * @param {string} zip
 */
export async function saveSecondaryWatchZip(zip) {
  const z = String(zip || '').replace(/\D/g, '');
  if (z.length !== 5) {
    return { ok: false, error: 'invalid_zip' };
  }
  const live = await ensureFile();
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ zip: z }, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
  return { ok: true, zip: z };
}
