/**
 * Client helper: suggest howWeMet when phone GPS confirms an ongoing calendar event.
 */
import { getDevicePlace } from './device-location.js';

/**
 * @returns {Promise<{ howWeMet: string, event?: object } | null>}
 */
export async function fetchHowWeMetSuggestion() {
  const place = getDevicePlace();
  // Only trust live phone GPS — not the dashboard weather fallback.
  if (!place || place.source !== 'device') return null;
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return null;
  if (Math.abs(place.lat) < 1e-6 && Math.abs(place.lon) < 1e-6) return null;

  const params = new URLSearchParams();
  params.set('lat', String(place.lat));
  params.set('lon', String(place.lon));
  if (Number.isFinite(place.accuracy) && place.accuracy > 0) {
    params.set('accuracy', String(place.accuracy));
  }

  try {
    const r = await fetch(`/api/network/how-we-met-suggest?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.ok || !j?.matched || !String(j.howWeMet || '').trim()) return null;
    return {
      howWeMet: String(j.howWeMet).trim(),
      event: j.event && typeof j.event === 'object' ? j.event : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Short status suffix when autofill applied.
 * @param {{ howWeMet: string, event?: { title?: string } } | null} suggestion
 */
export function howWeMetStatusBit(suggestion) {
  if (!suggestion?.howWeMet) return '';
  const title = String(suggestion.event?.title || '').trim();
  return title ? ` · How we met: ${title}` : ' · How we met filled from calendar';
}
