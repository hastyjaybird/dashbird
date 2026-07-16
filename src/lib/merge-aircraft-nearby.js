import { fetchAircraftNearbyLive, formatAircraftRegistrySubtitle } from './aircraft-nearby.js';

/**
 * @param {number | null | undefined} trackDeg true track (degrees, 0 = north)
 * @returns {'N' | 'E' | 'S' | 'W' | null}
 */
export function headingCompass(trackDeg) {
  if (!Number.isFinite(Number(trackDeg))) return null;
  const d = ((Number(trackDeg) % 360) + 360) % 360;
  const labels = ['N', 'E', 'S', 'W'];
  return labels[Math.floor((d + 45) / 90) % 4];
}

/**
 * @param {object} ac
 */
function formatCallsign(ac) {
  const cs = String(ac.callsign || '').trim();
  if (cs) return cs.toUpperCase();
  if (ac.nNumber) return String(ac.nNumber).trim().toUpperCase();
  return null;
}

/**
 * @param {object} ac
 */
function titleFor(ac) {
  if (ac.anonymousOrTisb || String(ac.label || '') === 'Unidentified') {
    return 'Unidentified aircraft';
  }
  const id = formatCallsign(ac) || ac.icao24;
  return `Aircraft ${id}`;
}

/**
 * @param {object} ac
 */
function detailFor(ac) {
  return formatAircraftRegistrySubtitle(ac, {
    omitTail: Boolean(ac.nNumber || ac.callsign),
    heading: headingCompass(ac.trackDeg),
  });
}

/**
 * @param {unknown[]} active
 * @param {Date} [now]
 */
export async function mergeAircraftNearby(active, now = new Date()) {
  const list = Array.isArray(active) ? [...active] : [];
  const live = await fetchAircraftNearbyLive(now);
  if (
    !live.ok ||
    live.disabled ||
    live.geocodeError ||
    live.fetchError ||
    !live.aircraft?.length
  ) {
    return list;
  }

  const t0 = now.toISOString();
  const t1 = new Date(now.getTime() + 15 * 60_000).toISOString();

  for (const ac of live.aircraft.slice(0, 5)) {
    const cs = formatCallsign(ac);
    list.push({
      id: `aircraft-live-${ac.icao24}`,
      type: 'aircraft',
      title: titleFor(ac),
      startsAt: t0,
      endsAt: t1,
      source: cs ? `${cs} · ${ac.distMi} mi` : `${ac.distMi} mi`,
      detailLine: detailFor(ac),
      forecastUrl: ac.fr24Url,
      aircraftCategory: ac.category,
      aircraftMedicalHelicopter: Boolean(ac.medicalHelicopter),
      aircraftHelicopter: Boolean(ac.helicopter),
      callsign: formatCallsign(ac),
      icao24: ac.icao24,
      anonymousOrTisb: Boolean(ac.anonymousOrTisb),
    });
  }

  return list.sort((a, b) => {
    const ta = new Date(a.startsAt).getTime();
    const tb = new Date(b.startsAt).getTime();
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
}
