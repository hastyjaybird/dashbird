# Facebook Apify search queries — draft for review

Editable planning doc for **Settings → Filter criteria → Facebook scrape → searchQueries**.

When you are happy with **Jay's final list** at the bottom, copy those lines into Settings and Save. Runtime copy lives in `data/events-finder-criteria.json` under `scrape.searchQueries`.

Related: [`events-finder-criteria.md`](events-finder-criteria.md), [`events-sources-roadmap.md`](events-sources-roadmap.md).

---

## Constraints

| Knob | Live value | Notes |
| --- | --- | --- |
| `maxQueries` | 24 | Hard cap in `buildFacebookSearchQueries()` |
| `maxEventsPerQuery` | 80 | Passed to Apify as `maxEvents` |
| `cacheHours` | 168 | 7-day cache between paid runs |
| Schedule | Daily ~04:00 PT | `FACEBOOK_EVENTS_WEEKLY=1` (default) |
| Spend cap | $3 / run | `FACEBOOK_EVENTS_MAX_CHARGE_USD` (default) |
| Pinned hosts | 39 | Separate `startUrls`; not part of searchQueries |

### City suffix rule

Logic: [`src/lib/events-finder-facebook.js`](../src/lib/events-finder-facebook.js) → `buildFacebookSearchQueries()`.

- Each line in `scrape.searchQueries` is sent to Apify (up to `maxQueries`).
- If a line **already contains** `San Francisco`, `Oakland`, `Berkeley`, `Emeryville`, or `Bay Area`, **no suffix is added**.
- Otherwise the dashboard ZIP city is appended. With **94608**, that becomes **`… Emeryville`** for every bare term.
- **`FACEBOOK_EVENTS_SEARCH_QUERIES` in `.env`** overrides the criteria list entirely if set.

### Why this matters

Last Apify run (2026-07-13): **1 event** in cache. Bare terms like `potluck` became `potluck Emeryville`, missing Oakland/Alameda/SF events you care about (e.g. Makerfarm potluck, Tiny Garage Concert).

---

## Current list (live criteria)

Stored as bare terms; Apify actually receives Emeryville suffix on all 12:

```
hack-a-thon
climate
sustainability
founder
interactive
circus
potluck
philosophy
dorkbot
solstice
green drinks
nerd
```

**Effective Apify input today:**

```
hack-a-thon Emeryville
climate Emeryville
sustainability Emeryville
founder Emeryville
interactive Emeryville
circus Emeryville
potluck Emeryville
philosophy Emeryville
dorkbot Emeryville
solstice Emeryville
green drinks Emeryville
nerd Emeryville
```

---

## Recommended list (18 queries)

Explicit cities in each line so suffix logic does not force Emeryville-only discovery.

### Oakland / East Bay community

```
potluck Oakland
permaculture Oakland
maker Oakland
green drinks Oakland
circus Oakland
burner Oakland
immersive Oakland
flea market Oakland
philosophy Oakland
community Oakland
concert Oakland
```

### Alameda

```
potluck Alameda
maker Alameda
```

### San Francisco

```
hackathon San Francisco
immersive San Francisco
dorkbot San Francisco
comedy San Francisco
```

### Berkeley

```
philosophy Berkeley
potluck Berkeley
```

**Total: 18** (6 slots left under the 24 cap for your edits)

---

## Optional add-ons (pick up to 6)

| Query | Why |
| --- | --- |
| `obtainium Vallejo` | Whitelist staple; outside pinned groups |
| `queer Oakland` | Matches doc taste; good FB signal |
| `oddities San Francisco` | SFIOP / oddity scene |
| `towne cycles Oakland` | Tiny Garage Concert host — **also pin the page** |
| `street fair Oakland` | Seasonal but high signal when active |
| `noisebridge San Francisco` | Maker/tech community |
| `climate Oakland` | If you want one climate term (drop `sustainability`) |

---

## Recommended drops (from current 12)

| Remove | Reason |
| --- | --- |
| `hack-a-thon` (bare) | Use `hackathon San Francisco` or Oakland variant |
| `climate` + `sustainability` | Redundant; keep one city-specific line if desired |
| `founder` | Generic startup noise; Luma/Meetup already cover AI |
| `interactive` | Too vague for FB search |
| `solstice` | Seasonal, low year-round yield |
| `nerd` | Too broad; Nerd Nite SF is already pinned |
| All bare `* Emeryville` auto-suffix terms | Use explicit Oakland / Alameda / SF / Berkeley |

**Overlap note:** `dorkbot`, `green drinks`, `circus`, `potluck` are already covered by pinned Facebook groups. Search budget is better spent on hosts/terms **not** pinned.

---

## Rationale (tied to your taste + missed events)

| Signal | Source |
| --- | --- |
| Footprint | SF, Emeryville, Oakland, Berkeley (+ Alameda in filters) |
| Whitelist | [`exampleevents/whitelist.txt`](../exampleevents/whitelist.txt) — potluck, maker, obtainium, dorkbot, circus, philosophy, queer, flea, etc. |
| Events you keep | Community swaps/potlucks, hackathons, immersive/odd culture, comedy |
| Missed FB events | Makerfarm potluck (Alameda), Tiny Garage Concert (Oakland / towne cycles) — never ingested; not pinned |
| Skip patterns | Toastmasters, cert workshops, generic networking — **not** addressed by searchQueries (grey/blacklist separate) |

Look for (whitelist ranking) is **empty** in live criteria; restoring it affects **feed ranking**, not Apify queries. See [`events-finder-criteria.md`](events-finder-criteria.md) §1.

---

## Pins to add alongside search (not searchQueries)

Search complements pins; some events only appear from host pages.

| Pin | Why |
| --- | --- |
| `https://www.facebook.com/bayareamakerfarm` | Makerfarm potlucks (already in live pins) |
| `https://www.facebook.com/the-towne-cycles` | Tiny Garage Concert series |
| Fix `towne cycles` in [`exampleevents/fblinks.txt`](../exampleevents/fblinks.txt) | Bare slug is not a valid Apify startUrl |

Consider **removing** numeric-only group IDs with **0 avg events/month** from pinned hosts to free `startUrls` budget for named hosts.

---

## Checklist before apply

1. Edit **Jay's final list** below.
2. Settings → Filter criteria → Facebook scrape → paste one query per line into **searchQueries**.
3. Save criteria.
4. Force refresh: open Events with `?refreshFacebook=1` or wait for daily 4am run.
5. Verify: `data/facebook-events-cache.json` → `count` should be > 1; check `searchQueries` sent match your list (with city suffix only where expected).
6. Confirm new events appear in Events feed (watch date/city filters too).

---

## Jay's final list

Applied to live Settings 2026-07-14 (24/24 cap). Deduped `immersive Oakland` / `Sustainability Oakland`. Dropped to fit 24: `gala San Francisco`, `cirque San Francisco`, `parade San Francisco` (say if you want those swapped back in).

```
hackathon San Francisco
immersive San Francisco
comedy San Francisco
noisebridge San Francisco
green San Francisco
nerd San Francisco
hardware San Francisco
playa San Francisco
circus San Francisco
Ocean Room San Francisco
philosophy Oakland
community Oakland
green Oakland
circus Oakland
nerd Oakland
potluck Oakland
maker Oakland
immersive Oakland
Sustainability Oakland
burner Oakland
hardware Oakland
playa Oakland
clothing swap Oakland
clown oakland
```


---

## Out of scope (separate follow-up)

- Restoring **Look for** from docs / whitelist (ranking only)
- Expanding grey/blacklist (toastmasters, watch party, etc.)
- Code change to auto-rotate cities instead of explicit city per line
