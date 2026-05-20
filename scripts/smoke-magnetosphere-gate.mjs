#!/usr/bin/env node
/**
 * Smoke: magnetosphere API hidden below G2, stormGte2 flag matches assessGeomagneticStormActivity.
 */
import {
  assessGeomagneticStormActivity,
  geomagneticStormMeetsG2Threshold,
} from '../src/lib/geomagnetic-storm-merge.js';

const base = process.env.DASHBIRD_URL || 'http://localhost:8787';

const storm = await assessGeomagneticStormActivity();
const meets = geomagneticStormMeetsG2Threshold(storm);
const r = await fetch(`${base}/api/magnetosphere`, { cache: 'no-store' });
const j = await r.json();

console.log('NOAA assessment:', storm.label, '| meetsG2:', meets, '| g:', storm.g);
console.log('API stormGte2:', j.stormGte2, '| stormActive:', j.stormActive, '| frames:', (j.frames || []).length);
console.log('card should show:', meets && j.stormGte2 === true);

if (meets !== j.stormGte2) {
  console.error('FAIL: API stormGte2 does not match local threshold');
  process.exit(1);
}
if (meets && !(j.frames?.length > 0 || j.ok)) {
  console.warn('WARN: G2+ but no frames yet (section may show loading)');
}
if (!meets && j.stormGte2) {
  console.error('FAIL: below G2 but API reports stormGte2');
  process.exit(1);
}
if (!meets && (j.frames || []).length > 0) {
  console.error('FAIL: below G2 but API returned frames');
  process.exit(1);
}
console.log('OK');
