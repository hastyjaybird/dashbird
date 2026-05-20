/**
 * Persisted Air Quality "force show" override (Settings checkbox).
 * Falls back to AIR_QUALITY_FORCE_SHOW when no saved preference exists.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function airQualityForceShowPath(env = process.env) {
  const override = String(env.AIR_QUALITY_FORCE_SHOW_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/air-quality-force-show.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function airQualityForceShowFromEnv(env = process.env) {
  const v = String(env.AIR_QUALITY_FORCE_SHOW ?? '1').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @returns {Promise<boolean>}
 */
export async function loadAirQualityForceShow() {
  const live = airQualityForceShowPath();
  try {
    const j = JSON.parse(await fs.readFile(live, 'utf8'));
    if (typeof j?.forceShow === 'boolean') return j.forceShow;
  } catch {
    /* no saved file — use env default */
  }
  return airQualityForceShowFromEnv();
}

/**
 * @param {boolean} forceShow
 */
export async function saveAirQualityForceShow(forceShow) {
  const live = airQualityForceShowPath();
  await fs.mkdir(path.dirname(live), { recursive: true });
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    tmp,
    `${JSON.stringify({ forceShow: Boolean(forceShow) }, null, 2)}\n`,
    'utf8',
  );
  await fs.rename(tmp, live);
  return { ok: true, forceShow: Boolean(forceShow) };
}
