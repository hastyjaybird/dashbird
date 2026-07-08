/**
 * Live non-airline aircraft within a radius of the rain-alert address (ADS-B via OpenSky).
 * Flightradar24 has no public API; OpenSky aggregates the same class of transponder data.
 */
import registry from '../data/oakland-aircraft-registry.json' with { type: 'json' };
import { geocodeAddress } from './geocode-address.js';
import { loadRainAlertAddress } from './rain-alert-address-store.js';

const OPENSKY_STATES = 'https://opensky-network.org/api/states/all';
const MIN_ALT_FT = 50;
const MIN_ALT_M = MIN_ALT_FT * 0.3048;
const DEFAULT_RADIUS_MI = 3;
/** OpenSky bbox queries often return empty below ~8–10 mi; fetch wider, filter to AIRCRAFT_WATCH_RADIUS_MI. */
const OPENSKY_FETCH_MIN_RADIUS_MI = 10;
const CACHE_MS = 90_000;

/** @type {{ at: number, key: string, states: unknown[] | null, error?: string }} */
let openskyCache = { at: 0, key: '', states: null };

const AIRLINE_CALLSIGN_PREFIXES = new Set([
  'AAL',
  'AA',
  'UAL',
  'DAL',
  'SWA',
  'SCX',
  'JBU',
  'ASA',
  'SKW',
  'RPA',
  'ENY',
  'EDV',
  'FFT',
  'NKS',
  'F9',
  'G4',
  'HAL',
  'QXE',
  'UAL',
  'CPA',
  'CES',
  'EVA',
  'CAL',
  'KAL',
  'AAR',
  'FDX',
  'UPS',
  'ABX',
  'ATN',
]);

/**
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 */
export function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusMi
 */
export function bboxForRadiusMi(lat, lon, radiusMi) {
  const dLat = radiusMi / 69;
  const dLon = radiusMi / (69 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    lamin: lat - dLat,
    lamax: lat + dLat,
    lomin: lon - dLon,
    lomax: lon + dLon,
  };
}

/**
 * @param {string | null | undefined} callsign
 */
