/**
 * Legacy helper: Open-Meteo `daily` sunrise/sunset sometimes returned wall-clock ISO
 * strings without offsets. Sunset for the hero now uses NWS `api.weather.gov` instead;
 * this module is kept for reference or reuse.
 *
 * Open-Meteo `daily` sunrise/sunset values are wall-clock in the requested
 * `timezone` but omit an offset (e.g. `2026-05-14T20:11`). Using
 * `new Date(iso)` interprets that string in the *runtime default* zone in some
 * engines, so the instant (and any later `toLocaleString` in `America/Los_Angeles`)
 * can be wrong off the Pacific coast. This resolves the string to a real UTC `Date`.
 *
 * @param {string} isoLocal from Open-Meteo daily sunrise/sunset
 * @param {string} timeZone IANA zone (e.g. `America/Los_Angeles`)
 * @returns {Date|null}
 */
export function utcInstantFromOpenMeteoWallClock(isoLocal, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(isoLocal).trim());
  if (!m) return null;
  const target = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    se: m[6] != null ? Number(m[6]) : 0,
  };

  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
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

  function matches(p) {
    return (
      p.y === target.y &&
      p.mo === target.mo &&
      p.d === target.d &&
      p.h === target.h &&
      p.mi === target.mi &&
      Math.abs(p.se - target.se) <= 1
    );
  }

  const anchor = Date.UTC(target.y, target.mo - 1, target.d, 12, 0, 0);
  for (let delta = -36 * 60 * 60 * 1000; delta <= 36 * 60 * 60 * 1000; delta += 60 * 1000) {
    const t = anchor + delta;
    if (matches(partsAt(t))) return new Date(t);
  }
  return null;
}
