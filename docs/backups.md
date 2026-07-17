# Dashbird backups

Dashbird keeps two automatic backups of your live data (both on by default while the stack is running):

| Schedule | Output | Scope |
|----------|--------|-------|
| **Daily** — every day 03:15 `America/Los_Angeles` | `data/backups/daily-YYYY-MM-DD.tar.gz` | Full `data/` tree + `public/data/bookmarks-personal.json` + `public/data/notes.md` |
| **Weekly** — Sunday 03:00 same timezone | `data/backups/tools-contacts-YYYY-MM-DD/` | Network CRM (`network.db`, assets) + Tool Library (`tool-library.json`, assets) |

Both update **`public/data/last-backup.txt`**, which feeds the health sidebar via `/api/config`.

Backups are **gitignored** — they live only on disk under `data/backups/`.

## What is protected

**Daily tarball** includes everything under `data/` except `data/backups/` itself:

- SQLite: `network.db`, `events-finder.db`, `telegram-intake.db`, Vikunja DB/files
- JSON settings and caches (events, Gmail, costs, dev notes, etc.)
- Network + tool library assets, Telegram media, OAuth token files

Known SQLite databases are snapshotted with `VACUUM INTO` before tar so the archive gets consistent DB copies even while the app is running.

**Weekly folder** is a lighter, structured restore path focused on CRM + tools (see restore script below).

## Configuration (`.env`)

```bash
# Daily full-data (default on)
# DATA_BACKUP_DAILY=0          # disable
# DATA_BACKUP_DAILY_HOUR=3
# DATA_BACKUP_DAILY_MINUTE=15
# DATA_BACKUP_DAILY_RETAIN=14  # days of daily tarballs

# Weekly tools + contacts (default on)
# DATA_BACKUP_WEEKLY=0
# DATA_BACKUP_WEEKLY_DOW=0     # 0=Sun … 6=Sat
# DATA_BACKUP_WEEKLY_HOUR=3
# DATA_BACKUP_WEEKLY_MINUTE=0
# DATA_BACKUP_WEEKLY_TZ=America/Los_Angeles
# DATA_BACKUP_DIR=data/backups
# DATA_BACKUP_RETAIN=8         # weekly folders
```

Schedulers run inside the Node process (`src/lib/data-backup-schedule.js`), started from `src/server.js` with Docker Compose.

## Restore: weekly tools + contacts

**Stop the stack first** so SQLite is not open during the copy:

```bash
docker compose down
node scripts/restore-tools-contacts-backup.mjs --list
node scripts/restore-tools-contacts-backup.mjs              # latest
node scripts/restore-tools-contacts-backup.mjs 2026-07-12   # specific date
docker compose up -d --build
```

## Restore: daily full tarball

1. **Stop the stack:** `docker compose down`
2. **Pick a backup:** `ls data/backups/daily-*.tar.gz`
3. **Extract** (from repo root; overwrites matching paths under `data/`):

   ```bash
   tar -xzf data/backups/daily-2026-07-16.tar.gz
   ```

   This restores `data/` and any included `public/data/` files.
4. **Start again:** `docker compose up -d --build`

To restore into a clean tree, move aside the current `data/` first:

```bash
docker compose down
mv data data.old.$(date +%Y%m%d)
mkdir -p data
tar -xzf data.old.*/backups/daily-2026-07-16.tar.gz   # adjust path to your backup file
docker compose up -d --build
```

## Cloud VPS (Vultr)

On the public host, use the shell script + cron (separate from the in-app daily job):

```bash
chmod +x /opt/dashbird/scripts/cloud-backup.sh
apt-get install -y sqlite3
mkdir -p /var/backups/dashbird
crontab -e
# 15 3 * * * /opt/dashbird/scripts/cloud-backup.sh >> /var/log/dashbird-backup.log 2>&1
```

See [`deploy-vultr.md`](deploy-vultr.md) for full cloud setup.

## Manual / on-demand backup

While the stack is running you can trigger exports from Node (e.g. in a one-off container shell):

```bash
docker compose exec dashboard node -e "
  import('./src/lib/data-backup-schedule.js').then(m =>
    m.runDailyDataBackup().then(r => console.log(r))
  )
"
```

Or copy the weekly CRM/tools backup:

```bash
docker compose exec dashboard node -e "
  import('./src/lib/data-backup-schedule.js').then(m =>
    m.runToolsContactsBackup().then(r => console.log(r))
  )
"
```

## Offsite copies

Local daily tarballs protect against bad edits and disk failure on one machine. For fire/theft/host loss, periodically copy `data/backups/` (or the whole `data/` tree) to another drive or cloud storage — rsync, `sync-to-cloud.sh`, or your backup tool of choice.

## Related

- Network restore safety: [`.cursor/rules/network-data-safety.mdc`](../.cursor/rules/network-data-safety.mdc)
- Security plan (cloud): [`security-plan.md`](security-plan.md)
- Cloud sync: [`scripts/sync-to-cloud.sh`](../scripts/sync-to-cloud.sh)
