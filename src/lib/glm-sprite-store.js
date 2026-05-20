/**
 * Persist “sprite-tier” extreme GLM flashes (optical-energy proxy near dashboard point).
 *
 * Ground-truth +CG polarity and peak current come from lightning-location networks (e.g. NLDN),
 * not GOES GLM; thresholds here are radiant-energy tiers you tune to match storms of interest.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { haversineMiles } from './dashboard-geo.js';

const STORE_VERSION = 1;
/** Retain flashes by flashUtc for this long (milliseconds). */
const FLASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function storePathFromEnv(env = process.env) {
  const override = String(env.GLM_SPRITE_STORE_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data', 'glm-sprite-events.json');
}

function storePath() {
  return storePathFromEnv();
}

/**
 * Stable id buckets flashes so repeat polling does not multiply rows.
 */
export function stableFlashId(lat, lon, utcMs) {
  return `glm:${Math.floor(Number(utcMs) / 20_000)}:${Number(lat).toFixed(3)}:${Number(lon).toFixed(3)}`;
}

async function ensureDataDir() {
  await fs.mkdir(path.join(PKG_ROOT, 'data'), { recursive: true });
}

async function readStore() {
  const p = storePath();
  try {
    const txt = await fs.readFile(p, 'utf8');
    const j = JSON.parse(txt);
    return j?.version === STORE_VERSION && Array.isArray(j.entries) ? j : { version: STORE_VERSION, entries: [] };
  } catch {
    return { version: STORE_VERSION, entries: [] };
  }
}

async function writeStore(doc) {
  await ensureDataDir();
  const p = storePath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * Trim old flashes and ingest new candidates. Returns flashes logged as newly merged.
 *
 * @param {object[]} hits
 */
export async function ingestSpriteCandidates(hits) {
  /** @type {object[]} */
  const addedLog = [];

  let doc = await readStore();

  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const row of doc.entries) {
    if (row?.id != null && typeof row.id === 'string') byId.set(row.id, row);
  }

  const now = Date.now();
  const ttlCutFlash = now - FLASH_RETENTION_MS;

  /** @type {typeof doc.entries} */
  const survivors = [];

  const upsert = (hit, idStr) => {
    const hid = typeof idStr === 'string' ? idStr : hit?.id;
    if (!hid) return false;

    const prev = byId.get(hid);
    const ej = Number(hit.radiantEnergyJ);
    if (!Number.isFinite(ej)) return false;
    if (!Number.isFinite(Number(hit.flashUtcEpochMs))) return false;

    const nextRowBase = {
      id: hid,
      flashUtcEpochMs: Number(hit.flashUtcEpochMs),
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      radiantEnergyJ: ej,
      flashAreaSqM:
        hit.flashAreaSqM != null && Number.isFinite(Number(hit.flashAreaSqM)) ? Number(hit.flashAreaSqM) : null,
      distMi: hit.distMi != null && Number.isFinite(Number(hit.distMi)) ? Number(hit.distMi) : null,
      bucket: typeof hit.bucket === 'string' ? hit.bucket : null,
      glmKeyTail: typeof hit.glmKeyTail === 'string' ? hit.glmKeyTail : null,
      satelliteLabel: typeof hit.satelliteLabel === 'string' ? hit.satelliteLabel : null,
      peakKaTier: Number(hit.peakKaTier) || 50,
    };

    if (!prev) {
      const nextRow = { ...nextRowBase, recordedAtUtcEpochMs: now, lastSeenAtUtcEpochMs: now };
      byId.set(hid, nextRow);
      addedLog.push({
        id: hid,
        flashUtcEpochMs: nextRow.flashUtcEpochMs,
        lat: nextRow.lat,
        lon: nextRow.lon,
        radiantEnergyJ: nextRow.radiantEnergyJ,
        peakKaTier: nextRow.peakKaTier,
      });
      return true;
    }

    const brighter = ej > Number(prev.radiantEnergyJ) + 1e-6;

    /** @type {object} */
    const merged = brighter
      ? {
          ...nextRowBase,
          recordedAtUtcEpochMs: prev.recordedAtUtcEpochMs ?? prev.lastSeenAtUtcEpochMs ?? now,
          lastSeenAtUtcEpochMs: now,
        }
      : {
          ...prev,
          distMi:
            typeof nextRowBase.distMi === 'number' && Number.isFinite(nextRowBase.distMi)
              ? nextRowBase.distMi
              : prev.distMi,
          lastSeenAtUtcEpochMs: now,
        };

    byId.set(hid, merged);
    if (brighter) {
      addedLog.push({
        id: hid,
        flashUtcEpochMs: merged.flashUtcEpochMs,
        lat: merged.lat,
        lon: merged.lon,
        radiantEnergyJ: merged.radiantEnergyJ,
        peakKaTier: merged.peakKaTier,
      });
    }

    return true;
  };

  for (const raw of hits) {
    upsert(raw, stableFlashId(raw.lat, raw.lon, raw.flashUtcEpochMs));
  }

  for (const row of byId.values()) {
    if (typeof row.flashUtcEpochMs !== 'number' || !Number.isFinite(row.flashUtcEpochMs)) continue;
    if (row.flashUtcEpochMs >= ttlCutFlash) survivors.push(row);
  }

  survivors.sort((a, b) => b.flashUtcEpochMs - a.flashUtcEpochMs);

  doc = { version: STORE_VERSION, entries: survivors.slice(0, 5000) };

  await writeStore(doc);

  return { addedLog, entries: doc.entries };
}

/**
 * Latest sprite-tier retained flash inside radius (by flashUtc, not ingestion time).
 *
 * @param {number} obsLat
 * @param {number} obsLon
 * @param {{ radiusMi?: number, excludeStableId?: string|null }} opts
 */
export async function pickSpriteFlashNear(obsLat, obsLon, opts = {}) {
  const radiusMi = Number(opts.radiusMi) || 200;
  const exclude = typeof opts.excludeStableId === 'string' ? opts.excludeStableId : null;

  const doc = await readStore();

  /** @type {object[]} */
  const rows = [...(doc.entries || [])];
  const now = Date.now();
  const cut = now - FLASH_RETENTION_MS;

  /** @type {{ row:object; distMi:number}|null} */
  let best = null;
  for (const row of rows) {
    if (typeof row.flashUtcEpochMs !== 'number' || row.flashUtcEpochMs < cut) continue;
    const distMi = haversineMiles(obsLat, obsLon, Number(row.lat), Number(row.lon));
    if (!Number.isFinite(distMi) || distMi > radiusMi + 3) continue;

    const sid = stableFlashId(row.lat, row.lon, row.flashUtcEpochMs);
    if (exclude && sid === exclude) continue;

    const cand = { ...row, distMi };

    const energy = Number(cand.radiantEnergyJ);
    const bestEnergy = best == null ? -Infinity : Number(best.row.radiantEnergyJ);
    const better =
      best == null ||
      energy > bestEnergy + 1e-6 ||
      (Math.abs(energy - bestEnergy) < 1e-6 && cand.flashUtcEpochMs > best.row.flashUtcEpochMs);
    if (better) best = { row: cand, distMi };
  }
  return best;
}
