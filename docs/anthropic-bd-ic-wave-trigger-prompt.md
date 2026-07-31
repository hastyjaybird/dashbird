# Daily prompt — Anthropic BD IC-wave trigger watch

**Purpose:** Every day, review Anthropic careers for signals that Beneficial Deployments is about to **lift the pause on generalist ICs** (CSM / Partner Success / Applied AI Architect). Surface those as Dashbird **Local News → Important** alerts.

**Cadence:** Daily (or on each Local News refresh; Greenhouse feed already polls via `anthropic-careers-bd`).

**Sources of truth:**
- Greenhouse board API: `https://boards-api.greenhouse.io/v1/boards/anthropic/jobs`
- Careers UI: `https://job-boards.greenhouse.io/anthropic`
- Strategy: portfolio `products/applications/anthropic/STRATEGY.md`
- Importance policy: [anthropic-bd-news-importance.md](./anthropic-bd-news-importance.md)

**Constraint:** Do **not** scrape LinkedIn. Prefer Greenhouse JSON + Anthropic news HTML.

---

## Agent prompt (copy/paste for daily-ops / Cursor agent)

```
You are Dashbird’s Anthropic Beneficial Deployments hiring watch.

Every day:
1. Fetch https://boards-api.greenhouse.io/v1/boards/anthropic/jobs
2. Load the previous snapshot from data/anthropic-bd-jobs-snapshot.json (create if missing).
3. Diff open jobs vs snapshot (by Greenhouse job id / absolute_url).
4. Classify each NEW, REMOVED, or TITLE-CHANGED job using the rules below.
5. Emit Dashbird Local News Important alerts for matches (prefix titles with [Job] or [Job filled]).
6. Write the new snapshot back to data/anthropic-bd-jobs-snapshot.json.

### Alert classes

**CLASS E — IC-wave canary (Important, NOT apply-now)**
Fire when these appear OR disappear (disappear ≈ likely filled → watch for IC reopen within 2–4 weeks):

1. Head of Applied AI Architecture, Beneficial Deployments
2. Manager of Applied AI Architecture (BD / Nonprofits / Partnerships / Global Development / Economic Mobility)
3. Manager, Applied AI Engineering, Beneficial Deployments (any vertical, including Life Sciences)
4. Head of Nonprofits / Head of Partner Success, BD / Head of Customer Success, BD (or equivalent BD GTM leadership)
5. Communications Manager, Beneficial Deployments (weaker — tag Important but note “secondary canary”)

Alert body must say: “IC-wave canary — do not apply; watch for Priority-1 IC reopen.”

**CLASS A — Pause lifted / apply-watch (Important, possible apply-now)**
Fire immediately when NEW open roles match Priority-1/2:

Priority-1:
- Customer Success Manager, Beneficial Deployments (any geo)
- CSM / Customer Success, Scaled Partnerships (BD / nonprofit)
- Partner Success Manager / Partner Success, BD or Global Development (non-clinical)
- Applied AI Architect / Applied AI Engineer / Solutions Architect, Beneficial Deployments (IC, not Head/Manager)

Priority-2:
- Partnerships / GTM roles scoped to agriculture, smallholder, economic mobility, or global development (non-clinical)
- Any JD that names Claude Corps + host success / fellowship enablement / office hours (BD-side)

Alert body must say: “Priority BD IC/GTM seat — review against STRATEGY before applying (12-month cooldown).”

**CLASS IGNORE — track only, never Important apply-now**
- Partner Manager, Global Health (clinical / MD)
- Manager, Applied AI Engineering BD (Life Sciences) as an *apply* target (still Class E canary if new/filled)
- Applied AI Technical Evangelist / Startup DevRel
- Head of Applied AI Architecture as an *apply* target (Class E canary only)
- Pure Research / RL / Pretraining
- Commercial Applied AI Architect with no BD / nonprofit / education / mobility / agri scope
- Claude Corps fellow postings ($85k / early-career)

### Diff rules
- NEW matching Class E or A → Important alert
- REMOVED matching Class E → Important alert titled “[Job filled?] <title>” + “Canary likely filled — check careers daily for CSM / Applied AI Architect BD ICs for 2–4 weeks”
- REMOVED matching Class A → note only (opportunity gone); do not celebrate
- Unchanged → no alert

### Output format per alert
- title: [Job] or [Job filled?] + exact Greenhouse title
- link: absolute_url
- summary: location · Class E or A · one-line why
- important: true
- importantReasons: ["E:ic-wave-canary"] or ["A:priority-role-or-bd-hiring"]
- importance: 8 (Class E) or 9 (Class A Priority-1)

Never recommend applying to Class E. For Class A, remind cooldown + STRATEGY Priority-1 filter.
```

---

## Wired into Dashbird (heuristic layer)

| Layer | Behavior |
|-------|----------|
| Feed `anthropic-careers-bd` | Already pulls Greenhouse + `isBdRelevantJobTitle` |
| `local-news-bd-importance.js` | Class **E** canaries → `important: true` with reason `E:ic-wave-canary` (not demoted as apply-now) |
| `local-news-relevance.js` SYSTEM | LLM also scores canaries 8–9 as wave triggers, not apply-now |
| UI | Local News **Important** badge |

Snapshot diff (`data/anthropic-bd-jobs-snapshot.json`) is optional hardening for “[Job filled?]” alerts; until that file exists, **new** canary/IC postings still alert via the heuristic on each Local News load.

---

## Canary list (quick reference)

| # | Role | Signal |
|---|------|--------|
| 1 | Head of Applied AI Architecture, BD | Strongest — “scale the architect team” |
| 2 | Manager of Applied AI Architecture (BD lanes) | Manager hired → IC reopen |
| 3 | Manager, Applied AI Engineering, BD | Eng manager → IC reopen |
| 4 | Head of Nonprofits / Partner or Customer Success, BD | CSM capacity owner |
| 5a | CSM BD / Scaled Partnerships / Partner Success (non-clinical) | Pause already lifting |
| 5b | Applied AI Architect/Engineer/SA, BD (IC) | Pause already lifting |
| 6 | Claude Corps host success / enablement / office hours | Corps ops capacity |
| 7 | Communications Manager, BD | Secondary |

---

## Jay actions when alert fires

| Alert | Action |
|-------|--------|
| Class E new or filled | Do **not** apply. Watch careers daily 2–4 weeks for Class A. |
| Class A Priority-1 | Open STRATEGY.md; if JD is real fit → prepare packet / referral; one burnout only. |
| Class A Priority-2 agri/mobility | Same, only if JD is non-clinical field partnerships. |
