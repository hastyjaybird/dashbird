import { buildFallFoliageSeasonStatus } from './fall-foliage-season.js';
import { buildFireflySeasonStatus } from './firefly-season.js';
import {
  resolveSecondaryWatchLocation,
  resolveWatchLocationForZip,
} from './secondary-watch-location.js';

/** Fall foliage watches a fixed ZIP, independent of the Settings secondary ZIP. */
export const FALL_FOLIAGE_ZIP = '24066';

/**
 * Earth-strip items: fireflies at the secondary ZIP + fall foliage at FALL_FOLIAGE_ZIP.
 * @param {object} [p]
 * @param {Date} [p.now]
 * @param {string} [p.baseUrl] USA-NPN GeoServer base
 */
export async function buildSecondaryWatchEarthBundle(p = {}) {
  if (String(process.env.SECONDARY_WATCH || '').trim() === '0') {
    return { ok: true, disabled: true, zip: '', items: [], firefly: null, fallFoliage: null };
  }

  const [loc, folLoc] = await Promise.all([
    resolveSecondaryWatchLocation(),
    resolveWatchLocationForZip(FALL_FOLIAGE_ZIP),
  ]);
  if (!loc && !folLoc) {
    return { ok: true, zip: '', items: [], geocodeError: true, firefly: null, fallFoliage: null };
  }

  const now = p.now instanceof Date ? p.now : new Date();

  const firefly = loc
    ? buildFireflySeasonStatus({
        lat: loc.lat,
        lon: loc.lon,
        timeZone: loc.timeZone,
        now,
        zip: loc.zip,
      })
    : null;

  const fallFoliage = folLoc
    ? await buildFallFoliageSeasonStatus({
        lat: folLoc.lat,
        lon: folLoc.lon,
        timeZone: folLoc.timeZone,
        now,
        zip: folLoc.zip,
        baseUrl: p.baseUrl,
      })
    : null;

  const items = [...(firefly?.items || []), ...(fallFoliage?.items || [])];

  return {
    ok: true,
    zip: loc?.zip || '',
    place: loc?.place || '',
    lat: loc?.lat,
    lon: loc?.lon,
    timeZone: loc?.timeZone,
    fallFoliageZip: FALL_FOLIAGE_ZIP,
    items,
    firefly,
    fallFoliage,
  };
}
