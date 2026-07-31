# Anthropic BD — Important tagging rules

**Goal:** Surface items that matter for Jay’s Beneficial Deployments job watch without drowning Bay Area Local News or burning cooldown on weak fits.

**Wired in code:**

| Layer | File | Behavior |
|-------|------|----------|
| Taste seeds | `src/data/local-news-bd-criteria-seeds.json` (merged at score time into live criteria) | `lookFor` boosts BD phrases; light `skip` for generic model launches when no lookFor match |
| Heuristic Important | `src/lib/local-news-bd-importance.js` | Sets `important: true` + floors `importance` ≥ 8 |
| LLM rubric | `src/lib/local-news-relevance.js` | Same batch as relevance blurbs; BD hiring/vertical cues score high |
| UI | `public/js/panels/local-news.js` | **Important** badge when `important` or `importance ≥ 8` |

Policy mirrors portfolio strategy (`STRATEGY.md`): wait for Priority-1/2 BD seats; track agri + economic mobility (Shad Ahmed).

---

## Why we’re watching

- Company-wide ~**12-month cooldown** after rejection — only burn on a real fit.
- Domain lane: **Gates agriculture** (setup, May 2026) + **US economic mobility** (more live via Claude for Nonprofits / Claude Corps).

### Priority-1 (Important = hiring signal)

- Applied AI Architect / technical partner (IC) on BD
- Customer Success / Partner Success on BD

### Priority-2

- Partnerships / GTM on **agriculture** or **global development (non-clinical)**

### Do **not** treat as apply-now (may still alert as Class E canary)

- Life Sciences eng-manager (Class E canary if BD Manager eng — watch only)
- Partner Manager, Global Health (clinical/MD) — demote, no canary
- Startup Evangelist / DevRel — demote
- Head of Applied AI Architecture, BD — **Class E canary** (Important, not apply-now)
- Pure research RL / pretraining
- Generic Claude product model launches
- Education-only teacher tooling with no hiring / mobility / agri angle
- Kyle Substack unless it names BD programs / hiring
- Competitor AI news

**IC-wave canaries (Class E):** full list + daily agent prompt → [anthropic-bd-ic-wave-trigger-prompt.md](./anthropic-bd-ic-wave-trigger-prompt.md)

---

## Tag `important: true` when ANY of:

| Code | Signal |
|------|--------|
| **A** | New/open BD job in Priority-1/2 families |
| **B** | New or expanded vertical/topic adjacent to agri, smallholder, economic mobility, rural/energy/climate deployment, field ops in resource-constrained settings |
| **C** | Named implementers/partners in agri or mobility that imply hiring/build-out soon |
| **D** | Leadership posts (Kelly / Younai / Shad) announcing team growth, new segments, or “we’re building X” in those lanes |
| **E** | IC-wave canary (Head/Manager Applied AI Arch or Eng BD; BD GTM leadership; Corps enablement) — Important alert, **do not apply** |

Also boost when BD program keywords appear as **new vertical/expansion**: Claude for Nonprofits, Claude for Teachers *(only with hiring/mobility/agri)*, Claude Corps, Gates partnership, GAILA, Beneficial Deployments, raising the floor.

### Career adjacency keywords (boost)

agriculture, smallholder, economic mobility, rural, energy access, climate resilience, field deployment, public goods, LMIC non-clinical ops, nonprofit forward-deployed, Claude Corps host enablement, skills/workforce infrastructure, underserved deployment.

---

## Normal / not Important

Generic Claude product news · education-only teacher tooling · clinical/global-health-only stories · pure safety research · competitor AI · Kyle personal essays without BD/hiring names.

---

## Taste criteria seeds (shared Local News file)

Appended as newline lines (existing chemistry / Bay Area taste kept):

**lookFor (boost, does not hide non-matches):**

```
Beneficial Deployments
Claude for Nonprofits
Claude Corps
Claude for Teachers
Gates Foundation
economic mobility
smallholder
agriculture
"raising the floor"
GAILA
Anthropic careers
```

**skip (grey — hide only when lookFor is non-empty and no lookFor match):**

```
Claude Opus
Claude Sonnet
open-weights
```

**blacklist:** leave clinical/cancer-style personal skips as-is; do **not** blacklist “global health” globally (would hide useful Gates context). Demote those via Important heuristic instead.

---

## Numeric `importance` (1–10)

- Heuristic Important → floor **8**
- Hard demote (clinical/LS Head/DevRel/pure model) → cap **5** if LLM scored higher
- LLM prompt also asks for BD job-watch weight on Anthropic/BD items (see `SYSTEM` in `local-news-relevance.js`)
