#!/usr/bin/env node
/**
 * Smoke test: Atlantic storm parsing against a real archived NHC public advisory.
 * Run: node scripts/smoke-atlantic-storm-watch.mjs
 */
import {
  buildStormEarthItem,
  extractLandfallLocation,
  landfallForecastDetailLine,
  stormQualifiesForEarthStrip,
} from '../src/lib/atlantic-storm-watch.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const irmaStorm = {
  id: 'al112017',
  binNumber: 'AT1',
  name: 'Irma',
  classification: 'HU',
  intensity: 125,
  publicAdvisory: {
    issuance: '2017-09-09T15:00:00.000Z',
    url: 'https://www.nhc.noaa.gov/archive/2017/al11/al112017.public.042.shtml',
  },
};

const irmaAdvisoryUrl =
  'https://www.nhc.noaa.gov/archive/2017/al11/al112017.public.042.shtml?text';
const r = await fetch(irmaAdvisoryUrl, {
  headers: { 'User-Agent': 'Dashbird/1.0 (smoke test)' },
});
assert(r.ok, `advisory fetch failed: ${r.status}`);
const advisoryText = await r.text();

assert(stormQualifiesForEarthStrip(irmaStorm), 'Irma should qualify as Atlantic Cat 1+');
const florida = extractLandfallLocation(advisoryText);
assert(florida === 'Florida', `expected Florida landfall location, got: ${florida}`);
assert(
  landfallForecastDetailLine(advisoryText).startsWith('Forecasted landfall: Florida'),
  'detail line should name Florida',
);

const item = buildStormEarthItem(irmaStorm, advisoryText);
assert(item, 'Irma advisory should produce an Earth strip item');
assert(item.label === 'Irma', `label should be Irma, got: ${item.label}`);
assert(item.earthType === 'atlantic_cyclone_land_impact', 'earthType mismatch');
assert(item.detailLine.includes('Cat 4'), `detail should include Cat 4, got: ${item.detailLine}`);
assert(item.detailLine.includes('Forecasted landfall: Florida'), `detail missing Florida: ${item.detailLine}`);

const live = await fetch('https://www.nhc.noaa.gov/CurrentStorms.json', {
  headers: { 'User-Agent': 'Dashbird/1.0 (smoke test)' },
});
assert(live.ok, `CurrentStorms.json failed: ${live.status}`);
const liveJson = await live.json();
assert(Array.isArray(liveJson.activeStorms), 'activeStorms should be an array');

console.log('smoke-atlantic-storm-watch: ok');
console.log(`  live active storms: ${liveJson.activeStorms.length}`);
console.log(`  Irma sample detail: ${item.detailLine}`);
