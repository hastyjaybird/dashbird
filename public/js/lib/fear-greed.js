/**
 * Live CNN Fear & Greed index (via Dashbird API).
 */
export async function fetchFearGreedIndex() {
  const r = await fetch('/api/market-watch/fear-greed', { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  return j.fearGreed || { ok: false, error: 'no_data' };
}
