# Anthropic Beneficial Deployments — news monitoring plan

**Purpose:** Watch BD program launches, partner co-announcements, and hiring signals for Jay’s Anthropic job watch — inside Dashbird **Local News**, not a parallel news system.

**Related:** [anthropic-bd-news-importance.md](./anthropic-bd-news-importance.md) · [anthropic-bd-ic-wave-trigger-prompt.md](./anthropic-bd-ic-wave-trigger-prompt.md) (daily canary / IC-reopen alerts) · watchlist `src/data/local-news-bd-watchlist.json` · feed directory `src/data/local-news-feed-directory.json`

**Constraint:** Prefer RSS and official list/API pages. **No LinkedIn login scraping.**

---

## How items land in Local News

```
Feed directory entry (id, url, optional fetchMode)
        → subscribed in data/local-news.json
        → GET /api/local-news → fetchLocalNewsFeed (RSS | anthropic-news-html | greenhouse-bd-jobs)
        → taste filter (lookFor / skip / blacklist)
        → BD Important heuristic + OpenRouter relevance/importance
        → sidebar Local News panel (Important badge when flagged)
```

| Field | Role |
|--------|------|
| **Dedupe key** | Article `id` = canonical `link` (else `${feedId}:${title}`) |
| **Cadence** | On-demand when the panel/API loads; in-memory feed cache **15 minutes** |
| **Suggestions** | BD feeds sit in the directory with tags `beneficial-deployments` / `anthropic` for “similar” suggestions |

---

## Sources 1–14

| # | Source | Method | Cadence | Automatable? | Dashbird wiring |
|---|--------|--------|---------|--------------|-----------------|
| 1 | [anthropic.com/news](https://www.anthropic.com/news) | **HTML list** (`fetchMode: anthropic-news-html`) — no public RSS | On panel load / 15m cache | Yes | Feed `anthropic-news` |
| 2 | [claude.com/customers](https://claude.com/customers) | Manual HTML spot-check | Weekly | No stable RSS | Watchlist only |
| 3 | Anthropic Academy / Learn | Manual HTML | Monthly + on rumor | No | Watchlist only |
| 4 | Anthropic careers | **Greenhouse JSON** board API, BD title filter | On panel load | Yes | Feed `anthropic-careers-bd` |
| 5 | Anthropic company LinkedIn | Manual (browser) | 2–3×/week | No | Watchlist |
| 6 | Elizabeth Kelly LinkedIn | Manual | 2–3×/week | No | Watchlist |
| 7 | Ariana Younai LinkedIn | Manual | 2–3×/week | No | Watchlist |
| 8 | Shad Ahmed LinkedIn | Manual | 2–3×/week | No | Watchlist |
| 9 | Kyle Munkittrick LinkedIn + Substack | LinkedIn manual; Substack **RSS** | Weekly / on load | Substack yes | Feed `kyle-substack-miracle`; LinkedIn watchlist |
| 10 | Gates Foundation media center | Manual + **Google News RSS** (Anthropic/Gates query) | Weekly / on load | Partial | Feed `anthropic-bd-google-news`; media center watchlist |
| 11 | AFT / Teach For America | Manual; co-announce often mirrored on Anthropic + Google News | On education launch | No clean RSS | Watchlist + Google News feed |
| 12 | GivingTuesday | **RSS** `givingtuesday.org/feed/` | On load | Yes (noisy) | Feed `givingtuesday` — taste/importance filter Claude/Anthropic |
| 13 | CodePath / Social Finance | Manual (Social Finance RSS is a stub) | On Corps news | No | Watchlist |
| 14 | Other partners (IRC, Epilepsy Foundation, MyFriendBen, YMCA, …) | Manual when named in #1/#10 | Event-driven | No | Watchlist `partner-others` |

### Aggregate automated lane

| Feed id | What it catches |
|---------|-----------------|
| `anthropic-bd-google-news` | Google News RSS for Beneficial Deployments / Claude Corps / Claude for Nonprofits / Claude for Teachers / Gates×Anthropic (365d query) — partner press + Anthropic posts that lack RSS |

---

## Poll / fetch details

### `anthropic-news` (HTML)

- **URL:** `https://www.anthropic.com/news`
- **Parse:** Anchor `href="/news/<slug>"` + stripped label text; date from `Mon DD, YYYY`
- **Dedupe:** `https://www.anthropic.com/news/<slug>`
- **Failure mode:** Markup change → empty/partial list; Google News feed is the backup

### `anthropic-careers-bd` (Greenhouse)

- **URL:** `https://boards-api.greenhouse.io/v1/boards/anthropic/jobs` (public board API)
- **Filter:** Titles matching Beneficial Deployments / nonprofit·education GTM·CS·architect / mobility·Corps (see `isBdRelevantJobTitle`)
- **Dedupe:** Greenhouse `absolute_url`
- **Title prefix:** `[Job] …` so taste/importance treat careers as hiring signals

### RSS feeds

- Standard `fetchFeedItems` (RSS 2.0 / Atom)
- **Kyle Substack:** `https://daysofmiracleandwonder.substack.com/feed` (*Days of Miracle & Wonder*)
- **GivingTuesday:** `https://www.givingtuesday.org/feed/`
- **Google News BD:** encoded search RSS (see feed directory `url`)

---

## Manual watch checklist (LinkedIn / partners)

1. Open watchlist URLs in a normal browser session (already logged into LinkedIn if needed).
2. If a post matches Important rules (hiring in Priority-1/2, agri/mobility expansion, Kelly/Younai/Shad “we’re building X”), paste the link into Notes or thumbs-up a related Local News item with a lookFor phrase.
3. Do **not** ask Dashbird to scrape LinkedIn.

Profile URLs for #7–#8 may drift — confirm on LinkedIn search if 404.

---

## Inventory

Settings monitoring inventory includes Local News BD rows via `dashboard-monitoring-sources.js` (`local_news_bd_*`).

## Freshness (new-from-here-on-out)

- **No pull until** `2026-07-31` America/Los_Angeles (`BD_WATCH_START_YMD` in `src/lib/local-news-bd-freshness.js`).
- **After that:** only items with `publishedAt` on the **current local day** (PT) or later. Undated items are dropped.
- Google News BD query uses `when:1d` (not a year backfill).
- Until the watch start day, BD subscriptions stay subscribed but return an empty lane (no network fetch).
