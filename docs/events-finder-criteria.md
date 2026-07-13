# Events finder — criteria (edit me)

Single place for taste keywords, feed filters, sample event URLs, and Facebook group pins.
Runtime copy also lives in Settings → Filter criteria (`data/events-finder-criteria.json`).
Keep this doc and Settings in sync when you change taste or pins.

Related: [`events-sources-roadmap.md`](events-sources-roadmap.md), [`events-sample-urls.md`](events-sample-urls.md).
Source scraps: `exampleevents/whitelist.txt`, `exampleevents/fblinks.txt`, `exampleevents/Unsaved Document 1`.

---

## 1. Look for (taste — Settings)

Saved in criteria `lookFor` (one idea per line). Used for ranking and Facebook Apify `searchQueries`.

```
ai
air pusher
anniversary
artificial
athletic playground
birthday
bombay beach
box shop
BRC
burlesque
burningman
campout
circus
climate
climate cocktails
Clothing Swap
comedy
community
crucible
curiosities
dorkbot
earth day
energy
equinox
existential
exploratorium
expo
fail night
fairyland
festival
flea
founder
founder dating
founder meetup
fundraiser
gala
good people
green drinks
guild
hack-a-thons
hands on
interactive
jamie de wolf
makerfare
Makers
market
meltdown
mutant
neotropolis (producers of wasteland)
nerd night
noisebridge
obtainium
obtainium works
oddities
oddity
omni commons
open sauce
optimism
optimist
phage
philosophy
playa
potluck
pride
queer
reggae down the river
retreat
ruckas
science
society
soiled dove
solstice
startup
street fair
sustainability
technology
the institute
thrift
tiat
towne cycles
UN
vaudevere
wasteland weekend
```

## 2. Grey list (taste — Settings)

Saved in criteria `skip`. Hides matching events **only when no Look for (whitelist) line also matches**.

```
anything before 10am
beach clean up
beach cleanups
bowling
certification
concerts
conscious
disco
film festival
Finals
hike
if DJs are the only point of interest
justice
kaiser
marathon
meditation
Reggaeton
Soccer
soul
sound bath
tasting
Watch Party
watercolor
wellness
```

## 2b. Black list (taste — Settings)

Saved in criteria `blacklist`. Always hides matching events, **even when a Look for line also matches**.

```
(empty by default — add hard blocks in Settings → Filter criteria)
```

## 3. Keyword whitelist (from `exampleevents/`)

Source list from `exampleevents/whitelist.txt`. Deduped and appended into **Look for** (Settings) above.

```
ai
air pusher
anniversary
artificial
athletic playground
birthday
bombay beach
box shop
burlesque
burningman
campout
circus
climate
climate cocktails
comedy
community
crucible
curiosities
dorkbot
earth day
equinox
existential
exploratorium
expo
fail night
fairyland
festival
flea
fundraiser
gala
good people
green drinks
guild
interactive
jamie de wolf
makerfare
market
meltdown
mutant
neotropolis (producers of wasteland)
nerd night
noisebridge
obtainium
obtainium works
oddities
oddity
omni commons
open sauce
optimism
phage
playa
potluck
pride
queer
reggae down the river
retreat
ruckas
soiled dove
solstice
street fair
sustainability
the institute
thrift
tiat
towne cycles
UN
vaudevere
wasteland weekend
```

## 4. Feed filters (Settings)

| Field | Current |
| --- | --- |
| Cities | San Francisco, Oakland, Emeryville, Berkeley |
| Max miles | (none) |
| Date from / to | (none) — or pick individual `dates` |
| Individual dates | (none) — toggle days on the calendar |
| Earliest local start | `11:00` |
| Attendance | **in person** (fixed — no UI toggle) |

## 5. Facebook scrape budget (Settings)

| Field | Current |
| --- | --- |
| maxQueries | 6 (default; live criteria may be higher) |
| maxEventsPerQuery | 30 (default; live criteria may be higher) |
| cacheHours | **168** (7 days — matches daily schedule cache reuse) |
| pinnedHosts | **34+ group URLs** from `exampleevents/fblinks.txt` |

