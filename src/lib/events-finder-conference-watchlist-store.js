/**
 * Cached research for user-added big conferences / festivals (Events Finder watchlist).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CACHE_CAP = 80;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function conferenceWatchlistStorePath(env = process.env) {
  const override = String(env.EVENTS_FINDER_CONFERENCE_WATCHLIST_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/events-finder-conference-watchlist.json');
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return s;
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const query = String(r.query || '').trim().slice(0, 120);
  if (!query) return null;
  const slug = String(r.slug || slugFromQuery(query)).trim().slice(0, 100);
  if (!slug) return null;
  return {
    slug,
    query,
    name: String(r.name || query).trim().slice(0, 160) || query,
    url: String(r.url || '').trim().slice(0, 500) || null,
    eventStart: normalizeDate(r.eventStart),
    eventEnd: normalizeDate(r.eventEnd),
    venue: String(r.venue || '').trim().slice(0, 160) || null,
    city: String(r.city || '').trim().slice(0, 80) || null,
    ticketPrice: String(r.ticketPrice || '').trim().slice(0, 120) || null,
    earlyBirdStart: normalizeDate(r.earlyBirdStart),
    earlyBirdEnd: normalizeDate(r.earlyBirdEnd),
    notes: String(r.notes || '').trim().slice(0, 400) || null,
    error: String(r.error || '').trim().slice(0, 200) || null,
    researching: r.researching === true,
    researchedAt: String(r.researchedAt || '').trim().slice(0, 40) || null,
  };
}

/**
 * @param {string} query
 * @returns {string}
 */
export function slugFromQuery(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * @param {unknown} raw
 */
function normalize(raw) {
  const o = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const bySlugRaw = o.bySlug && typeof o.bySlug === 'object' ? o.bySlug : {};
  /** @type {Record<string, ReturnType<typeof normalizeRecord>>} */
  const bySlug = {};
  for (const [key, row] of Object.entries(bySlugRaw)) {
    const slug = String(key || '').trim().slice(0, 100);
    const rec = normalizeRecord({ .../** @type {object} */ (row), slug, query: row?.query || slug });
    if (!slug || !rec) continue;
    bySlug[slug] = rec;
  }
  const entries = Object.entries(bySlug);
  if (entries.length > CACHE_CAP) {
    entries.sort((a, b) => Date.parse(b[1].researchedAt || '') - Date.parse(a[1].researchedAt || ''));
    return { bySlug: Object.fromEntries(entries.slice(0, CACHE_CAP)) };
  }
  return { bySlug };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConferenceWatchlistStore(env = process.env) {
  try {
    const raw = await fs.readFile(conferenceWatchlistStorePath(env), 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return { bySlug: {} };
  }
}

/**
 * @param {{ bySlug: Record<string, object> }} cache
 * @param {NodeJS.ProcessEnv} [env]
 */
async function writeCache(cache, env) {
  const target = conferenceWatchlistStorePath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(normalize(cache), null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

/**
 * @param {Record<string, object>} rows keyed by slug
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function upsertConferenceWatchlistRecords(rows, env = process.env) {
  const cache = await loadConferenceWatchlistStore(env);
  for (const [slug, row] of Object.entries(rows)) {
    const key = String(slug || '').trim().slice(0, 100);
    const rec = normalizeRecord({ ...row, slug: key });
    if (!key || !rec) continue;
    cache.bySlug[key] = rec;
  }
  const normalized = normalize(cache);
  await writeCache(normalized, env);
  return normalized;
}

/**
 * @param {string[]} slugs
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function removeConferenceWatchlistSlugs(slugs, env = process.env) {
  const cache = await loadConferenceWatchlistStore(env);
  for (const slug of slugs) {
    delete cache.bySlug[String(slug || '').trim()];
  }
  const normalized = normalize(cache);
  await writeCache(normalized, env);
  return normalized;
}
