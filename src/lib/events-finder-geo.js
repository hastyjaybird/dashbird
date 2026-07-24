/**
 * Events finder geo — Bay Area city set, city-first inclusion, soft distance ranking.
 */
import { haversineMiles } from './dashboard-geo.js';
import { resolveDashboardWeatherLatLon } from './hero-weather-location.js';

/** @typedef {{ lat: number, lon: number, zip: string | null, city: string | null, place: string | null, stateAbbrev: string | null, stateName: string | null }} DashboardGeo */

/** Core East Bay + SF cities for “when I’m in the Bay” discovery. */
export const BAY_AREA_HOME_CITIES = [
  'San Francisco',
  'Oakland',
  'Emeryville',
  'Berkeley',
  'Alameda',
];

/**
 * Bay Area cities with approximate centroids for ZIP-radius city picking.
 * Used to auto-check filter city boxes within max miles of a ZIP.
 * @type {ReadonlyArray<{ name: string, lat: number, lon: number }>}
 */
export const BAY_AREA_CITY_COORDS = Object.freeze([
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  { name: 'Oakland', lat: 37.8044, lon: -122.2712 },
  { name: 'Emeryville', lat: 37.8313, lon: -122.2852 },
  { name: 'Berkeley', lat: 37.8715, lon: -122.273 },
  { name: 'Alameda', lat: 37.7652, lon: -122.2416 },
  { name: 'Albany', lat: 37.8869, lon: -122.2977 },
  { name: 'Piedmont', lat: 37.8244, lon: -122.2316 },
  { name: 'San Leandro', lat: 37.7249, lon: -122.1561 },
  { name: 'Daly City', lat: 37.6879, lon: -122.4702 },
  { name: 'South San Francisco', lat: 37.6547, lon: -122.4077 },
  { name: 'Richmond', lat: 37.9358, lon: -122.3477 },
  { name: 'El Cerrito', lat: 37.9161, lon: -122.3108 },
  { name: 'Orinda', lat: 37.8771, lon: -122.1797 },
  { name: 'Lafayette', lat: 37.8858, lon: -122.118 },
  { name: 'Walnut Creek', lat: 37.9101, lon: -122.0652 },
  { name: 'Hayward', lat: 37.6688, lon: -122.0808 },
  { name: 'Fremont', lat: 37.5485, lon: -121.9886 },
  { name: 'Mountain View', lat: 37.3861, lon: -122.0839 },
  { name: 'Palo Alto', lat: 37.4419, lon: -122.143 },
  { name: 'Redwood City', lat: 37.4852, lon: -122.2364 },
  { name: 'San Mateo', lat: 37.5629, lon: -122.3255 },
  { name: 'Burlingame', lat: 37.5841, lon: -122.3661 },
  { name: 'Millbrae', lat: 37.5985, lon: -122.387 },
  { name: 'Sausalito', lat: 37.8591, lon: -122.4853 },
  { name: 'Marin City', lat: 37.8685, lon: -122.5091 },
  { name: 'San Rafael', lat: 37.9735, lon: -122.5311 },
  { name: 'Concord', lat: 37.978, lon: -122.0311 },
  { name: 'Pleasanton', lat: 37.6624, lon: -121.8747 },
  { name: 'Livermore', lat: 37.6819, lon: -121.768 },
  { name: 'San Jose', lat: 37.3382, lon: -121.8863 },
  { name: 'Santa Clara', lat: 37.3541, lon: -121.9552 },
  { name: 'Sunnyvale', lat: 37.3688, lon: -122.0363 },
  { name: 'Cupertino', lat: 37.323, lon: -122.0322 },
  { name: 'Menlo Park', lat: 37.453, lon: -122.1817 },
  { name: 'Pacifica', lat: 37.6138, lon: -122.4869 },
  { name: 'Half Moon Bay', lat: 37.4636, lon: -122.4286 },
  { name: 'Vallejo', lat: 38.1041, lon: -122.2566 },
  { name: 'Napa', lat: 38.2975, lon: -122.2869 },
]);

/**
 * Normalize a city/place string for comparison.
 * @param {string | null | undefined} s
 * @returns {string}
 */
