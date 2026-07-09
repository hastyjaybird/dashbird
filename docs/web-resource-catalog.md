# Web Resource Catalog — dashbird scope

Shared **web-resource registry** (favorites, tools, feeds, watched sites). Not a content-ingest pipeline.

## Architecture (all apps)

Two Supabase projects — **not** one per app folder:

| Supabase project | Apps | Stores |
|------------------|------|--------|
| **climate-dash** (existing) | climate-dash | Research: `data_sources`, articles, scrape, … |
| **web-catalog** (new) | **dashbird + portfolio** (shared) | Favorites, tools, feeds, watch status, review queue |

```text
climate-dash/  ──►  Supabase A (research)
dashbird/      ──►  Supabase B (catalog)  ◄──  portfolio/
                      │
                      └── filtered import/export ──► Supabase A
```

Import/export is between the **two databases**, by normalized URL. Dashbird and portfolio share catalog B and filter via memberships / `proficient`.

## Dashbird responsibilities

- Own the catalog schema migrations (in this repo under `supabase/migrations/`)
- UI: tools + favorites + feed URLs + watch status + review queue
- Background: watch poller (~50), alternatives discovery → `review_items`
- Export filtered JSON; optional trusted promote into climate-dash `data_sources`
- Keep local JSON (`data/tool-library.json`, bookmarks) as fallback until Supabase is configured

## Data model (catalog B)

See migrations in `supabase/migrations/`. Core tables:

- `web_resources` — one row per URL; tags, FTS, watch fields, `proficient`, `ingest_candidate`
- `project_memberships` — `dashbird` | `portfolio` | `climate_bridge` + section/sort
- `review_items` — suggested alternatives / sites awaiting approve
- `discovery_jobs` — background find-alternatives / enrich runs

## Interchange format (v1)

```json
{
  "version": 1,
  "exported_at": "ISO",
  "source": "web-catalog",
  "filter": { "tags": ["energy"], "ingest_candidate": true },
  "resources": [
    {
      "url": "https://www.iea.org",
      "title": "IEA",
      "summary": "...",
      "tags": ["energy"],
      "kind_hints": ["site"]
    }
  ]
}
```

CLI: `npm run catalog:export` / `npm run catalog:import` (see `scripts/`).

## Env

```bash
# Optional — when unset, Tool Library stays on local JSON
WEB_CATALOG_SUPABASE_URL=
WEB_CATALOG_SUPABASE_SERVICE_ROLE_KEY=
# Optional promote bridge (server/script only — never browser)
CLIMATE_DASH_SUPABASE_URL=
CLIMATE_DASH_SUPABASE_SERVICE_ROLE_KEY=
```

## Status modes

Per resource: `off` | `updown` | `change` (reachability + optional content fingerprint).

## Dashbird implementation status

Shipped in this repo (works on **local JSON** until Supabase env is set):

- Schema: `supabase/migrations/001_web_catalog.sql`
- Store + interchange: `src/lib/web-catalog-*.js`
- API: `/api/web-catalog` (list/filter, CRUD, export/import, review, jobs, watch, promote)
- Background: watch poller + discovery worker started from `src/server.js`
- Tool Library UI: token search, status chips, Review queue, Export, right-click → background alternatives
- Seed: `npm run catalog:migrate` (tools + bookmarks → catalog)
- Dual-write: new tools also upsert into the catalog

**Next for you:** create the web-catalog Supabase project, apply the migration, set `WEB_CATALOG_SUPABASE_*` in `.env`, re-run `catalog:migrate`.
