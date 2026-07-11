# Calendar ICS pins (Partiful sync, Google Calendar, etc.)

Paste one ICS / webcal URL per line under **Pins**. Pulled into the Events
sidebar on each feed load (cached ~1h).

## Partiful

Partiful account → calendar subscribe link, e.g.:

```
webcal://calendars.partiful.com/getCalendar?id=…
```

(`webcal://` is normalized to `https://` on fetch.)

## Google Calendar (optional)

1. Open [Google Calendar](https://calendar.google.com) as the account that syncs invites.
2. Calendar ⋮ → **Settings and sharing** → **Integrate calendar**.
3. Copy **Secret address in iCal format**.

```
https://calendar.google.com/calendar/ical/.../private-.../basic.ics | Random Events
```

On **Skip** in the Events bar, Dashbird keeps the event out of the feed.
Deleting the matching Google Calendar row still needs Calendar edit access
(OAuth) — until that is connected, remove it once in Google Calendar UI.

---

## Pins

<!-- one ICS / webcal URL per line -->

webcal://calendars.partiful.com/getCalendar?id=0b607b07-151d-4880-b4cd-d502ab9fbb0d | Partiful