export function normalizeCityName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bst\b/g, 'saint')
    .replace(/\bsf\b/g, 'san francisco')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {string | null | undefined} city
 * @returns {boolean}
 */
export function isBayAreaCity(city) {
  const n = normalizeCityName(city);
  if (!n) return false;
  return BAY_AREA_CITY_COORDS.some((c) => {
    const h = normalizeCityName(c.name);
    return n === h || n.includes(h) || h.includes(n);
  });
}

/**
 * Eventbrite-style destination slug: `ca--oakland`.
 * @param {{ city?: string | null, stateAbbrev?: string | null }} p
 * @returns {string | null}
 */
export function eventbriteLocationSlug(p) {
  const st = String(p.stateAbbrev || '')
    .trim()
    .toLowerCase();
  const city = String(p.city || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!st || !city) return null;
  return `${st}--${city}`;
}

/**
 * Home cities for discovery when dashboard ZIP is in the Bay.
 * @param {{ city?: string | null, place?: string | null, stateAbbrev?: string | null }} loc
 * @returns {{ bayArea: boolean, homeCities: string[], locationSlugs: string[] }}
 */
export function homeCitiesForLocation(loc) {
  const primary =
    loc.city ||
    (loc.place ? String(loc.place).split(',')[0].trim() : null) ||
    null;
  const bayArea =
    (String(loc.stateAbbrev || '').toUpperCase() === 'CA' && isBayAreaCity(primary)) ||
    isBayAreaCity(primary);

  if (bayArea) {
    const slugs = BAY_AREA_HOME_CITIES.map((city) =>
      eventbriteLocationSlug({ city, stateAbbrev: loc.stateAbbrev || 'CA' }),
    ).filter(Boolean);
    return {
      bayArea: true,
      homeCities: [...BAY_AREA_HOME_CITIES],
      locationSlugs: /** @type {string[]} */ (slugs),
    };
  }

  if (primary) {
    const slug = eventbriteLocationSlug({
      city: primary,
      stateAbbrev: loc.stateAbbrev,
    });
    return {
      bayArea: false,
      homeCities: [primary],
      locationSlugs: slug ? [slug] : [],
    };
  }

  return { bayArea: false, homeCities: [], locationSlugs: [] };
}

/**
 * Cities from the Bay catalog within `miles` of a point (sorted nearest-first).
 * @param {number} lat
 * @param {number} lon
 * @param {number} miles
 * @param {{ catalog?: ReadonlyArray<{ name: string, lat: number, lon: number }> }} [opts]
 * @returns {{ name: string, miles: number, lat: number, lon: number }[]}
 */
export function citiesWithinRadius(lat, lon, miles, opts = {}) {
  const max = Number(miles);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(max) || max <= 0) {
    return [];
  }
  const catalog = opts.catalog || BAY_AREA_CITY_COORDS;
  /** @type {{ name: string, miles: number, lat: number, lon: number }[]} */
  const out = [];
  for (const city of catalog) {
    const d = haversineMiles(lat, lon, city.lat, city.lon);
    if (!Number.isFinite(d) || d > max) continue;
    out.push({
      name: city.name,
      miles: Math.round(d * 10) / 10,
      lat: city.lat,
      lon: city.lon,
    });
  }
  out.sort((a, b) => a.miles - b.miles || a.name.localeCompare(b.name));
  return out;
}

/**
 * Resolve dashboard geo used by Events (ZIP city when available).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<
 *   DashboardGeo & {
 *     geoMode: 'city',
 *     bayArea: boolean,
 *     homeCities: string[],
 *     locationSlug: string | null,
 *     locationSlugs: string[],
 *   }
 * >}
 */
export async function resolveEventsFinderGeo(env = process.env) {
  const loc = await resolveDashboardWeatherLatLon(env);
  let city = loc.city;
  if (!city && loc.place) {
    city = String(loc.place).split(',')[0].trim() || null;
  }
  const home = homeCitiesForLocation({
    city,
    place: loc.place,
    stateAbbrev: loc.stateAbbrev,
  });
  return {
    ...loc,
    city,
    geoMode: 'city',
    bayArea: home.bayArea,
    homeCities: home.homeCities,
    locationSlug: home.locationSlugs[0] || eventbriteLocationSlug({ city, stateAbbrev: loc.stateAbbrev }),
    locationSlugs: home.locationSlugs,
  };
}

