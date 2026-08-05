/**
 * Planning & logistics helpers for notable / distant events.
 * Uses deep links (no paid travel APIs) + nearest major airport lookup.
 */
import { haversineMiles } from './dashboard-geo.js';
import { BAY_AREA_CITY_COORDS, resolveEventLatLon } from './events-finder-geo.js';

/** Approximate Bay Area centroid (SF downtown). */
export const BAY_AREA_CENTER = Object.freeze({
  name: 'San Francisco Bay Area',
  lat: 37.7749,
  lon: -122.4194,
});

/** Major US international airports (lat/lon centroids). */
export const MAJOR_INTL_AIRPORTS = Object.freeze([
  { code: 'SFO', name: 'San Francisco International', lat: 37.6213, lon: -122.379 },
  { code: 'OAK', name: 'Oakland International', lat: 37.7126, lon: -122.2195 },
  { code: 'SJC', name: 'San Jose Mineta International', lat: 37.3639, lon: -121.9289 },
  { code: 'LAX', name: 'Los Angeles International', lat: 33.9416, lon: -118.4085 },
  { code: 'SAN', name: 'San Diego International', lat: 32.7336, lon: -117.1897 },
  { code: 'SEA', name: 'Seattle-Tacoma International', lat: 47.4502, lon: -122.3088 },
  { code: 'PDX', name: 'Portland International', lat: 45.5898, lon: -122.5951 },
  { code: 'DEN', name: 'Denver International', lat: 39.8561, lon: -104.6737 },
  { code: 'LAS', name: 'Harry Reid International', lat: 36.084, lon: -115.1537 },
  { code: 'PHX', name: 'Phoenix Sky Harbor', lat: 33.4373, lon: -112.0078 },
  { code: 'ORD', name: 'Chicago O\'Hare', lat: 41.9742, lon: -87.9073 },
  { code: 'JFK', name: 'John F. Kennedy International', lat: 40.6413, lon: -73.7781 },
  { code: 'EWR', name: 'Newark Liberty International', lat: 40.6895, lon: -74.1745 },
  { code: 'BOS', name: 'Boston Logan International', lat: 42.3656, lon: -71.0096 },
  { code: 'ATL', name: 'Hartsfield-Jackson Atlanta', lat: 33.6407, lon: -84.4277 },
  { code: 'MIA', name: 'Miami International', lat: 25.7959, lon: -80.287 },
  { code: 'DFW', name: 'Dallas/Fort Worth International', lat: 32.8998, lon: -97.0403 },
  { code: 'IAH', name: 'Houston George Bush Intercontinental', lat: 29.9902, lon: -95.3368 },
  { code: 'MSP', name: 'Minneapolis–Saint Paul International', lat: 44.8848, lon: -93.2223 },
  { code: 'DTW', name: 'Detroit Metro', lat: 42.2162, lon: -83.3554 },
  { code: 'SLC', name: 'Salt Lake City International', lat: 40.7899, lon: -111.9791 },
  { code: 'AUS', name: 'Austin-Bergstrom International', lat: 30.1945, lon: -97.6699 },
  { code: 'BNA', name: 'Nashville International', lat: 36.1263, lon: -86.6774 },
  { code: 'MSY', name: 'Louis Armstrong New Orleans', lat: 29.9934, lon: -90.258 },
  { code: 'RNO', name: 'Reno-Tahoe International', lat: 39.4991, lon: -119.7681 },
  { code: 'BOI', name: 'Boise Airport', lat: 43.5644, lon: -116.2228 },
  { code: 'SMF', name: 'Sacramento International', lat: 38.6954, lon: -121.5908 },
]);

const BAY_AIRPORTS = new Set(['SFO', 'OAK', 'SJC']);

/**
 * @param {number | null | undefined} lat
 * @param {number | null | undefined} lon
 * @returns {number | null}
 */
export function milesFromBayArea(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (Math.abs(la) < 0.01 && Math.abs(lo) < 0.01) return null;
  return haversineMiles(BAY_AREA_CENTER.lat, BAY_AREA_CENTER.lon, la, lo);
}

/**
 * True when the event is more than `thresholdMiles` outside the Bay Area centroid.
 * Also treats known Bay cities within ~60mi as "in Bay" even if centroid distance is high.
 * @param {{ lat?: unknown, lon?: unknown, city?: unknown }} event
 * @param {number} [thresholdMiles]
 */
