/**
 * Last known good CNN Fear & Greed reading (score > 0) for stale fallback.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** @type {object | null} */
let memoryLast = null;

export function fearGreedLastPath(env = process.env) {
  const override = String(env.FEAR_GREED_LAST_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/fear-greed-last.json');
}

/**
 * @param {number} score
 */
export function isPublishableFearGreedScore(score) {
  const n = Number(score);
  return Number.isFinite(n) && n > 0;
}

/**
 * @returns {Promise<object | null>}
 */
export async function loadLastFearGreedReading() {
  if (memoryLast?.ok && isPublishableFearGreedScore(memoryLast.score)) {
    return memoryLast;
  }
  const p = fearGreedLastPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw);
    if (j?.ok && isPublishableFearGreedScore(j.score)) {
      memoryLast = j;
      return j;
    }
  } catch {
    /* no file yet */
  }
  return null;
}

/**
 * @param {object} reading
 */
export async function saveLastFearGreedReading(reading) {
  if (!reading?.ok || !isPublishableFearGreedScore(reading.score)) return;
  const payload = { ...reading, savedAt: new Date().toISOString() };
  memoryLast = payload;
  const p = fearGreedLastPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * @param {object} reading
 */
export function withStaleFearGreed(reading, reason) {
  return {
    ...reading,
    ok: true,
    stale: true,
    staleReason: reason || 'unavailable',
  };
}
