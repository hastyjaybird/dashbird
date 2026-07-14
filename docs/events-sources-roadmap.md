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

**Event catalog (implemented):** Node `node:sqlite` file at `EVENTS_FINDER_DB_PATH` (default `data/events-finder.db`). Each feed load upserts Gmail + Facebook + public HTML (Partiful/Secret Party/Eventbrite) + Meetup pins + Multiverse ICS + Luma calendar pins, prunes stale rows (~14d), then serves from the catalog. **Telegram** upserts immediately on bot message (text / voice / flyer photo) and appears on the next feed load. **Dedupe:** same normalized title + same local calendar day (`WEATHER_TIME_ZONE`) → keep the richer listing. **Taste:** Skip lines drop unless a Look for line also matches; Look for lines boost rank (`events-finder-taste.js`). API includes a `store` block (`count`, `bySource`, `upserted`, `dedupedRemoved`, `tasteSkipped`).

**Geo + filters (implemented):** `src/lib/events-finder-geo.js` + criteria `filters` (`cities`, `maxMiles`, `dates`, `dateFrom`, `dateTo`, `earliestLocalTime`, `attendance`). Date/time gates use **local** timezone (not UTC). Settings → Filter criteria edits all of these. API returns `geo.homeCities` / `geo.bayArea` and `filters`. Online events skip city/distance gates; unknowns are kept when attendance is filtered.

---

## 1. Partiful (`partiful.com`) — Explore SF + Gmail for private

**Constraint:** Public HTML only sees **public** parties. Private / invite-only events are invisible without an account session — do **not** rely on scraping for those.

**Primary path for private:** In the Partiful account, set notification / invite email to **`jay.intake.box@gmail.com`**, then ingest via **Intake Gmail** (already queries `from:partiful.com` + Partiful URLs in body).

**Public path (wired):** `https://partiful.com/explore/sf` → `__NEXT_DATA__` trending + sections + feed (~50 Bay Area public events). Optional extra URLs in [`docs/events-sample-urls.md`](events-sample-urls.md). Override region with `PARTIFUL_EXPLORE_REGION` (default `sf`).

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | Account: route Partiful email notifications → `jay.intake.box@gmail.com`; confirm Gmail intake parses Partiful mailers. |
| P1 | ~~Parse sample public party URLs~~ → **Explore SF listing** (done). |
| P2 | Dedupe Gmail-sourced Partiful vs Explore/watchlist; criteria filter. |

**Needs from you:** In Partiful settings, set invite/notification email to `jay.intake.box@gmail.com` (one-time). Public SF discovery needs no action.

---

## 1b. Secret Party (`secretparty.io`) — Gmail primary + optional watchlist

**Constraint:** Public HTML / unauthenticated API cannot see **private / semi-private** events. Site `robots.txt` Disallows crawling; `api.secretparty.io` returns 401 without auth. Event pages are usually `https://<slug>.secretparty.io/`.

**Primary path for private:** In the Secret Party account, set notification / invite email to **`jay.intake.box@gmail.com`**, then ingest via **Intake Gmail** (`from:secretparty.io` + `*.secretparty.io` URLs).

**Today (wired):** Gmail tags Secret Party links as `source: secretparty`. Optional public watchlist in [`docs/events-sample-urls.md`](events-sample-urls.md). Gap checklist: [`docs/secretparty-ingest-plan.md`](secretparty-ingest-plan.md).

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | Account: route Secret Party email → intake; confirm Gmail parse (done in code; needs account setting). |
| P1 | Grow public watchlist when share URLs are known. |
| P2 | Optional API if credentials ever land. |

**Needs from you:** In Secret Party settings, set invite/notification email to `jay.intake.box@gmail.com` (one-time). Paste any public `*.secretparty.io` URLs into the sample doc.
---

## 2. Luma (`lu.ma` / `luma.com`) — Public pages + calendar API

**Today:** Wired. Pins in [`docs/luma-calendar-pins.md`](luma-calendar-pins.md) →
`events-finder-luma.js` fetches page HTML (`__NEXT_DATA__`), then:

