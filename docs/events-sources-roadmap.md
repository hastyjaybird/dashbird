# Events sources — ingest roadmap

Per-source plan for turning Settings **Events sources** (bookmarks § Events) into a real feed. Status/ingestion-test columns already probe reachability and strategy; this doc is the build path after that.

Sample fixtures: [`docs/events-sample-urls.md`](events-sample-urls.md).

Shared pipeline (all sources eventually feed the same shape):

1. **Discover** candidate event URLs or API hits near the dashboard **city** (from `WEATHER_ZIP` / lat-lon) / criteria.
2. **Normalize** → `{ id, title, start, end?, venue?, city?, lat?, lon?, url, source, raw }`.
3. **Upsert** into the local SQLite catalog (`data/events-finder.db` via `src/lib/events-finder-store.js`). Criteria stay in `data/events-finder-criteria.json`.
4. **Geo filter** — **city-first**. When the dashboard ZIP is in the Bay, home cities are **San Francisco, Oakland, Emeryville, Berkeley**. Soft-rank by distance when lat/lon exist; don’t drop city-only listings solely for missing coordinates.
5. **Feed filters** (saved in criteria): city checkboxes, optional max miles, individual dates and/or date from/to, earliest start time (default 11:00), attendance (**any** / **in person** / **online**).
6. **Taste filter** with Look for / Skip criteria.
7. **Rank + show** on the main Events card (thumbs ± later).

**Event catalog (implemented):** Node `node:sqlite` file at `EVENTS_FINDER_DB_PATH` (default `data/events-finder.db`). Each feed load upserts Gmail + Facebook hits, prunes stale rows (~14d), then serves from the catalog. **Dedupe:** same normalized title + same local calendar day (`WEATHER_TIME_ZONE`) → keep the richer listing. API includes a `store` block (`count`, `bySource`, `upserted`, `dedupedRemoved`).

**Geo + filters (implemented):** `src/lib/events-finder-geo.js` + criteria `filters` (`cities`, `maxMiles`, `dates`, `dateFrom`, `dateTo`, `earliestLocalTime`, `attendance`). Settings → Filter criteria edits all of these. API returns `geo.homeCities` / `geo.bayArea` and `filters`. Online events skip city/distance gates; unknowns are kept when attendance is filtered.

---

## 1. Partiful (`partiful.com`) — Public pages + Gmail for private

**Constraint:** Public HTML only sees **public** parties. Private / invite-only events are invisible without an account session — do **not** rely on scraping for those.

**Primary path for private:** In the Partiful account, set notification / invite email to **`jay.intake.box@gmail.com`**, then ingest via **Intake Gmail** (already queries `from:partiful.com` + Partiful URLs in body).

**Today:** Site reachable; ingest smoke test finds generic “event” page signals. No list API; parties are mostly share-link based.

**Samples:** 7 public event URLs in [`docs/events-sample-urls.md`](events-sample-urls.md) (all HTTP 200 with real titles). HTML is thin on schema.org — plan Partiful-specific parse (title / `<time>` / embedded JSON) for **public** only.

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | Account: route Partiful email notifications → `jay.intake.box@gmail.com`; confirm Gmail intake parses Partiful mailers. |
| P1 | Parse sample **public** party URLs → title, date/time, host, RSVP link (watchlist optional). |
| P2 | Dedupe Gmail-sourced Partiful vs public URL watchlist; criteria filter. |

**Needs from you:** In Partiful settings, set invite/notification email to `jay.intake.box@gmail.com` (one-time).

---

## 1b. Secret Party (`secretparty.io`) — Public pages + Gmail for private

**Constraint:** Same as Partiful — public pages cannot see **private** events.

**Primary path for private:** In the Secret Party account, set notification / invite email to **`jay.intake.box@gmail.com`**, then ingest via **Intake Gmail** (`from:secretparty.io` already in the query).

**Today:** Source row in Settings (Personal bookmarks → Events → **Secret Party**). Site reachable; strategy **Public pages**. No list API — events are share/invite URL based (similar to Partiful).

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | Account: route Secret Party email notifications → `jay.intake.box@gmail.com`; confirm Gmail intake parses mailers. |
| P1 | Optional: parse sample **public** event URLs + watchlist refresh. |
| P2 | Dedupe against Partiful/Luma/Gmail; criteria filter. |

**Needs from you:** In Secret Party settings, set invite/notification email to `jay.intake.box@gmail.com` (one-time). Optional: a few public `secretparty.io` URLs for parse fixtures.
---

## 2. Luma (`lu.ma` / `luma.com`) — Public pages

