import { fetchCnnFearGreedIndex } from './fear-greed-index.js';
import { getEventTypeLiveUrl } from './event-types-manifest.js';
import { getWeatherRadarStatus, radarDisabled } from './weather-radar-status.js';

/** @param {string} err */
export function formatServiceError(err) {
  const e = String(err || '').trim();
  if (!e) return 'Unavailable';
  if (e === 'fetch_failed') return 'Fetch failed (upstream or network)';
  if (e === 'timeout') return 'Request timed out';
  if (e === 'disabled') return 'Disabled in server config';
  if (e === 'no_score' || e === 'score_zero') return 'No valid score from upstream';
  if (e.startsWith('http_')) return `Upstream HTTP ${e.slice(5)}`;
  if (/networkerror/i.test(e) || /fetch resource/i.test(e)) {
    return 'Network error when attempting to fetch resource';
  }
  return e.replace(/_/g, ' ');
}

/**
 * @returns {Promise<{ ok: true, part: string, types: object[] }>}
 */
export async function buildServiceEventTypesStatus() {
  const types = [];

  try {
    const fng = await fetchCnnFearGreedIndex();
    if (fng.ok && Number(fng.score) > 0) {
      const stale = Boolean(fng.stale);
      const errMsg = stale
        ? formatServiceError(fng.staleReason || fng.error || 'fetch_failed')
        : '';
      const reading = `${fng.score} · ${fng.label || '—'}${stale ? ' (prior reading)' : ''}`;
      types.push({
        id: 'fear_greed_index',
        active: !stale,
        value: errMsg ? `${reading} — ${errMsg}` : reading,
        liveUrl: getEventTypeLiveUrl('fear_greed_index'),
      });
    } else {
      types.push({
        id: 'fear_greed_index',
        active: false,
        value: formatServiceError(fng.error || 'unavailable'),
        liveUrl: getEventTypeLiveUrl('fear_greed_index'),
      });
    }
  } catch (e) {
    types.push({
      id: 'fear_greed_index',
      active: false,
      value: formatServiceError(e?.message || e),
      liveUrl: getEventTypeLiveUrl('fear_greed_index'),
    });
  }

  try {
    if (radarDisabled()) {
      types.push({
        id: 'weather_radar',
        active: false,
        value: 'Disabled (WEATHER_RADAR=0)',
        liveUrl: getEventTypeLiveUrl('weather_radar'),
      });
    } else {
      const radar = await getWeatherRadarStatus();
      if (!radar.ok) {
        types.push({
          id: 'weather_radar',
          active: false,
          value: formatServiceError(radar.error || 'unavailable'),
          liveUrl: getEventTypeLiveUrl('weather_radar'),
        });
      } else if (radar.geocodeError) {
        types.push({
          id: 'weather_radar',
          active: false,
          value: 'Invalid dashboard weather location',
          liveUrl: getEventTypeLiveUrl('weather_radar'),
        });
      } else if (!radar.show) {
        types.push({
          id: 'weather_radar',
          active: false,
          value: 'Hidden · no precipitation expected in 24 hours',
          liveUrl: getEventTypeLiveUrl('weather_radar'),
        });
      } else {
        const msg = typeof radar.message === 'string' ? radar.message.trim() : '';
        const loc = radar.geo?.zip ? `ZIP ${radar.geo.zip}` : '';
        types.push({
          id: 'weather_radar',
          active: true,
          value: [msg, loc].filter(Boolean).join(' · ') || 'Windy radar active',
          liveUrl: radar.embed?.mapPageUrl || getEventTypeLiveUrl('weather_radar'),
        });
      }
    }
  } catch (e) {
    types.push({
      id: 'weather_radar',
      active: false,
      value: formatServiceError(e?.message || e),
      liveUrl: getEventTypeLiveUrl('weather_radar'),
    });
  }

  return { ok: true, now: new Date().toISOString(), part: 'services', types };
}
