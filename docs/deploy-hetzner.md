# Deploy dashbird on Hetzner Cloud

Move dashbird from a home LAN Docker setup to a Hetzner VPS with HTTPS and optional HTTP basic auth.

## What changes on Hetzner

| Local (home) | Hetzner (cloud) |
|--------------|-----------------|
| Port **8787** on LAN | **443** HTTPS via Caddy |
| `lan-url` service for phone Wi‑Fi link | Set **`DASHBOARD_LAN_ORIGIN=https://your-domain`** |
| X11 / DBus / desktop app tiles | Not available (remove `cursor://` / `/api/open-desktop/` tiles or replace with web links) |
| Host GPU/thermal sidebar stats | Shows container stats only (expected) |
| Trusted LAN, no auth | **Use basic auth** + OpenRouter spend limits |

Most panels (weather, calendar, sky/earth events, chat, radar) work unchanged — they call public APIs from the server.

## Prerequisites

1. **Hetzner Cloud** account and a server (Ubuntu 24.04, **CX22** or larger is plenty).
2. **Domain name** with DNS you control (A/AAAA record → server public IP).
3. **OpenRouter API key** (for chat).
4. Local copies of gitignored files you care about: `.env`, `public/data/bookmarks-personal.json`, `public/data/notes.md`, `data/*`.

## 1. Create the server

In Hetzner Cloud Console:

- **Location**: pick closest to you (e.g. Ashburn, Hillsboro).
- **Image**: Ubuntu 24.04.
- **Type**: CX22 (2 vCPU, 4 GB) or CX11 for light use.
- **Networking**: IPv4 (+ IPv6 if you want AAAA).
- **SSH key**: add yours at create time.

Note the **public IP**.

## 2. DNS

Create an **A record** (and optional **AAAA**):

```
dashbird.example.com  →  YOUR_SERVER_IP
```

Wait for propagation before starting Caddy (Let’s Encrypt needs the name to resolve).

## 3. Bootstrap the server

SSH in and install Docker + firewall:

```bash
ssh root@YOUR_SERVER_IP
git clone YOUR_REPO_URL /opt/dashbird
cd /opt/dashbird
sudo bash scripts/hetzner-bootstrap.sh
```

Or copy the repo from your machine (see [Sync from your PC](#sync-from-your-pc) below).

## 4. Configure environment

```bash
cd /opt/dashbird
cp deploy/env.hetzner.example .env
nano .env   # or vim
```

Set at minimum:

- `DASHBOARD_DOMAIN` — e.g. `dashbird.example.com`
- `CADDY_EMAIL` — for Let’s Encrypt
- `DASHBOARD_LAN_ORIGIN` — `https://dashbird.example.com` (no trailing slash)
- `OPENROUTER_API_KEY`

Generate a **basic auth** password hash (recommended):

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'choose-a-strong-password'
```

Put the hash in `.env`:

```
DASHBOARD_BASIC_AUTH_USER=dashbird
DASHBOARD_BASIC_AUTH_HASH=$2a$14$...
```

Copy personal data if you use it:

```bash
cp public/data/bookmarks-personal.example.json public/data/bookmarks-personal.json
# then edit, or rsync from your home machine
```

## 5. Start production stack

```bash
docker compose -f docker-compose.hetzner.yml up -d --build
docker compose -f docker-compose.hetzner.yml logs -f
```

Open `https://dashbird.example.com` — you should get a basic-auth prompt, then the dashboard.

## Sync from your PC

From your home machine (with the repo and `.env`):

```bash
HETZNER_HOST=root@YOUR_SERVER_IP ./scripts/sync-to-hetzner.sh
```

This rsyncs the tree (excluding `node_modules`), pushes `.env`, `data/`, and personal bookmark/notes files, then rebuilds on the server.

## Updates

On the server:

```bash
cd /opt/dashbird
git pull
docker compose -f docker-compose.hetzner.yml up -d --build
```

Or run `sync-to-hetzner.sh` from home after local edits.

## Security checklist

- [ ] HTTP basic auth enabled (`DASHBOARD_BASIC_AUTH_HASH` set)
- [ ] OpenRouter **spend limits** on [openrouter.ai](https://openrouter.ai/)
- [ ] `CHAT_RATE_LIMIT_PER_MINUTE` set (e.g. `12`)
- [ ] Do **not** port-forward 8787 on your home router anymore once migrated
- [ ] Review bookmark tiles: remove desktop-only links (`cursor://`, `/api/open-desktop/`)
- [ ] `AIR_QUALITY_FORCE_SHOW=0` for production

## Troubleshooting

**Certificate errors** — DNS must point to this server before first `up`. Check with `dig +short dashbird.example.com`.

**502 from Caddy** — `docker compose -f docker-compose.hetzner.yml logs dashboard`

**Chat “User not found”** — invalid or missing `OPENROUTER_API_KEY` in `.env`.

**Calendar empty** — set `GOOGLE_CALENDAR_ICAL_URL` to your public iCal URL (same as local).

## Keeping a local copy

You can run **both**: home LAN on `docker compose` (port 8787) and Hetzner on `docker-compose.hetzner.yml`. Use `sync-to-hetzner.sh` to push config when you change bookmarks or settings.

## Files added for Hetzner

| File | Purpose |
|------|---------|
| `docker-compose.hetzner.yml` | Caddy + dashboard, persistent volumes, no LAN/desktop mounts |
| `deploy/Caddyfile` | TLS + reverse proxy + optional basic auth |
| `deploy/env.hetzner.example` | Production env template |
| `scripts/hetzner-bootstrap.sh` | Docker + UFW on fresh Ubuntu |
| `scripts/sync-to-hetzner.sh` | Rsync from home PC to VPS |
