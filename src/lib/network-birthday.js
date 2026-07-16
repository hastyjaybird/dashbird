/**
 * Flexible birthday parsing for Network CRM.
 * Accepts month-only ("March", "3"), month+day ("March 15", "3/15"),
 * or full date with year ("3/15/1990"). Year and day are optional.
 */

const MONTH_NAMES = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_LABELS = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * @param {number} year
 * @param {number} month 1–12
 * @param {number} day
 */
function daysInMonth(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Use a leap-safe year when year unknown so Feb 29 is allowed.
  const y = year || 2000;
  const dim = new Date(Date.UTC(y, month, 0)).getUTCDate();
  return day <= dim;
}

/**
 * @param {number} year
 * @returns {number}
 */
function expandYear(year) {
  if (year >= 100) return year;
  // 2-digit → 1900–1999 for birth years (00–29 → 2000–2029, 30–99 → 1930–1999)
  if (year <= 29) return 2000 + year;
  return 1900 + year;
}

/**
 * @param {number | null} month
 * @param {number | null} day
 * @param {number | null} year
 */
export function formatBirthdayDisplay(month, day = null, year = null) {
  if (!month || month < 1 || month > 12) return '';
  const label = MONTH_LABELS[month];
  if (!day) return label;
  if (!year) return `${label} ${day}`;
  return `${label} ${day}, ${year}`;
}

/**
 * @param {{ birthdayMonth?: number | null, birthdayDay?: number | null, birthdayYear?: number | null }} contact
 */
export function formatContactBirthday(contact) {
  if (!contact?.birthdayMonth) return '';
  return formatBirthdayDisplay(
    contact.birthdayMonth,
    contact.birthdayDay || null,
    contact.birthdayYear || null,
  );
}

/**
 * How complete a birthday is (higher = richer). Used for merge preference.
 * @param {{ birthdayMonth?: number | null, birthdayDay?: number | null, birthdayYear?: number | null }} contact
 */
export function birthdayCompleteness(contact) {
  if (!contact?.birthdayMonth) return 0;
  let n = 1;
  if (contact.birthdayDay) n += 1;
  if (contact.birthdayYear) n += 1;
  return n;
}

/**
 * Parse free-text birthday input.
 * @param {unknown} raw
 * @returns {{ month: number, day: number | null, year: number | null, display: string } | null}
 */
export function parseBirthdayInput(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return null;

  const lower = original.toLowerCase().replace(/\s+/g, ' ').trim();

  /** @param {number} m @param {number | null} d @param {number | null} y */
  const done = (m, d, y) => {
    if (!daysInMonth(y || 2000, m, d || 1)) return null;
    if (d == null) {
      return { month: m, day: null, year: y, display: formatBirthdayDisplay(m, null, y) };
    }
    return { month: m, day: d, year: y, display: formatBirthdayDisplay(m, d, y) };
  };

  // Month name only: "march", "oct"
  const monthOnly = lower.match(
    /^(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)$/,
  );
  if (monthOnly) {
    return done(MONTH_NAMES[monthOnly[1]], null, null);
  }

  // Month number only: "3", "03" (not 13–31 — those need a month)
  const numMonth = lower.match(/^(0?[1-9]|1[0-2])$/);
  if (numMonth) {
    return done(Number(numMonth[1]), null, null);
  }

  // Month name + day + optional year: "march 15", "mar 15, 1990", "october 3 90"
  const named = lower.match(
    /^(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:[,\s]+(\d{2}|\d{4}))?$/,
  );
  if (named) {
    const month = MONTH_NAMES[named[1]];
    const day = Number(named[2]);
    const year = named[3] ? expandYear(Number(named[3])) : null;
    return done(month, day, year);
  }

  // Numeric M/D or M/D/Y: "3/15", "03-15-1990", "3.15.90"
  const full = lower.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (full) {
    const month = Number(full[1]);
    const day = Number(full[2]);
    const year = full[3] ? expandYear(Number(full[3])) : null;
    if (month >= 1 && month <= 12) {
      return done(month, day, year);
    }
  }

  return null;
}

/**
 * @param {unknown} n
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
function cleanInt(n, min, max) {
  if (n == null || n === '') return null;
  const v = typeof n === 'number' ? n : Number(String(n).trim());
  if (!Number.isFinite(v)) return null;
  const i = Math.trunc(v);
  if (i < min || i > max) return null;
  return i;
}

/**
 * Normalize birthday fields from API/UI payload.
 * Accepts structured month/day/year and/or a free-text `birthday` string.
 * @param {object} raw
 * @returns {{ birthdayMonth: number | null, birthdayDay: number | null, birthdayYear: number | null }}
 */
export function normalizeBirthdayFields(raw) {
  const empty = { birthdayMonth: null, birthdayDay: null, birthdayYear: null };
  if (!raw || typeof raw !== 'object') return empty;

  const free = String(raw.birthday ?? '').trim();
  if (free) {
    const parsed = parseBirthdayInput(free);
    if (parsed) {
      return {
        birthdayMonth: parsed.month,
        birthdayDay: parsed.day,
        birthdayYear: parsed.year,
      };
    }
    // Unrecognized free text with no structured fallback → clear
    if (
      raw.birthdayMonth == null
      && raw.birthdayDay == null
      && raw.birthdayYear == null
    ) {
      return empty;
    }
  }

  const month = cleanInt(raw.birthdayMonth, 1, 12);
  if (!month) return empty;
  const day = cleanInt(raw.birthdayDay, 1, 31);
  const year = cleanInt(raw.birthdayYear, 1900, 2100);
  if (day != null && !daysInMonth(year || 2000, month, day)) {
    return { birthdayMonth: month, birthdayDay: null, birthdayYear: year };
  }
  return {
    birthdayMonth: month,
    birthdayDay: day,
    birthdayYear: year,
  };
}
