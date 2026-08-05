#!/usr/bin/env node
/**
 * Smoke-test webpage listing parsers (Squarespace HTML + Google Calendar ICS extract).
 * Usage: node scripts/validate-webpage-listings-parse.mjs
 */
import {
  extractGoogleCalendarIcsUrls,
  parseSquarespaceEventListHtml,
  fetchOneWebpageListing,
} from '../src/lib/events-finder-webpage-listings.js';

const fixtureHtml = `
<article class="eventlist-event eventlist-event--upcoming">
  <h1 class="eventlist-title"><a href="/events/trivia-night">Trivia Night</a></h1>
  <time datetime="2026-08-10">Mon, Aug 10, 2026</time>
  <time datetime="2026-08-10">7:00 PM</time>
</article>
<iframe src="https://calendar.google.com/calendar/embed?src=Y18yMjk3YzVhMTY0ZGZhMjNlMjRjNTUzMTk0ZTc5YzkwZDY0MjRiYWU0YjM4N2I5MzU1MzBkM2IyZmE5MmVmMjBhQGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20&ctz=America%2FNew_York"></iframe>
`;

const fromHtml = parseSquarespaceEventListHtml(fixtureHtml, {
  label: 'Test',
  pageUrl: 'https://www.prescottmarket.com/events',
});
if (!fromHtml.length || fromHtml[0].title !== 'Trivia Night') {
  console.error('FAIL squarespace html', fromHtml);
  process.exit(1);
}
if (!fromHtml[0].start) {
  console.error('FAIL missing start', fromHtml[0]);
  process.exit(1);
}

const ics = extractGoogleCalendarIcsUrls(fixtureHtml);
if (!ics.length || !ics[0].includes('/calendar/ical/')) {
  console.error('FAIL ics extract', ics);
  process.exit(1);
}

console.log('fixture ok:', { title: fromHtml[0].title, start: fromHtml[0].start, ics: ics[0] });

if (process.env.WEBPAGE_LISTINGS_LIVE === '1') {
  const artisans = await fetchOneWebpageListing({
    label: 'Artisans Asylum',
    url: 'https://www.artisansasylum.com/upcoming-class-calendar',
    host: 'artisansasylum.com',
  });
  const prescott = await fetchOneWebpageListing({
    label: 'Prescott Market',
    url: 'https://www.prescottmarket.com/events',
    host: 'prescottmarket.com',
  });
  console.log('live artisans', { ok: artisans.ok, count: artisans.events.length, via: artisans.via, err: artisans.error });
  console.log('live prescott', { ok: prescott.ok, count: prescott.events.length, via: prescott.via, err: prescott.error });
  if (!artisans.ok || artisans.events.length < 1) {
    console.error('FAIL live artisans');
    process.exit(1);
  }
  if (!prescott.ok || prescott.events.length < 1) {
    console.error('FAIL live prescott');
    process.exit(1);
  }
}

console.log('validate-webpage-listings-parse: ok');