**Today:** Reachable; HTML smoke test passes. Public event + calendar pages are the realistic path. Event pages expose JSON-LD + `__NEXT_DATA__` (easier than Partiful).

**Samples:** 2 event URLs + 4 hub names (screenshot) in [`docs/events-sample-urls.md`](events-sample-urls.md).

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | Parse sample **event** pages → title, when, host, join URL. |
| P1 | Subscribe to hub calendars: Big Brain Lectures BA, Frontier Tower SF, SF Hardware Meetup, tiat (need canonical calendar URLs). |
| P2 | Optional ICS/export if Luma exposes it for those calendars. |
| P3 | Location + criteria filter into the shared feed. |

**Needs from you:** canonical Luma **calendar/hub** URLs for the four screenshot calendars (event URLs alone are not enough for ongoing ingest).

---

## 3. Eventbrite (`eventbrite.com`) — Public pages (API optional)

**Decision (corrected):** Discover from **public listing pages** — no API key required for explore. Official REST search is auth-only / largely retired; keep a token as an optional later upgrade, not a blocker.

**Verified:** `https://www.eventbrite.com/d/ca--san-francisco/events/` returns HTTP 200 with embedded `__SERVER_DATA__` and many schema.org Event / `/e/` links. Category pages (e.g. science-and-tech) work the same way.

**Today:** Settings strategy updated to **Public pages**. Ingestion smoke test will fetch HTML signals like Luma/Partiful.

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | Fetch `/d/{location}/…` (and keyword/category variants) → parse ItemList JSON-LD / `__SERVER_DATA__` → normalized events. |
| P1 | Seed listings for dashboard **city** (Eventbrite `/d/{state}--{city}/…`); apply Look for / Skip. Soft-rank by distance when coords exist. |
| P2 | Pagination (`?page=N`), date filters, category seeds matching criteria. |
| P3 | Optional: `EVENTBRITE_API_TOKEN` only if public pages get brittle or we need organizer-owned inventory. |

**Needs from you:** nothing for geo (derive city from dashboard ZIP). API token **not** required for P0–P2.

---

## 4. Meetup (`meetup.com`) — Gmail first (API optional later)

**Constraint:** Browsing / public discovery on Meetup is weak for our use — hard to look through well. Don’t block the feed on a full Meetup crawl or API.

**Primary path:** In the Meetup account, set email notifications (group digests, event invites, RSVP mail) to **`jay.intake.box@gmail.com`**, then scrape via **Intake Gmail** (`from:meetup.com` + Meetup URLs already in the query).

**Optional later:** Official API if credentials land and we want location/group pins beyond what email covers. Sample seed still in [`docs/events-sample-urls.md`](events-sample-urls.md).

**Today:** Site up; HTML/API ingest **Not wired**. Gmail path is the intended live source.

**Seed intent (API / pins — deferred)**

- Pin candidates if we ever wire API: **SF Hardware Meetup**, **Noisebridge** (need `meetup.com/<slug>/` URLs; SF Hardware also on Luma).

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | Account: route Meetup notification email → `jay.intake.box@gmail.com`; confirm Gmail intake parses Meetup mailers / `.ics`. |
| P1 | Normalize Gmail-sourced Meetup events → shared schema; criteria filter. |
| P2 | Optional: Meetup OAuth / API for location search + pinned groups (only if email coverage is thin). |

**Needs from you:** In Meetup settings, set notification email to `jay.intake.box@gmail.com` (one-time). API credentials only if we reopen P2.
---

## 5. Facebook Events (`facebook.com`) — Apify + Gmail invites + pinned hosts

**Decision:** Three paths working together:

1. **Gmail invites** — `facebookmail.com` / event links in intake inbox (`events-finder-gmail.js`).
2. **Apify public search** — Look for lines → `searchQueries` (`apify/facebook-events-scraper`).
3. **Pinned hosts** — Pages/groups in Filter criteria → `startUrls` (`upcoming_hosted_events` / `groups/…/events`).

**Today:** Wired when `APIFY_TOKEN` is set (2+3) and Gmail OAuth connected (1). Module: `src/lib/events-finder-facebook.js`. Pins: `scrape.pinnedHosts` in criteria. Cache: `data/facebook-events-cache.json`.

**Setup**

| Step | Work |
| --- | --- |
| 1 | `APIFY_TOKEN` in `.env`; Connect Gmail for invites. |
| 2 | Filter criteria → Look for (search) + scrape budget + **Pinned Facebook hosts**. |
| 3 | Forward FB invite email to intake Gmail if invites land on another address. |
| 4 | Force refresh: `GET /api/events-finder/events?refreshFacebook=1`. Weekly: Tuesday 21:00 America/Los_Angeles (`FACEBOOK_EVENTS_WEEKLY`). |

