/**
 * Hero strip planet glyphs under `public/assets/sky/planets/`.
 * Filenames/extensions vary by asset (e.g. WebP for Mercury); map keys stay lowercase body names.
 */
export const PLANET_ICON_BY_KEY = Object.freeze({
  mercury: '/assets/sky/planets/mercury.webp',
  venus: '/assets/sky/planets/venus.png',
  mars: '/assets/sky/planets/mars.png',
  jupiter: '/assets/sky/planets/jupiter.png',
  saturn: '/assets/sky/planets/saturn.png',
});

/**
 * @param {string} planetKey lowercase id from naked-eye-planets (e.g. "venus")
 * @returns {string|null} icon URL or null if unknown
 */
export function planetIconUrl(planetKey) {
  const k = typeof planetKey === 'string' ? planetKey.toLowerCase().trim() : '';
  if (!k || !Object.prototype.hasOwnProperty.call(PLANET_ICON_BY_KEY, k)) return null;
  return PLANET_ICON_BY_KEY[k];
}
