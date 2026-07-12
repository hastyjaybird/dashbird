/**
 * Resolve an Open-Meteo / iCal wall-clock ISO (no offset) in an IANA zone to a UTC Date.
 *
 * Open-Meteo `daily` sunrise/sunset and many TZID ICS values are wall-clock in the
 * requested timezone but omit an offset (e.g. `2026-05-14T20:11`). Using
 * `new Date(iso)` interprets that string in the *runtime default* zone in some
 * engines, so the instant can be wrong. This resolves the string to a real UTC `Date`.
 *
 * @param {string} isoLocal from Open-Meteo daily sunrise/sunset or ICS local time
 * @param {string} timeZone IANA zone (e.g. `America/Los_Angeles`)
 * @returns {Date|null}
 */
export function utcInstantFromOpenMeteoWallClock(isoLocal, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(isoLocal).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const se = m[6] != null ? Number(m[6]) : 0;
  if (![y, mo, d, h, mi, se].every((n) => Number.isFinite(n))) return null;

  const tz = String(timeZone || '').trim() || 'UTC';
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  /** @param {number} utcMs */
  function partsAt(utcMs) {
    const o = {};
    for (const { type, value } of f.formatToParts(new Date(utcMs))) {
      if (type !== 'literal') o[type] = value;
    }
    return {
      y: Number(o.year),
      mo: Number(o.month),
      d: Number(o.day),
      h: Number(o.hour),
      mi: Number(o.minute),
      se: Number(o.second),
    };
  }

  /** Local wall-clock as if it were UTC (for offset arithmetic). */
  function asUtcMs(p) {
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.se);
  }

  const target = { y, mo, d, h, mi, se };
  const desiredAsUtc = asUtcMs(target);

  // Guess: treat wall clock as UTC, then correct by the zone's offset at that instant.
  // One refinement covers DST edges for almost all civil times.
  let guess = desiredAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const shown = partsAt(guess);
    const shownAsUtc = asUtcMs(shown);
    const next = guess + (desiredAsUtc - shownAsUtc);
    if (next === guess) break;
    guess = next;
  }

  const finalParts = partsAt(guess);
  const closeEnough =
    finalParts.y === target.y &&
    finalParts.mo === target.mo &&
    finalParts.d === target.d &&
    finalParts.h === target.h &&
    finalParts.mi === target.mi &&
    Math.abs(finalParts.se - target.se) <= 1;
  if (!closeEnough) return null;
  return new Date(guess);
}
