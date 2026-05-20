/**
 * When true, Earth-related APIs include out-of-season / below-threshold rows for local testing.
 * Set EARTH_DEBUG_SHOW_INACTIVE=1 in .env (never enable on a shared production host unless intended).
 */
export function isEarthDebugShowInactive(env = process.env) {
  const v = String(env.EARTH_DEBUG_SHOW_INACTIVE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
