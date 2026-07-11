/**
 * Live non-airline aircraft within a radius of the rain-alert address (ADS-B via adsb.fi).
 * Free community feed with registration + type; denser than anonymous OpenSky for Bay Area GA/LE.
 */
import registry from '../data/oakland-aircraft-registry.json' with { type: 'json' };
import { geocodeAddress } from './geocode-address.js';
import { loadRainAlertAddress } from './rain-alert-address-store.js';

const ADSB_FI_NEAR = 'https://opendata.adsb.fi/api/v2/lat';
/** Same readsb-style JSON as adsb.fi; used if adsb.fi returns 429 / errors. */
const AIRPLANES_LIVE_NEAR = 'https://api.airplanes.live/v2/point';
/** Statute miles → nautical miles (adsb.fi / airplanes.live dist param). */
const MI_TO_NM = 1 / 1.15078;
const MIN_ALT_FT = 50;
const DEFAULT_RADIUS_MI = 3;
const CACHE_MS = 90_000;

/** @type {{ at: number, key: string, aircraft: unknown[] | null, error?: string, source?: string, sourceUrl?: string }} */
let feedCache = { at: 0, key: '', aircraft: null };

/** Common ICAO type codes for helicopters / rotorcraft. */
const HELI_ICAO_TYPES = new Set([
  'AS50',
  'AS55',
  'AS65',
  'B06',
  'B06T',
  'B407',
  'B412',
  'B429',
  'B430',
  'EC20',
  'EC30',
  'EC35',
  'EC45',
  'EC55',
  'EC75',
  'H500',
  'H60',
  'R22',
  'R44',
  'R66',
  'S76',
  'S92',
  'A109',
  'A119',
  'A139',
  'A189',
  'UH1',
]);

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
  'JSX',
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
 * OpenSky numeric 4–7 = large airliners; adsb.fi A3–A5 = large/heavy. Rotorcraft (8 / A7) kept.
 * @param {number | string | null | undefined} category
 */
function isLikelyCommercialCategory(category) {
  const c = Number(category);
  if (Number.isFinite(c)) return c >= 4 && c <= 7;
  const s = String(category || '')
    .trim()
    .toUpperCase();
  return s === 'A3' || s === 'A4' || s === 'A5';
}

/**
 * @param {number | string | null | undefined} adsbCategory
 */
function isRotorcraftCategory(adsbCategory) {
  if (Number(adsbCategory) === 8) return true;
  const s = String(adsbCategory || '')
    .trim()
    .toUpperCase();
  return s === 'A7' || s === '7';
}

/**
 * @param {string | null | undefined} typeCode
 * @param {string | null | undefined} desc
 */
function isHelicopterTypeOrDesc(typeCode, desc) {
  const t = String(typeCode || '')
    .trim()
    .toUpperCase();
  if (t && HELI_ICAO_TYPES.has(t)) return true;
  const d = String(desc || '').toLowerCase();
  return (
    d.includes('helicopter') ||
    d.includes('rotorcraft') ||
    d.includes('ecureuil') ||
    d.includes('as-350') ||
    d.includes('as350') ||
    d.includes('bell 407') ||
    d.includes('bell 206')
  );
}

/**
 * @param {string | null | undefined} raw
 */
