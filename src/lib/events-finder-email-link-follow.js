/**
 * Follow email body links to recover missing event dates/venues.
 * Not limited to a hard-coded platform list — whitelist hosts are preferred,
 * but any public http(s) link that looks like an event page can be tried.
 * Always SSRF-gated via assertPublicHttpUrl.
 */
import { assertPublicHttpUrl, looksLikePublicHttpUrl } from './public-http-url.js';
import {
  isWhitelistedEventPlatformHost,
  rememberEmailPlatformHost,
  sourceKeyForEmailPlatform,
  hostnameFromHref,
} from './events-finder-email-platforms.js';

const SKIP_HOST_RE =
  /(?:^|\.)(?:google(?:apis)?|gstatic|facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|linkedin\.com|cdn\.|doubleclick|googletagmanager|fonts\.)/i;

const SKIP_PATH_RE =
  /unsubscribe|email-preferences|manage-preferences|view-in-browser|privacy|terms|favicon|\/assets\/|\/fonts\/|\.(?:png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|otf|eot)(?:$|\?)/i;

const EVENTISH_PATH_RE =
  /\/(?:e\/|events?\/|invitation|rsvp|tickets?|schedule|wedding|party|meetup|register)/i;

/**
 * @param {string} htmlOrText
 * @returns {string[]}
 */
export function extractFollowableUrls(htmlOrText) {
  const raw = String(htmlOrText || '');
  /** @type {string[]} */
  const found = [];
  const hrefRe = /\b(?:href|src)=["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(raw))) found.push(m[1]);
  const bareRe = /https?:\/\/[^\s"'<>)\]]+/gi;
  while ((m = bareRe.exec(raw))) found.push(m[0]);

  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (let u of found) {
    u = String(u || '')
      .replace(/&amp;/g, '&')
      .replace(/[.,;:!?)]+$/, '')
      .trim();
    if (!looksLikePublicHttpUrl(u)) continue;
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (SKIP_HOST_RE.test(host)) continue;
    if (SKIP_PATH_RE.test(parsed.pathname + parsed.search)) continue;
    if (host === 'mail.google.com' || host === 'w3.org' || host.endsWith('.w3.org')) continue;
      const key = parsed.href.split('#')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed.href.split('#')[0]);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * @param {string} href
 * @returns {number}
 */
export function followableUrlScore(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname || '/';
    let score = 5;
    if (isWhitelistedEventPlatformHost(host)) score += 80;
    if (EVENTISH_PATH_RE.test(path)) score += 40;
    if (path.length > 1 && path !== '/') score += 15;
    if (/mailchi\.mp|list-manage\.com|sendgrid\.net|ct\.sendgrid/i.test(host)) score -= 20;
    if (/track\.|click\.|clicks\./i.test(host)) score += 10; // may unwrap to real event
    if (host.includes('withjoy')) {
      if (/\/assets\/|\/fonts\/|\.woff/i.test(path)) return 0;
      score += 30;
    }
    if (host.includes('fuckupnights')) {
      if (/\/at-work|\/about|\/blog/i.test(path)) return 8;
      score += 25;
    }
    return score;
  } catch {
    return 0;
  }
}

/**
 * Heuristic: host/path looks like it could hide event details.
 * @param {string} href
 */
export function couldBeEventPlatformUrl(href) {
  if (followableUrlScore(href) >= 40) return true;
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (isWhitelistedEventPlatformHost(host)) return true;
    if (EVENTISH_PATH_RE.test(u.pathname || '')) return true;
    // Unknown marketing/site root with a path slug (e.g. /sarah-and-gavan)
    const parts = (u.pathname || '/').split('/').filter(Boolean);
    return parts.length >= 1 && parts[0].length >= 3;
  } catch {
    return false;
  }
}

/**
 * @param {object} event
 * @returns {boolean}
 */
export function eventNeedsLinkFollow(event) {
  const missingStart = !event?.start || !Number.isFinite(Date.parse(event.start));
  const missingPlace = !event?.venue && !event?.city;
  const via = String(event?.raw?.via || '');
  const thin =
    via === 'subject_heuristic'
    || String(event?.url || '').includes('mail.google.com');
  return missingStart || (thin && missingPlace);
}