**Needs from you:** Pin page/group slugs your circle actually follows; keep Look for short to control cost.

---

## 6. Fet (`fetlife.com`) — Deferred

**Decision:** **Defer** — bookmark + reachability only; no auto-ingest for now.

**Today:** Login-walled; scrape off-limits. Leave as manual bookmark until reopened.

**Roadmap:** None until explicitly reopened (then revisit paste URLs vs any official export).

**Needs from you:** Nothing for now.

---

## 7. Intake Gmail (`mail.google.com` / multi-account) — Gmail API

**Decision:** Official **Gmail API** (OAuth, readonly). Not HTML scraping — `mail.google.com` is login-walled.

**Inboxes (default):** `jay.intake.box@gmail.com` **and** `julia.hasty@gmail.com` (override with `GMAIL_INTAKE_ADDRESSES`).

**Role:** Primary ingest for **private Partiful**, **private Secret Party**, and **Meetup** (after each account’s notification email is set to an intake inbox). Also catches Facebook / Luma / Eventbrite mailers and `.ics` invites from either mailbox.

**Today:** Source row in Settings (Personal bookmarks → Events → **Intake Gmail**). Modules: `src/lib/events-finder-gmail.js`, OAuth routes under `/api/events-finder-gmail/*`, feed contribution via `GET /api/events-finder/events`. Tokens: `data/gmail-intake-tokens/<email>.json`.

**Parse path**

1. List messages with event-ish query (`.ics`, invite/RSVP subjects, Partiful/Luma/Eventbrite/Meetup/Facebook/Secret Party mailers).
2. Prefer `.ics` attachments → existing `ical-parse.js`.
3. Else extract platform URLs from body; else subject/date heuristics.
4. Normalize → shared `{ id, title, start, venue, url, source: 'gmail', raw }` (deduped across inboxes by URL).

**Setup**

| Step | Work |
| --- | --- |
| 1 | Google Cloud project: enable **Gmail API**; OAuth client (web or desktop). |
| 2 | Add redirect: `http://127.0.0.1:8787/api/events-finder-gmail/oauth/callback` (or `DASHBOARD_LAN_ORIGIN` + same path). |
| 3 | Set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in `.env` (aliases: `GMAIL_INTAKE_*`). |
| 4 | Settings → Events sources → **Connect** each inbox — sign in as **jay.intake.box@gmail.com**, then as **julia.hasty@gmail.com**. |
| 5 | In **Partiful**, **Secret Party**, and **Meetup** account settings: set notification / invite email → one of the intake addresses. |

**Needs from you:** OAuth client credentials + Connect for **both** Gmail accounts + step 5 on each platform.

---

## Suggested build order

1. **Intake Gmail** (OAuth) — primary path for **private Partiful / Secret Party** and **Meetup** (after accounts point notifications at intake).
2. **Luma** + **Eventbrite** + **public** Partiful/Secret Party HTML (listings / watchlists — no keys).
3. **Facebook (Apify)** — live when `APIFY_TOKEN` is set; cache + look-for queries (+ Gmail invites).
4. **Meetup API** — optional later; email first.
5. **Fet** — stay deferred.

---

## Your short to-do list (open)

1. **Intake Gmail** — Google OAuth client + Connect **jay.intake.box@gmail.com** and **julia.hasty@gmail.com** (Settings → Events sources).
2. **Account email routing (do this in each product UI)** — set notification / invite email to an intake address (`jay.intake.box@gmail.com` or `julia.hasty@gmail.com`) on:
   - **Partiful** (private invites won't show on public pages)
   - **Secret Party** (same)
   - **Meetup** (browsing/API discovery is weak; email is the feed)
3. **Luma** — Paste canonical calendar/hub URLs for Big Brain Lectures, Frontier Tower SF, SF Hardware Meetup, tiat.
4. **Facebook** — paste `APIFY_TOKEN` in `.env` (Actor already chosen).
5. **Noisebridge** (optional) — site/calendar/Meetup URL if it should be a source.

**Settled:** Fet deferred. Partiful sample event URLs received. Eventbrite = public pages first. Intake Gmail = Gmail API (**jay.intake.box + julia.hasty**). **Partiful / Secret Party private + Meetup → email to intake, not public scrape.** **Bay home cities: SF / Oakland / Emeryville / Berkeley.** Feed filters: city, optional distance, date range, earliest time, online vs in person.
