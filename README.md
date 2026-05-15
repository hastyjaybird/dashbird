# dashbird

Local **homepage dashboard** (Dashy-inspired glass UI): full-width photo background, a **hero** cluster (12-hour clock, Open-Meteo weather with low-poly SVG icons), **Personal** and **Admin** tile grids (favicon + one word), Google Calendar, plain-text notes, and **chat** via [OpenRouter](https://openrouter.ai/) through a **server-side** proxy (API keys never ship to the browser).

Post–v1 integrations (Vikunja, Google Keep, optional Home Assistant proxy) live in [`docs/v2-roadmap.md`](docs/v2-roadmap.md).

This repo supersedes the earlier **`homeassistantdashboard`** workspace; the Cursor plan was merged here under the name **dashbird** (see `~/.cursor/plans/local_firefox_dashboard_26fbbff8.plan.md` if you still have it).

## Quick start

1. Copy environment template and set at least `OPENROUTER_API_KEY` for chat:

   ```bash
   cp .env.example .env
   ```

2. Run with Docker Compose (service name **`dashboard`**):

   ```bash
   docker compose up --build
   ```

3. Open **`http://127.0.0.1:8787/`** (or whatever you set as `HOST_PORT` in `.env`). The container listens on **3000** internally; Compose maps **`HOST_PORT` → 3000**.

### Local Node (without Docker)

```bash
npm install
npm start
```

Default `PORT` is **3000** when not using Compose.

## Configuration

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port inside the container / for `npm start` |
| `HOST_PORT` | Host port published by Compose (default `8787`) |
| `OPENROUTER_API_KEY` | Server-only key for `/api/chat` |
| `OPENROUTER_MODEL` | Model id (default `openrouter/auto`) |
| `CALENDAR_EMBED_URL` | Full `src` URL from Google Calendar **Integrate calendar** (iframe embed) |
| `WEATHER_LAT` / `WEATHER_LON` | Open-Meteo coordinates (defaults: **Oakland, CA 94608**) |
| `DASHBOARD_LOCATION_LABEL` | Reserved for future use (the hero no longer shows a location line under the date) |
| `SF_WEATHER_LAT` / `SF_WEATHER_LON` | Second city in hero (default San Francisco) |
| `LAST_BACKUP_AT` | Optional ISO time for **“days since last backup”** in the right system sidebar (overrides file below) |
| `CHAT_RATE_LIMIT_PER_MINUTE` | Optional `/api/chat` throttle per IP per minute (`0` = off, **default**). Spend caps: set on [openrouter.ai](https://openrouter.ai/). |

Commented **v2** placeholders are listed in [`.env.example`](.env.example).

## Last backup (system sidebar)

Set **`LAST_BACKUP_AT`** in `.env` to an ISO timestamp, **or** put a single ISO line in [`public/data/last-backup.txt`](public/data/last-backup.txt) (first non-`#` line wins if env is empty). The **right system sidebar** shows **days since last backup** (full calendar days since that time) with a short tooltip for the exact timestamp.

## Layout

The main column uses the **full browser width** with responsive side padding (`clamp`), so laptop windows are not locked to a narrow max-width.

## OpenRouter: cost and key safety

- The **API key stays on the server** (`.env` / Docker secrets); it is never sent to the browser.
- Turn on **spend limits and alerts** in your [OpenRouter account](https://openrouter.ai/) so a stolen key cannot run up an unlimited bill.
- **`CHAT_RATE_LIMIT_PER_MINUTE`** (default **off**) can throttle how often this app calls OpenRouter per client IP. Your **monthly / spend limits** should stay on the OpenRouter account; this is only an optional local guardrail.
- Prefer **not** exposing dashbird to the public internet without authentication; treat it like any local admin tool.

## Product backlog (from `features.txt`)

Not implemented yet; tracked for future work:

- Life-goals / refocus panel (financial, housing, music, friends, schedule, events).
- Agent daily-ops status (fed by a separate orchestrator).
- Private cycle / “bioclock” notes (local-only, no third party).
- Persistent “Amazon package arrived” banner (external email agent later).
- Chat: Perplexity-style **hover citations** on sources.
- Google Keep–style sync (see [`docs/v2-roadmap.md`](docs/v2-roadmap.md) for Keep as v2).

## Browser home / new tab

Use your browser’s settings to set **home page** and/or **custom new tab URL** to this app’s origin (for example `http://127.0.0.1:8787/`). The app uses normal **HTTPS/HTTP** APIs only—no Firefox-only APIs and no requirement for extensions.

## Editing tiles and notes

- **Personal** tiles: [`public/data/bookmarks-personal.json`](public/data/bookmarks-personal.json) — object with a `sections` array. Each section has `title` and `items` (`word`, `href`, optional `icon`, optional `title` for native tooltip). Sections render as collapsible groups (**first section open** by default). **`cursor://` and `signal://`** open the desktop handlers; other links open in a new tab.
- **Admin** tiles: [`public/data/bookmarks-work.json`](public/data/bookmarks-work.json) — same `sections` / `items` shape; sections render as collapsible groups (first open by default).
- **Background image**: [`public/assets/dashboard-bg.jpg`](public/assets/dashboard-bg.jpg) (replace this file to change the wallpaper).
- Notes: [`public/data/notes.md`](public/data/notes.md) (shown as plain text).

Docker Compose mounts **`./public`** and **`./src`** into the container, so new sky icons, `sky-events-calendar.json`, and panel JS match the repo without `docker compose build` (restart or refresh is enough). Static responses use **`Cache-Control: no-cache, must-revalidate`** and **`GET /api/sky-events`** uses **`no-store`**, so a normal reload picks up icon URL changes; use a hard refresh if a tab was open for a long time. After **server** or **dependency** changes, run **`docker compose up --build`** again.

## Architecture (v1)

- **Express** serves `public/` and [`docs/`](docs/) at **`/docs/...`**.
- **Panels** are ES modules under [`public/js/panels/`](public/js/panels/) (one file per area), loaded from [`public/js/app.js`](public/js/app.js).
- **APIs**: `GET /api/config` (includes `openrouterModel` label), `POST /api/chat` (streams OpenRouter SSE), `GET /api/openrouter/summary` (monthly % when OpenRouter’s key payload allows it; else purchased-credits %), `GET /api/openrouter/credits` / `GET /api/openrouter/key` (proxies when the key is allowed), **`GET /api/sky-events`** (hero “sky sights” rows from [`src/data/sky-events-calendar.json`](src/data/sky-events-calendar.json); optional `?windowHours=24`), **`501`** stubs: `/api/vikunja/*`, `/api/keep/*`, `/api/home-assistant/*` for v2.

### Sky event types and reference websites

Sky rows come from **hand-edited** [`src/data/sky-events-calendar.json`](src/data/sky-events-calendar.json), except: **geomagnetic / solar proton warning** — the server calls **NOAA SWPC** GOES integral-proton JSON and injects a row **only** when **≥10 MeV** flux is at or above the **10 pfu** (S1) threshold; calendar `geomagnetic` entries are not shown in the strip. **Aurora** — the server calls **SWPC** [`ovation_aurora_latest.json`](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json) and [`planetary_k_index_1m.json`](https://services.swpc.noaa.gov/json/planetary_k_index_1m.json), bilinear-samples Ovation at **`WEATHER_LAT` / `WEATHER_LON`** (94608 defaults in `.env`), and replaces calendar `aurora` rows with one **“today”** row (`America/Los_Angeles` day bounds). The subtitle shows **Low / Medium / High / Very high** from `computeAuroraLikelihood` in [`src/lib/swpc-aurora.js`](src/lib/swpc-aurora.js) (latitude-aware Kp + Ovation); not clouds/moon. The app **does not** otherwise call the sites in the table on a schedule; update the JSON when you refresh passes, showers, etc. **ISS pass** and **Satellite flare** rows use optional `forecastUrl` in the same file so the hero can open the primary site in a new tab. Hero **weather** and **sunrise/sunset** use live [Open-Meteo](https://api.open-meteo.com/) requests from the browser when the page loads; **moonrise** is computed locally (SunCalc).


| Event (hero label) | Primary website (curation / forecast) |
|--------------------|----------------------------------------|
| Aurora | Live **Ovation + Kp** from [SWPC JSON](https://services.swpc.noaa.gov/json/) at **`WEATHER_LAT` / `WEATHER_LON`** (94608 defaults); [30-minute aurora forecast (SWPC)](https://www.swpc.noaa.gov/products/aurora-30-minute-forecast) |
| Geomagnetic storm | [NOAA SWPC](https://www.swpc.noaa.gov/) — hero **geomagnetic** row appears only when live **GOES ≥10 MeV** integral flux from SWPC JSON meets the **≥10 pfu** (NOAA **S1**) threshold; [GOES proton flux product](https://www.swpc.noaa.gov/products/goes-proton-flux) |
| Lunar eclipse | [Time and Date — eclipses](https://www.timeanddate.com/eclipse/) (see also [NASA JPL skywatching](https://solarsystem.nasa.gov/skywatching/home/) in calendar `sources`) |
| Solar eclipse | [Time and Date — eclipses](https://www.timeanddate.com/eclipse/) (see also [NASA JPL skywatching](https://solarsystem.nasa.gov/skywatching/home/) in calendar `sources`) |
| Comet | [NASA JPL — What’s Up / skywatching](https://solarsystem.nasa.gov/skywatching/home/) (see also [In-The-Sky.org](https://in-the-sky.org/) in calendar `sources`) |
| Supermoon | Curated public lists (e.g. NASA Science, Sky at Night, Time and Date); see `meta.window_policy` in the calendar JSON — not every full moon qualifies |
| Meteor shower | [AMS meteor shower calendar](https://www.amsmeteors.org/meteor-showers/meteor-shower-calendar/) (peaks & moon) and [IMO calendar](https://www.imo.net/resources/calendar/) — calendar JSON uses **`startsAt`/`endsAt` = peak night only** (see `meta.meteor_range_policy`) |
| ISS pass | [NASA Spot the Station](https://spotthestation.nasa.gov/) |
| Satellite flare | [Heavens-Above](https://www.heavens-above.com/) |
| Satellite train | [Heavens-Above](https://www.heavens-above.com/) |
| Rocket launch | [SpaceLaunchSchedule](https://www.spacelaunchschedule.com/) and [NASA TV / nasalive](https://www.nasa.gov/nasalive/) for live coverage |
| Rainbow | No dedicated URL in the calendar; use weather (same hero stack: **Open-Meteo** on load; optional human check [weather.gov](https://www.weather.gov/)) plus sun-low geometry |

The calendar `sources` array also lists [SpaceWeatherLive](https://www.spaceweatherlive.com/) for aurora / geomagnetic / solar context alongside NOAA.

### Chat + OpenRouter metadata

- After each reply, the footer shows **model**, **total tokens**, and a **mode** hint from OpenRouter usage when present.
- **Enter** sends the message; **Shift+Enter** inserts a newline in the chat box.
- **Credits / monthly %**: **`GET /api/openrouter/summary`** feeds the **OpenRouter ring** in the **right system sidebar** (refreshed periodically and after each successful chat). The summary prefers OpenRouter’s **`/api/v1/key`** payload for **% of period limit left**; if that is not available, it falls back to **`/api/v1/credits`** (purchased balance).

### Connectivity check (right sidebar)

The **Check all** button at the bottom of the system sidebar runs **`POST /api/dashboard-check`**: OpenRouter, **`/api/sky-events`** (including live SWPC/GOES paths used there), Open-Meteo for both hero cities, **`CALENDAR_EMBED_URL`** when set, HTTP(S) **bookmark** tiles (skips `cursor://` / `signal://`), **`public/data/notes.md`**, and internal **`/api/*`** probes. If anything fails, a **yellow warning triangle** appears next to the button; **hover** it for a plain-text list of what failed. When you add a new outbound connector or API, update **`src/lib/dashboard-check.js`** (checklist in that file’s header).

## Home Assistant / Lovelace vs this app

You can still set the browser home URL to your **Home Assistant Lovelace** dashboard if entity control and community cards are the main goal. **dashbird** is a small, separate page for mixed “browser life” widgets and chat; see the plan file above for the full comparison.

## License

Private project unless you add a license.
