/**
 * GOES GLM L2 LCFA flashes within ~200 statute miles of the dashboard centroid (ZIP → lat/lon),
 * from NOAA open-data S3 (`noaa-goes16`, `noaa-goes18`, …).
 *
 * **Sprite / +CG / kA:** GLM measures cloud-top optical energy and extent — it does **not** report
 * return-stroke polarity or peak current (kA). The “Sprite” row is a **radiant-energy + footprint**
 * tier you tune with env vars; labels use “+CG-class” and “>NkA tier” as **aliases** for that tier.
 *
 * @see https://registry.opendata.aws/noaa-goes/
 */

import { File as H5File } from 'jsfive';

import { haversineMiles } from './dashboard-geo.js';
import { ingestSpriteCandidates, pickSpriteFlashNear } from './glm-sprite-store.js';

const RADIUS_MI = 200;
const FETCH_TIMEOUT_MS = 22_000;
const MAX_NC_OBJECTS = 40;
const MAX_NC_BYTES = 1_050_000;

const USER_AGENT =
  'Dashbird/1.0 (dashboard GOES GLM L2 CFA; registry.opendata.aws/noaa-goes/)';

const FLASH_LEAVES = new Set([
  'flash_lat',
  'flash_lon',
  'flash_energy',
  'flash_area',
  'flash_time_offset_of_first_event',
]);

function glmPathTripleFromUtc(nowUtc = new Date()) {
  const y = nowUtc.getUTCFullYear();
  const noon = Date.UTC(y, nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 12, 0, 0);
  const jan1Noon = Date.UTC(y, 0, 1, 12, 0, 0);
  const doy = Math.round((noon - jan1Noon) / 86400000) + 1;
  const j = Math.max(1, Math.min(366, doy));
  const hh = ((nowUtc.getUTCHours() % 24) + 24) % 24;
  return {
    y: String(y),
    j: String(j).padStart(3, '0'),
    h: String(hh).padStart(2, '0'),
  };
}

function glmPrefixesRollingTwoHoursUtc(nowUtc) {
  const out = [];
  for (let hOff = 0; hOff < 2; hOff++) {
    const t = new Date(nowUtc.getTime() - hOff * 3600000);
    const { y, j, h } = glmPathTripleFromUtc(t);
    out.push(`GLM-L2-LCFA/${y}/${j}/${h}/`);
  }
  return out;
}

function glmBucketFromLon(obsLon, env = process.env) {
  const raw = String(env.EARTH_GOES_GLM_BUCKET ?? '').trim().toLowerCase();
  if (/^noaa-goes(16|17|18|19)$/.test(raw)) return raw;

  const l = Number(obsLon);
  if (!Number.isFinite(l)) return 'noaa-goes18';

  return l <= -103 ? 'noaa-goes18' : 'noaa-goes16';
}

function satelliteLabelFromBucket(bucket) {
  const m = /^noaa-goes(\d+)/i.exec(String(bucket || ''));
  return m ? `GOES-${m[1]}` : 'GOES GLM';
}

function parseS3Keys(xml) {
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml))) keys.push(String(m[1]));
  return keys;
}

async function s3ListKeys(bucket, prefix, signal) {
  const qs = `https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  const res = await fetch(qs, { signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' } });
  if (!res.ok) throw new Error(`s3_list_http_${res.status}`);
  return parseS3Keys(await res.text());
}

function s3ObjectUrl(bucket, key) {
  const segs = String(key || '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `https://${bucket}.s3.amazonaws.com/${segs}`;
}

async function s3FetchNcBuffer(bucket, key, signal) {
  const url = s3ObjectUrl(bucket, key);
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
  });
  if (!res.ok) throw new Error(`s3_obj_http_${res.status}`);
  const ab = await res.arrayBuffer();
  if (!ab.byteLength || ab.byteLength > MAX_NC_BYTES) return null;
  return ab;
}