/**
 * WithJoy card pages bury "SATURDAY, SEPTEMBER 26, 2026" inside escaped JSON.
 * @param {string} html
 * @param {(blob: string) => string | null} guessStartIso
 * @returns {string | null}
 */
export function scrapeWithJoyDateIso(html, guessStartIso) {
  const raw = String(html || '');
  const cues = [];
  const re =
    /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/gi;
  let m;
  while ((m = re.exec(raw))) {
    cues.push(m[0].replace(/\\"/g, '"'));
  }
  // Also escaped unicode-ish payloads sometimes use MONTH D, YYYY without weekday.
  const re2 =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})\b/gi;
  while ((m = re2.exec(raw))) cues.push(m[0]);
  if (!cues.length || typeof guessStartIso !== 'function') return null;
  // Prefer the latest future-looking cue (wedding dates often far out).
  let best = null;
  let bestMs = -Infinity;
  const now = Date.now();
  for (const cue of cues) {
    const iso = guessStartIso(cue);
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) continue;
    if (ms < now - 2 * 86400000) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = iso;
    }
  }
  return best;
}

/**
 * Parse loose dates from raw HTML when JSON-LD is absent (WithJoy-style).
 * @param {string} html
 * @param {(blob: string) => string | null} guessStartIso
 * @returns {{ start: string | null, title: string | null, venue: string | null, city: string | null }}
 */
