/**
 * NOAA SWPC 1-minute geoelectric field map (US–Canada 1D) during active geomagnetic storms.
 * @see https://www.swpc.noaa.gov/products/geoelectric-field-models-1-minute
 */
import {
  assessGeomagneticStormActivity,
  geomagneticStormMeetsG2Threshold,
} from './geomagnetic-storm-merge.js';

const SWPC_PRODUCT = 'https://www.swpc.noaa.gov/products/geoelectric-field-models-1-minute';
const IMAGE_URL =
  'https://services.swpc.noaa.gov/images/animations/geoelectric/US-Canada/EmapGraphics_1m/latest.png';

function geoelectricDisabled(env = process.env) {
  return String(env.GEOELECTRIC_FIELD || '').trim() === '0';
}

/**
 * @returns {Promise<object>}
 */
export async function getGeoelectricFieldPayload() {
  if (geoelectricDisabled()) {
    return { ok: true, active: false, disabled: true };
  }

  const storm = await assessGeomagneticStormActivity();
  const stormGte2 = geomagneticStormMeetsG2Threshold(storm);
  const show = stormGte2;

  if (!show) {
    return {
      ok: true,
      disabled: false,
      active: false,
      stormActive: false,
      stormGte2: false,
      storm,
    };
  }

  const refreshedAt = Date.now();
  const caption = storm.label || 'Geomagnetic storm';

  return {
    ok: true,
    active: true,
    stormActive: true,
    stormGte2: true,
    storm,
    imageUrl: IMAGE_URL,
    imageSrc: `${IMAGE_URL}?_=${refreshedAt}`,
    productUrl: SWPC_PRODUCT,
    refreshedAt,
    caption,
  };
}
