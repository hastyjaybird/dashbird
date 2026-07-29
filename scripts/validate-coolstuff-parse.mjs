/**
 * Smoke-check Cool Happenings HTML parser.
 * Run: node scripts/validate-coolstuff-parse.mjs
 */
import assert from 'node:assert/strict';
import { parseCoolstuffHtml } from '../src/lib/events-finder-coolstuff.js';

const fixture = `
<html><body>
<p>[7/31, SF, 8pm] <a href="https://example.com/party">Neon Garden Party</a> (free)</p>
<p>listed by <a href="https://richierhombus.space/">richie rhombus</a></p>
<p><a href="https://luma.com/tiat-z1tr">Fidget Camp 2026 Showcase</a> in Oakland</p>
</body></html>
`;

const events = parseCoolstuffHtml(fixture, { timeZone: 'America/Los_Angeles' });
assert.equal(events.length, 2);
assert.equal(events[0].source, 'coolstuff');
assert.match(events[0].title, /Neon Garden Party/);
assert.equal(events[0].url, 'https://example.com/party');
assert.ok(events[0].start);
assert.equal(events[1].url, 'https://luma.com/tiat-z1tr');

console.log('validate-coolstuff-parse: ok');