function normalizeCallsign(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * @param {object} reg registry hit
 * @param {number | string | null | undefined} adsbCategory
 */
export function isMedicalHelicopter(reg, adsbCategory) {
  if (reg?.icon === 'medical_helicopter') return true;
  if ((reg?.category || 'unknown') !== 'medical') return false;
  const text = `${reg.label || ''} ${reg.equipment || ''}`.toLowerCase();
  if (text.includes('helicopter') || text.includes('heli') || text.includes('rotorcraft')) return true;
  return isRotorcraftCategory(adsbCategory);
}

/**
 * Sky strip glyph: registry icon, rotorcraft category, or known heli type/desc.
 * @param {object} reg
 * @param {number | string | null | undefined} adsbCategory
 * @param {{ type?: string | null, desc?: string | null }} [feed]
 */
export function isStripHelicopter(reg, adsbCategory, feed = {}) {
  const icon = String(reg?.icon || '').trim();
  if (icon === 'helicopter' || icon === 'medical_helicopter') return true;
  if (isRotorcraftCategory(adsbCategory)) return true;
  if (isHelicopterTypeOrDesc(feed.type, feed.desc)) return true;
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

/**
 * @param {object} p
 */
function lookupRegistry(p) {
  const list = Array.isArray(registry.aircraft) ? registry.aircraft : [];
  const icao = String(p.icao24 || '').toLowerCase();
  const nNum =
    parseNNumber(p.nNumber) || parseNNumber(p.registration) || parseNNumber(p.callsign);
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
        icon: hint.icon || undefined,
        operator: '',
        equipment: '',
        notes: 'Inferred from callsign',
      };
    }
  }
  if (isRotorcraftCategory(p.category) || isHelicopterTypeOrDesc(p.type, p.desc)) {
    return {
      label: 'Rotorcraft',
      category: 'private',
      icon: 'helicopter',
      operator: '',
      equipment: p.desc || p.type || 'ADS-B rotorcraft',
      notes: '',
    };
  }
  const catNum = Number(p.category);
  if (catNum === 2 || catNum === 3 || p.category === 'A1' || p.category === 'A2') {
    return {
      label: 'Light aircraft',
      category: 'private',
      operator: '',
      equipment: p.desc || p.type || '',
      notes: '',
    };
  }
  return {
    label: 'Aircraft',
    category: 'unknown',
    operator: '',
    equipment: p.desc || p.type || '',
    notes: '',
  };
}

/**
 * @param {unknown} row
 */
function parseAdsbFiRow(row) {
  if (!row || typeof row !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const icao24 = String(r.hex || '')
    .trim()
    .toLowerCase();
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!icao24 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const altRaw = r.alt_baro != null ? r.alt_baro : r.alt_geom;
  const onGround =
    r.alt_baro === 'ground' ||
    r.alt_geom === 'ground' ||
    String(altRaw).toLowerCase() === 'ground';
  const altFt = onGround ? null : Number(altRaw);
  const callsign = typeof r.flight === 'string' ? r.flight.trim() : '';
  const registration = typeof r.r === 'string' ? r.r.trim().toUpperCase() : '';
  const type = typeof r.t === 'string' ? r.t.trim().toUpperCase() : '';
  const desc = typeof r.desc === 'string' ? r.desc.trim() : '';
  const category = r.category != null ? String(r.category).trim() : '';
  const track = Number.isFinite(Number(r.track)) ? Math.round(Number(r.track)) : null;
  const ownOp = typeof r.ownOp === 'string' ? r.ownOp.trim() : '';

  return {
    icao24,
    callsign,
    registration,
    nNumber: parseNNumber(registration) || parseNNumber(callsign),
    lat,
    lon,
    altFt: Number.isFinite(altFt) ? altFt : null,
    onGround,
    category,
    type,
    desc,
    trackDeg: track,
    ownOp,
  };
}

/**
 * @param {string} url
 * @param {string} label
 * @param {AbortSignal} [signal]
 */
async function fetchReadsbNearbyUrl(url, label, signal) {
  const r = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Dashbird/1.0 (personal; aircraft watch; https://adsb.fi)',
    },
  });
  if (!r.ok) throw new Error(`${label}_http_${r.status}`);
  const j = await r.json();
  const aircraft = Array.isArray(j?.aircraft) ? j.aircraft : Array.isArray(j?.ac) ? j.ac : [];
  return { aircraft, label };
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} distNm
 * @returns {Promise<{ aircraft: unknown[], source: string, sourceUrl: string }>}
 */
