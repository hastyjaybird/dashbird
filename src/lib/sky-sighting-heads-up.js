import {
  SIGHTING_HEADS_UP_TYPES,
  formatObserverSiteLabel,
  resolveLookDirection,
} from './sky-sighting-direction.js';
import { isNightlySightingVisible } from './sky-sighting-night.js';

export const SIGHTING_HEADS_UP_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Sighting events starting within the next `headsUpMs` that have not ended.
 * @param {unknown[]} events
 * @param {Date} now
 * @param {number} [headsUpMs]
 * @param {{ lat?: number, lon?: number }} [geo]
 */
export function filterSightingHeadsUp(events, now = new Date(), headsUpMs = SIGHTING_HEADS_UP_MS, geo = null) {
  const t0 = now.getTime();
  const tHead = t0 + headsUpMs;
  const lat = geo?.lat;
  const lon = geo?.lon;
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lon);

  return (events || [])
    .filter((ev) => {
      if (!ev || !SIGHTING_HEADS_UP_TYPES.has(ev.type)) return false;
      if (typeof ev.startsAt !== 'string') return false;
      const s = new Date(ev.startsAt).getTime();
      if (!Number.isFinite(s)) return false;
      const endRaw = ev.endsAt != null ? new Date(ev.endsAt).getTime() : s;
      const e = Number.isNaN(endRaw) ? s : endRaw;
      if (e < t0) return false;
      if (s > tHead) return false;
      if (hasGeo && !isNightlySightingVisible(ev, lat, lon)) return false;
      return true;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/**
 * Heads-up rows that start after the hero `windowMs` (24h default) but within 3 days.
 * @param {unknown[]} events
 * @param {Date} now
 * @param {number} windowMs
 * @param {number} [headsUpMs]
 */
export function filterSightingHeadsUpBeyondWindow(
  events,
  now = new Date(),
  windowMs = 24 * 60 * 60 * 1000,
  headsUpMs = SIGHTING_HEADS_UP_MS,
  geo = null,
) {
  const t0 = now.getTime();
  const windowEnd = t0 + windowMs;
  return filterSightingHeadsUp(events, now, headsUpMs, geo).filter((ev) => {
    const s = new Date(ev.startsAt).getTime();
    return Number.isFinite(s) && s > windowEnd;
  });
}

/**
 * @param {unknown} ev
 * @param {Date} now
 * @param {string} timeZone
 * @param {{ headsUp?: boolean, lat?: number, lon?: number, zip?: string | null, locationLabel?: string | null }} opts
 */
export function buildSightingDetailLine(ev, now, timeZone, _opts = {}) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  const start = new Date(ev.startsAt);
  if (Number.isNaN(start.getTime())) return '—';

  const dateOpts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz };
  const timeOpts = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz };
  const when = `${start.toLocaleDateString('en-US', dateOpts)} · ${start.toLocaleTimeString('en-US', timeOpts)}`;

  const look = resolveLookDirection(ev);
  const lookBits = [];
  if (look.label) lookBits.push(look.label);
  else if (look.compass) lookBits.push(`look ${look.compass}`);

  return lookBits.length ? `${when} · ${lookBits.join(' · ')}` : when;
}

/**
 * Enrich 24h active sighting rows and append 3-day heads-up rows not already listed.
 * @param {unknown[]} active
 * @param {unknown[]} calendarEvents
 * @param {Date} now
 * @param {number} windowMs
 * @param {string} timeZone
 * @param {{ lat: number, lon: number, zip?: string | null, locationLabel?: string | null }} geo
 */
export function mergeSightingHeadsUp(
  active,
  calendarEvents,
  now = new Date(),
  windowMs = 24 * 60 * 60 * 1000,
  timeZone = 'America/Los_Angeles',
  geo = {},
) {
  const lat = geo.lat;
  const lon = geo.lon;
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lon);

  let list = Array.isArray(active) ? [...active] : [];
  if (hasGeo) {
    list = list.filter((ev) => isNightlySightingVisible(ev, lat, lon));
  }
  const activeIds = new Set(list.map((e) => e?.id).filter(Boolean));
  const t0 = now.getTime();
  const windowEnd = t0 + windowMs;
  const geoOpts = {
    lat: geo.lat,
    lon: geo.lon,
    zip: geo.zip ?? null,
    locationLabel: geo.locationLabel ?? null,
  };

  const enriched = list.map((ev) => {
    if (!ev || !SIGHTING_HEADS_UP_TYPES.has(ev.type)) return ev;
    if (typeof ev.detailLine === 'string' && ev.detailLine.trim() !== '') return ev;
    const s = new Date(ev.startsAt).getTime();
    const headsUp = Number.isFinite(s) && s > windowEnd;
    return {
      ...ev,
      headsUp: headsUp || ev.headsUp === true,
      detailLine: buildSightingDetailLine(ev, now, timeZone, { ...geoOpts, headsUp }),
    };
  });

  const extras = [];
  for (const ev of filterSightingHeadsUpBeyondWindow(calendarEvents, now, windowMs, SIGHTING_HEADS_UP_MS, geo)) {
    if (!ev?.id || activeIds.has(ev.id)) continue;
    extras.push({
      ...ev,
      headsUp: true,
      detailLine: buildSightingDetailLine(ev, now, timeZone, { ...geoOpts, headsUp: true }),
    });
  }

  return [...enriched, ...extras].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
}

/**
 * Settings / status text for a sighting event type.
 * @param {unknown[]} events
 * @param {string} typeId
 * @param {Date} now
 * @param {number} windowMs
 * @param {string} timeZone
 * @param {{ lat: number, lon: number, zip?: string | null, locationLabel?: string | null }} geo
 */
export function sightingTypeStatusValue(events, typeId, now, windowMs, timeZone, geo) {
  const typed = (events || []).filter((e) => e && e.type === typeId);
  const headsUp = filterSightingHeadsUp(typed, now, SIGHTING_HEADS_UP_MS, geo);
  if (!headsUp.length) {
    const hasGeo = Number.isFinite(geo?.lat) && Number.isFinite(geo?.lon);
    const future = typed
      .filter((ev) => {
        const s = new Date(ev.startsAt).getTime();
        if (!Number.isFinite(s) || s <= now.getTime() + SIGHTING_HEADS_UP_MS) return false;
        if (hasGeo && !isNightlySightingVisible(ev, geo.lat, geo.lon)) return false;
        return true;
      })
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    if (future.length) {
      const ev = future[0];
      const site = formatObserverSiteLabel(geo);
      const look = resolveLookDirection(ev);
      const lookBit = look.label || (look.compass ? `look ${look.compass}` : 'direction TBD');
      return `Next (>3d, ${site}): ${ev.title || ev.id} · ${lookBit}`;
    }
    return `No sighting in next 3 days (${formatObserverSiteLabel(geo)})`;
  }

  const geoOpts = {
    lat: geo.lat,
    lon: geo.lon,
    zip: geo.zip ?? null,
    locationLabel: geo.locationLabel ?? null,
  };
  const t0 = now.getTime();
  const windowEnd = t0 + windowMs;

  return headsUp
    .map((ev) => {
      const s = new Date(ev.startsAt).getTime();
      const isHeadsUp = Number.isFinite(s) && s > windowEnd;
      return buildSightingDetailLine(ev, now, timeZone, { ...geoOpts, headsUp: isHeadsUp });
    })
    .join('; ');
}
