/**
 * Expand recurring / relative date language from invite mail into concrete local days.
 * - "every 3rd Thursday" → rolling N months of YYYY-MM-DD
 * - "this Thursday" / "this coming Saturday" / "next Friday" → one day
 * Callers convert YMD (+ optional clock) to ISO via ymdAtLocalTimeIso / noon helpers.
 */

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const WEEKDAY_RE =
  '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)';

/**
 * @param {string} token
 * @returns {number | null} 0=Sun … 6=Sat
 */
export function weekdayIndexFromName(token) {
  const t = String(token || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .trim();
  if (!t) return null;
  const full = WEEKDAYS.find((d) => d.startsWith(t.slice(0, 3)));
  return full ? WEEKDAYS.indexOf(full) : null;
}

/**
 * @param {string} ordinal
 * @returns {number | null}
 */
function ordinalToN(ordinal) {
  const o = String(ordinal || '').toLowerCase().trim();
  if (o === 'first' || o === '1st') return 1;
  if (o === 'second' || o === '2nd') return 2;
  if (o === 'third' || o === '3rd') return 3;
  if (o === 'fourth' || o === '4th') return 4;
  if (o === 'fifth' || o === '5th') return 5;
  const n = Number(o.replace(/(?:st|nd|rd|th)$/i, ''));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

/**
 * @param {Date | number} when
 * @param {string} timeZone
 */
function localYmdParts(when, timeZone = 'America/Los_Angeles') {
  const ms = typeof when === 'number' ? when : when.getTime();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  const wd = String(parts.find((p) => p.type === 'weekday')?.value || '').toLowerCase();
  const weekday = WEEKDAYS.findIndex((d) => d.startsWith(wd.slice(0, 3)));
  return {
    year,
    month,
    day,
    weekday,
    ymd: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} weekday 0-6
 * @param {number} nth 1-5
 * @returns {string | null} YYYY-MM-DD
 */
export function nthWeekdayOfMonth(year, month, weekday, nth) {
  if (nth < 1 || nth > 5) return null;
  const first = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  const firstWd = first.getUTCDay();
  const day = 1 + ((weekday - firstWd + 7) % 7) + (nth - 1) * 7;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > dim) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @param {number} weekday
 * @param {number} [nowMs]
 * @param {string} [timeZone]
 * @param {number} [minDaysAhead]
 */
export function nextWeekdayYmd(
  weekday,
  nowMs = Date.now(),
  timeZone = 'America/Los_Angeles',
  minDaysAhead = 0,
) {
  const start = localYmdParts(nowMs + minDaysAhead * 86400000, timeZone);
  for (let i = 0; i < 8; i += 1) {
    const probe = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12, 0, 0));
    const p = localYmdParts(probe, timeZone);
    if (p.weekday === weekday) return p.ymd;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{ hours: number, minutes: number } | null}
 */
export function extractClockFromText(text) {
  const m = String(text || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2] || 0);
  const ap = m[3].toLowerCase();
  if (!Number.isFinite(hours) || hours < 1 || hours > 12) return null;
  if (ap === 'pm' && hours < 12) hours += 12;
  if (ap === 'am' && hours === 12) hours = 0;
  return { hours, minutes };
}

/**
 * @typedef {{
 *   kind: 'nth_weekday' | 'every_weekday' | 'every_other_weekday' | 'relative_weekday',
 *   weekday: number,
 *   nth?: number,
 *   label: string,
 *   days: Array<{ ymd: string, hours: number | null, minutes: number | null }>,
 * }} RecurringExpansion
 */

/**
 * @param {string} text
 * @param {{ now?: number, monthsAhead?: number, timeZone?: string }} [opts]
 * @returns {RecurringExpansion[]}
 */
export function expandRecurringAndRelativeDates(text, opts = {}) {
  const blob = String(text || '');
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const monthsAhead = Math.min(Math.max(Number(opts.monthsAhead) || 3, 1), 12);
  const timeZone = String(opts.timeZone || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  const clock = extractClockFromText(blob);
  const hours = clock?.hours ?? null;
  const minutes = clock?.minutes ?? null;
  /** @type {RecurringExpansion[]} */
  const out = [];
  const today = localYmdParts(now, timeZone);

  const nthRe = new RegExp(
    `\\bevery\\s+(?:the\\s+)?(\\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth)\\s+(${WEEKDAY_RE})s?\\b`,
    'gi',
  );
  let m;
  while ((m = nthRe.exec(blob))) {
    const nth = ordinalToN(m[1]);
    const weekday = weekdayIndexFromName(m[2]);
    if (nth == null || weekday == null) continue;
    /** @type {Array<{ ymd: string, hours: number | null, minutes: number | null }>} */
    const days = [];
    for (let i = 0; i < monthsAhead; i += 1) {
      const month = ((today.month - 1 + i) % 12) + 1;
      const year = today.year + Math.floor((today.month - 1 + i) / 12);
      const ymd = nthWeekdayOfMonth(year, month, weekday, nth);
      if (!ymd || ymd < today.ymd) continue;
      days.push({ ymd, hours, minutes });
    }
    out.push({ kind: 'nth_weekday', weekday, nth, label: m[0], days });
  }

  const everyWd = new RegExp(`\\bevery\\s+(?:other\\s+)?(${WEEKDAY_RE})s?\\b`, 'gi');
  while ((m = everyWd.exec(blob))) {
    const lookback = blob.slice(Math.max(0, m.index - 24), m.index);
    if (/(?:the\s+)?(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth)\s*$/i.test(lookback)) {
      continue;
    }
    const weekday = weekdayIndexFromName(m[1]);
    if (weekday == null) continue;
    const other = /every\s+other/i.test(m[0]);
    /** @type {Array<{ ymd: string, hours: number | null, minutes: number | null }>} */
    const days = [];
    let cursor = now;
    let take = true;
    const horizonYmd = (() => {
      const endMonth = today.month - 1 + monthsAhead;
      const y = today.year + Math.floor(endMonth / 12);
      const mo = (endMonth % 12) + 1;
      return `${y}-${String(mo).padStart(2, '0')}-28`;
    })();
    for (let i = 0; i < 40; i += 1) {
      const ymd = nextWeekdayYmd(weekday, cursor, timeZone, i === 0 ? 0 : 1);
      if (!ymd || ymd > horizonYmd) break;
      if (ymd >= today.ymd && (!other || take)) days.push({ ymd, hours, minutes });
      if (other) take = !take;
      const [yy, mm, dd] = ymd.split('-').map(Number);
      cursor = Date.UTC(yy, mm - 1, dd + 1, 12, 0, 0);
    }
    out.push({
      kind: other ? 'every_other_weekday' : 'every_weekday',
      weekday,
      label: m[0],
      days,
    });
  }

  const relativeRe = new RegExp(
    `\\b(?:this\\s+coming|this|next)\\s+(${WEEKDAY_RE})\\b`,
    'gi',
  );
  while ((m = relativeRe.exec(blob))) {
    const weekday = weekdayIndexFromName(m[1]);
    if (weekday == null) continue;
    let minAhead = /^next\b/i.test(m[0]) ? 1 : 0;
    if (/^next\b/i.test(m[0]) && today.weekday === weekday) minAhead = 1;
    let ymd = nextWeekdayYmd(weekday, now, timeZone, minAhead);
    if (/^next\b/i.test(m[0]) && ymd === today.ymd) {
      ymd = nextWeekdayYmd(weekday, now + 86400000, timeZone, 0);
    }
    if (!ymd) continue;
    out.push({
      kind: 'relative_weekday',
      weekday,
      label: m[0],
      days: [{ ymd, hours, minutes }],
    });
  }

  return out;
}
