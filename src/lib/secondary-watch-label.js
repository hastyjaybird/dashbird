/**
 * @param {string} label
 * @param {string | null | undefined} zip
 */
export function labelWithSecondaryZip(label, zip) {
  const base = String(label || '').trim() || 'Event';
  const z = String(zip ?? '')
    .trim()
    .replace(/\D/g, '');
  if (z.length < 5) return base;
  return `${base} @ ${z}`;
}

/**
 * @param {string | null | undefined} zip
 */
export function secondaryZipSuffix(zip) {
  const z = String(zip ?? '')
    .trim()
    .replace(/\D/g, '');
  return z.length >= 5 ? ` @ ${z}` : '';
}
