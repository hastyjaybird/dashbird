import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', '..', 'public', 'data', 'yosemite-moonbow-windows.json');

const LEAD_DAYS = 14;

/**
 * @param {string} ymd
 * @param {number} deltaDays
 */
export function addCalendarDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ymd;
  const u = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = u.getUTCFullYear();
  const mo = String(u.getUTCMonth() + 1).padStart(2, '0');
  const da = String(u.getUTCDate()).padStart(2, '0');
  return `${yy}-${mo}-${da}`;
}

/**
 * @param {Date} now
 * @param {string} timeZone
 * @returns {string} YYYY-MM-DD
 */
export function wallYmdInTimeZone(now, timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * `YYYY-MM-DD` → `M/D` (no leading zeros), e.g. `2026-05-28` → `5/28`.
 * @param {string} ymd
 * @returns {string}
 */
export function formatYmdToMdSlash(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd || '').trim();
  const month = Number.parseInt(m[2], 10);
  const day = Number.parseInt(m[3], 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return String(ymd || '').trim();
  return `${month}/${day}`;
}

/**
 * @param {string} startYmd
 * @param {string} endYmd
 * @returns {string} e.g. `5/28 – 6/3`
 */
export function formatMoonbowWindowMdRange(startYmd, endYmd) {
  return `${formatYmdToMdSlash(startYmd)} \u2013 ${formatYmdToMdSlash(endYmd)}`;
}

/**
 * During an active window: full `start – end` before window start day; `until end` once start has passed.
 * @param {string} wallYmd
 * @param {string} startYmd
 * @param {string} endYmd
 */
export function formatMoonbowWindowMdRangeForWall(wallYmd, startYmd, endYmd) {
  if (wallYmd >= startYmd) {
    return `until ${formatYmdToMdSlash(endYmd)}`;
  }
  return formatMoonbowWindowMdRange(startYmd, endYmd);
}

/**
 * @returns {Promise<{ referenceUrl: string, windows: Array<{ start: string, end: string, label?: string }> } | null>}
 */
export async function loadYosemiteMoonbowConfig() {
  try {
    const raw = await readFile(DATA_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !Array.isArray(j.windows)) return null;
    return {
      referenceUrl: typeof j.referenceUrl === 'string' ? j.referenceUrl.trim() : 'https://www.yosemitemoonbow.com/',
      windows: j.windows.filter((w) => w && typeof w.start === 'string' && typeof w.end === 'string'),
    };
  } catch {
    return null;
  }
}

/**
 * First matching window for "show" rule, or null.
 * Active when wall date is within `LEAD_DAYS` before window start through window end (inclusive).
 *
 * @param {object} p
 * @param {string} p.wallYmd
 * @param {Array<{ start: string, end: string, label?: string }>} p.windows
 */
export function pickActiveMoonbowWindow(p) {
  const { wallYmd, windows } = p;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const leadStart = addCalendarDaysYmd(w.start, -LEAD_DAYS);
    if (wallYmd >= leadStart && wallYmd <= w.end) {
      return w;
    }
  }
  return null;
}

/**
 * Settings / status text when strip row is off or on.
 * @param {string} wallYmd
 * @param {Array<{ start: string, end: string, label?: string }>} windows
 */
export function describeMoonbowForStatus(wallYmd, windows) {
  const active = pickActiveMoonbowWindow({ wallYmd, windows });
  if (active) {
    const range = formatMoonbowWindowMdRange(active.start, active.end);
    const label = typeof active.label === 'string' && active.label.trim() ? ` · ${active.label.trim()}` : '';
    return {
      active: true,
      value: `${range}${label} (14-day lead before window start)`,
    };
  }

  const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
  for (const w of sorted) {
    const leadStart = addCalendarDaysYmd(w.start, -LEAD_DAYS);
    if (wallYmd < leadStart) {
      return {
        active: false,
        value: `Next window ${formatMoonbowWindowMdRange(w.start, w.end)} · strip opens ${formatYmdToMdSlash(leadStart)}`,
      };
    }
    if (wallYmd > w.end) continue;
    return {
      active: false,
      value: `Between windows · current date ${formatYmdToMdSlash(wallYmd)}`,
    };
  }

  const last = sorted[sorted.length - 1];
  if (last) {
    return {
      active: false,
      value: `Season ended · last window ${formatMoonbowWindowMdRange(last.start, last.end)}`,
    };
  }
  return { active: false, value: 'No windows in yosemite-moonbow-windows.json' };
}

export { LEAD_DAYS as YOSEMITE_MOONBOW_LEAD_DAYS };