function parseNNumber(callsign) {
  const cs = String(callsign || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (/^N[0-9][0-9A-Z]{0,4}[0-9A-Z]$/.test(cs)) return cs;
  return null;
}

/**
 * @param {string | null | undefined} callsign
 */
function isLikelyCommercialAirline(callsign) {
  const cs = String(callsign || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!cs || cs.length < 3) return false;
  const prefix3 = cs.slice(0, 3);
  const prefix2 = cs.slice(0, 2);
  if (AIRLINE_CALLSIGN_PREFIXES.has(prefix3) || AIRLINE_CALLSIGN_PREFIXES.has(prefix2)) {
    return /^[A-Z]{2,3}\d+$/.test(cs);
  }
  return false;
}

/**
 * @param {number | null | undefined} category
 */
function isLikelyCommercialCategory(category) {
  const c = Number(category);
  if (!Number.isFinite(c)) return false;
  return c >= 4 && c <= 7;
}

/**
 * @param {unknown} row
 */
function parseStateRow(row) {
  if (!Array.isArray(row) || row.length < 8) return null;
  const icao24 = typeof row[0] === 'string' ? row[0].trim().toLowerCase() : '';
  const callsign = typeof row[1] === 'string' ? row[1].trim() : '';
  const lat = Number(row[6]);
  const lon = Number(row[5]);
  const baroM = Number(row[7]);
  const geoM = row.length > 13 ? Number(row[13]) : NaN;
  const onGround = row[8] === true;
  const category = row.length > 17 ? Number(row[17]) : NaN;
  if (!icao24 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const altM = Number.isFinite(baroM) ? baroM : Number.isFinite(geoM) ? geoM : null;
  return { icao24, callsign, lat, lon, altM, onGround, category };
}

/**
 * @param {object} p
 */
function normalizeCallsign(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * @param {object} reg registry hit
 * @param {number | null | undefined} adsbCategory OpenSky emitter category (8 = rotorcraft)
 */
export function isMedicalHelicopter(reg, adsbCategory) {
  if (reg?.icon === 'medical_helicopter') return true;
  if ((reg?.category || 'unknown') !== 'medical') return false;
  const text = `${reg.label || ''} ${reg.equipment || ''}`.toLowerCase();
  if (text.includes('helicopter') || text.includes('heli') || text.includes('rotorcraft')) return true;
  return Number(adsbCategory) === 8;
}

/**
 * Sky strip glyph: registry `icon` helicopter / medical_helicopter, or medical heli rules.
 * @param {object} reg
 * @param {number | null | undefined} adsbCategory
 */
export function isStripHelicopter(reg, adsbCategory) {
  const icon = String(reg?.icon || '').trim();
  if (icon === 'helicopter' || icon === 'medical_helicopter') return true;
  return isMedicalHelicopter(reg, adsbCategory);
}

const GENERIC_AIRCRAFT_LABELS = new Set(['Aircraft', 'Light aircraft', 'Rotorcraft']);

/**
 * @param {string} s
 */
function subtitleNormalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when label and notes repeat the same gist (e.g. "Flight training / local" + "Flight training & local ops").
 * @param {string} label
 * @param {string} notes
 */
function subtitleLabelNotesOverlap(label, notes) {
  const a = subtitleNormalize(label);
  const b = subtitleNormalize(notes);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  const aw = a.split(/\s+/).filter(Boolean);
  const bw = b.split(/\s+/).filter(Boolean);
  return aw.length >= 2 && bw.length >= 2 && aw[0] === bw[0] && aw[1] === bw[1];
}

const ALTITUDE_MI_THRESHOLD_FT = 800;

/**
 * @param {number} altFt
 * @returns {string | null}
 */
export function formatAircraftAltitude(altFt) {
  const ft = Math.round(Number(altFt));
  if (!Number.isFinite(ft)) return null;
  if (ft > ALTITUDE_MI_THRESHOLD_FT) {
    const mi = Math.round((ft / 5280) * 10) / 10;
    return `${mi} mi alt`;
  }
  return `${ft.toLocaleString('en-US')} ft`;
}

/**
 * Registry-backed subtitle for sky strip and Settings when aircraft are active.
 * @param {object} ac
 * @param {{ includeDistance?: boolean, heading?: string | null, omitTail?: boolean }} [opts]
 */
export function formatAircraftRegistrySubtitle(ac, opts = {}) {
  const includeDistance = opts.includeDistance !== false;
  const bits = [];
  const tail = ac.nNumber ? String(ac.nNumber).trim().toUpperCase() : null;
  const label = String(ac.label || '').trim();
  const notes = ac.notes ? String(ac.notes).trim() : '';
  const showLabel =
    label && !GENERIC_AIRCRAFT_LABELS.has(label) && !(notes && subtitleLabelNotesOverlap(label, notes));
  if (tail && !opts.omitTail) bits.push(tail);
  if (showLabel) bits.push(label);
  if (includeDistance && Number.isFinite(Number(ac.distMi))) bits.push(`${ac.distMi} mi`);
  const altLabel = formatAircraftAltitude(ac.altFt);
  if (altLabel) bits.push(altLabel);
  if (opts.heading) bits.push(`heading ${opts.heading}`);
  if (ac.equipment) bits.push(String(ac.equipment).trim());
  if (ac.operator) bits.push(String(ac.operator).trim());
  if (notes) bits.push(notes);
  if (bits.length) return bits.join(' · ');
  const cat =
    {
      police: 'Police',
      fire: 'Fire',
      medical: 'Medical',
      news: 'News media',
      government: 'Government',
      private: 'General aviation',
      unknown: 'Aircraft',
    }[ac.category] || 'Aircraft';
  return includeDistance && Number.isFinite(Number(ac.distMi))
    ? `${cat} · ${ac.distMi} mi`
    : cat;
}

function lookupRegistry(p) {
  const list = Array.isArray(registry.aircraft) ? registry.aircraft : [];
  const icao = String(p.icao24 || '').toLowerCase();
  const nNum = parseNNumber(p.callsign);
  for (const hit of list) {
    if (hit.icao24 && String(hit.icao24).toLowerCase() === icao) return hit;
    if (nNum && hit.nNumber && String(hit.nNumber).toUpperCase() === nNum) return hit;
  }
  const cs = normalizeCallsign(p.callsign);
  if (cs) {
    for (const hit of list) {
      if (hit.callsign && cs === normalizeCallsign(hit.callsign)) return hit;
    }
  }
  for (const hint of registry.callsignHints || []) {
    if (hint.pattern && cs.includes(normalizeCallsign(hint.pattern))) {
      return {
        label: hint.label,
        category: hint.category,
        operator: '',
        equipment: '',
        notes: 'Inferred from callsign',
      };
    }
  }
  const cat = Number(p.category);
  if (cat === 8) {
    return {
      label: 'Rotorcraft',
      category: 'private',
      operator: '',
      equipment: 'ADS-B category: rotorcraft',
      notes: '',
    };
  }
  if (cat === 2 || cat === 3) {
    return {
      label: 'Light aircraft',
      category: 'private',
      operator: '',
      equipment: '',
      notes: '',
    };
  }
  return {
    label: 'Aircraft',
    category: 'unknown',
    operator: '',
    equipment: '',
    notes: '',
  };
}

/**
 * @param {object} box
 */
async function fetchOpenSkyStates(box) {
  const key = `${box.lamin},${box.lomin},${box.lamax},${box.lomax}`;
  const now = Date.now();
  if (openskyCache.key === key && openskyCache.states && now - openskyCache.at < CACHE_MS) {
    return openskyCache.states;
  }
  const url = new URL(OPENSKY_STATES);
  url.searchParams.set('lamin', String(box.lamin));
  url.searchParams.set('lomin', String(box.lomin));
  url.searchParams.set('lamax', String(box.lamax));
  url.searchParams.set('lomax', String(box.lomax));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 18_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Dashbird/1.0 (aircraft watch; opensky-network.org)',
      },
    });
    if (!r.ok) throw new Error(`opensky_http_${r.status}`);
    const j = await r.json();
    const states = Array.isArray(j?.states) ? j.states : [];
    openskyCache = { at: now, key, states };
    return states;
  } catch (e) {
    openskyCache = { at: now, key, states: null, error: String(e?.message || e) };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Date} [now]
 */