function expandFlashes(groups) {
  /** @type {{ lat:number; lon:number; energy:number; areaSqM:number|null; timeOffsetRaw:number|null }[]} */
  const flashes = [];
  for (const [, g] of Object.entries(groups)) {
    if (!g?.lat || !g?.lon || !g?.ej) continue;
    const n = Math.min(g.lat.length, g.lon.length, g.ej.length);
    const nArea = g.area ? Math.min(n, g.area.length) : n;
    const nTime = g.tOff ? Math.min(n, g.tOff.length) : n;
    const lim = Math.min(n, nArea, nTime);
    for (let i = 0; i < lim; i++) {
      const lat = Number(g.lat[i]);
      const lon = Number(g.lon[i]);
      const energy = Number(g.ej[i]);
      const areaSqM = g.area ? Number(g.area[i]) : null;
      const timeOffsetRaw = g.tOff ? Number(g.tOff[i]) : null;
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Number.isFinite(energy) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
      ) {
        flashes.push({
          lat,
          lon,
          energy,
          areaSqM: areaSqM != null && Number.isFinite(areaSqM) ? areaSqM : null,
          timeOffsetRaw: timeOffsetRaw != null && Number.isFinite(timeOffsetRaw) ? timeOffsetRaw : null,
        });
      }
    }
  }
  return flashes;
}

export function flashesFromGlmLcfaBuffer(buf) {
  const f = new H5File(buf, 'glm.nc');
  const groups = {};

  f.visititems((_rel, obj) => {
    if (!obj?.shape || obj.shape === null || typeof obj.name !== 'string') return null;
    const full = obj.name.replace(/^\/+/, '');
    const segments = full.split('/').filter(Boolean);
    if (segments.length < 1) return null;

    const leaf = segments[segments.length - 1];
    if (!FLASH_LEAVES.has(leaf)) return null;

    const parentKey = segments.length > 1 ? segments.slice(0, -1).join('/') : '_root';

    if (!groups[parentKey]) groups[parentKey] = {};

    let v;
    try {
      v = obj.value;
    } catch {
      return null;
    }

    const arr = typeof v.buffer !== 'undefined' && typeof v.byteOffset === 'number' ? v : null;
    if (!arr || !groups[parentKey]) return null;

    const g = groups[parentKey];
    if (leaf === 'flash_lat') g.lat = arr;
    if (leaf === 'flash_lon') g.lon = arr;
    if (leaf === 'flash_energy') g.ej = arr;
    if (leaf === 'flash_area') g.area = arr;
    if (leaf === 'flash_time_offset_of_first_event') g.tOff = arr;
    return null;
  });

  return expandFlashes(groups);
}

export function glmFileCoverageStartUtcMs(buf) {
  try {
    const f = new H5File(buf, 'glm.nc');
    const a = typeof f.attrs === 'object' && f.attrs ? f.attrs : null;
    const s = typeof a?.time_coverage_start === 'string' ? a.time_coverage_start : '';
    const m = Date.parse(String(s || '').trim());
    return Number.isFinite(m) ? m : null;
  } catch {
    return null;
  }
}

/** Interpret GLM time offset (seconds in DO.07+, or ms in older builds). */
function flashUtcMsFromOffsets(fileStartMs, timeOffsetRaw) {
  if (fileStartMs == null || !Number.isFinite(fileStartMs)) return null;
  if (timeOffsetRaw == null || !Number.isFinite(timeOffsetRaw)) return fileStartMs;

  const off = timeOffsetRaw;
  if (off > 1e12) return Math.round(off);
  if (off > 86400 * 10) return Math.round(fileStartMs + off);
  if (off > 5000) return Math.round(fileStartMs + off);
  return Math.round(fileStartMs + off * 1000);
}

function formatEnergyJ(j) {
  const en = Math.abs(Number(j));
  if (!Number.isFinite(en)) return '-';
  if (en >= 5e12) return `${(en / 1e12).toFixed(2)} TJ`;
  if (en >= 5e9) return `${(en / 1e9).toFixed(2)} GJ`;
  if (en >= 5e6) return `${(en / 1e6).toFixed(2)} MJ`;
  return `${Math.round(en / 1e3)} kJ`;
}

