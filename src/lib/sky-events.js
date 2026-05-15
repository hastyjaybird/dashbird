import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const calendarPath = path.join(__dirname, '../data/sky-events-calendar.json');

/**
 * Events overlapping [now, now + windowMs] (inclusive overlap).
 * Point events (no endsAt) use startsAt only: visible if that instant lies in [now, now+windowMs].
 */
export function filterActiveEvents(events, now = new Date(), windowMs = 24 * 60 * 60 * 1000) {
  const t0 = now.getTime();
  const t1 = t0 + windowMs;
  return (events || [])
    .filter((ev) => {
      if (!ev || typeof ev.startsAt !== 'string') return false;
      const s = new Date(ev.startsAt).getTime();
      if (Number.isNaN(s)) return false;
      const endRaw = ev.endsAt != null ? new Date(ev.endsAt).getTime() : s;
      const e = Number.isNaN(endRaw) ? s : endRaw;
      return s <= t1 && e >= t0;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/**
 * Supermoon strip policy:
 * 1) `listedSupermoon: true` — only lunations you have verified on a public
 *    supermoon list (NASA Science, Sky at Night, Time and Date, etc.). Ordinary
 *    full moons must not use type `supermoon` or must omit this flag.
 * 2) Calendar proximity — “today” in `timeZone` within ±1 day of `peakAt`
 *    (full moon instant) so the row does not linger outside the viewing window.
 */
export function filterSupermoonForHeroStrip(
  events,
  now = new Date(),
  timeZone = 'America/Los_Angeles',
) {
  const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone });
  const noonUtcMs = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12, 0, 0);
  };
  return (events || []).filter((ev) => {
    if (!ev || ev.type !== 'supermoon') return true;
    if (ev.listedSupermoon !== true) return false;
    const raw = ev.peakAt;
    if (raw == null || raw === '') return true;
    const peak = new Date(raw);
    if (Number.isNaN(peak.getTime())) return true;
    const days = Math.round(
      Math.abs(noonUtcMs(ymd(peak)) - noonUtcMs(ymd(now))) / 86400000,
    );
    return days <= 1;
  });
}

export async function loadSkyCalendar() {
  const raw = await readFile(calendarPath, 'utf8');
  return JSON.parse(raw);
}