- calendar hubs → `api.lu.ma/calendar/get-items`
- discover places (e.g. [`luma.com/sf`](https://luma.com/sf)) → `api.lu.ma/discover/get-paginated-events`
- event pages → single-event parse

Cached ~6h. Gmail catches Luma invite mailers.

**Pins:** SF city discover (`/sf`) + Big Brain Lectures BA (`/Big-Brain-SF`), Frontier Tower SF
(`/frontiertower`), SF Hardware Meetup (`/sf-hardware-meetup`), tiat (`/tiat`), plus a couple
event-page seeds.

**Roadmap**

| Phase | Work |
| --- | --- |
| P0 | ✅ Parse event + calendar pages → title, when, venue, join URL, price. |
| P1 | ✅ Subscribe to hub calendars (canonical URLs in pin file). |
| P1b | ✅ SF discover-place (`luma.com/sf`) via get-paginated-events. |
| P2 | Optional ICS/export if Luma exposes it for those calendars. |
| P3 | Location + criteria filter into the shared feed (shared pipeline already applies). |

**Needs from you:** add more calendar/discover/event URLs to the pin file as you discover them.

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
| 4 | Force refresh: `GET /api/events-finder/events?refreshFacebook=1`. Daily Apify: 04:00 America/Los_Angeles (`FACEBOOK_EVENTS_WEEKLY`). Other sources: every 2h, quiet 02:00–07:00. |

**Needs from you:** Pin page/group slugs your circle actually follows; keep Look for short to control cost.

---

## 6. Fet (`fetlife.com`) — Deferred

**Decision:** **Defer** — bookmark + reachability only; no auto-ingest for now.

**Today:** Login-walled; scrape off-limits. Leave as manual bookmark until reopened.

**Roadmap:** None until explicitly reopened (then revisit paste URLs vs any official export).

**Needs from you:** Nothing for now.

---

## 6b. Telegram (`t.me`) — Phone screenshots / voice / text

**Decision:** Push intake via a private Telegram bot (long-poll `getUpdates` — works on LAN Docker without a public webhook).

**Accepts**

| Input | Path |
| --- | --- |
| Flyer / text-invite screenshot | Download photo → OpenRouter vision → event JSON |
| Business card / LinkedIn / social screenshot / headshot | Vision intake-kind classify → Network contact (fields + avatar crop when identified) |
| Guest / RSVP / attendee list screenshot | Vision classify → Network contacts for each readable name (cap 40); event title noted when visible |
| Company logo | Vision classify → Network company card + logo |
| Name + phone / email text | Text classifier → Network contact |
| Voice note | Whisper transcription → same NL classify as text |
| Text | e.g. “event on July 18…” / `/todo` / `/note` / `/contact` / `/company` |

**Image:** flyer photo is saved under `public/data/telegram-events/` and used as the card art. Contact headshots/logos land in `data/network-assets/`. Text/voice events with no graphic → `/assets/tile-telegram.svg`.

**Today:** Modules `src/lib/events-finder-telegram.js` + `telegram-message-classify.js` + `events-finder-invite-parse.js`. Status: `/api/events-finder/telegram/status`. Poller starts from `server.js` when `TELEGRAM_BOT_TOKEN` is set.

**Setup**

| Step | Work |
| --- | --- |
| 1 | `@BotFather` → create bot → `TELEGRAM_BOT_TOKEN` in `.env` |
| 2 | `OPENROUTER_API_KEY` (vision + text + Whisper) |
| 3 | DM the bot `/start` → copy chat id → `TELEGRAM_ALLOWED_CHAT_IDS=` |
| 4 | Restart stack; send a test text/voice/photo |

**Needs from you:** Bot token + allowlisted chat id(s).

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

1. **Account email routing (in each product UI)** — set notification / invite email to an intake address (`jay.intake.box@gmail.com` or `julia.hasty@gmail.com`) on:
   - **Partiful** (private invites won't show on public pages)
   - **Secret Party** (same)
   - **Meetup** (browsing/API discovery is weak; email is the feed)
2. **Luma** — ✅ Hub URLs in [`docs/luma-calendar-pins.md`](luma-calendar-pins.md) (add more as you find them).
3. **Noisebridge** (optional) — site/calendar/Meetup URL if it should be a source.
4. **Filter window** — in Settings → Filter criteria, widen `dateFrom` / `dateTo` (or clear them) when the sidebar looks empty; a tight week window hides later events.

**Already wired (no action):** Gmail IMAP app passwords for both inboxes; `APIFY_TOKEN`; SQLite catalog; name+date dedupe; Look for / Skip taste; public Partiful + Luma calendar pins + Eventbrite SF listing + Meetup pins + Multiverse ICS.

**Settled:** Fet deferred. Partiful sample event URLs received. Eventbrite = public pages first. Intake Gmail = IMAP app passwords (**jay.intake.box + julia.hasty**). **Partiful / Secret Party private + Meetup → email to intake, not public scrape.** **Bay home cities: SF / Oakland / Emeryville / Berkeley.** Feed filters: city, optional distance, date range, earliest time, online vs in person.