Needs: `APIFY_TOKEN` in `.env` (set); optional Gmail intake for invite mail. Per-run spend capped via `FACEBOOK_EVENTS_MAX_CHARGE_USD` (default $3).

---

## 6. Sample event URLs (public — verified reachable)

### Partiful

| URL | Title (approx) |
| --- | --- |
| https://partiful.com/e/sNG4KUUrbwYskFZtXVUm | EBPG July Potluck |
| https://partiful.com/e/IIlhGomgXdZiH0o64FrT | Elysian Mothership |
| https://partiful.com/e/rFuJxDXFtkGVUWOq8reK | Philosophy Slumber Party #31 |
| https://partiful.com/e/hgFB26jigU4DfLaqU3wn | Re-Animate NYE |
| https://partiful.com/e/r6rIrHJEYDzTtfcexyRO | Holiday Art Market |
| https://partiful.com/e/JqsqeIT0qcfGa6ole785 | Carmen Sandiego at Euclid |
| https://partiful.com/e/DMRUVpMFWsuxbTLn1kHB | NYC Climate Week Decompression |

### Luma (calendars + events — wired)

Pin file: [`luma-calendar-pins.md`](luma-calendar-pins.md). Module: `events-finder-luma.js`.

| URL | Title |
| --- | --- |
| https://luma.com/sf | San Francisco discover (city feed) |
| https://luma.com/Big-Brain-SF | Big Brain Lectures - Bay Area |
| https://luma.com/frontiertower | Frontier Tower SF |
| https://luma.com/sf-hardware-meetup | SF Hardware Meetup |
| https://luma.com/tiat | tiat (the intersection of art & technology) |
| https://luma.com/4esilsg5 | AI Philosophy Nights |
| https://luma.com/ghnew59o | Create for Good |

### Meetup (pins TBD)

- SF Hardware Meetup
- Noisebridge

Paste `meetup.com/<slug>/` URLs when ready.

---

## 7. Facebook group pins (from screenshots + `fblinks.txt`)

Paste into Settings → **Pinned Facebook hosts** (one URL per line). Apify uses these as `startUrls`.

Names from your Groups screenshots; URLs from `exampleevents/fblinks.txt`. Slug matches are confident; numeric IDs are best-effort — fix labels if wrong.