export function isOutsideBayArea(event, thresholdMiles = 100) {
  const miles = milesFromBayArea(event?.lat, event?.lon);
  if (miles != null) return miles > thresholdMiles;

  const city = String(event?.city || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!city) return false;
  for (const c of BAY_AREA_CITY_COORDS) {
    const name = c.name.toLowerCase();
    if (city === name || city.includes(name) || name.includes(city)) return false;
  }
  // Unknown city with no coords — don't assume travel.
  return false;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {{ code: string, name: string, lat: number, lon: number, miles: number } | null}
 */
export function nearestInternationalAirport(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  let best = null;
  for (const a of MAJOR_INTL_AIRPORTS) {
    const miles = haversineMiles(la, lo, a.lat, a.lon);
    if (!best || miles < best.miles) {
      best = { ...a, miles };
    }
  }
  return best;
}

/**
 * Suggested ground transport from nearest airport to venue.
 * @param {{ code: string, name: string, miles: number }} airport
 * @param {{ lat?: unknown, lon?: unknown, venue?: unknown, city?: unknown }} event
 */
export function airportTransportOptions(airport, event) {
  const dest =
    [event?.venue, event?.city].map((s) => String(s || '').trim()).filter(Boolean).join(', ')
    || `${event?.lat},${event?.lon}`;
  const mapsDir = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    `${airport.name} (${airport.code})`,
  )}&destination=${encodeURIComponent(dest)}`;
  const rideshare = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `rideshare to ${dest}`,
  )}`;
  /** @type {{ label: string, detail: string, url: string }[]} */
  const options = [
    {
      label: 'Rideshare / taxi',
      detail: `Door-to-door from ${airport.code} (~${Math.round(airport.miles)} mi to venue area).`,
      url: rideshare,
    },
    {
      label: 'Driving directions',
      detail: `Google Maps route from ${airport.code} to the venue.`,
      url: mapsDir,
    },
  ];
  if (airport.code === 'SFO' || airport.code === 'OAK' || airport.code === 'SJC') {
    options.unshift({
      label: 'BART / Caltrain / VTA',
      detail: 'Bay Area rail + local transit from the airport — check schedules for event day.',
      url: 'https://www.google.com/maps/travel/flights?tfs=transit',
    });
  } else if (airport.miles <= 15) {
    options.unshift({
      label: 'Airport transit / shuttle',
      detail: `Venue is ~${Math.round(airport.miles)} mi from ${airport.code} — local transit or hotel shuttle may work.`,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${airport.code} airport transit to ${dest}`,
      )}`,
    });
  } else {
    options.push({
      label: 'Rental car',
      detail: `~${Math.round(airport.miles)} mi from ${airport.code} — rental may be simplest for the area.`,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `car rental ${airport.code}`,
      )}`,
    });
  }
  return options;
}

/**
 * @param {string | null | undefined} iso
 * @returns {string} YYYY-MM-DD or empty
 */
function ymd(iso) {
  const d = Date.parse(String(iso || ''));
  if (!Number.isFinite(d)) return '';
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Build deep-link suggestions (no live fare quotes).
 * @param {object} event
 * @param {{
 *   milesFromBay: number | null,
 *   outsideBay: boolean,
 *   nearestAirport: ReturnType<typeof nearestInternationalAirport>,
 * }} geo
 */
export function buildTravelDeepLinks(event, geo) {
  const city = String(event?.city || event?.venue || '').trim() || 'destination';
  const start = ymd(event?.start);
  const end = ymd(event?.end) || start;
  const destQuery = encodeURIComponent(city);

  /** @type {{ label: string, detail: string, url: string }[]} */
  const flights = [];
  /** @type {{ label: string, detail: string, url: string }[]} */
  const stays = [];
  /** @type {{ label: string, detail: string, url: string }[]} */
  const other = [];

  if (geo.outsideBay && geo.nearestAirport && !BAY_AIRPORTS.has(geo.nearestAirport.code)) {
    const destCode = geo.nearestAirport.code;
    const q = start
      ? `flights from SFO to ${destCode} on ${start}`
      : `flights from SFO to ${destCode}`;
    flights.push({
      label: `Flights SFO → ${destCode}`,
      detail: start
        ? `Suggested arrival window around ${start}${end && end !== start ? `–${end}` : ''}.`
        : 'Open Google Flights and pick dates.',
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`,
    });
    flights.push({
      label: `Flights OAK → ${destCode}`,
      detail: 'Alternate Bay Area departure.',
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent(
        start ? `flights from OAK to ${destCode} on ${start}` : `flights from OAK to ${destCode}`,
      )}`,
    });
  } else if (geo.outsideBay) {
    flights.push({
      label: 'Search flights',
      detail: `Look up flights toward ${city}.`,
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent(
        start ? `flights to ${city} on ${start}` : `flights to ${city}`,
      )}`,
    });
  }

  stays.push({
    label: 'Hotels near venue',
    detail: start
      ? `Stay search for ${city} (${start}${end && end !== start ? ` → ${end}` : ''}).`
      : `Stay search for ${city}.`,
    url: `https://www.google.com/travel/search?q=${encodeURIComponent(
      start ? `hotels in ${city} ${start}` : `hotels in ${city}`,
    )}`,
  });
  stays.push({
    label: 'Map lodging nearby',
    detail: 'Browse hotels / short-term stays on Maps.',
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`hotels near ${city}`)}`,
  });

  other.push({
    label: 'Venue on map',
    detail: String(event?.venue || city),
    url:
      Number.isFinite(Number(event?.lat)) && Number.isFinite(Number(event?.lon))
        ? `https://www.google.com/maps/search/?api=1&query=${Number(event.lat)},${Number(event.lon)}`
        : `https://www.google.com/maps/search/?api=1&query=${destQuery}`,
  });
  other.push({
    label: 'Weather around event',
    detail: 'Check the forecast before packing.',
    url: `https://www.google.com/search?q=${encodeURIComponent(
      start ? `weather ${city} ${start}` : `weather ${city}`,
    )}`,
  });
  other.push({
    label: 'Local transit overview',
    detail: `Getting around ${city}.`,
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `public transit ${city}`,
    )}`,
  });

  return { flights, stays, other };
}

/**
 * Nearby catalog events within radiusMiles, overlapping ± windowDays of the target start.
 * @param {object} target
 * @param {object[]} catalog
 * @param {{ radiusMiles?: number, windowDays?: number, limit?: number }} [opts]
 */
export function findNearbyEvents(target, catalog, opts = {}) {
  const radius = Number(opts.radiusMiles) > 0 ? Number(opts.radiusMiles) : 40;
  const windowDays = Number(opts.windowDays) > 0 ? Number(opts.windowDays) : 3;
  const limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), 20) : 8;
  const tLat = Number(target?.lat);
  const tLon = Number(target?.lon);
  const tStart = Date.parse(String(target?.start || ''));
  const targetId = String(target?.id || '');
  if (!Number.isFinite(tLat) || !Number.isFinite(tLon)) return [];

  /** @type {{ event: object, miles: number }[]} */
  const scored = [];
  for (const ev of Array.isArray(catalog) ? catalog : []) {
    if (!ev || String(ev.id || '') === targetId) continue;
    const lat = Number(ev.lat);
    const lon = Number(ev.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const miles = haversineMiles(tLat, tLon, lat, lon);
    if (miles > radius) continue;
    if (Number.isFinite(tStart)) {
      const s = Date.parse(String(ev.start || ''));
      if (Number.isFinite(s)) {
        const deltaDays = Math.abs(s - tStart) / (24 * 60 * 60 * 1000);
        if (deltaDays > windowDays) continue;
      }
    }
    scored.push({ event: ev, miles });
  }
  scored.sort((a, b) => a.miles - b.miles || String(a.event.start || '').localeCompare(String(b.event.start || '')));
  return scored.slice(0, limit).map(({ event, miles }) => ({
    id: event.id,
    title: event.title,
    start: event.start,
    city: event.city,
    venue: event.venue,
    url: event.url,
    miles: Math.round(miles * 10) / 10,
    notable: event.notable === true,
  }));
}

/**
 * Prefer stored coords; fall back to Bay Area city centroid resolution.
 * Rejects Null Island / missing pairs (Number(null) === 0).
 * @param {object} event
 * @returns {{ lat: number, lon: number } | null}
 */
export function resolveLogisticsLatLon(event) {
  const resolved = resolveEventLatLon(event);
  if (
    resolved
    && Number.isFinite(resolved.lat)
    && Number.isFinite(resolved.lon)
    && !(Math.abs(resolved.lat) < 0.01 && Math.abs(resolved.lon) < 0.01)
  ) {
    return resolved;
  }
  const la = Number(event?.lat);
  const lo = Number(event?.lon);
  if (
    event?.lat != null
    && event?.lon != null
    && Number.isFinite(la)
    && Number.isFinite(lo)
    && !(Math.abs(la) < 0.01 && Math.abs(lo) < 0.01)
  ) {
    return { lat: la, lon: lo };
  }
  return null;
}

/**
 * Full logistics payload for one event.
 * @param {object} event
 * @param {object[]} catalog
 */
export function buildEventLogistics(event, catalog = []) {
  const coords = resolveLogisticsLatLon(event);
  const located = coords ? { ...event, lat: coords.lat, lon: coords.lon } : { ...event };
  const milesFromBay = milesFromBayArea(located.lat, located.lon);
  const outsideBay = isOutsideBayArea(located, 100);
  const nearestAirport = coords
    ? nearestInternationalAirport(coords.lat, coords.lon)
    : null;
  const links = buildTravelDeepLinks(located, { milesFromBay, outsideBay, nearestAirport });
  const transport =
    outsideBay && nearestAirport ? airportTransportOptions(nearestAirport, located) : [];
  const nearby = findNearbyEvents(located, catalog.map((ev) => {
    const c = resolveLogisticsLatLon(ev);
    return c ? { ...ev, lat: c.lat, lon: c.lon } : ev;
  }));

  return {
    ok: true,
    eventId: String(event?.id || ''),
    map: {
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      label: [event?.venue, event?.city].filter(Boolean).join(', ') || event?.title || 'Event',
      bayCenter: BAY_AREA_CENTER,
    },
    milesFromBay: milesFromBay != null ? Math.round(milesFromBay * 10) / 10 : null,
    outsideBay,
    nearestAirport: nearestAirport
      ? {
          code: nearestAirport.code,
          name: nearestAirport.name,
          lat: nearestAirport.lat,
          lon: nearestAirport.lon,
          miles: Math.round(nearestAirport.miles * 10) / 10,
        }
      : null,
    transportFromAirport: transport,
    flights: links.flights,
    accommodations: links.stays,
    otherConsiderations: links.other,
    nearbyEvents: nearby,
    planningNotes: event?.planningNotes || null,
  };
}