function formatAreaSqM(a) {
  const x = Number(a);
  if (!Number.isFinite(x) || x <= 0) return null;
  const km2 = x / 1e6;
  if (km2 >= 1) return `${km2 >= 100 ? km2.toFixed(0) : km2.toFixed(1)} km²`;
  return `${(x / 1e4).toFixed(2)} ha`;
}

function readSpriteEnv(env = process.env) {
  const minJ = Number(env.EARTH_SPRITE_MIN_RADIANT_J);
  const minArea = Number(env.EARTH_SPRITE_MIN_AREA_SQ_M);
  const peakTier = Number(env.EARTH_SPRITE_PEAK_KA_TIER);
  return {
    minRadiantJ: Number.isFinite(minJ) && minJ > 0 ? minJ : 5e10,
    minAreaSqM: Number.isFinite(minArea) && minArea > 0 ? minArea : 0,
    peakKaTier: Number.isFinite(peakTier) && peakTier > 0 ? peakTier : 50,
    polarityAlias: String(env.EARTH_SPRITE_POLARITY_ALIAS || '+CG').trim() || '+CG',
  };
}

function isSpriteTierFlash(flash, spriteCfg) {
  if (!Number.isFinite(flash.energy) || flash.energy < spriteCfg.minRadiantJ) return false;
  if (spriteCfg.minAreaSqM > 0) {
    if (flash.areaSqM == null || !Number.isFinite(flash.areaSqM) || flash.areaSqM < spriteCfg.minAreaSqM) {
      return false;
    }
  }
  return true;
}

function buildSpriteStripItem(row, tz, spriteCfg) {
  const distRounded = Math.max(0, Math.round(Number(row.distMi) || 0));
  const whenFlash = new Date(row.flashUtcEpochMs).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
  const whenDate = new Date(row.flashUtcEpochMs).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: tz,
  });
  const energyFmt = formatEnergyJ(row.radiantEnergyJ);
  const areaFmt = formatAreaSqM(row.flashAreaSqM);
  const latS = Number(row.lat).toFixed(3);
  const lonS = Number(row.lon).toFixed(3);
  const tier = Number(row.peakKaTier) || spriteCfg.peakKaTier;

  const detailPieces = [
    'Sprite',
    `${spriteCfg.polarityAlias}-class`,
    `>${tier} kA tier`,
    energyFmt,
    ...(areaFmt ? [areaFmt] : []),
    `${distRounded} mi`,
    `${latS}°, ${lonS}°`,
    whenFlash,
    whenDate,
  ];

  return {
    earthType: 'goes_glm_sprite_proxy',
    label: 'Sprite-class flash (GLM proxy)',
    detailLine: detailPieces.join(' · '),
    forecastUrl: 'https://www.star.nesdis.noaa.gov/GOES/thumbnail.php?v=glm',
    spriteMeta: {
      flashUtcEpochMs: row.flashUtcEpochMs,
      lat: row.lat,
      lon: row.lon,
      radiantEnergyJ: row.radiantEnergyJ,
      flashAreaSqM: row.flashAreaSqM,
      peakKaTier: tier,
      polarityAlias: spriteCfg.polarityAlias,
      distMi: distRounded,
      stableId: row.id,
    },
  };
}

function buildMainStripItem(winner, tz, sat) {
  const distRounded = Math.max(0, Math.round(winner.distMi));
  const when =
    winner.fileStartMs != null
      ? new Date(winner.fileStartMs).toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: tz,
        })
      : null;

  const energyFmt = formatEnergyJ(winner.energy);
  const detailPieces = [`${energyFmt}`, `${distRounded} mi GLM CFA`, ...(when ? [`${when}`] : [])];

  return {
    earthType: 'goes_glm_lightning_max_recent',
    label: `${sat} lightning`,
    detailLine: detailPieces.join(' · '),
    forecastUrl: 'https://www.star.nesdis.noaa.gov/GOES/thumbnail.php?v=glm',
  };
}

/**
 * @returns {Promise<{ ok: true; items: object[] } | { ok: false; error: string }>}
 */
