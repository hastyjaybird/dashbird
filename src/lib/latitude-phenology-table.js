/**
 * Interpolate MM-DD phenology fields across latitude rows (via day-of-year).
 */

/**
 * @param {string} mmdd
 * @param {number} year
 */
export function mmddToYmd(mmdd, year) {
  const [mo, da] = String(mmdd)
    .split('-')
    .map((x) => Number.parseInt(String(x).trim(), 10));
  if (!Number.isFinite(mo) || !Number.isFinite(da) || !Number.isFinite(year)) return '';
  const u = new Date(Date.UTC(year, mo - 1, da));
  if (u.getUTCMonth() !== mo - 1 || u.getUTCDate() !== da) return '';
  return `${year}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

/**
 * @param {string} mmdd
 * @param {number} [year]
 */
function mmddToDoy(mmdd, year = 2024) {
  const ymd = mmddToYmd(mmdd, year);
  if (!ymd) return NaN;
  const u = new Date(`${ymd}T12:00:00Z`);
  const jan1 = Date.UTC(year, 0, 1);
  return Math.round((u.getTime() - jan1) / 86_400_000) + 1;
}

/**
 * @param {number} doy
 * @param {number} [year]
 */
function doyToMmdd(doy, year = 2024) {
  const d = Math.max(1, Math.min(366, Math.round(doy)));
  const u = new Date(Date.UTC(year, 0, d));
  const mo = u.getUTCMonth() + 1;
  const da = u.getUTCDate();
  return `${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

/**
 * @param {Array<{ latitude: number }>} rows
 * @param {number} lat
 * @param {string[]} fields
 */
export function interpolateMmddFields(rows, lat, fields) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.latitude - b.latitude);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  let latUse = lat;
  if (latUse <= lo.latitude) latUse = lo.latitude;
  if (latUse >= hi.latitude) latUse = hi.latitude;

  let i = 0;
  while (i < sorted.length - 1 && sorted[i + 1].latitude < latUse) i += 1;
  const a = sorted[i];
  const b = sorted[Math.min(i + 1, sorted.length - 1)];

  /** @type {Record<string, string>} */
  const out = {};
  if (Math.abs(a.latitude - b.latitude) < 1e-6) {
    for (const f of fields) out[f] = String(a[f] || '');
    return out;
  }

  const t = (latUse - a.latitude) / (b.latitude - a.latitude);
  for (const f of fields) {
    const av = String(a[f] || '');
    const bv = String(b[f] || '');
    if (!av || !bv) {
      out[f] = av || bv;
      continue;
    }
    const ad = mmddToDoy(av);
    const bd = mmddToDoy(bv);
    if (!Number.isFinite(ad) || !Number.isFinite(bd)) {
      out[f] = av;
      continue;
    }
    let mix = ad + (bd - ad) * t;
    if (bd < ad) {
      if (t > 0.5) mix = bd;
      else mix = ad;
    }
    out[f] = doyToMmdd(mix);
  }
  return out;
}
