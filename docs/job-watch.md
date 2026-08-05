# Job Watch — Anthropic careers panel

**Purpose:** Watch STRATEGY-aligned Anthropic roles and assess brand-new postings — in a dedicated left-rail **Job Watch** card, not Local News.

**Strategy source:** portfolio `products/applications/anthropic/STRATEGY.md`  
**Config:** `src/data/job-watch-targets.json`  
**State:** `data/job-watch.json`  
**API:** `GET/POST /api/job-watch`

---

## What moved out of Local News

Feed `anthropic-careers-bd` is stripped from Local News subscriptions on load/save (`stripCareersFeedFromNews`). Anthropic **news** feeds (site HTML + Google News BD) stay in Local News. Careers belong here.

---

## Watched targets (grey → green sparkle)

| Priority | Target | Icon when open |
|----------|--------|----------------|
| 1 | Applied AI Architect (IC), BD | Green sparkle star |
| 1 | Customer / Partner Success, BD | Green sparkle star |
| 2 | Partnerships / GTM — agri or global development | Green sparkle star |
| Watch | Gates agriculture / smallholder | Green sparkle star |
| Watch | Economic mobility / Claude Corps | Green sparkle star |
| Queued | Startup Partnerships Lead | Green sparkle star |

Closed targets show a **grey** hollow circle.

---

## Cadence

- Server scheduler: **every 2 hours** (`startJobWatchScheduler`, `JOB_WATCH_INTERVAL_MS`)
- Startup scan ~25s after listen
- Panel refresh: reads `/api/job-watch` every 5 minutes (triggers scan if snapshot &gt; 2h stale)
- Manual: **Scan now** in the card header / footer

Disable with `JOB_WATCH=0`.

---

## Assessment plan (new postings)

When a job ID appears that was not in the previous snapshot:

1. **Hard-pass** — clinical / Global Health, Life Sciences eng-manager, Evangelist/DevRel, Head of Applied AI Architecture BD, pure research/RL/pretraining → verdict `pass`, no yellow dot.
2. **Watch-target match** — updates the target row to open (green star); not duplicated as a yellow candidate.
3. **IC-wave canary** — BD leadership seats that signal staffing but are do-not-apply → yellow dot, verdict `canary`.
4. **Interest heuristics** — BD / nonprofit / agri / mobility / Architect / Success cues → score 0–10, verdict `maybe` or `burn`.
5. **Location** — SF / NYC / Bay preferred; other offices noted as weaker.
6. **Recommendation prose** — stored on the candidate; shown when the yellow dot is clicked.

### Yellow dot UI

- Unreviewed candidate → yellow glowing dot.
- Click → modal with close-fit (`strong` / `partial` / `weak` / `none`), score, verdict, recommendation, reasons.
- Close marks **reviewed**; Dismiss hides the row.

### First scan

Baselines the full Greenhouse board into `knownJobIds` **without** creating yellow dots. Only jobs that appear on a later scan become candidates.

---

## Related

- Local News BD news monitoring: `docs/anthropic-bd-news-monitoring.md` (news only; careers → this doc)
- IC-wave canary prompt: `docs/anthropic-bd-ic-wave-trigger-prompt.md`
