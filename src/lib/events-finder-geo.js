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

/** Extra place names that still count as “in the Bay” for activating the metro set. */
const BAY_AREA_TRIGGER_CITIES = BAY_AREA_CITY_COORDS.map((c) => c.name);

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
  return BAY_AREA_TRIGGER_CITIES.some((c) => {
    const h = normalizeCityName(c);
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
 * Soft distance for ranking (null when either side lacks coords).
 * @param {{ lat?: number | null, lon?: number | null }} event
 * @param {{ lat: number, lon: number }} home
 * @returns {number | null}
 */
export function eventDistanceMiles(event, home) {
  const elat = Number(event.lat);
  const elon = Number(event.lon);
  if (!Number.isFinite(elat) || !Number.isFinite(elon)) return null;
  if (!Number.isFinite(home.lat) || !Number.isFinite(home.lon)) return null;
  const d = haversineMiles(home.lat, home.lon, elat, elon);
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
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
 * Apply saved feed filters (city subset, optional max miles, date/time, attendance).
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
 * @returns {{ ok: boolean, reason?: string, distanceMiles: number | null, cityMatch: boolean }}
 */
export function eventPassesFeedFilters(event, filters, home) {
  const distanceMiles = eventDistanceMiles(event, home);
  const attendanceWanted = String(filters?.attendance || 'any')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const attendance = eventAttendanceMode(event);

  if (attendanceWanted === 'online' || attendanceWanted === 'in_person') {
    if (attendance === 'unknown') {
      // Keep unknowns when filtering by attendance — don't hard-drop incomplete data.
    } else if (attendance !== attendanceWanted) {
      return { ok: false, reason: 'attendance', distanceMiles, cityMatch: false };
    }
  }

  // Online events skip city/distance gates (no local venue required).
  if (attendance === 'online') {
    // still apply date/time below
  } else {
    const activeCities =
      Array.isArray(filters?.cities) && filters.cities.length
        ? filters.cities
        : home.homeCities || [];

    const cityMatch = eventMatchesHomeCity(event, {
      ...home,
      homeCities: activeCities,
    });
    if (!cityMatch) {
      return { ok: false, reason: 'city', distanceMiles, cityMatch: false };
    }

    const maxMiles = filters?.maxMiles;
    if (maxMiles != null && Number.isFinite(Number(maxMiles))) {
      if (distanceMiles == null) {
        // No coords: keep if city matched (city-first), don't hard-drop.
      } else if (distanceMiles > Number(maxMiles)) {
        return { ok: false, reason: 'distance', distanceMiles, cityMatch: true };
      }
    }
  }

  const cityMatch =
    attendance === 'online'
      ? true
      : eventMatchesHomeCity(event, {
          ...home,
          homeCities:
            Array.isArray(filters?.cities) && filters.cities.length
              ? filters.cities
              : home.homeCities || [],
        });

  const start = event.start ? new Date(event.start) : null;
  if (start && !Number.isNaN(start.getTime())) {
    const day = start.toISOString().slice(0, 10);
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
    if (/^\d{1,2}:\d{2}$/.test(earliest)) {
      const [eh, em] = earliest.split(':').map(Number);
      const mins = start.getHours() * 60 + start.getMinutes();
      const floor = eh * 60 + em;
      if (mins < floor) {
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
