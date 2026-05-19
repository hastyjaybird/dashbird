import rrulePkg from 'rrule';

const { rrulestr } = rrulePkg;

const DEFAULT_TIMED_MS = 60 * 60 * 1000;
const DEFAULT_ALLDAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN = 400;

/**
 * @param {{ startMs: number, endMs: number | null, allDay?: boolean }} ev
 */
export function effectiveEndMs(ev, nowMs = Date.now()) {
  if (ev.endMs != null && ev.endMs > ev.startMs) return ev.endMs;
  const span = ev.allDay ? DEFAULT_ALLDAY_MS : DEFAULT_TIMED_MS;
  return ev.startMs + span;
}

/**
 * @param {import('rrule').RRule} rule
 * @param {number} startMs series DTSTART
 * @param {number | null} endMs series DTEND
 * @param {number} nowMs
 */
export function nextOccurrenceFromRule(rule, startMs, endMs, nowMs) {
  const duration =
    endMs != null && endMs > startMs ? endMs - startMs : endMs == null ? DEFAULT_TIMED_MS : DEFAULT_TIMED_MS;
  let cursor = new Date(nowMs - duration);
  for (let i = 0; i < MAX_SCAN; i++) {
    const occ = rule.after(cursor, false);
    if (!occ) return null;
    const occStart = occ.getTime();
    const occEnd = occStart + duration;
    if (occEnd > nowMs) return { startMs: occStart, endMs: occEnd };
    cursor = occ;
  }
  return null;
}

/**
 * @param {string} rruleLine value after RRULE:
 * @param {string} dtstartKey e.g. DTSTART;TZID=America/Los_Angeles
 * @param {string} dtstartVal e.g. 20260123T123000
 * @param {Date[]} [exdates]
 */
export function buildRRule(rruleLine, dtstartKey, dtstartVal, exdates = []) {
  const key = String(dtstartKey || 'DTSTART').trim();
  const val = String(dtstartVal || '').trim();
  const body = val ? `${key}:${val}\nRRULE:${rruleLine.trim()}` : `RRULE:${rruleLine.trim()}`;
  const rule = rrulestr(body, { forceset: false });
  if (!exdates.length) return rule;
  const ex = exdates.map((d) => d.getTime());
  const origAfter = rule.after.bind(rule);
  rule.after = (date, inc) => {
    let cur = origAfter(date, inc);
    let guard = 0;
    while (cur && ex.includes(cur.getTime()) && guard++ < MAX_SCAN) {
      cur = origAfter(cur, false);
    }
    return cur;
  };
  return rule;
}

/**
 * Expand VEVENT masters with RRULE to their next occurrence from `nowMs`.
 * @param {Array<{ id: string, title: string, location: string, startMs: number, endMs: number | null, allDay: boolean, rrule?: string, exdates?: Date[], status?: string, recurrenceId?: string }>} events
 * @param {number} [nowMs]
 */
export function expandRecurringIcsEvents(events, nowMs = Date.now()) {
  const singles = [];
  const masters = [];

  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    if (ev.recurrenceId) {
      singles.push(ev);
      continue;
    }
    if (ev.rrule) masters.push(ev);
    else singles.push(ev);
  }

  const expanded = [];
  for (const m of masters) {
    try {
      const rule = buildRRule(m.rrule, m.dtstartKey, m.dtstartVal, m.exdates || []);
      const next = nextOccurrenceFromRule(rule, m.startMs, m.endMs, nowMs);
      if (!next) continue;
      expanded.push({
        id: `${m.id}@${next.startMs}`,
        title: m.title,
        location: m.location,
        startMs: next.startMs,
        endMs: next.endMs,
        allDay: m.allDay,
        seriesId: m.id,
      });
    } catch (err) {
      console.warn('[ical] RRULE expand failed:', m.title, err?.message || err);
    }
  }

  return [...singles, ...expanded];
}
