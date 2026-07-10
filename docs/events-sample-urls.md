# Events sample URLs (seed / parse fixtures)

Personal fixtures for P0 ingest. Trim trailing spaces; prefer `https://`.

## Partiful (event pages)

```
https://partiful.com/e/sNG4KUUrbwYskFZtXVUm
https://partiful.com/e/IIlhGomgXdZiH0o64FrT
https://partiful.com/e/rFuJxDXFtkGVUWOq8reK
https://partiful.com/e/hgFB26jigU4DfLaqU3wn
https://partiful.com/e/r6rIrHJEYDzTtfcexyRO
https://partiful.com/e/JqsqeIT0qcfGa6ole785
https://partiful.com/e/DMRUVpMFWsuxbTLn1kHB
```

Checked titles (approx): EBPG July Potluck; Elysian Mothership; Philosophy Slumber Party #31; Re-Animate NYE; Holiday Art Market; Carmen Sandiego at Euclid; NYC Climate Week Decompression.

## Luma (event pages)

```
https://luma.com/4esilsg5
https://luma.com/ghnew59o
```

Titles: AI Philosophy Nights; Create for Good. (`lu.ma/…` redirects to `luma.com/…`.)

## Luma (calendar hubs — from screenshot; need canonical calendar URLs)

Subscribe targets once hub URLs are known:

- Big Brain Lectures - Bay Area
- Frontier Tower SF
- SF Hardware Meetup
- tiat (the intersection of art & technology)

Screenshot: `~/Pictures/Screenshot from 2026-07-09 05-41-03.png`

## Meetup (groups / search)

**Path:** **Gmail first** — set Meetup notification email to `jay.intake.box@gmail.com` (browsing/API discovery is weak). Official API optional later.

| Mode | Intent |
| --- | --- |
| Email intake | Primary — invites / digests / `.ics` via Intake Gmail |
| Location search / pin groups | Optional later once `MEETUP_*` env exists |

**Pin candidates** (need `meetup.com/…` group URLs if we reopen API):

- SF Hardware Meetup (also appears as a Luma hub in the screenshot — confirm which platform to prefer, or both)
- Noisebridge (org name only so far — Meetup group and/or other calendar TBD)

```
# Paste meetup.com group URLs below:
# https://www.meetup.com/<group-slug>/
```

## Eventbrite (public listings — no API key)

Explore via destination URLs (JSON-LD / `__SERVER_DATA__`), e.g.:

```
https://www.eventbrite.com/d/ca--san-francisco/events/
https://www.eventbrite.com/d/ca--san-francisco/science-and-tech--events/
```

Official REST search needs a token and is optional later.

## Other orgs (not wired yet)

- Noisebridge — name only; add site/calendar/Meetup URL when ready.