export async function buildGoesGlmLightningStripItem(p) {
  const obsLat = Number(p?.lat);
  const obsLon = Number(p?.lon);
  if (!Number.isFinite(obsLat) || !Number.isFinite(obsLon)) {
    return { ok: false, error: 'bad_lat_lon' };
  }

  const bucket = glmBucketFromLon(obsLon);
  const sat = satelliteLabelFromBucket(bucket);
  const tz = String(process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';
  const spriteCfg = readSpriteEnv();

  const nowUtc = new Date();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

  /** @type {object[]} */
  const spriteHits = [];

  try {
    let keysAll = [];
    for (const pre of glmPrefixesRollingTwoHoursUtc(nowUtc)) {
      keysAll = keysAll.concat(await s3ListKeys(bucket, pre, ac.signal));
      ac.signal.throwIfAborted();
    }

    keysAll = keysAll.filter((k) => k.endsWith('.nc')).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    keysAll = keysAll.slice(0, MAX_NC_OBJECTS);

    let winner = null;

    for (let k = 0; k < keysAll.length; k++) {
      const key = keysAll[k];
      let buf;
      try {
        buf = await s3FetchNcBuffer(bucket, key, ac.signal);
      } catch {
        continue;
      }
      if (!buf?.byteLength) continue;

      let flashes;
      try {
        flashes = flashesFromGlmLcfaBuffer(buf);
      } catch {
        continue;
      }

      const fileStartMs = glmFileCoverageStartUtcMs(buf);

      for (let ui = 0; ui < flashes.length; ui++) {
        const e = flashes[ui];
        const distMi = haversineMiles(obsLat, obsLon, e.lat, e.lon);
        if (!Number.isFinite(distMi) || distMi > RADIUS_MI + 2) continue;

        const flashUtcEpochMs = flashUtcMsFromOffsets(fileStartMs, e.timeOffsetRaw);

        if (isSpriteTierFlash({ ...e, energy: e.energy, areaSqM: e.areaSqM }, spriteCfg)) {
          if (flashUtcEpochMs != null && Number.isFinite(flashUtcEpochMs)) {
            spriteHits.push({
              flashUtcEpochMs,
              lat: e.lat,
              lon: e.lon,
              radiantEnergyJ: e.energy,
              flashAreaSqM: e.areaSqM,
              distMi,
              bucket,
              glmKeyTail: key.slice(-48),
              satelliteLabel: sat,
              peakKaTier: spriteCfg.peakKaTier,
            });
          }
        }

        if (
          winner == null ||
          e.energy > winner.energy ||
          (Math.abs(e.energy - winner.energy) < 1e-6 &&
            distMi < haversineMiles(obsLat, obsLon, winner.lat, winner.lon))
        ) {
          winner = {
            lat: e.lat,
            lon: e.lon,
            energy: e.energy,
            fileStartMs,
            distMi,
            flashUtcEpochMs,
            sampleKey: key.slice(-48),
          };
        }
      }
    }

    let ingestLog = [];
    if (spriteHits.length > 0) {
      const ing = await ingestSpriteCandidates(spriteHits);
      ingestLog = ing.addedLog || [];
    }

    const items = [];
    if (winner) {
      items.push(buildMainStripItem(winner, tz, sat));
    }

    const spriteNear = await pickSpriteFlashNear(obsLat, obsLon, {
      radiusMi: RADIUS_MI,
    });

    if (spriteNear?.row) {
      items.push(buildSpriteStripItem(spriteNear.row, tz, spriteCfg));
    }

    if (ingestLog.length > 0) {
      console.log(
        '[glm-sprite]',
        ingestLog
          .map((h) => `${new Date(h.flashUtcEpochMs).toISOString()} ${h.lat},${h.lon} ${h.radiantEnergyJ}J tier>${h.peakKaTier}kA id=${h.id}`)
          .join(' | '),
      );
    }

    if (items.length === 0) return { ok: true, items: [] };

    return { ok: true, items };
  } catch (e) {
    if (e?.name === 'AbortError' || /^aborted$/i.test(String(e?.message ?? ''))) {
      return { ok: false, error: 'glm_timeout_or_abort' };
    }
    return {
      ok: false,
      error: String(e?.message || e || 'glm_fetch_failed').slice(0, 240),
    };
  } finally {
    clearTimeout(timer);
  }
}
