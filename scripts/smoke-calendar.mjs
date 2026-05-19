#!/usr/bin/env node
/**
 * Smoke test: GOOGLE_CALENDAR_ICAL_URL is set, reachable, and returns parseable events.
 * Usage: node scripts/smoke-calendar.mjs [baseUrl]
 */
import 'dotenv/config';
import { fetchUpcomingGoogleCalendarEvents, resolveGoogleCalendarIcalUrl } from '../src/lib/google-calendar-ical.js';

function buildDefaultBase() {
  const p = process.env.PORT || process.env.HOST_PORT || '8787';
  return `http://127.0.0.1:${p}`;
}

const base = (process.argv[2] || buildDefaultBase()).replace(/\/$/, '');
const icalUrl = resolveGoogleCalendarIcalUrl();

function icalUrlLogLabel(url) {
  if (!url) return '(not set)';
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().includes('google.com') ? 'Google Calendar iCal (configured)' : `${u.hostname} (configured)`;
  } catch {
    return '(configured)';
  }
}

console.log('GOOGLE_CALENDAR_ICAL_URL →', icalUrlLogLabel(icalUrl));

let failed = false;

if (!icalUrl) {
  console.error('FAIL: Set GOOGLE_CALENDAR_ICAL_URL in .env');
  failed = true;
} else {
  const direct = await fetchUpcomingGoogleCalendarEvents();
  if (!direct.ok) {
    console.error('FAIL: iCal fetch —', direct.error);
    console.error('      ', direct.hint);
    failed = true;
  } else {
    console.log(`OK:   iCal feed (${direct.cached ? 'cached' : 'fresh'}), ${direct.events.length} upcoming event(s)`);
    if (direct.events[0]) {
      const e = direct.events[0];
      console.log('      next:', e.title);
    }
  }
}

try {
  const r = await fetch(`${base}/api/calendar/upcoming`, { cache: 'no-store' });
  const j = await r.json();
  if (!j?.ok) {
    console.error('FAIL: GET /api/calendar/upcoming —', j?.error || r.status);
    if (j?.hint) console.error('      ', j.hint);
    failed = true;
  } else {
    console.log(`OK:   API /api/calendar/upcoming — ${j.events?.length ?? 0} event(s)`);
  }
} catch (e) {
  console.error('FAIL: API unreachable at', base, '—', e?.message || e);
  failed = true;
}

process.exit(failed ? 1 : 0);
