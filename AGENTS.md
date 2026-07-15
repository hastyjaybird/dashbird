# dashbird — agent notes

## Cursor Cloud specific instructions

dashbird is a single Node.js/Express app (ES modules, no build step, no bundler,
no TypeScript). It serves `public/` plus ~45 `/api/*` routers from `src/`.

### Running in the cloud VM

- **Use local Node, not Docker.** The `docker-compose.yml` mounts host-only paths
  (X11, dbus, `/usr/share/applications`, `~/Applications`) for desktop-launch tiles
  and won't work in this VM. The workspace "Docker restart after changes" rule is
  for Jay's home host; ignore it here and run the app directly with Node.
- Start the dev server with `npm run dev` (`node --watch src/server.js`). It hot-reloads
  on `src/` changes.
- **Without Docker the server listens on `PORT` (default `3000`)**, e.g.
  `http://127.0.0.1:3000/`. Port `8787` (`HOST_PORT`) is only the Docker host mapping.
- Copy env once with `cp .env.example .env`. Nearly every integration is optional and
  fails soft (panels show a "setup hint") when its secret is missing, so the app runs
  fully with an unconfigured `.env`.

### Node version

- Requires **Node ≥ 22.5** even though `package.json` `engines` says `>=20`: the SQLite
  stores (`src/lib/network-db.js`, `events-finder-store.js`, `telegram-intake-queue.js`)
  import `DatabaseSync` from the built-in `node:sqlite`. The VM's Node 22 is fine. The
  `ExperimentalWarning: SQLite is an experimental feature` log line on startup is expected.

### Data

- SQLite files (`data/*.db`) and `.env` are gitignored and created on first run; the
  Network CRM / Events Finder / Telegram intake all use these embedded DBs (no DB server).

### Tests / lint / build

- There is **no linter, no build step, and no unit-test framework**. The only checks are
  HTTP smoke scripts (`npm run smoke:core|calendar|earth|weather-radar`) that hit a
  **running** server. They default to `http://127.0.0.1:8787`; when running the app via
  local Node, point them at the dev port:
  `DASHBIRD_BASE=http://127.0.0.1:3000 npm run smoke:core`.
- `smoke:calendar` "fails" unless `GOOGLE_CALENDAR_ICAL_URL` is set — that's an optional
  Google Calendar secret, not an environment problem. `smoke:earth` prints empty/soft
  rows out of season, which is also expected.