async function fetchCommunityAdsbNearby(lat, lon, distNm) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${distNm}`;
  const now = Date.now();
  if (feedCache.key === key && feedCache.aircraft && now - feedCache.at < CACHE_MS) {
    return {
      aircraft: feedCache.aircraft,
      source: feedCache.source || 'adsb.fi open data (community ADS-B)',
      sourceUrl: feedCache.sourceUrl || 'https://adsb.fi/',
    };
  }

  const primaryUrl = `${ADSB_FI_NEAR}/${encodeURIComponent(String(lat))}/lon/${encodeURIComponent(String(lon))}/dist/${encodeURIComponent(String(distNm))}`;
  const fallbackUrl = `${AIRPLANES_LIVE_NEAR}/${encodeURIComponent(String(lat))}/${encodeURIComponent(String(lon))}/${encodeURIComponent(String(distNm))}`;

  const meta = {
    adsb_fi: { source: 'adsb.fi open data (community ADS-B)', sourceUrl: 'https://adsb.fi/' },
    airplanes_live: { source: 'airplanes.live (adsb.fi fallback)', sourceUrl: 'https://airplanes.live/' },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 7_000);
  try {
    // Prefer adsb.fi when both are healthy (150ms head start); otherwise first success wins.
    const picked = await Promise.any([
      fetchReadsbNearbyUrl(primaryUrl, 'adsb_fi', ac.signal),
      new Promise((resolve, reject) => {
        const t = setTimeout(async () => {
          try {
            resolve(await fetchReadsbNearbyUrl(fallbackUrl, 'airplanes_live', ac.signal));
          } catch (e) {
            reject(e);
          }
        }, 150);
        ac.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
    ]);
    const m = meta[picked.label] || meta.adsb_fi;
    feedCache = {
      at: now,
      key,
      aircraft: picked.aircraft,
      source: m.source,
      sourceUrl: m.sourceUrl,
    };
    return { aircraft: picked.aircraft, source: m.source, sourceUrl: m.sourceUrl };
  } catch (e) {
    const err = e?.errors?.[0] || e;
    feedCache = { at: now, key, aircraft: null, error: String(err?.message || err) };
    throw err;
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
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

  // Slightly wider NM query, then filter to statute-mile radius.
  const fetchRadiusNm = Math.min(250, Math.max(1, Math.ceil(radiusMi * MI_TO_NM * 10) / 10 + 0.5));
  let rows;
  let source = 'adsb.fi open data (community ADS-B)';
  let sourceUrl = 'https://adsb.fi/';
  try {
    const feed = await fetchCommunityAdsbNearby(geo.lat, geo.lon, fetchRadiusNm);
    rows = feed.aircraft;
    source = feed.source;
    sourceUrl = feed.sourceUrl;
  } catch (e) {
    return {
      ok: true,
      address,
      geo,
      radiusMi,
      fetchRadiusNm,
      aircraft: [],
      fetchError: String(e?.message || e),
    };
  }

  /** @type {Array<object>} */
  const aircraft = [];
  for (const row of rows) {
    const st = parseAdsbFiRow(row);
    if (!st || st.onGround) continue;
    if (st.altFt == null || st.altFt < MIN_ALT_FT) continue;
    if (isLikelyCommercialAirline(st.callsign)) continue;
    if (isLikelyCommercialCategory(st.category)) continue;

    const distMi = haversineMiles(geo.lat, geo.lon, st.lat, st.lon);
    if (distMi > radiusMi) continue;

    const reg = lookupRegistry(st);
    const nNum = st.nNumber || reg.nNumber || null;
    const feed = { type: st.type, desc: st.desc };
    const operator = reg.operator || st.ownOp || '';
    const equipment = reg.equipment || st.desc || st.type || '';

    aircraft.push({
      icao24: st.icao24,
      callsign: st.callsign || null,
      nNumber: nNum,
      lat: st.lat,
      lon: st.lon,
      altFt: Math.round(st.altFt),
      distMi: Math.round(distMi * 10) / 10,
      trackDeg: st.trackDeg,
      label: reg.label || 'Aircraft',
      category: reg.category || 'unknown',
      medicalHelicopter: isMedicalHelicopter(reg, st.category),
      helicopter: isStripHelicopter(reg, st.category, feed),
      operator,
      equipment,
      notes: reg.notes || '',
      type: st.type || null,
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
    fetchRadiusNm,
    feedCount: rows.length,
    source,
    sourceUrl,
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
    return { active: false, value: `adsb.fi unavailable (${live.fetchError})`, aircraft: [] };
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