| Name (from your Groups) | URL | Notes |
| --- | --- | --- |
| SFBay AcroYoga | https://www.facebook.com/groups/sfbayacro/ | slug match |
| Green Drinks Silicon Valley | https://www.facebook.com/groups/GreenDrinksSiliconValley/ | slug match |
| Children's Fairyland in Oakland, CA | https://www.facebook.com/groups/fairylandoakland/ | slug match |
| Athletic Playground | https://www.facebook.com/groups/athleticplayground/ | slug match |
| East Bay Permaculture | https://www.facebook.com/groups/eastbaypermaculture/ | slug match |
| East Bay Community Space | https://www.facebook.com/groups/eastbaycommunityspace/ | slug match |
| The Golden Guy | https://www.facebook.com/groups/goldenguyalley/ | slug match |
| Bay Area Comedy Network | https://www.facebook.com/groups/bayareacomedynetwork/ | slug match |
| Burner Events | https://www.facebook.com/groups/burnerevents/ | slug match |
| Bay Area Circus | https://www.facebook.com/groups/bayareacircus/ | slug match |
| Burning Man Classifieds (or BAB Classifieds) | https://www.facebook.com/groups/babclassifieds/ | slug match |
| Lightning in a Bottle | https://www.facebook.com/groups/libfestival/ | slug match |
| Bay Area Comedy Showcase | https://www.facebook.com/groups/BAYAREACOMEDYSHOWCASE/ | slug match |
| Oakland Parties, Concerts, Undergrounds and Events | https://www.facebook.com/groups/510events/ | from Jay |
| Brass Tax | https://www.facebook.com/groups/brasstax/ | slug match |
| Everything Immersive | https://www.facebook.com/groups/everythingimmersive/ | slug match |
| San Francisco Burners | https://www.facebook.com/groups/sanfranciscoburners/ | slug match |
| dorkbotSF | https://www.facebook.com/groups/dorkbotsf/ | slug match |
| East Bay Bike Party | https://www.facebook.com/groups/eastbaybikeparty/ | slug match |
| San Francisco Institute of Possibility | https://www.facebook.com/groups/sfiop/ | slug match |
| Burning Man Theme Camps | https://www.facebook.com/groups/1068110536587565/ | prior session candidate |
| (unlabeled — confirm) | https://www.facebook.com/groups/1200317343400926/ | numeric only |
| (unlabeled — confirm) | https://www.facebook.com/groups/1619795184916731/ | numeric only |
| (unlabeled — confirm) | https://www.facebook.com/groups/885109698218583/ | numeric only |
| (unlabeled — confirm) | https://www.facebook.com/groups/1180072779497499/ | numeric only |
| (unlabeled — confirm) | https://www.facebook.com/groups/138155232972461/ | numeric only |
| Burning Man Art Projects | https://www.facebook.com/groups/408645952626168/ | from Jay |
| (unlabeled — confirm) | https://www.facebook.com/groups/698593531630485/ | numeric only |
| Survival Research Labs | https://www.facebook.com/groups/9716795555/ | from Jay |
| (unlabeled — confirm) | https://www.facebook.com/groups/211057618333661/ | numeric only |
| (unlabeled — confirm) | https://www.facebook.com/groups/1135130563921407/ | numeric only |
| Oshan's Event List | https://www.facebook.com/groups/318196436499494/ | from Jay |
| (unlabeled — confirm) | https://www.facebook.com/groups/1693539184298377/ | numeric only |
| (unlabeled — confirm) | https://www.facebook.com/groups/1579904642253145/ | numeric only |
| Nerd Nite San Francisco | https://www.facebook.com/groups/NerdNiteSF/ | public site link |
| Ephemerisle | https://www.facebook.com/groups/notephemerisle/ | from Jay |
| Regenerative Changemakers | https://www.facebook.com/groups/416925721848554/ | from Jay |

### Screenshot groups — complete

