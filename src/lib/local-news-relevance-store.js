/**
 * Cached 1–2 sentence "why this matters" blurbs for Local News articles (keyed by id/url).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CACHE_CAP = 600;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function localNewsRelevancePath(env = process.env) {
  const override = String(env.LOCAL_NEWS_RELEVANCE_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/local-news-relevance.json');
}

/**
 * @param {unknown} raw
 */
function normalize(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const byIdRaw = o.byId && typeof o.byId === 'object' ? o.byId : {};
  /** @type {Record<string, { relevance: string, importance?: number, generatedAt: string }>} */
  const byId = {};
  for (const [id, row] of Object.entries(byIdRaw)) {
    const key = String(id || '').trim().slice(0, 300);
    if (!key) continue;
    const r = row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : {};
    const relevance = String(r.relevance || '').trim().slice(0, 400);
    if (!relevance) continue;
    const importanceRaw = Number(r.importance);
    const importance = Number.isFinite(importanceRaw) && importanceRaw > 0
      ? Math.min(10, Math.max(1, Math.round(importanceRaw)))
      : undefined;
    byId[key] = {
      relevance,
      ...(importance ? { importance } : {}),
      generatedAt: String(r.generatedAt || '').trim().slice(0, 40) || new Date().toISOString(),
    };
  }
  const entries = Object.entries(byId);
  if (entries.length > CACHE_CAP) {
    entries.sort((a, b) => Date.parse(b[1].generatedAt) - Date.parse(a[1].generatedAt));
    const trimmed = Object.fromEntries(entries.slice(0, CACHE_CAP));
    return { byId: trimmed };
  }
  return { byId };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadLocalNewsRelevance(env = process.env) {
  try {
    const raw = await fs.readFile(localNewsRelevancePath(env), 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return { byId: {} };
  }
}

/**
 * @param {{ byId: Record<string, { relevance: string, generatedAt: string }> }} cache
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCache(cache, env) {
  const target = localNewsRelevancePath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

/**
 * @param {Record<string, { relevance: string, generatedAt?: string }>} rows
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function upsertLocalNewsRelevance(rows, env = process.env) {
  const cache = await loadLocalNewsRelevance(env);
  const now = new Date().toISOString();
  for (const [id, row] of Object.entries(rows)) {
    const key = String(id || '').trim().slice(0, 300);
    const relevance = String(row?.relevance || '').trim().slice(0, 400);
    if (!key || !relevance) continue;
    const importanceRaw = Number(row?.importance);
    const importance = Number.isFinite(importanceRaw) && importanceRaw > 0
      ? Math.min(10, Math.max(1, Math.round(importanceRaw)))
      : undefined;
    cache.byId[key] = {
      relevance,
      ...(importance ? { importance } : {}),
      generatedAt: row?.generatedAt || now,
    };
  }
  const normalized = normalize(cache);
  await writeCache(normalized, env);
  return normalized;
}
