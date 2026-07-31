/**
 * BD Local News freshness — no historical backfill.
 * Watch starts at WATCH_START_YMD (America/Los_Angeles); until then BD feeds
 * are not fetched. After that, only items published on the current local day
 * (or later) are kept.
 */

export const BD_FRESHNESS_TZ = 'America/Los_Angeles';

/** First calendar day (PT) BD feeds may pull. Before this: no fetch, empty BD lane. */
export const BD_WATCH_START_YMD = '2026-07-31';

/**
 * @param {object} feed
 */
export function isBdFeed(feed) {
  const id = String(feed?.id || '');
  const tags = Array.isArray(feed?.tags) ? feed.tags.map(String) : [];
  if (tags.includes('beneficial-deployments') || tags.includes('bd')) return true;
  return (
    id.startsWith('anthropic-')
    || id === 'givingtuesday'
    || id === 'kyle-substack-miracle'
  );
}

/**
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {string} YYYY-MM-DD in timeZone
 */
export function localYmd(now = new Date(), timeZone = BD_FRESHNESS_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * UTC instant for local midnight of ymd in timeZone (best-effort via offset format).
 * @param {string} ymd YYYY-MM-DD
 * @param {string} [timeZone]
 * @returns {number} epoch ms
 */
export function localMidnightUtcMs(ymd, timeZone = BD_FRESHNESS_TZ) {
  const parts = String(ymd || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
  const [y, m, d] = parts;
  // Probe noon UTC on that civil date, read TZ offset, then back out local midnight.
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map = Object.fromEntries(
    fmt.formatToParts(probe).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const offsetRaw = String(map.timeZoneName || 'GMT').replace(/^GMT/, '').replace(/^UTC/, '');
  let offsetMin = 0;
  if (offsetRaw && offsetRaw !== 'GMT') {
    const om = offsetRaw.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (om) {
      const sign = om[1] === '-' ? -1 : 1;
      offsetMin = sign * (Number(om[2]) * 60 + Number(om[3] || 0));
    }
  }
  // local midnight = UTC midnight of ymd minus offset
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60_000;
}

/**
 * @param {Date} [now]
 */
export function bdWatchActive(now = new Date()) {
  return localYmd(now) >= BD_WATCH_START_YMD;
}

/**
 * Earliest publishedAt (ms) allowed for BD items right now.
 * Before watch start: Infinity (nothing allowed). After: start of today PT.
 * @param {Date} [now]
 */
export function bdMinPublishedMs(now = new Date()) {
  if (!bdWatchActive(now)) return Number.POSITIVE_INFINITY;
  return localMidnightUtcMs(localYmd(now));
}

/**
 * @param {object} article
 * @param {number} minMs
 */
export function articleMeetsBdFreshness(article, minMs) {
  if (!Number.isFinite(minMs)) return false;
  if (minMs === Number.POSITIVE_INFINITY) return false;
  const raw = article?.publishedAt;
  if (!raw) return false; // undated = treat as old / unknown — drop
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= minMs;
}

/**
 * @param {Array<object>} articles
 * @param {Date} [now]
 */
export function filterBdArticlesByFreshness(articles, now = new Date()) {
  const minMs = bdMinPublishedMs(now);
  return (Array.isArray(articles) ? articles : []).filter((a) => {
    // Non-BD articles (if any) pass through unchanged.
    if (!isBdFeed({ id: a?.feedId, tags: a?.tags })) return true;
    return articleMeetsBdFreshness(a, minMs);
  });
}