export async function fetchAircraftNearbyLive(now = new Date()) {
  if (String(process.env.SKY_AIRCRAFT_NEARBY || '').trim() === '0') {
    return { ok: true, disabled: true, aircraft: [] };
  }

  const address = await loadRainAlertAddress();
  const geo = await geocodeAddress(address);
  if (!geo) {
    return { ok: true, geocodeError: true, address, aircraft: [] };
  }

  const radiusMi = (() => {
    const raw = process.env.AIRCRAFT_WATCH_RADIUS_MI;
    if (raw != null && String(raw).trim() !== '') {
      return Math.min(15, Math.max(1, Number.parseFloat(String(raw))));
    }
    return DEFAULT_RADIUS_MI;
  })();

  const fetchRadiusMi = Math.max(radiusMi, OPENSKY_FETCH_MIN_RADIUS_MI);
  const box = bboxForRadiusMi(geo.lat, geo.lon, fetchRadiusMi);
  let states;
  try {
    states = await fetchOpenSkyStates(box);
  } catch (e) {
    return {
      ok: true,
      address,
      geo,
      radiusMi,
      fetchRadiusMi,
      aircraft: [],
      fetchError: String(e?.message || e),
    };
  }

  /** @type {Array<object>} */
  const aircraft = [];
  for (const row of states) {
    const st = parseStateRow(row);
    if (!st || st.onGround) continue;
    if (st.altM == null || st.altM < MIN_ALT_M) continue;
    if (isLikelyCommercialAirline(st.callsign)) continue;
    if (isLikelyCommercialCategory(st.category)) continue;

    const distMi = haversineMiles(geo.lat, geo.lon, st.lat, st.lon);
    if (distMi > radiusMi) continue;

    const reg = lookupRegistry(st);
    const nNum = parseNNumber(st.callsign) || reg.nNumber || null;
    const altFt = Math.round(st.altM / 0.3048);
    const track = row.length > 10 && Number.isFinite(Number(row[10])) ? Math.round(Number(row[10])) : null;

    aircraft.push({
      icao24: st.icao24,
      callsign: st.callsign || null,
      nNumber: nNum,
      lat: st.lat,
      lon: st.lon,
      altFt,
      distMi: Math.round(distMi * 10) / 10,
      trackDeg: track,
      label: reg.label || 'Aircraft',
      category: reg.category || 'unknown',
      medicalHelicopter: isMedicalHelicopter(reg, st.category),
      helicopter: isStripHelicopter(reg, st.category),
      operator: reg.operator || '',
      equipment: reg.equipment || '',
      notes: reg.notes || '',
      fr24Url: nNum
        ? `https://www.flightradar24.com/data/aircraft/${encodeURIComponent(nNum.toLowerCase())}`
        : `https://globe.adsbexchange.com/?icao=${encodeURIComponent(st.icao24)}`,
    });
  }

  aircraft.sort((a, b) => a.distMi - b.distMi);

  return {
    ok: true,
    address,
    geo,
    radiusMi,
    fetchRadiusMi,
    openskyStateCount: states.length,
    source: 'OpenSky Network ADS-B (same transponder feed class as Flightradar24)',
    sourceUrl: 'https://opensky-network.org/',
    aircraft,
  };
}

/**
 * @param {Date} [now]
 */
export async function snapshotAircraftNearby(now = new Date()) {
  const live = await fetchAircraftNearbyLive(now);
  if (live.disabled) {
    return { active: false, value: 'Disabled (SKY_AIRCRAFT_NEARBY=0)', aircraft: [] };
  }
  if (live.geocodeError) {
    return { active: false, value: 'Could not geocode watch address', aircraft: [] };
  }
  if (live.fetchError) {
    return { active: false, value: `OpenSky unavailable (${live.fetchError})`, aircraft: [] };
  }

  const n = live.aircraft?.length || 0;
  const radiusMi = live.radiusMi ?? DEFAULT_RADIUS_MI;
  if (!n) {
    return {
      active: false,
      value: `None within ${radiusMi} mi`,
      aircraft: [],
      live,
    };
  }

  const summary = live.aircraft
    .slice(0, 4)
    .map((a) => {
      const cs = String(a.callsign || a.nNumber || '').trim().toUpperCase() || a.icao24;
      const sub = formatAircraftRegistrySubtitle(a, { omitTail: Boolean(a.nNumber) });
      return `Aircraft ${cs} — ${sub}`;
    })
    .join('; ');

  return {
    active: true,
    value: `${n} airborne within ${radiusMi} mi: ${summary}`,
    aircraft: live.aircraft,
    live,
  };
}
