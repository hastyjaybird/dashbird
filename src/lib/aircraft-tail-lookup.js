/**
 * Simple online tail-number / Mode-S lookup for sky-strip aircraft that lack
 * curated registry details. Results are cached under data/ for later reuse.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ADSBDB_AIRCRAFT = 'https://api.adsbdb.com/v0/aircraft';
const HEXDB_AIRCRAFT = 'https://hexdb.io/api/v1/aircraft';
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60_000;
const NEGATIVE_TTL_MS = 24 * 60 * 60_000;
/** Soft miss after timeout/network errors — retry later without hammering APIs. */
const ERROR_TTL_MS = 30 * 60_000;
const FETCH_MS = 5_000;

/** @type {Record<string, object> | null} */
let memoryCache = null;
/** @type {Map<string, Promise<object | null>>} */
const inflight = new Map();

export function aircraftTailCachePath(env = process.env) {
  const override = String(env.AIRCRAFT_TAIL_CACHE_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data', 'aircraft-tail-cache.json');
}

/**
 * Real Mode-S hex only — strip anonymous `~` TIS-B addresses (not in registries).
 * @param {string | null | undefined} icao24
 */
export function normalizeLookupHex(icao24) {
  const hex = String(icao24 || '')
    .trim()
    .toLowerCase()
    .replace(/^~/, '');
  if (!/^[0-9a-f]{6}$/.test(hex)) return '';
  // Anonymous / non-ICAO trackfiles use the leading ~; bare hex after strip is still
  // often unlisted, but only reject clearly invalid forms here.
  if (String(icao24 || '').trim().startsWith('~')) return '';
  return hex;
}

/**
 * @param {string | null | undefined} nNumber
 * @param {string | null | undefined} icao24
 */
export function tailCacheKey(nNumber, icao24) {
  const n = String(nNumber || '')
    .trim()
    .toUpperCase();
  if (n) return `n:${n}`;
  const hex = normalizeLookupHex(icao24);
  if (hex) return `hex:${hex}`;
  return '';
}

/**
 * @returns {Promise<Record<string, object>>}
 */
async function loadCache() {
  if (memoryCache) return memoryCache;
  const p = aircraftTailCachePath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw);
    memoryCache = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

/**
 * @param {Record<string, object>} cache
 */
async function saveCache(cache) {
  memoryCache = cache;
  const p = aircraftTailCachePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * @param {object | null | undefined} entry
 * @param {number} now
 */
function cacheEntryFresh(entry, now = Date.now()) {
  if (!entry?.at) return false;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return false;
  const ttl = entry.error ? ERROR_TTL_MS : entry.miss ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  return now - at < ttl;
}

/**
 * @param {string} url
 * @param {AbortSignal} [signal]
 */
async function fetchJson(url, signal) {
  const r = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Dashbird/1.0 (personal; aircraft tail lookup)',
    },
  });
  // 404 unknown; 400 invalid id (e.g. anonymous ~hex) — both are definitive misses.
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`tail_lookup_http_${r.status}`);
  return r.json();
}

/**
 * @param {unknown} j
 */
function fromAdsbdb(j) {
  const ac = j?.response?.aircraft;
  if (!ac || typeof ac !== 'object') return null;
  const registration = String(ac.registration || '')
    .trim()
    .toUpperCase();
  const owner = String(ac.registered_owner || '').trim();
  const manufacturer = String(ac.manufacturer || '').trim();
  const type = String(ac.type || '').trim();
  const icaoType = String(ac.icao_type || '').trim();
  const equipment = [manufacturer, type || icaoType].filter(Boolean).join(' ').trim();
  if (!registration && !owner && !equipment) return null;
  return {
    nNumber: registration || null,
    icao24: String(ac.mode_s || '')
      .trim()
      .toLowerCase() || null,
    operator: owner,
    equipment,
    notes: 'Online registry lookup',
    source: 'adsbdb',
  };
}

/**
 * @param {unknown} j
 */
function fromHexdb(j) {
  if (!j || typeof j !== 'object' || j.error || j.status === '404') return null;
  const registration = String(j.Registration || '')
    .trim()
    .toUpperCase();
  const owner = String(j.RegisteredOwners || '').trim();
  const manufacturer = String(j.Manufacturer || '').trim();
  const type = String(j.Type || '').trim();
  const icaoType = String(j.ICAOTypeCode || '').trim();
  const equipment = [manufacturer, type || icaoType].filter(Boolean).join(' ').trim();
  if (!registration && !owner && !equipment) return null;
  return {
    nNumber: registration || null,
    icao24: String(j.ModeS || '')
      .trim()
      .toLowerCase() || null,
    operator: owner,
    equipment,
    notes: 'Online registry lookup',
    source: 'hexdb',
  };
}

/**
 * @param {string | null | undefined} nNumber
 * @param {string | null | undefined} icao24
 */
async function fetchOnline(nNumber, icao24) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const n = String(nNumber || '')
      .trim()
      .toUpperCase();
    if (n) {
      const hit = fromAdsbdb(await fetchJson(`${ADSBDB_AIRCRAFT}/${encodeURIComponent(n)}`, ac.signal));
      if (hit) return hit;
    }
    const hex = normalizeLookupHex(icao24);
    if (hex) {
      const byHex = fromAdsbdb(await fetchJson(`${ADSBDB_AIRCRAFT}/${encodeURIComponent(hex)}`, ac.signal));
      if (byHex) return byHex;
      const hexdb = fromHexdb(await fetchJson(`${HEXDB_AIRCRAFT}/${encodeURIComponent(hex)}`, ac.signal));
      if (hexdb) return hexdb;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up registration details. Only call when the strip has no curated extras.
 * @param {{ nNumber?: string | null, icao24?: string | null }} id
 * @returns {Promise<{ nNumber: string | null, icao24: string | null, operator: string, equipment: string, notes: string, source: string } | null>}
 */
export async function lookupAircraftTailOnline(id) {
  const key = tailCacheKey(id?.nNumber, id?.icao24);
  if (!key) return null;

  const cache = await loadCache();
  const cached = cache[key];
  if (cacheEntryFresh(cached)) {
    return cached.miss ? null : cached;
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const work = (async () => {
    try {
      const hit = await fetchOnline(id?.nNumber, id?.icao24);
      const at = new Date().toISOString();
      if (!hit) {
        cache[key] = { miss: true, at };
        await saveCache(cache).catch(() => {});
        return null;
      }
      const entry = { ...hit, miss: false, at };
      cache[key] = entry;
      if (hit.nNumber) cache[`n:${hit.nNumber}`] = entry;
      if (hit.icao24) {
        const hx = normalizeLookupHex(hit.icao24);
        if (hx) cache[`hex:${hx}`] = entry;
      }
      await saveCache(cache).catch(() => {});
      return entry;
    } catch {
      const at = new Date().toISOString();
      cache[key] = { miss: true, error: true, at };
      await saveCache(cache).catch(() => {});
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, work);
  return work;
}