High-value event groups from screenshots are pinned and labeled (Ephemerisle, Survival Research Labs, Oshan's Event List, Burning Man Art Projects, Oakland Parties/Concerts/Undergrounds, Regenerative Changemakers, Nerd Nite SF, plus the earlier slug-matched set). No further screenshot URLs outstanding.

---

## 8. Links I cannot see (private / login-walled)

Probed 2026-07-09 without a Facebook session. **Every** Facebook group URL in §7 redirects to login (`login.php`, HTTP 400 “Error”) — no public title or membership visibility from here. Treat the whole FB pin list as **not visible to the agent / anonymous fetch**.

```
https://www.facebook.com/groups/1200317343400926/
https://www.facebook.com/groups/1068110536587565/
https://www.facebook.com/groups/sfbayacro/
https://www.facebook.com/groups/GreenDrinksSiliconValley/
https://www.facebook.com/groups/fairylandoakland/
https://www.facebook.com/groups/athleticplayground/
https://www.facebook.com/groups/1619795184916731/
https://www.facebook.com/groups/885109698218583/
https://www.facebook.com/groups/eastbaypermaculture/
https://www.facebook.com/groups/1180072779497499/
https://www.facebook.com/groups/eastbaycommunityspace/
https://www.facebook.com/groups/goldenguyalley/
https://www.facebook.com/groups/bayareacomedynetwork/
https://www.facebook.com/groups/138155232972461/
https://www.facebook.com/groups/burnerevents/
https://www.facebook.com/groups/408645952626168/
https://www.facebook.com/groups/698593531630485/
https://www.facebook.com/groups/bayareacircus/
https://www.facebook.com/groups/9716795555/
https://www.facebook.com/groups/211057618333661/
https://www.facebook.com/groups/babclassifieds/
https://www.facebook.com/groups/libfestival/
https://www.facebook.com/groups/1135130563921407/
https://www.facebook.com/groups/BAYAREACOMEDYSHOWCASE/
https://www.facebook.com/groups/510events/
https://www.facebook.com/groups/brasstax/
https://www.facebook.com/groups/everythingimmersive/
https://www.facebook.com/groups/sanfranciscoburners/
https://www.facebook.com/groups/318196436499494/
https://www.facebook.com/groups/1693539184298377/
https://www.facebook.com/groups/dorkbotsf/
https://www.facebook.com/groups/eastbaybikeparty/
https://www.facebook.com/groups/1579904642253145/
https://www.facebook.com/groups/sfiop/
```

**Public (reachable without login):** all Partiful + Luma pin URLs in §6 / `luma-calendar-pins.md`.

**Implication for ingest:** anonymous HTML fetch cannot read these groups. Facebook path stays Apify (logged-in actor) + Gmail invites + your pinned hosts in Settings — not open-web scrape.

---

## 9. Apify cost (Facebook Events Scraper)

Actor: [`apify/facebook-events-scraper`](https://apify.com/apify/facebook-events-scraper) — **pay per event** (platform compute included).

| Plan | Per scraped event | Actor start | Notes |
| --- | --- | --- | --- |
| Free (current) | **$0.013** | ~$0.001–$0.006 | $5/mo usage credits |
| Starter (~$29/mo) | ~$0.010 | lower | ~2.9k events from credits |
| Scale / Business | $0.0085 → $0.007 | lower | volume tiers |

**Our budget knobs:** `maxQueries=6`, `maxEventsPerQuery=30` (= Apify `maxEvents`), `cacheHours=168`, `FACEBOOK_EVENTS_MAX_CHARGE_USD=3` (default).

**Schedule:** daily **04:00** `America/Los_Angeles` (server polls once/minute). Env: `FACEBOOK_EVENTS_WEEKLY=1` (default), `FACEBOOK_EVENTS_WEEKLY_HOUR=4`, `FACEBOOK_EVENTS_WEEKLY_TZ=America/Los_Angeles`. Optional `FACEBOOK_EVENTS_WEEKLY_DOW=0..6` restricts to one weekday. Set `FACEBOOK_EVENTS_WEEKLY=0` to disable. Manual: `?refreshFacebook=1`.

Other sources (Gmail, Meetup, Luma, public pages, …) ingest every **2 hours** (`EVENTS_FINDER_INGEST_COOLDOWN_MS=7200000`), paused **02:00–07:00** local (`EVENTS_FINDER_INGEST_QUIET_START_HOUR` / `_END_HOUR`). Facebook’s 4am Apify run is allowed inside that quiet window.

**Measured (2026-07-10):** one live run with 3 search queries + **34 group startUrls**, `maxEvents=15` → **~$1.08** charged; **6** events kept in cache after normalize (feed may show fewer after geo/taste filters).

### Rough monthly estimate (Free plan, weekly schedule ≈ 4–5 runs/mo)

| Scenario | Events billed / run | Cost / run | Cost / month |
| --- | --- | --- | --- |
| Weekly (current pins + search) | ~83 billed → ~6 kept | **~$1.08** | **~$4–$5** (fits Free $5 if nothing else) |
| Light (search only) | ~15–30 | ~$0.20–$0.40 | ~$1–$2 |

**Practical advice:** Weekly + 7-day cache is the intended cadence. Free plan (~$5) can cover ~4 full pin runs/month; leave headroom or trim pins if other Apify usage exists.

---

## 10. How to edit later

1. Change taste / filters / pins in this file **or** Settings (prefer Settings for live feed; mirror here for git history).
2. Pins are already loaded into Settings from `exampleevents/fblinks.txt` (2026-07-09).
3. Force Facebook refresh: `GET /api/events-finder/events?refreshFacebook=1` (needs `APIFY_TOKEN`).
