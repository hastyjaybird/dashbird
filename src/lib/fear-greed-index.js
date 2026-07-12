/**
 * CNN Business Fear & Greed Index (undocumented JSON feed).
 * @see https://www.cnn.com/markets/fear-and-greed
 */
const CNN_FNG_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const CNN_FNG_PAGE = 'https://www.cnn.com/markets/fear-and-greed';

const SEGMENTS = [
  { id: 'extreme-fear', min: 0, max: 25, label: 'Extreme Fear', tone: 'fear', color: '#d32f2f' },
  { id: 'fear', min: 26, max: 45, label: 'Fear', tone: 'fear', color: '#f57c00' },
  { id: 'neutral', min: 46, max: 55, label: 'Neutral', tone: 'neutral', color: '#fbc02d' },
  { id: 'greed', min: 56, max: 75, label: 'Greed', tone: 'greed', color: '#9ccc65' },
  { id: 'extreme-greed', min: 76, max: 100, label: 'Extreme Greed', tone: 'greed', color: '#388e3c' },
];

import {
  isPublishableFearGreedScore,
  loadLastFearGreedReading,
  saveLastFearGreedReading,
  withStaleFearGreed,
} from './fear-greed-last-store.js';

const CACHE_TTL_MS = 90_000;
/** @type {{ at: number, value: Awaited<ReturnType<typeof fetchCnnFearGreedIndexUncached>> } | null} */
let cache = null;

/**
 * @param {string} rating
 */
function labelFromRating(rating) {
  const r = String(rating || '').toLowerCase().trim();
  const hit = SEGMENTS.find((s) => s.id === r.replace(/\s+/g, '-'));
  if (hit) return hit.label;
  if (r.includes('extreme') && r.includes('fear')) return 'Extreme Fear';
  if (r.includes('extreme') && r.includes('greed')) return 'Extreme Greed';
  if (r.includes('fear')) return 'Fear';
  if (r.includes('greed')) return 'Greed';
  return 'Neutral';
}

/**
 * @param {number} score
 */
export function fearGreedSegmentIndex(score) {
  const s = Math.max(0, Math.min(100, Math.round(Number(score))));
  const idx = SEGMENTS.findIndex((seg) => s >= seg.min && s <= seg.max);
  return idx >= 0 ? idx : 2;
}

/**
 * @param {number} score
 */
export function fearGreedTone(score) {
  return SEGMENTS[fearGreedSegmentIndex(score)]?.tone || 'neutral';
}

function fearGreedSegmentsPayload() {
  return SEGMENTS.map(({ id, min, max, label, tone, color }) => ({
    id,
    min,
    max,
    label,
    tone,
    color,
  }));
}

/**
 * @returns {Promise<{ ok: true, score: number, rating: string, label: string, tone: string, previousClose?: number, sourceUrl: string } | { ok: false, error: string }>}
 */
async function fetchCnnFearGreedIndexUncached() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 14_000);
  try {
    const res = await fetch(CNN_FNG_URL, {
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: CNN_FNG_PAGE,
      },
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const doc = await res.json();
    const block = doc?.fear_and_greed;
    const score = Number(block?.score);
    if (!isPublishableFearGreedScore(score)) {
      return { ok: false, error: !Number.isFinite(score) ? 'no_score' : 'score_zero' };
    }

    const rating = typeof block?.rating === 'string' ? block.rating : '';
    const rounded = Math.round(score);

    /** @param {unknown} v */
    const histScore = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : undefined;
    };

    return {
      ok: true,
      score: rounded,
      scoreRaw: score,
      rating,
      label: labelFromRating(rating),
      tone: fearGreedTone(rounded),
      segmentIndex: fearGreedSegmentIndex(rounded),
      segments: fearGreedSegmentsPayload(),
      previousClose: histScore(block?.previous_close),
      previous1Week: histScore(block?.previous_1_week),
      previous1Month: histScore(block?.previous_1_month),
      previous1Year: histScore(block?.previous_1_year),
      updatedAt:
        typeof block?.timestamp === 'string' && block.timestamp.trim() !== ''
          ? block.timestamp.trim()
          : undefined,
      sourceUrl: CNN_FNG_PAGE,
      source: 'CNN Business F & G Index',
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    const msg =
      e && typeof e === 'object' && 'name' in e && e.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ ok: true, score: number, rating: string, label: string, tone: string, previousClose?: number, sourceUrl: string } | { ok: false, error: string }>}
 */
async function fearGreedStaleFallback(reason) {
  const last = await loadLastFearGreedReading();
  if (!last) return { ok: false, error: reason };
  return withStaleFearGreed(last, reason);
}

export async function fetchCnnFearGreedIndex() {
  if (String(process.env.MARKET_WATCH_FEAR_GREED || '').trim() === '0') {
    return { ok: false, error: 'disabled' };
  }

  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const value = await fetchCnnFearGreedIndexUncached();
  if (value.ok && isPublishableFearGreedScore(value.score)) {
    await saveLastFearGreedReading(value);
    cache = { at: now, value };
    return value;
  }

  const reason = value.ok ? 'invalid_score' : value.error || 'fetch_failed';
  const stale = await fearGreedStaleFallback(reason);
  cache = { at: now, value: stale };
  return stale;
}

export { SEGMENTS as FEAR_GREED_SEGMENTS };
