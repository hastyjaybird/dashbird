/**
 * Smoke-check dorkbotSF homepage parser against a frozen HTML fixture snippet.
 * Run: node scripts/validate-dorkbotsf-parse.mjs
 */
import assert from 'node:assert/strict';
import {
  parseDorkbotsfClock,
  parseDorkbotsfDateToken,
  parseDorkbotsfHomepage,
  parseDorkbotsfTalkTitles,
} from '../src/lib/events-finder-dorkbotsf.js';

assert.deepEqual(parseDorkbotsfClock('7:00pm'), { hours: 19, minutes: 0 });
assert.deepEqual(parseDorkbotsfClock('7pm'), { hours: 19, minutes: 0 });
assert.deepEqual(parseDorkbotsfDateToken('Jun 24 2026'), {
  year: 2026,
  month: 6,
  day: 24,
});

const fixture = `
<html><body>
<table>
<tr><td>
<b>time:</b>
<br>7:00pm
<br>Jun 24 2026
<br>
<b>location:</b>
<br>Monkeybrains
<br>
933 Treat
<br>San Francisco, CA
<br>
<img src=https://dorkbotsf.org/archive/202606/collagedbsf-17.jpg width=800>
<h2>DONATIONS MUCH APPRECIATED $5-$20 sliding scale. All proceeds go to our hosts monkeybrains</h2>
</td></tr>
<tr><td><h3>Michael Shiloh - <a href=https://example.com/>Recent Experiments</a></h3></td></tr>
<tr><td><h3>Jill Miller - An Eco-Humiliation Ritual</h3></td></tr>
</table>
<a href=https://dorkbotsf.org/archive/202606/>Jun 24 2026</a>
2026 Archives:
</body></html>
`;

const talks = parseDorkbotsfTalkTitles(fixture);
assert.equal(talks.length, 2);
assert.match(talks[0], /Michael Shiloh/);

const ev = parseDorkbotsfHomepage(fixture, { timeZone: 'America/Los_Angeles' });
assert.ok(ev);
assert.equal(ev.id, 'dorkbotsf:2026-06-24');
assert.equal(ev.source, 'dorkbotsf');
assert.equal(ev.venue, 'Monkeybrains, 933 Treat');
assert.equal(ev.city, 'San Francisco');
assert.equal(ev.url, 'https://dorkbotsf.org/archive/202606/');
assert.equal(ev.imageUrl, 'https://dorkbotsf.org/archive/202606/collagedbsf-17.jpg');
assert.equal(ev.priceMin, 5);
assert.equal(ev.priceMax, 20);
assert.equal(ev.start, '2026-06-25T02:00:00.000Z'); // 7pm PDT
assert.match(ev.title, /dorkbotSF/);

console.log('validate-dorkbotsf-parse: ok');
