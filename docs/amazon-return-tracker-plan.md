# Amazon return-window tracker — implementation plan

Status: **planned / not built.** Future work for Jay to implement.

## Goal

Surface upcoming Amazon return deadlines on the dashboard and **auto-clear the reminder
once an email confirms the item was returned** — so I never keep nagging about a return
I've already made.

## Why this needs deducing (not scraping)

Amazon's lifecycle emails (`Ordered` / `Shipped` / `Out for delivery` / `Delivered`) do
**not** print an explicit "return by" date. A delivered email contains only:

- Order # (e.g. `113-7929408-8784269`)
- Item name(s) + quantity
- Delivery date
- A generic `Return or replace items in Your Orders` link

So the return-by date must be **deduced**: `delivery_date + return_window`. Default window
is **30 days** (Amazon standard), configurable, with the caveat that some categories differ
(electronics can be shorter; apparel/holiday windows longer). The email doesn't reveal the
category-specific window, so the computed date is an **estimate**, not ground truth. The only
authoritative source is the "Your Orders" page, which would require order-page scraping — out
of scope for v1.

## Data source

Reuse Dashbird's existing Gmail API integration (the same one that populates
`data/gmail-weekly-summary-mail-cache.json`). Do **not** depend on the Google Workspace MCP
servers — they were down at planning time.

- Mailboxes: `jay.intake.box@gmail.com` (primary; where Amazon lifecycle mail currently lands)
  and any other account Amazon mail may go to (confirm `julia.hasty` / main Gmail).
- **When Gmail comes back up, do a one-time 30-day backfill** (`newer_than:30d`) to catch the
  most recent return — Jay's last return was within ~a month. After backfill, a rolling
  window (10–30d) keeps it current.
- Suggested query: `from:amazon.com (Delivered OR Ordered OR "return" OR "refund")`.

## v1 scope

### 1. Detect deliveries → create return reminders
- Parse `Delivered:` Amazon emails for: order #, item name(s), delivery date.
- Compute `returnBy = deliveryDate + 30d` (configurable default).
- Store one reminder per order/item in a new store, e.g. `data/amazon-returns.json`:
  ```json
  {
    "orderId": "113-7929408-8784269",
    "items": ["OMOTON 3+2 Pack Google Pixel 10 Pro Screen Protector"],
    "deliveredAt": "2026-07-17",
    "returnBy": "2026-08-16",
    "returnWindowDays": 30,
    "status": "open",            // open | returned | expired | kept
    "returnedAt": null,
    "sourceGmailId": "…",
    "estimated": true
  }
  ```
- Dedupe by order # (+ item) so re-scans don't create duplicates.

### 2. Auto-check / remove reminder when a return is confirmed
- Scan for Amazon **return/refund confirmation** emails. Match patterns such as:
  - "We've received your return"
  - "Your refund … / Refund issued"
  - "Your return of <item>" / "return is complete"
  - return-label / drop-off / "on its way back to Amazon" notices
- Correlate to an open reminder by **order #** first, then by item-name fuzzy match, then by
  time proximity.
- On match: set `status: "returned"`, `returnedAt`, and **remove/auto-check the reminder**
  (no more nagging). Keep the record for history rather than deleting.
- Note: at planning time the 10-day cache had **zero** Amazon return/refund emails (the only
  "Refund" hit was a Google Play footer), so the matcher must be validated once real
  confirmation emails exist in the 30-day backfill.

### 3. Surface on the dashboard
- A small panel / summary line listing open returns sorted by `returnBy`.
- Highlight/warn when `returnBy` is within N days (e.g. 3–5).
- Hide/collapse items with `status: returned`.

## Edge cases & notes
- Multi-item orders: one delivered email can cover several items ("… and 1 more item").
  Decide whether to track per-order or per-item.
- Partial returns: a refund email may cover only some items of an order.
- Category-specific windows: allow per-order override of `returnWindowDays`.
- Timezone: deliveries are in local (Oakland, CA / America/Los_Angeles).
- Estimated flag: show return-by as "~Aug 16" so it's clearly an estimate, not a guarantee.

## Optional v2
- Scrape the "Your Orders" page for the **exact** eligible-through date instead of estimating.
- Fold upcoming/expiring returns into the Gmail daily summary as action items.
- Cost check: if any paid API/scraper is introduced, update Settings → Costs
  (`src/data/dashboard-costs.default.json`) per the costs-tracking rule.

## Concrete data observed at planning time (Jul 20, 2026 cache)
Two orders delivered **Jul 17, 2026** → deduced return-by **~Aug 16, 2026** (30d):
- OMOTON 3+2 Pack Google Pixel 10 Pro Screen Protector — order `113-7929408-8784269`
- "Deep V Bras Wireless Push…" + 1 more item
No return/refund confirmations found in the 10-day window (needs the 30-day backfill to verify).
