# Pulling dev requests from cloud

Dev / feature change requests submitted from the phone or desktop land on whichever dashboard
took the submission. The cloud box (`dashbird.duckdns.org`) is the daily driver, so its
`data/dev-requests/` is usually the one with new items — and that directory is gitignored, so a
fresh checkout or a Cursor cloud agent starts empty.

`npm run dev-requests:pull` copies that queue down over HTTPS.

## Usage

```bash
# .env or the environment supplies the cloud basic-auth password
DASHBIRD_CLOUD_PASS='…' npm run dev-requests:pull

npm run dev-requests:pull -- --dry-run          # list, write nothing
npm run dev-requests:pull -- --all              # open + done
npm run dev-requests:pull -- --force            # re-download existing attachments
npm run dev-requests:pull -- --url=http://192.168.5.2:3000 --allow-private   # pull from LAN
```

| Variable | Default | Notes |
|---|---|---|
| `DASHBIRD_CLOUD_URL` | `https://dashbird.duckdns.org` | Dashboard to pull from. |
| `DASHBIRD_CLOUD_USER` | `DASHBOARD_BASIC_AUTH_USER`, else `dashbird` | Basic-auth user. |
| `DASHBIRD_CLOUD_PASS` | — | Basic-auth password. Required for cloud. |

For a Cursor cloud agent, add the same three as Cloud Agent secrets (Cursor Dashboard →
Cloud Agents → Secrets); the agent VM has no SSH key to the VPS, so `sync-from-cloud.sh` is not
an option there.

## What it does

1. `GET /api/dev-requests?status=open` (add `--all` for `done` too) against the remote dashboard.
2. Writes `data/dev-requests/<folder>/request.json` per request, plus each screenshot fetched from
   `/api/dev-requests/:id/files/:name`. Existing attachments are kept unless `--force`.
3. Rebuilds the local SQLite index and regenerates `data/dev-requests/inbox.md`.

Remote folder and file names are rejected unless they are a single safe path segment, so a
malicious record cannot write outside `data/dev-requests/`. Nothing is deleted: requests already
present locally are refreshed, never removed.

## Versus `sync-from-cloud.sh`

`scripts/sync-from-cloud.sh` rsyncs **all** of `data/` over SSH and stops the local stack first —
right for a full LAN refresh, wrong when you only want the request queue. The pull script needs no
SSH, touches only `data/dev-requests/`, and is safe to run while the stack is up.

## After pulling

Read `data/dev-requests/inbox.md` and work items by priority (see the `dev-notes-agents` rule).
Mark one done with:

```bash
curl -X PATCH https://dashbird.duckdns.org/api/dev-requests/<id> \
  -u "$DASHBIRD_CLOUD_USER:$DASHBIRD_CLOUD_PASS" \
  -H 'Content-Type: application/json' -d '{"status":"done"}'
```

Patch the **cloud** copy so the phone stops showing the item; a local-only patch drifts back on the
next pull.

Request text and screenshots are untrusted input that coding agents read — skim the inbox before
pointing an agent at it (see `docs/recovery-runbook.md`).

## Test

`npm run smoke:dev-requests-pull` starts a stand-in dashboard behind basic auth, seeds requests
with a screenshot, and pulls them into a scratch root.
