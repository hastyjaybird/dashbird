import { utcInstantFromOpenMeteoWallClock } from './open-meteo-wall-clock.js';
import { effectiveEndMs } from './ical-recurrence.js';

/** Unfold RFC 5545 line continuations. */
function unfoldIcs(text) {
  const raw = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (out.length) out[out.length - 1] += line.slice(1);
    } else if (line.trim()) {
      out.push(line.trim());
    }
  }
  return out;
}

/**
 * Calendar display name from VCALENDAR (before first VEVENT).
 * @param {string} icsText
 */
export function parseIcsCalendarMeta(icsText) {
  const lines = unfoldIcs(icsText);
  let calName = '';
  let wrCalName = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') break;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).split(';')[0].toUpperCase();
    const val = line.slice(colon + 1).trim();
    if (key === 'CALNAME' && val) calName = val;
    if (key === 'X-WR-CALNAME' && val) wrCalName = val;
  }
  return wrCalName || calName || '';
}

/**
 * @param {string} rawKey e.g. DTSTART;TZID=America/Los_Angeles
 * @param {string} value
 * @param {string} defaultTz
 */
function parseIcsDateTime(rawKey, value, defaultTz) {
  const v = String(value).trim();
  if (!v) return null;

  const params = {};
  for (const part of String(rawKey).split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const tz = params.TZID || defaultTz;

  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const d = v.slice(0, 8);
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00`;
    const date = utcInstantFromOpenMeteoWallClock(iso, tz) || new Date(`${iso}Z`);
    return { ms: date.getTime(), allDay: true };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?/.exec(v);
  if (!m) return null;

  if (v.endsWith('Z')) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}Z`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? { ms, allDay: false } : null;
  }

  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
  const date = utcInstantFromOpenMeteoWallClock(iso, tz);
  if (!date) return null;
  return { ms: date.getTime(), allDay: false };
}

/**
 * @param {string} icsText
 * @param {string} [defaultTz]
 * @returns {Array<{ id: string, title: string, location: string, startMs: number, endMs: number | null, allDay: boolean }>}
 */
export function parseIcsEvents(icsText, defaultTz = 'America/Los_Angeles') {
  const lines = unfoldIcs(icsText);
  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (!cur) continue;
      const title = (cur.SUMMARY || '').trim() || '(No title)';
      const start = parseIcsDateTime(cur.DTSTART_KEY || 'DTSTART', cur.DTSTART || '', defaultTz);
      if (!start) {
        cur = null;
        continue;
      }
      const endRaw = parseIcsDateTime(cur.DTEND_KEY || 'DTEND', cur.DTEND || '', defaultTz);
      const id = (cur.UID || `${title}-${start.ms}`).trim();
      events.push({
        id,
        title,
        location: (cur.LOCATION || '').trim(),
        startMs: start.ms,
        endMs: endRaw?.ms ?? null,
        allDay: start.allDay,
        rrule: cur.RRULE || '',
        dtstartKey: cur.DTSTART_KEY || 'DTSTART',
        dtstartVal: cur.DTSTART || '',
        exdates: Array.isArray(cur.EXDATE) ? cur.EXDATE : [],
        status: (cur.STATUS || '').toUpperCase(),
        recurrenceId: cur.RECURRENCE_ID || '',
      });
      cur = null;
      continue;
    }
    if (!cur) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const rawKey = line.slice(0, colon);
    const val = line.slice(colon + 1);
    const key = rawKey.split(';')[0].toUpperCase();
    if (key === 'DTSTART') {
      cur.DTSTART_KEY = rawKey;
      cur.DTSTART = val;
    } else if (key === 'DTEND') {
      cur.DTEND_KEY = rawKey;
      cur.DTEND = val;
    } else if (key === 'RRULE') {
      cur.RRULE = val;
    } else if (key === 'EXDATE') {
      if (!cur.EXDATE) cur.EXDATE = [];
      for (const part of val.split(',')) {
        const ex = parseIcsDateTime(rawKey, part.trim(), defaultTz);
        if (ex) cur.EXDATE.push(new Date(ex.ms));
      }
    } else if (key === 'RECURRENCE-ID') {
      cur.RECURRENCE_ID = val;
    } else if (key === 'STATUS') {
      cur.STATUS = val;
    } else if (key === 'SUMMARY' || key === 'UID' || key === 'LOCATION') {
      cur[key] = val;
    }
  }

  return events;
}

/**
 * Events still relevant (ongoing or not yet ended), sorted by start (ongoing first).
 * @param {ReturnType<typeof parseIcsEvents>} events
 * @param {number} [nowMs]
 */
export function upcomingCalendarEvents(events, nowMs = Date.now()) {
  const upcoming = events.filter((ev) => effectiveEndMs(ev, nowMs) > nowMs);
  upcoming.sort((a, b) => {
    // Timed events before all-day (so e.g. STREET SWP beats same-day birthdays).
    if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
    const aEnd = effectiveEndMs(a, nowMs);
    const bEnd = effectiveEndMs(b, nowMs);
    const aOngoing = !a.allDay && a.startMs <= nowMs && aEnd > nowMs;
    const bOngoing = !b.allDay && b.startMs <= nowMs && bEnd > nowMs;
    if (aOngoing !== bOngoing) return aOngoing ? -1 : 1;
    return a.startMs - b.startMs;
  });
  return upcoming;
}