/**
 * City match against home city list (Bay set or single city).
 * Missing venue city → keep (don't hard-drop incomplete addresses).
 * @param {{
 *   venueCity?: string | null,
 *   listingCity?: string | null,
 *   city?: string | null,
 * }} event
 * @param {{
 *   city?: string | null,
 *   place?: string | null,
 *   homeCities?: string[],
 *   aliases?: string[],
 * }} home
 * @returns {boolean}
 */
export function eventMatchesHomeCity(event, home) {
  const homeNames = [
    ...(Array.isArray(home.homeCities) ? home.homeCities : []),
    home.city,
    home.place ? String(home.place).split(',')[0] : null,
    ...(Array.isArray(home.aliases) ? home.aliases : []),
  ]
    .map(normalizeCityName)
    .filter(Boolean);
  if (!homeNames.length) return true;

  const candidates = [event.venueCity, event.listingCity, event.city]
    .map(normalizeCityName)
    .filter(Boolean);
  if (!candidates.length) return true;

  return candidates.some((c) =>
    homeNames.some((h) => c === h || c.includes(h) || h.includes(c)),
  );
}

/**
 * Landmark / host cues used only when no explicit city field is present.
 * Keep these high-confidence — false SF/Oakland labels poison city filters.
 * @type {ReadonlyArray<{ city: string, re: RegExp }>}
 */