export function scrapeLooseEventFields(html, guessStartIso) {
  const titleMatch = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = titleMatch
    ? titleMatch[1]
      .replace(/&#x27;/gi, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s*[|\-–].*$/, '')
      .trim()
      .slice(0, 500)
    : null;
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
  let start = typeof guessStartIso === 'function' ? guessStartIso(text) : null;
  if (!start) start = scrapeWithJoyDateIso(html, guessStartIso);
  const venue =
    text.match(/\b(?:at|venue)[:\s]+([A-Z][^.]{3,80})/)?.[1]?.trim()?.slice(0, 200)
    || null;
  const city =
    text.match(
      /\b(San Francisco|Oakland|Berkeley|Emeryville|Alameda|Los Angeles|New York|Brooklyn|Seattle|Portland|Chicago|Austin)\b/i,
    )?.[1] || null;
  if (title && /^(home|joy|with joy|welcome|you.?ve got a card)$/i.test(title)) title = null;
  return { start, title, venue, city };
}

/**
 * @param {object[]} events
 * @param {{
 *   concurrency?: number,
 *   timeoutMs?: number,
 *   maxFetches?: number,
 *   guessStartIso?: (blob: string) => string | null,
 * }} [opts]
 * @returns {Promise<object[]>}
 */
export async function enrichEventsByFollowingLinks(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return list;
  const concurrency = Math.min(Math.max(Number(opts.concurrency) || 2, 1), 4);
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 12000, 2000), 20000);
  const maxFetches = Math.min(Math.max(Number(opts.maxFetches) || 16, 1), 24);
  const guessStartIso = opts.guessStartIso;

  const { fetchNormalizedEventFromUrl, parsePublicEventHtml, fetchHtml } = await import(
    './events-finder-public-pages.js'
  );

  /** @type {Map<string, object | null>} */
  const pageCache = new Map();
  let fetches = 0;

  /**
   * @param {string} href
   * @param {string} source
   */
  async function load(href, source) {
    const key = href.split('#')[0].toLowerCase();
    if (pageCache.has(key)) return pageCache.get(key) ?? null;
    if (fetches >= maxFetches) {
      pageCache.set(key, null);
      return null;
    }
    fetches += 1;
    let safe;
    try {
      safe = await assertPublicHttpUrl(href);
    } catch {
      pageCache.set(key, null);
      return null;
    }
    let page = null;
    try {
      page = await fetchNormalizedEventFromUrl(safe, source, timeoutMs);
    } catch {
      page = null;
    }
    if (!page?.start) {
      try {
        const raw = await fetchHtml(safe, timeoutMs);
        if (raw.ok && raw.html) {
          const parsed = parsePublicEventHtml(raw.html, source, raw.finalUrl || safe);
          const withStart = parsed.find((e) => e?.start);
          if (withStart) page = withStart;
          else {
            const loose = scrapeLooseEventFields(raw.html, guessStartIso);
            if (loose.start || loose.title) {
              page = {
                title: loose.title,
                start: loose.start,
                end: null,
                venue: loose.venue,
                city: loose.city,
                url: raw.finalUrl || safe,
                source,
                raw: { via: 'loose_html_scrape' },
              };
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    pageCache.set(key, page);
    return page;
  }

  const indexes = list
    .map((ev, i) => (eventNeedsLinkFollow(ev) ? i : -1))
    .filter((i) => i >= 0);
  if (!indexes.length) return list;

  const out = list.map((ev) => ev);
  /** @type {object[]} */
  const extras = [];

  for (let i = 0; i < indexes.length; i += concurrency) {
    const batch = indexes.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (idx) => {
        const ev = out[idx];
        const rawUrls = Array.isArray(ev.raw?.urls) ? ev.raw.urls : [];
        const bodyUrls = Array.isArray(ev.raw?.followUrls) ? ev.raw.followUrls : [];
        const candidates = [...new Set([ev.url, ...rawUrls, ...bodyUrls].filter(Boolean))]
          .filter((u) => !String(u).includes('mail.google.com'))
          .filter((u) => couldBeEventPlatformUrl(u) || isWhitelistedEventPlatformHost(u))
          .sort((a, b) => followableUrlScore(b) - followableUrlScore(a))
          .slice(0, 6);
        if (!candidates.length) return;

        for (const href of candidates) {
          const source =
            sourceKeyForEmailPlatform(href)
            || String(ev.source || 'gmail').toLowerCase()
            || 'gmail';
          const page = await load(href, source);
          if (!page) continue;
          if (!page.start && !page.venue && !page.city && !page.title) continue;

          rememberEmailPlatformHost(href, `enriched:${ev.id || 'gmail'}`);

          const via = String(ev?.raw?.via || '');
          const keepSeriesStart =
            via === 'recurring_series' || via === 'series_watch' || via === 'dated_blocks';
          const nextStart = keepSeriesStart && ev.start ? ev.start : (page.start || ev.start);
          // Marketing pages without a real start do not upgrade newsletter noise.
          if (!nextStart && !page.start && /fuckupnights|corporate events/i.test(`${page.title || ''} ${href}`)) {
            continue;
          }
          out[idx] = {
            ...ev,
            title:
              keepSeriesStart
                ? ev.title
                : (page.title && !/^secret party$/i.test(page.title) && !/^corporate events/i.test(page.title)
                  ? page.title
                  : ev.title),
            start: nextStart,
            end: keepSeriesStart ? ev.end : (page.end || ev.end || null),
            venue: page.venue || ev.venue || null,
            location: page.venue || page.location || ev.location || null,
            city: page.city || ev.city || null,
            lat: page.lat ?? ev.lat ?? null,
            lon: page.lon ?? ev.lon ?? null,
            url: (/\/assets\/|\.woff/i.test(String(page.url || href)) ? ev.url : (page.url || href)),
            source: source === 'gmail' ? ev.source : source,
            description: page.description || ev.description || null,
            imageUrl: page.imageUrl || ev.imageUrl || null,
            raw: {
              ...(ev.raw || {}),
              enrich: 'link_follow',
              resolvedUrl: page.url || href,
              followedHost: hostnameFromHref(href),
              schema: page.raw?.schema ?? ev.raw?.schema ?? null,
            },
          };

          // Multi-event pages: emit sibling cards for additional dated rows.
          try {
            const safe = await assertPublicHttpUrl(href);
            const raw = await fetchHtml(safe, timeoutMs);
            if (raw.ok && raw.html) {
              const all = parsePublicEventHtml(raw.html, source, raw.finalUrl || safe);
              const primaryStart = out[idx].start;
              for (let n = 0; n < all.length; n += 1) {
                const row = all[n];
                if (!row?.start || row.start === primaryStart) continue;
                extras.push({
                  ...out[idx],
                  id: `${ev.id}:page:${n}`,
                  title: row.title || out[idx].title,
                  start: row.start,
                  end: row.end || null,
                  venue: row.venue || out[idx].venue,
                  city: row.city || out[idx].city,
                  url: row.url || out[idx].url,
                  raw: {
                    ...(out[idx].raw || {}),
                    via: 'link_follow_series',
                    seriesIndex: n,
                  },
                });
              }
            }
          } catch {
            /* ignore series expansion failures */
          }
          break;
        }
      }),
    );
  }

  return extras.length ? [...out, ...extras] : out;
}
