/**
 * Flexible "last contact" date parsing for Network CRM.
 * Accepts phrases like "last month", "Q326", "october", "4/5/27", "this morning"
 * and normalizes to an ISO timestamp + day|month precision for display.
 */

const DEFAULT_TZ = 'America/Los_Angeles';

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

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number }}
 */
export function wallPartsInZone(date, timeZone = DEFAULT_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  /** @type {Record<string, string>} */
  const bag = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') bag[p.type] = p.value;
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
  };
}

/**
 * @param {number} year
 * @param {number} month 1–12
 * @param {number} day
 * @returns {string} ISO timestamp (UTC noon on that calendar day)
 */
function isoFromYmd(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString();
}

/**
 * @param {number} year
 * @returns {number}
 */
function expandYear(year) {
  if (year >= 100) return year;
  // 2-digit → 2000–2099 (personal CRM horizon)
  return 2000 + year;
}

/**
 * @param {string} iso
 * @param {'day' | 'month'} precision
 * @param {string} [timeZone]
 */
export function formatLastContactDisplay(iso, precision = 'day', timeZone = DEFAULT_TZ) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const { year, month, day } = wallPartsInZone(d, timeZone);
  // Stored as UTC noon; wallPartsInZone for America/Los_Angeles still lands on same calendar day.
  const yy = String(year).slice(-2);
  if (precision === 'month') return `${month}/${yy}`;
  return `${month}/${day}/${yy}`;
}

/**
 * @param {{ lastContactAt?: string | null, lastContactPrecision?: string | null }} contact
 * @param {string} [timeZone]
 */
export function formatContactLastContact(contact, timeZone = DEFAULT_TZ) {
  if (!contact?.lastContactAt) return '';
  const precision = contact.lastContactPrecision === 'month' ? 'month' : 'day';
  return formatLastContactDisplay(contact.lastContactAt, precision, timeZone);
}

/**
 * @param {number} year
 * @param {number} month
 * @returns {{ year: number, month: number }}
 */
function addMonths(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/**
 * Parse free-text last-contact input.
 * @param {unknown} raw
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {{ iso: string, precision: 'day' | 'month', display: string } | null}
 */
export function parseLastContactInput(raw, now = new Date(), timeZone = DEFAULT_TZ) {
  const original = String(raw ?? '').trim();
  if (!original) return null;

  const today = wallPartsInZone(now, timeZone);
  const lower = original.toLowerCase().replace(/\s+/g, ' ').trim();

  /** @param {number} y @param {number} m @param {number} d @param {'day'|'month'} precision */
  const done = (y, m, d, precision) => {
    const iso = isoFromYmd(y, m, d);
    return { iso, precision, display: formatLastContactDisplay(iso, precision, timeZone) };
  };

  // Relative phrases
  if (/^last year$/.test(lower)) {
    return done(today.year - 1, today.month, 1, 'month');
  }
  if (/^last month$/.test(lower)) {
    const prev = addMonths(today.year, today.month, -1);
    return done(prev.year, prev.month, 1, 'month');
  }
  if (/^(this morning|this afternoon|this evening|tonight|today)$/.test(lower)) {
    return done(today.year, today.month, today.day, 'day');
  }
  if (/^yesterday$/.test(lower)) {
    const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const p = wallPartsInZone(yest, timeZone);
    return done(p.year, p.month, p.day, 'day');
  }

  // Quarters: Q326, Q3-26, Q3/26, Q3 26, Q3 2026
  const q = lower.match(/^q\s*([1-4])\s*[-/ ]?\s*(\d{2}|\d{4})$/i);
  if (q) {
    const quarter = Number(q[1]);
    const year = expandYear(Number(q[2]));
    const month = (quarter - 1) * 3 + 1; // Q1→1, Q2→4, Q3→7, Q4→10
    return done(year, month, 1, 'month');
  }

  // Month name, optional year: "october", "oct 2025", "October '26"
  const monthOnly = lower.match(
    /^(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:\s+'?(\d{2}|\d{4}))?$/,
  );
  if (monthOnly) {
    const month = MONTH_NAMES[monthOnly[1]];
    let year = monthOnly[2] ? expandYear(Number(monthOnly[2])) : today.year;
    if (!monthOnly[2]) {
      // Most recent occurrence of that month (not in the future).
      if (month > today.month) year = today.year - 1;
    }
    return done(year, month, 1, 'month');
  }

  // Numeric dates
  // M/D/YYYY or M/D/YY → day known
  const full = lower.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (full) {
    const month = Number(full[1]);
    const day = Number(full[2]);
    const year = expandYear(Number(full[3]));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return done(year, month, day, 'day');
    }
  }

  // M/YY or M/YYYY → month only (day unknown)
  const my = lower.match(/^(\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (my) {
    const month = Number(my[1]);
    const year = expandYear(Number(my[2]));
    if (month >= 1 && month <= 12) {
      return done(year, month, 1, 'month');
    }
  }

  // Already ISO / Date.parse-able (e.g. telegram auto-stamps)
  const parsed = Date.parse(original);
  if (!Number.isNaN(parsed)) {
    const iso = new Date(parsed).toISOString();
    // If prior save was month-precision display re-entered as ISO mid-month day 1,
    // treat explicit ISO/datetime as day unless it came from our month formatter path above.
    return { iso, precision: 'day', display: formatLastContactDisplay(iso, 'day', timeZone) };
  }

  return null;
}

/**
 * Normalize a raw lastContactAt value from API/UI into iso + precision.
 * Passes through already-normalized ISO when paired with precision.
 * @param {unknown} rawAt
 * @param {unknown} [rawPrecision]
 * @param {Date} [now]
 * @param {string} [timeZone]
 */
export function normalizeLastContactFields(rawAt, rawPrecision, now = new Date(), timeZone = DEFAULT_TZ) {
  const at = String(rawAt ?? '').trim();
  if (!at) {
    return { lastContactAt: null, lastContactPrecision: null };
  }

  // Already-normalized ISO + precision (DB reload / client echo) — don't re-infer day.
  const looksIso = /^\d{4}-\d{2}-\d{2}T/.test(at);
  if (looksIso && (rawPrecision === 'day' || rawPrecision === 'month')) {
    const ms = Date.parse(at);
    if (!Number.isNaN(ms)) {
      return { lastContactAt: new Date(ms).toISOString(), lastContactPrecision: rawPrecision };
    }
  }

  const parsed = parseLastContactInput(at, now, timeZone);
  if (parsed) {
    return { lastContactAt: parsed.iso, lastContactPrecision: parsed.precision };
  }

  // Fallback: keep string if it looks like ISO, else drop
  const ms = Date.parse(at);
  if (!Number.isNaN(ms)) {
    const precision = rawPrecision === 'month' ? 'month' : 'day';
    return { lastContactAt: new Date(ms).toISOString(), lastContactPrecision: precision };
  }

  return { lastContactAt: null, lastContactPrecision: null };
}
