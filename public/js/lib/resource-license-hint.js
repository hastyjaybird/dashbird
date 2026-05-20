/** Thin space + ID-card emoji — harvest/fish often needs a license or permit (sky strip only). */
const LICENSE_MARK = '\u2009🪪';

/**
 * Sky strip: optional `type` values or `licenseRequired` on an event object.
 * @param {{ type?: string, licenseRequired?: boolean } | null | undefined} ev
 */
export function needsSkyHarvestLicense(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.licenseRequired === true) return true;
  const t = String(ev.type || '');
  return t === 'hunting' || t === 'fishing' || t === 'foraging';
}

/**
 * @param {string | null | undefined} detailLine
 * @param {{ type?: string, licenseRequired?: boolean } | null | undefined} ev
 */
export function detailLineWithSkyHarvestLicenseHint(detailLine, ev) {
  const base = String(detailLine ?? '').trim();
  if (!needsSkyHarvestLicense(ev)) return base;
  if (!base) return '🪪';
  return `${base}${LICENSE_MARK}`;
}