const BAY_AREA_LANDMARK_HINTS = Object.freeze([
  // SF Mission / Valencia corridor (e.g. Sunday Streets)
  {
    city: 'San Francisco',
    re: /\bvalencia\s+(?:st|street)\b/i,
  },
  {
    city: 'San Francisco',
    re: /\bmission\s+(?:st|street|district|dolores)\b/i,
  },
  {
    city: 'San Francisco',
    re: /\b(?:castro|soma|so\s*ma|tenderloin|north\s*beach|haight|marina|financial\s+district|dogpatch|potrero|richmond\s+district|sunset\s+district|excelsior|bernal|noe\s*valley|hayes\s+valley|japantown|chinatown)\b/i,
  },
  {
    city: 'San Francisco',
    re: /\b(?:golden\s+gate\s+park|dolores\s+park|mission\s+bay|fisherman'?s\s+wharf|oracle\s+park|chase\s+center)\b/i,
  },
  {
    city: 'Oakland',
    re: /\b(?:lake\s+merritt|uptown\s+oakland|jack\s+london\s+square|temescal|rockridge|fruitvale|chinatown\s+oakland|oaklandish)\b/i,
  },
  {
    city: 'Berkeley',
    re: /\b(?:telegraph\s+ave|uc\s+berkeley|sather\s+gate|downtown\s+berkeley)\b/i,
  },
  {
    city: 'Emeryville',
    re: /\b(?:public\s+market\s+emeryville|emeryville\s+public\s+market|pixar\s+pier)\b/i,
  },
]);

/**
 * @param {string} host
 * @returns {string | null}
 */
function cityFromHostname(host) {
  const h = String(host || '')
    .replace(/^www\./i, '')
    .toLowerCase();
  if (!h) return null;
  if (/san[\s.-]?francisco|sfgov|sfba|\.sf\.ca/.test(h)) return 'San Francisco';
  // Labels that end with "sf" (sundaystreetssf.com) or contain -sf- / .sf.
  const labels = h.split('.');
  for (const label of labels.slice(0, -1)) {
    if (!label || label === 'com' || label === 'org' || label === 'net') continue;
    if (/(?:^|[^a-z])sf$/.test(label) || label.endsWith('sf')) return 'San Francisco';
    if (/(?:^|-)sf(?:-|$)/.test(label)) return 'San Francisco';
  }
  if (/\boakland\b/.test(h)) return 'Oakland';
  if (/\bberkeley\b/.test(h)) return 'Berkeley';
  if (/\bemeryville\b/.test(h)) return 'Emeryville';
  if (/\balameda\b/.test(h)) return 'Alameda';
  return null;
}

/**
 * Deduce a Bay Area city when the structured city field is empty.
 * Uses venue/location/title/description text + URL host/path cues.
 * @param {{
 *   city?: string | null,
 *   venueCity?: string | null,
 *   listingCity?: string | null,
 *   venue?: string | null,
 *   location?: string | null,
 *   title?: string | null,
 *   description?: string | null,
 *   url?: string | null,
 * }} event
 * @returns {string | null} Canonical city name, or null if unknown
 */
export function inferEventCity(event) {
  const explicit = [event?.city, event?.venueCity, event?.listingCity]
    .map((c) => String(c || '').trim().replace(/\s+/g, ' '))
    .find(Boolean);
  if (explicit) {
    // Prefer a catalog spelling when the explicit value is a Bay city.
    const want = normalizeCityName(explicit);
    for (const c of BAY_AREA_CITY_COORDS) {
      const n = normalizeCityName(c.name);
      if (want === n || want.includes(n) || n.includes(want)) return c.name;
    }
    return explicit;
  }

  const textBlob = [event?.venue, event?.location, event?.title, event?.description]
    .map((s) => String(s || ''))
    .join(' \n ');
  const url = String(event?.url || '').trim();

  // 1) URL host / path
  if (url) {
    try {
      const u = new URL(url);
      const fromHost = cityFromHostname(u.hostname);
      if (fromHost) return fromHost;
      const pathNorm = normalizeCityName(`${u.hostname} ${u.pathname}`);
      // Longest Bay city name first so "south san francisco" wins over "san francisco".
      const cities = [...BAY_AREA_CITY_COORDS].sort(
        (a, b) => b.name.length - a.name.length,
      );
      for (const c of cities) {
        const n = normalizeCityName(c.name);
        if (!n) continue;
        if (pathNorm.includes(n)) return c.name;
      }
      if (/\bsf\b/.test(pathNorm)) return 'San Francisco';
    } catch {
      /* ignore bad url */
    }
  }

  // 2) High-confidence street / neighborhood landmarks (before bare city tokens,
  //    so "Richmond District" → SF, not East Bay Richmond).
  for (const hint of BAY_AREA_LANDMARK_HINTS) {
    if (hint.re.test(textBlob)) return hint.city;
  }

  // 3) Explicit Bay city names in venue/title/description
  const textNorm = normalizeCityName(textBlob);
  if (textNorm) {
    const cities = [...BAY_AREA_CITY_COORDS].sort(
      (a, b) => b.name.length - a.name.length,
    );
    for (const c of cities) {
      const n = normalizeCityName(c.name);
      if (!n) continue;
      // Avoid "richmond" matching inside "richmond district" (handled above).
      if (n === 'richmond' && /\brichmond\s+district\b/.test(textNorm)) continue;
      const re = new RegExp(`(?:^|\\s)${n.replace(/\s+/g, '\\s+')}(?:\\s|$)`);
      if (re.test(textNorm)) return c.name;
    }
    if (/(?:^|\s)sf(?:\s|$)/.test(textNorm)) return 'San Francisco';
  }

  return null;
}

/**
 * Display / filter label for an event's city (missing → infer → Unknown).
 * @param {{
 *   venueCity?: string | null,
 *   listingCity?: string | null,
 *   city?: string | null,
 *   venue?: string | null,
 *   location?: string | null,
 *   title?: string | null,
 *   description?: string | null,
 *   url?: string | null,
 * }} event
 * @returns {string}
 */
export function eventCityLabel(event) {
  const inferred = inferEventCity(event);
  return inferred || 'Unknown';
}

/**
 * Cities pinned to the front of Events filter checklists.
 * Match is case-insensitive; remaining cities stay A–Z (Unknown last).
 */
const PRIORITY_CITIES = ['oakland', 'san francisco', 'emeryville', 'alameda'];

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCityLabels(a, b) {
  if (a === 'Unknown') return 1;
  if (b === 'Unknown') return -1;
  const ai = PRIORITY_CITIES.indexOf(a.toLowerCase());
  const bi = PRIORITY_CITIES.indexOf(b.toLowerCase());
  if (ai !== bi) {
    if (ai < 0) return 1;
    if (bi < 0) return -1;
    return ai - bi;
  }
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/**
 * Unique sorted city labels from events.
 * @param {object[]} events
 * @returns {string[]}
 */
export function uniqueEventCities(events) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const label = eventCityLabel(ev);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  out.sort(compareCityLabels);
  return out;
}

/**
 * Soft distance for ranking (null when either side lacks coords).
 * `Number(null) === 0`, so null/empty must be rejected before coercion or
 * events without coords look like they're in the Atlantic (0,0).
 * @param {{ lat?: number | null, lon?: number | null }} event
 * @param {{ lat: number, lon: number }} home
 * @returns {number | null}
 */
export function eventDistanceMiles(event, home) {
  const pair = eventLatLonOrNull(event);
  const hlat = coordOrNull(home?.lat);
  const hlon = coordOrNull(home?.lon);
  if (!pair || hlat == null || hlon == null) return null;
  const d = haversineMiles(hlat, hlon, pair.lat, pair.lon);
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function coordOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * True for (0,0) / Null Island — common when APIs send missing coords as zeros.
 * @param {number} lat
 * @param {number} lon
 */
export function isNullIsland(lat, lon) {
  return Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01;
}

/**
 * Finite lat/lon pair, or null when missing / Null Island.
 * @param {{ lat?: unknown, lon?: unknown } | null | undefined} event
 * @returns {{ lat: number, lon: number } | null}
 */
export function eventLatLonOrNull(event) {
  const lat = coordOrNull(event?.lat);
  const lon = coordOrNull(event?.lon);
  if (lat == null || lon == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (isNullIsland(lat, lon)) return null;
  return { lat, lon };
}

/**
 * Look up approximate coords for a Bay Area city name (centroid).
 * @param {string | null | undefined} cityName
 * @returns {{ lat: number, lon: number, name: string } | null}
 */
export function bayAreaCityCoords(cityName) {
  const want = normalizeCityName(cityName);
  if (!want) return null;
  for (const city of BAY_AREA_CITY_COORDS) {
    const n = normalizeCityName(city.name);
    if (n === want || n.includes(want) || want.includes(n)) {
      return { lat: city.lat, lon: city.lon, name: city.name };
    }
  }
  return null;
}

/**
 * Map / display coords: real lat/lon when sane, else Bay Area city centroid.
 * Prefer the city pin when stored coords disagree with the city label by >12 mi
 * (same rule as distance ranking — avoids Null Island and far-off bad geocodes).
 * @param {{
 *   lat?: number | null,
 *   lon?: number | null,
 *   city?: string | null,
 *   venueCity?: string | null,
 *   listingCity?: string | null,
 *   venue?: string | null,
 *   location?: string | null,
 * }} event
 * @returns {{ lat: number, lon: number } | null}
 */
export function resolveEventLatLon(event) {
  const label = eventCityLabel(event);
  const centroid =
    label && label !== 'Unknown' ? bayAreaCityCoords(label) : null;
  const pair = eventLatLonOrNull(event);

  if (pair && centroid) {
    const coordToCity = haversineMiles(pair.lat, pair.lon, centroid.lat, centroid.lon);
    if (Number.isFinite(coordToCity) && coordToCity > 12) {
      return { lat: centroid.lat, lon: centroid.lon };
    }
  }

  if (pair) return pair;
  if (centroid) return { lat: centroid.lat, lon: centroid.lon };
  return null;
}

/**
 * Distance using event coords, else Bay Area city centroid when city is known.
 * @param {{
 *   lat?: number | null,
 *   lon?: number | null,
 *   city?: string | null,
 *   venueCity?: string | null,
 *   listingCity?: string | null,
 * }} event
 * @param {{ lat: number, lon: number }} home
 * @returns {number | null}
 */
export function eventDistanceMilesWithCityFallback(event, home) {
  const label = eventCityLabel(event);
  const centroid =
    label && label !== 'Unknown' ? bayAreaCityCoords(label) : null;
  const pair = eventLatLonOrNull(event);
  const direct = eventDistanceMiles(event, home);

  // Prefer city centroid when stored lat/lon clearly disagree with the city label
  // (common bad geocodes: Petaluma/Sacramento events pinned to Oakland/SF).
  if (direct != null && centroid && pair) {
    const coordToCity = haversineMiles(pair.lat, pair.lon, centroid.lat, centroid.lon);
    if (Number.isFinite(coordToCity) && coordToCity > 12) {
      return eventDistanceMiles({ lat: centroid.lat, lon: centroid.lon }, home);
    }
  }

  // No catalog centroid for this label — still reject coords that sit inside the
  // Bay catalog next to a *different* city than the event claims.
  if (direct != null && label && label !== 'Unknown' && !centroid && pair) {
    const near = citiesWithinRadius(pair.lat, pair.lon, 15);
    if (near.length) {
      const labelNorm = normalizeCityName(label);
      const matchesNear = near.some((c) => {
        const n = normalizeCityName(c.name);
        return n === labelNorm || n.includes(labelNorm) || labelNorm.includes(n);
      });
      if (!matchesNear) {
        // Coords are for somewhere else; don't let them pass the radius gate.
        return null;
      }
    }
  }

  if (direct != null) return direct;
  if (!centroid) return null;
  return eventDistanceMiles({ lat: centroid.lat, lon: centroid.lon }, home);
}

/**
 * Infer online vs in-person from explicit flags or venue text.
 * @param {{
 *   online?: boolean | null,
 *   isOnline?: boolean | null,
 *   attendance?: string | null,
 *   venue?: string | null,
 *   venueName?: string | null,
 *   location?: string | null,
 * }} event
 * @returns {'online' | 'in_person' | 'unknown'}
 */
export function eventAttendanceMode(event) {
  if (event?.online === true || event?.isOnline === true) return 'online';
  if (event?.online === false || event?.isOnline === false) return 'in_person';
  const raw = String(event?.attendance || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (raw === 'online' || raw === 'virtual') return 'online';
  if (raw === 'in_person' || raw === 'inperson' || raw === 'offline') return 'in_person';

  const blob = [event?.venue, event?.venueName, event?.location]
    .map((s) => String(s || '').toLowerCase())
    .join(' ');
  if (/\bonline\b|\bvirtual\b|\bzoom\b|\bwebinar\b|\blivestream\b|\blive stream\b/.test(blob)) {
    return 'online';
  }
  if (blob.trim()) return 'in_person';
  return 'unknown';
}

/**
 * Local calendar day + clock minutes for an event start.
 * @param {Date} start
 * @param {string} [timeZone]
 * @returns {{ day: string, minutes: number } | null}
 */
export function eventLocalDayAndMinutes(start, timeZone = 'America/Los_Angeles') {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return null;
  const tz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : 'America/Los_Angeles';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(start);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const y = get('year');
    const m = get('month');
    const d = get('day');
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (!y || !m || !d || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { day: `${y}-${m}-${d}`, minutes: hour * 60 + minute };
  } catch {
    return {
      day: start.toISOString().slice(0, 10),
      minutes: start.getUTCHours() * 60 + start.getUTCMinutes(),
    };
  }
}

/**
 * Apply saved feed filters (ZIP radius, date/time, attendance).
 * @param {{
 *   venueCity?: string | null,
 *   listingCity?: string | null,
 *   city?: string | null,
 *   lat?: number | null,
 *   lon?: number | null,
 *   start?: string | Date | null,
 *   online?: boolean | null,
 *   isOnline?: boolean | null,
 *   attendance?: string | null,
 *   venue?: string | null,
 *   venueName?: string | null,
 *   location?: string | null,
 * }} event
 * @param {{
 *   cities?: string[],
 *   maxMiles?: number | null,
 *   dateFrom?: string | null,
 *   dateTo?: string | null,
 *   dates?: string[] | null,
 *   earliestLocalTime?: string | null,
 *   attendance?: 'any' | 'in_person' | 'online' | null,
 * }} filters
 * @param {{ lat: number, lon: number, homeCities?: string[] }} home
 * @param {{ timeZone?: string }} [opts]
 * @returns {{ ok: boolean, reason?: string, distanceMiles: number | null, cityMatch: boolean }}
 */
export function eventPassesFeedFilters(event, filters, home, opts = {}) {
  const distanceMiles = eventDistanceMilesWithCityFallback(event, home);
  const attendanceWanted = String(filters?.attendance || 'any')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const attendance = eventAttendanceMode(event);
  const timeZone =
    String(opts.timeZone || process.env.WEATHER_TIME_ZONE || 'America/Los_Angeles').trim()
    || 'America/Los_Angeles';

  if (attendanceWanted === 'online' || attendanceWanted === 'in_person') {
    if (attendance === 'unknown') {
      // Keep unknowns when filtering by attendance — don't hard-drop incomplete data.
    } else if (attendance !== attendanceWanted) {
      return { ok: false, reason: 'attendance', distanceMiles, cityMatch: false };
    }
  }

  // Online events skip distance gates (no local venue required).
  // City-first: when coords are missing, use Bay Area city centroid distance.
  let cityMatch = true;
  if (attendance !== 'online') {
    const maxMiles = filters?.maxMiles;
    if (maxMiles != null && Number.isFinite(Number(maxMiles))) {
      if (distanceMiles == null) {
        // Still allow home-city matches with no usable city/coords (incomplete data).
        if (!eventMatchesHomeCity(event, home)) {
          return { ok: false, reason: 'distance', distanceMiles, cityMatch: false };
        }
        cityMatch = true;
      } else if (distanceMiles > Number(maxMiles)) {
        return { ok: false, reason: 'distance', distanceMiles, cityMatch: false };
      } else {
        cityMatch = true;
      }
    }
  }

  const wantedCities = Array.isArray(filters?.cities)
    ? filters.cities.map((c) => String(c || '').trim()).filter(Boolean)
    : [];
  if (wantedCities.length) {
    const label = eventCityLabel(event);
    const labelNorm = normalizeCityName(label);
    const okCity = wantedCities.some((w) => {
      const wn = normalizeCityName(w);
      return wn && (wn === labelNorm || labelNorm.includes(wn) || wn.includes(labelNorm));
    });
    if (!okCity) {
      return { ok: false, reason: 'city', distanceMiles, cityMatch: false };
    }
    cityMatch = true;
  }

  const start = event.start ? new Date(event.start) : null;
  if (start && !Number.isNaN(start.getTime())) {
    const local = eventLocalDayAndMinutes(start, timeZone);
    const day = local?.day || start.toISOString().slice(0, 10);
    const dates = Array.isArray(filters?.dates)
      ? filters.dates.map((d) => String(d).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [];
    if (dates.length) {
      if (!dates.includes(day)) {
        return { ok: false, reason: 'date', distanceMiles, cityMatch };
      }
    } else {
      const dateFrom = filters?.dateFrom ? String(filters.dateFrom).slice(0, 10) : null;
      const dateTo = filters?.dateTo ? String(filters.dateTo).slice(0, 10) : null;
      if (dateFrom && day < dateFrom) {
        return { ok: false, reason: 'date', distanceMiles, cityMatch };
      }
      if (dateTo && day > dateTo) {
        return { ok: false, reason: 'date', distanceMiles, cityMatch };
      }
    }

    const earliest = String(filters?.earliestLocalTime || '').trim();
    const via = String(event?.raw?.via || '');
    // Date-only Gmail heuristics have no real clock time (local noon placeholder).
    if (via !== 'subject_heuristic' && /^\d{1,2}:\d{2}$/.test(earliest) && local) {
      const [eh, em] = earliest.split(':').map(Number);
      const floor = eh * 60 + em;
      if (local.minutes < floor) {
        return { ok: false, reason: 'time', distanceMiles, cityMatch };
      }
    }
  }

  return { ok: true, distanceMiles, cityMatch };
}

/**
 * Sort key: matched city first, then closer distance, then unknown distance last.
 * @param {{ cityMatch: boolean, distanceMiles: number | null }} a
 * @param {{ cityMatch: boolean, distanceMiles: number | null }} b
 * @returns {number}
 */
export function compareEventsByGeo(a, b) {
  if (a.cityMatch !== b.cityMatch) return a.cityMatch ? -1 : 1;
  const da = a.distanceMiles;
  const db = b.distanceMiles;
  if (da == null && db == null) return 0;
  if (da == null) return 1;
  if (db == null) return -1;
  return da - db;
}
