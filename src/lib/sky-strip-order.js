/** Canonical naked-eye order when magnitudes tie. */
const PLANET_KEY_ORDER = ['mercury', 'venus', 'mars', 'jupiter', 'saturn'];

/**
 * @param {unknown} ev
 */
function planetSortKey(ev) {
  const k = typeof ev?.planetKey === 'string' ? ev.planetKey.toLowerCase().trim() : '';
  const i = PLANET_KEY_ORDER.indexOf(k);
  return i >= 0 ? i : 99;
}

/**
 * Sky strip: all planet rows first (brighter first), then everything else by start time.
 * Aircraft stay in the returned list; the UI renders them at the bottom separately.
 *
 * @param {unknown[]} events
 * @returns {unknown[]}
 */
export function sortSkyStripWithPlanetsFirst(events) {
  const list = Array.isArray(events) ? events : [];
  const planets = list.filter((e) => e && e.type === 'planet');
  const rest = list.filter((e) => e && e.type !== 'planet');

  planets.sort((a, b) => {
    const magA = Number.isFinite(a.magnitude) ? a.magnitude : 99;
    const magB = Number.isFinite(b.magnitude) ? b.magnitude : 99;
    if (magA !== magB) return magA - magB;
    return planetSortKey(a) - planetSortKey(b);
  });

  rest.sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  return [...planets, ...rest];
}
