/**
 * Research + 2-month heads-up cards for user-added big conferences / festivals.
 */
import { searchWeb, normalizeEventPageUrl } from './events-finder-event-url.js';
import { capturePageScreenshot, searchChromeResultUrls } from './chrome-web-search.js';
import {
  loadConferenceWatchlistStore,
  slugFromQuery,
  upsertConferenceWatchlistRecords,
  saveBigEventShot,
} from './events-finder-conference-watchlist-store.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** ~2 months before the event. */
export const CONFERENCE_HEADS_UP_MS = 60 * 24 * 60 * 60 * 1000;
const RESEARCH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 24 * 60 * 60 * 1000;

const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'openai/gpt-4o-mini',
];

const EXTRACT_SYSTEM = `You extract structured facts about a big conference or festival from web page text.
Return JSON only:
{
  "name": string,
  "url": string | null,
  "eventStart": "YYYY-MM-DD" | null,
  "eventEnd": "YYYY-MM-DD" | null,
  "venue": string | null,
  "city": string | null,
  "ticketPrice": string | null,
  "earlyBirdPrice": string | null,
  "earlyBirdStart": "YYYY-MM-DD" | null,
  "earlyBirdEnd": "YYYY-MM-DD" | null,
  "notes": string | null
}
Report facts about the NEXT (upcoming) edition of the event.
Use ISO dates only. ticketPrice is the regular/standard ticket price as a short label like "$299" or "$120–$1,553".
earlyBirdPrice is the cheaper early bird / advance ticket price if one is offered (e.g. "$99"); null if none.
If unsure, use null. Prefer the official event site over aggregators/resellers.`;

/** @type {Set<string>} */
const researchInFlight = new Set();

/** Spacing between web-search queries — keeps Brave under its bot-rate limit. */
const SEARCH_QUERY_DELAY_MS = 700;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeConferenceWatchlist(raw) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/\r?\n/)
      : [];
  for (const item of items) {
    const s = String(item || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 30) break;
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

/**
 * @param {string | null | undefined} ymd
 * @returns {number | null}
 */
function parseYmd(ymd) {
  const s = String(ymd || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T12:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPageText(url) {
  const href = String(url || '').trim();
  if (!href) return '';
  try {
    const r = await fetch(href, {
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return '';
    return htmlToText(await r.text());
  } catch {
    return '';
  }
}

/** Hosts that are never the official conference site. */
const OFFICIAL_NOISE_HOSTS = [
  'wikipedia.org', 'reddit.com', 'youtube.com', 'youtu.be', 'facebook.com',
  'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com',
  'medium.com', 'quora.com', 'tripadvisor.com', 'yelp.com', 'allevents.in',
  '10times.com', 'bizzabo.com', 'eventbrite.com', 'ticketmaster.com',
  'stubhub.com', 'viagogo.com', 'seatgeek.com', 'vividseats.com',
  'crunchbase.com', 'glassdoor.com', 'indeed.com', 'pinterest.com',
];

/**
 * @param {string} host
 * @param {string[]} tokens
 * @returns {number}
 */
function conferenceHostScore(host, tokens) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (!h) return -Infinity;
  for (const n of OFFICIAL_NOISE_HOSTS) {
    if (h === n || h.endsWith(`.${n}`)) return -100;
  }
  let score = 0;
  const hostFlat = h.replace(/[^a-z0-9]/g, '');
  const nameFlat = tokens.join('');
  if (nameFlat && hostFlat.includes(nameFlat)) {
    score += 60;
  } else {
    // Length-weight token matches so a distinctive token ("sauce") counts far
    // more than a common one ("open"); avoids picking openai.com for "open sauce".
    let hitLen = 0;
    let totalLen = 0;
    for (const t of tokens) {
      if (t.length <= 2) continue;
      totalLen += t.length;
      if (hostFlat.includes(t)) hitLen += t.length;
    }
    if (totalLen) score += (hitLen / totalLen) * 40;
  }
  if (/\.(?:com|org|net|io|co|events?|fest|us)$/i.test(h)) score += 4;
  return score;
}

/**
 * Rank search hits and return the most likely official event site.
 * @param {string} query
 * @param {Array<{ url: string, title?: string }>} hits
 * @returns {string | null}
 */
export function pickOfficialSiteUrl(query, hits) {
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let best = null;
  let bestScore = -Infinity;
  for (const hit of hits || []) {
    const url = normalizeEventPageUrl(hit?.url);
    if (!url) continue;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    let score = conferenceHostScore(host, tokens);
    const title = String(hit?.title || '').toLowerCase();
    let thit = 0;
    for (const t of tokens) {
      if (t.length > 2 && title.includes(t)) thit += 1;
    }
    if (tokens.length) score += (thit / tokens.length) * 15;
    try {
      const p = new URL(url).pathname || '/';
      if (/ticket|register|attend|pass/i.test(p)) score += 6;
    } catch {
      /* ignore */
    }
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

/** Ticket / pricing / registration subpage path signals. */
const TICKET_PATH_RE =
  /(?:^|\/)(?:tickets?|ticketing|pricing|prices?|passes|pass|register|registration|admission|attend|rsvp|buy|purchase|checkout|box-?office|order)(?:[/?#]|-|$)/i;

/**
 * Resilient hit fetch for conference research/preview. Headless-Chrome Brave
 * search is the primary source (DuckDuckGo/Yahoo HTML scraping is unreliable and
 * frequently returns zero real results inside the container). Falls back to the
 * HTML scrapers only when Chrome search is disabled or empty.
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
export async function searchConferenceHits(query, env = process.env) {
  const q = String(query || '').trim();
  if (!q) return [];
  /** @type {Array<{ url: string, title: string }>} */
  const out = [];
  const push = (rawUrl, title = '') => {
    const n = normalizeEventPageUrl(rawUrl);
    if (!n) return;
    if (out.some((x) => x.url === n)) return;
    out.push({ url: n, title: String(title || '') });
  };
  try {
    const urls = await searchChromeResultUrls(q, 8, env);
    for (const u of urls) push(u);
  } catch {
    /* fall through to HTML scrapers */
  }
  if (out.length < 3) {
    try {
      const web = await searchWeb(q);
      for (const h of web) push(h.url, h.title);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Common multi-label public suffixes so apex stripping keeps the real domain. */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br',
  'co.jp', 'com.mx', 'co.za', 'com.sg', 'co.in',
]);

/**
 * Registrable apex domain for a host (strip subdomains, keep multi-part TLDs).
 * @param {string} host
 * @returns {string}
 */
function registrableDomain(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * Select BOTH the official homepage root (dates live here) and the best ticketing
 * subpage (ticket/pricing info lives here) from ranked search hits.
 * @param {string} query
 * @param {Array<{ url: string, title?: string }>} hits
 * @returns {{ homepageUrl: string | null, ticketUrl: string | null, officialHost: string | null, confident: boolean }}
 */
export function pickOfficialSitePair(query, hits) {
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const nameFlat = tokens.join('');
  /** @type {Array<{ url: string, u: URL, hostScore: number, score: number }>} */
  const scored = [];
  let best = null;
  let bestScore = -Infinity;
  for (const hit of hits || []) {
    const url = normalizeEventPageUrl(hit?.url);
    if (!url) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const hostScore = conferenceHostScore(u.hostname, tokens);
    let score = hostScore;
    const title = String(hit?.title || '').toLowerCase();
    let thit = 0;
    for (const t of tokens) {
      if (t.length > 2 && title.includes(t)) thit += 1;
    }
    if (tokens.length) score += (thit / tokens.length) * 15;
    scored.push({ url, u, hostScore, score });
    if (score > bestScore) {
      bestScore = score;
      best = { url, u, score };
    }
  }
  if (!best) return { homepageUrl: null, ticketUrl: null, officialHost: null, confident: false };

  // Official domain = registrable apex of the best hit (e.g. profiles.burningman.org
  // and cart.sxsw.com both resolve to burningman.org / sxsw.com). The homepage is
  // the recognizable apex root — dates usually live there — even when search only
  // surfaced a subdomain/subpage.
  const officialHost = registrableDomain(best.u.hostname);
  let homepageUrl = null;
  for (const s of scored) {
    if (registrableDomain(s.u.hostname) !== officialHost) continue;
    const host = s.u.hostname.replace(/^www\./, '').toLowerCase();
    const path = s.u.pathname || '/';
    if (host === officialHost && (path === '/' || path === '')) {
      homepageUrl = `${s.u.origin}/`;
      break;
    }
  }
  if (!homepageUrl) homepageUrl = `https://${officialHost}/`;

  // Ticket URL: prefer a ticket-ish path on the same official domain; otherwise
  // a ticket-ish path on any other plausibly-official host.
  let ticketUrl = null;
  let ticketScore = -Infinity;
  for (const s of scored) {
    const path = s.u.pathname || '/';
    if (!TICKET_PATH_RE.test(`${path}${s.u.search}`)) continue;
    let ts;
    if (registrableDomain(s.u.hostname) === officialHost) ts = 100;
    else if (s.hostScore > 0) ts = 20;
    else continue;
    ts += Math.max(0, 60 - path.length);
    if (ts > ticketScore) {
      ticketScore = ts;
      ticketUrl = s.url;
    }
  }
  if (ticketUrl && ticketUrl.replace(/\/+$/, '') === homepageUrl.replace(/\/+$/, '')) {
    ticketUrl = null;
  }
  // Confident when the official domain actually embeds the flattened event name
  // (e.g. "opensauce" ⊂ opensauce.com) — lets callers stop early on a good hit
  // instead of firing more search queries and tripping engine rate limits.
  const officialFlat = officialHost.replace(/[^a-z0-9]/g, '');
  const confident = Boolean(nameFlat && nameFlat.length >= 4 && officialFlat.includes(nameFlat));
  return { homepageUrl, ticketUrl, officialHost, confident };
}

/**
 * Bare origin root ("https://host/") for any URL. Used to normalize a homepage.
 * @param {string | null | undefined} rawUrl
 * @returns {string | null}
 */
export function homepageRootFromUrl(rawUrl) {
  const n = normalizeEventPageUrl(rawUrl);
  if (!n) return null;
  try {
    return `${new URL(n).origin}/`;
  } catch {
    return null;
  }
}

/**
 * Pull the first $ price (or range) from free text.
 * @param {string} text
 * @returns {string | null}
 */
function extractPriceLabel(text) {
  const m = String(text || '').match(
    /\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*[-–—]\s*\$?\s?\d[\d,]*(?:\.\d{2})?)?/,
  );
  return m ? m[0].replace(/\s+/g, '') : null;
}

/**
 * Search + capture a website snapshot for a Big Event, without committing it to
 * the watchlist. Used by the "Add event → Search" preview step.
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function previewBigEvent(query, env = process.env) {
  const q = String(query || '').trim().slice(0, 120);
  const slug = slugFromQuery(q);
  if (!slug) return { ok: false, error: 'invalid_query' };
  const year = new Date().getFullYear();
  const queries = [
    `${q} official site tickets ${year}`,
    `${q} conference festival official website`,
    `${q} tickets ${year}`,
  ];
  /** @type {Array<{ url: string, title: string }>} */
  const hits = [];
  let pair = { homepageUrl: null, ticketUrl: null, officialHost: null, confident: false };
  for (let i = 0; i < queries.length; i += 1) {
    if (i > 0) await sleep(SEARCH_QUERY_DELAY_MS);
    const batch = await searchConferenceHits(queries[i], env);
    for (const h of batch) {
      if (!hits.some((x) => x.url === h.url)) hits.push(h);
    }
    pair = pickOfficialSitePair(q, hits);
    // Stop as soon as we have a confident official-domain match (avoids extra
    // Brave queries that would trip its rate limit and fall back to weaker engines).
    if (pair.confident) break;
  }

  const homepageUrl =
    pair.homepageUrl || homepageRootFromUrl(pickOfficialSiteUrl(q, hits)) || hits[0]?.url || null;
  const ticketUrl = pair.ticketUrl || null;
  // Snapshot the homepage/main page — it's the recognizable card image.
  const url = homepageUrl;
  let screenshotPath = null;
  if (url) {
    const buf = await capturePageScreenshot(url, {}, env).catch(() => null);
    if (buf) screenshotPath = await saveBigEventShot(slug, buf, env).catch(() => null);
  }
  return { ok: true, slug, query: q, name: q, url, homepageUrl, ticketUrl, screenshotPath };
}

/**
 * @param {string} text
 */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {string} query
 * @param {Array<{ url: string, title: string, text: string }>} pages
 * @param {NodeJS.ProcessEnv} [env]
 */
async function extractWithOpenRouter(query, pages, env = process.env) {
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (!key || !pages.length) return null;

  const model = String(
    env.EVENTS_FINDER_CONFERENCE_MODEL
      || env.OPENROUTER_FREE_TEXT_MODEL
      || env.OPENROUTER_MODEL
      || 'openai/gpt-4o-mini',
  ).trim();
  const models = [model, ...TEXT_FALLBACK_MODELS.filter((m) => m !== model)];

  const payload = {
    query,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.title.slice(0, 200),
      text: p.text.slice(0, 6000),
    })),
  };

  for (const m of models) {
    let r;
    try {
      r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
          'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-events-conference',
        },
        body: JSON.stringify({
          model: m,
          temperature: 0.2,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: JSON.stringify(payload) },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      continue;
    }
    if (!r.ok) continue;
    const j = await r.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(typeof content === 'string' ? content : '');
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

/**
 * Lightweight regex fallback when OpenRouter is unavailable.
 * @param {string} query
 * @param {Array<{ url: string, title: string, text: string }>} pages
 */
function extractHeuristic(query, pages) {
  const blob = pages.map((p) => `${p.title}\n${p.text}`).join('\n');
  /** @type {Record<string, string | null>} */
  const out = {
    name: query,
    url: pages[0]?.url || null,
    eventStart: null,
    eventEnd: null,
    venue: null,
    city: null,
    ticketPrice: null,
    earlyBirdStart: null,
    earlyBirdEnd: null,
    notes: null,
  };

  const price = blob.match(/\$\s?\d[\d,]*(?:\.\d{2})?(?:\s*[-–—]\s*\$\s?\d[\d,]*(?:\.\d{2})?)?/);
  if (price) out.ticketPrice = price[0].replace(/\s+/g, '');

  const earlyBird = blob.match(/early\s+bird[^.\n]{0,120}/i);
  if (earlyBird) out.notes = earlyBird[0].trim().slice(0, 200);

  const isoDates = [...blob.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)]
    .map((m) => {
      const y = m[1];
      const mo = String(m[2]).padStart(2, '0');
      const d = String(m[3]).padStart(2, '0');
      return `${y}-${mo}-${d}`;
    })
    .filter((d, i, arr) => arr.indexOf(d) === i)
    .sort();
  if (isoDates.length) {
    out.eventStart = isoDates[0];
    if (isoDates.length > 1) out.eventEnd = isoDates[isoDates.length - 1];
  }

  const monthDates = [...blob.matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?,?\s+(20\d{2})\b/gi,
  )];
  if (!out.eventStart && monthDates.length) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const m = monthDates[0];
    const monKey = String(m[1]).slice(0, 3).toLowerCase();
    const mon = months[/** @type {keyof typeof months} */ (monKey)];
    if (mon != null) {
      const y = Number(m[4]);
      const d1 = Number(m[2]);
      const start = new Date(Date.UTC(y, mon, d1));
      if (Number.isFinite(start.getTime())) {
        out.eventStart = start.toISOString().slice(0, 10);
        const d2 = m[3] ? Number(m[3]) : null;
        if (d2) {
          const end = new Date(Date.UTC(y, mon, d2));
          if (Number.isFinite(end.getTime())) out.eventEnd = end.toISOString().slice(0, 10);
        }
      }
    }
  }

  return out;
}

/** First non-empty value from a list of candidates. */
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return v;
  }
  return null;
}

/**
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ url?: string, homepageUrl?: string, ticketUrl?: string, screenshotPath?: string }} [opts]
 *   Seed from the Add-event preview.
 */
export async function researchConferenceQuery(query, env = process.env, opts = {}) {
  const q = String(query || '').trim().slice(0, 120);
  const slug = slugFromQuery(q);
  if (!slug) return { ok: false, error: 'invalid_query' };

  if (researchInFlight.has(slug)) return { ok: true, slug, skipped: true };
  researchInFlight.add(slug);
  const nowIso = new Date().toISOString();

  // Preserve any snapshot / user-picked URLs already on the record.
  const existingStore = await loadConferenceWatchlistStore(env);
  const existing = existingStore.bySlug[slug] || {};
  const seedHomepage =
    homepageRootFromUrl(opts.homepageUrl)
    || homepageRootFromUrl(existing.homepageUrl)
    || homepageRootFromUrl(opts.url)
    || homepageRootFromUrl(existing.url)
    || null;
  const seedTicket = normalizeEventPageUrl(opts.ticketUrl) || existing.ticketUrl || null;
  const seedUrl = seedHomepage || normalizeEventPageUrl(opts.url) || existing.url || null;
  let screenshotPath =
    String(opts.screenshotPath || '').trim() || existing.screenshotPath || null;

  await upsertConferenceWatchlistRecords({
    [slug]: {
      ...existing,
      slug,
      query: q,
      name: existing.name || q,
      url: seedUrl,
      homepageUrl: seedHomepage,
      ticketUrl: seedTicket,
      screenshotPath,
      researching: true,
      researchedAt: nowIso,
    },
  }, env);

  try {
    const year = new Date().getFullYear();
    const queries = [
      `${q} official site dates ${year}`,
      `${q} tickets pricing early bird ${year}`,
      `${q} conference festival official website`,
    ];
    /** @type {Array<{ url: string, title: string }>} */
    const hits = [];
    if (seedHomepage) hits.push({ url: seedHomepage, title: q });
    if (seedTicket) hits.push({ url: seedTicket, title: `${q} tickets` });
    // Re-fetch known pages without searching once BOTH URLs are known — dates /
    // price changes show up on the same pages, and this keeps the recurring
    // daily poll well under any bot-rate limit. Still search when the ticket URL
    // hasn't been discovered yet so it can be filled in.
    if (!seedHomepage || !seedTicket) {
      for (let i = 0; i < queries.length; i += 1) {
        if (i > 0) await sleep(SEARCH_QUERY_DELAY_MS);
        const batch = await searchConferenceHits(queries[i], env);
        for (const h of batch) {
          if (!hits.some((x) => x.url === h.url)) hits.push(h);
        }
        if (pickOfficialSitePair(q, hits).confident) break;
      }
    }

    // Resolve BOTH pages: homepage (dates) + ticketing page (price/sales).
    const pair = pickOfficialSitePair(q, hits);
    const homepageUrl = seedHomepage || pair.homepageUrl || hits[0]?.url || null;
    const ticketUrl = seedTicket || pair.ticketUrl || null;

    // Fetch homepage-first, then ticket page, then a couple more hits for redundancy.
    /** @type {Array<{ url: string, title: string, text: string }>} */
    const homePages = [];
    /** @type {Array<{ url: string, title: string, text: string }>} */
    const ticketPages = [];
    if (homepageUrl) {
      const text = await fetchPageText(homepageUrl);
      if (text.length > 120) homePages.push({ url: homepageUrl, title: q, text });
    }
    if (ticketUrl && ticketUrl !== homepageUrl) {
      const text = await fetchPageText(ticketUrl);
      if (text.length > 120) ticketPages.push({ url: ticketUrl, title: `${q} tickets`, text });
    }
    // Backfill from other hits so extraction still has material if a primary
    // page is JS-heavy / empty.
    for (const h of hits) {
      if (homePages.length + ticketPages.length >= 5) break;
      if (h.url === homepageUrl || h.url === ticketUrl) continue;
      const text = await fetchPageText(h.url);
      if (text.length <= 120) continue;
      if (TICKET_PATH_RE.test(h.url) && ticketPages.length < 2) {
        ticketPages.push({ url: h.url, title: h.title || `${q} tickets`, text });
      } else if (homePages.length < 3) {
        homePages.push({ url: h.url, title: h.title || q, text });
      }
    }

    const allPages = [...homePages, ...ticketPages];
    const homeParsed = homePages.length
      ? (await extractWithOpenRouter(q, homePages, env)) || extractHeuristic(q, homePages)
      : null;
    const ticketParsed = ticketPages.length
      ? (await extractWithOpenRouter(q, ticketPages, env)) || extractHeuristic(q, ticketPages)
      : null;

    // Merge across pages: dates/venue prefer the homepage; ticket price / early
    // bird prefer the ticketing page. Fall back either way when one is empty.
    const eventStart = normalizeYmd(firstNonEmpty(homeParsed?.eventStart, ticketParsed?.eventStart));
    const eventEnd = normalizeYmd(firstNonEmpty(homeParsed?.eventEnd, ticketParsed?.eventEnd));
    const venue = String(firstNonEmpty(homeParsed?.venue, ticketParsed?.venue) || '').trim().slice(0, 160) || null;
    const city = String(firstNonEmpty(homeParsed?.city, ticketParsed?.city) || '').trim().slice(0, 80) || null;
    const parsedName = String(firstNonEmpty(homeParsed?.name, ticketParsed?.name) || '').trim().slice(0, 160) || null;
    const notes = String(firstNonEmpty(homeParsed?.notes, ticketParsed?.notes) || '').trim().slice(0, 400) || null;
    const earlyBirdPrice =
      String(firstNonEmpty(ticketParsed?.earlyBirdPrice, homeParsed?.earlyBirdPrice) || '').trim().slice(0, 120) || null;
    const earlyBirdStart = normalizeYmd(firstNonEmpty(ticketParsed?.earlyBirdStart, homeParsed?.earlyBirdStart));
    const earlyBirdEnd = normalizeYmd(firstNonEmpty(ticketParsed?.earlyBirdEnd, homeParsed?.earlyBirdEnd));

    let ticketPrice =
      String(firstNonEmpty(ticketParsed?.ticketPrice, homeParsed?.ticketPrice) || '').trim().slice(0, 120) || null;
    let ticketPriceEstimated = false;
    let estimatedFromYear = null;

    // No announced price for the upcoming edition → estimate from last year's edition.
    if (!ticketPrice) {
      const baseYear = eventStart ? Number(eventStart.slice(0, 4)) : year;
      const priorYear = (Number.isFinite(baseYear) ? baseYear : year) - 1;
      const estHits = await searchConferenceHits(`${q} ${priorYear} ticket price cost`, env);
      /** @type {Array<{ url: string, title: string, text: string }>} */
      const estPages = [];
      for (const h of estHits.slice(0, 4)) {
        const text = await fetchPageText(h.url);
        if (text.length > 120) estPages.push({ url: h.url, title: h.title || q, text });
        if (estPages.length >= 3) break;
      }
      const estAi = estPages.length
        ? await extractWithOpenRouter(`${q} ${priorYear}`, estPages, env)
        : null;
      const estPrice =
        (estAi && String(estAi.ticketPrice || '').trim())
        || extractPriceLabel(estPages.map((p) => p.text).join(' '));
      if (estPrice) {
        ticketPrice = String(estPrice).slice(0, 120);
        ticketPriceEstimated = true;
        estimatedFromYear = priorYear;
      }
    }

    // Never downgrade known-good data to null. Web-search result ordering is
    // non-deterministic (a pass can land on the JS-heavy homepage or a reseller
    // page with no dates/price), so when this pass comes back empty for a field,
    // keep the previously cached value instead of blanking it to "TBD".
    if (!ticketPrice && existing.ticketPrice) {
      ticketPrice = existing.ticketPrice;
      ticketPriceEstimated = existing.ticketPriceEstimated === true;
      estimatedFromYear = existing.estimatedFromYear ?? null;
    }

    // Capture the homepage snapshot (the recognizable card image) if missing.
    const snapUrl = homepageUrl || seedUrl;
    if (!screenshotPath && snapUrl) {
      const buf = await capturePageScreenshot(snapUrl, {}, env).catch(() => null);
      if (buf) screenshotPath = await saveBigEventShot(slug, buf, env).catch(() => null);
    }

    const resolvedHomepage = homepageUrl || seedHomepage || existing.homepageUrl || null;
    const record = {
      slug,
      query: q,
      name: parsedName || existing.name || q,
      url: resolvedHomepage || existing.url || null,
      homepageUrl: resolvedHomepage,
      ticketUrl: ticketUrl || existing.ticketUrl || null,
      eventStart: eventStart || existing.eventStart || null,
      eventEnd: eventEnd || existing.eventEnd || null,
      venue: venue || existing.venue || null,
      city: city || existing.city || null,
      ticketPrice,
      ticketPriceEstimated,
      estimatedFromYear,
      earlyBirdPrice: earlyBirdPrice || existing.earlyBirdPrice || null,
      earlyBirdStart: earlyBirdStart || existing.earlyBirdStart || null,
      earlyBirdEnd: earlyBirdEnd || existing.earlyBirdEnd || null,
      screenshotPath: screenshotPath || existing.screenshotPath || null,
      notes: notes || existing.notes || null,
      researching: false,
      error:
        eventStart || existing.eventStart || ticketPrice || allPages.length ? null : 'no_pages_found',
      researchedAt: nowIso,
    };

    await upsertConferenceWatchlistRecords({ [slug]: record }, env);
    return { ok: true, slug, record };
  } catch (e) {
    await upsertConferenceWatchlistRecords({
      [slug]: {
        ...existing,
        slug,
        query: q,
        name: existing.name || q,
        url: seedUrl,
        homepageUrl: seedHomepage,
        ticketUrl: seedTicket,
        screenshotPath,
        researching: false,
        error: String(e?.message || e || 'research_failed').slice(0, 200),
        researchedAt: nowIso,
      },
    }, env);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    researchInFlight.delete(slug);
  }
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeYmd(raw) {
  const s = String(raw || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isFinite(Date.parse(`${s}T12:00:00Z`)) ? s : null;
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function buildEarlyBirdLine(record, now = new Date()) {
  const t = now.getTime();
  const ebStart = parseYmd(record.earlyBirdStart);
  const ebEnd = parseYmd(record.earlyBirdEnd);
  if (ebStart && t < ebStart) {
    return { kind: 'upcoming', text: `Early bird tickets start ${formatMd(record.earlyBirdStart)}` };
  }
  if (ebStart && ebEnd && t >= ebStart && t < ebEnd) {
    return { kind: 'active', text: `Early bird ends ${formatMd(record.earlyBirdEnd)}` };
  }
  if (ebEnd && t >= ebEnd) {
    return { kind: 'ended', text: record.ticketPrice ? String(record.ticketPrice) : 'Early bird ended' };
  }
  if (record.ticketPrice) {
    return { kind: 'price', text: String(record.ticketPrice) };
  }
  return null;
}

/**
 * Human status for where ticket sales stand for the upcoming edition.
 * @param {object} record
 * @param {Date} [now]
 * @returns {{ text: string, kind: 'pending'|'onsale'|'earlybird'|'soon'|'ended'|'unknown' }}
 */
export function buildTicketSalesStatus(record, now = new Date()) {
  if (record.researching) return { text: 'Checking…', kind: 'pending' };
  const t = now.getTime();
  const DAY = 24 * 60 * 60 * 1000;
  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd) || startMs;
  const ebStart = parseYmd(record.earlyBirdStart);
  const ebEnd = parseYmd(record.earlyBirdEnd);

  if (endMs && t > endMs + DAY) return { text: 'Event passed', kind: 'ended' };
  if (ebStart && t < ebStart) return { text: 'Early bird soon', kind: 'soon' };
  if (ebStart && ebEnd && t >= ebStart && t < ebEnd) {
    return { text: 'Early bird on sale', kind: 'earlybird' };
  }
  // Price only found on last year's edition → this year isn't on sale yet.
  if (record.ticketPriceEstimated) return { text: 'Not on sale yet', kind: 'soon' };
  if (record.ticketPrice) return { text: 'On sale', kind: 'onsale' };
  return { text: 'Unknown', kind: 'unknown' };
}

/**
 * @param {string | null | undefined} ymd
 */
function formatMd(ymd) {
  const ms = parseYmd(ymd);
  if (!ms) return String(ymd || '');
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return String(ymd);
  }
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function isConferenceHeadsUpActive(record, now = new Date()) {
  if (record.researching) return true;
  const t = now.getTime();
  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd) || startMs;
  const leadMs =
    record.reminderLeadDays != null && Number.isFinite(Number(record.reminderLeadDays))
      ? Number(record.reminderLeadDays) * 24 * 60 * 60 * 1000
      : CONFERENCE_HEADS_UP_MS;
  if (startMs) {
    const windowStart = startMs - leadMs;
    const windowEnd = (endMs || startMs) + 24 * 60 * 60 * 1000;
    if (t >= windowStart && t <= windowEnd) return true;
    return false;
  }
  // No event date yet — keep visible while we research / user just added it.
  const researchedAt = Date.parse(String(record.researchedAt || ''));
  if (!Number.isFinite(researchedAt)) return true;
  return t - researchedAt < 14 * 24 * 60 * 60 * 1000;
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function conferenceRecordToHeadsUp(record, now = new Date()) {
  const eb = buildEarlyBirdLine(record, now);
  const startMs = parseYmd(record.eventStart);
  const endMs = parseYmd(record.eventEnd);
  /** @type {string[]} */
  const whenBits = [];
  if (record.eventStart) {
    whenBits.push(
      endMs && endMs !== startMs
        ? `${formatMd(record.eventStart)} – ${formatMd(record.eventEnd)}`
        : formatMd(record.eventStart),
    );
  } else {
    whenBits.push('Dates TBD');
  }
  const placeBits = [record.venue, record.city].filter(Boolean);

  const priceEstimated = record.ticketPriceEstimated === true;
  let ticketLabel = null;
  if (record.ticketPrice) {
    ticketLabel = priceEstimated
      ? `${record.ticketPrice} (estimated from last year)`
      : String(record.ticketPrice);
  }
  let earlyBirdNote = null;
  if (record.earlyBirdPrice) {
    const ebp = String(record.earlyBirdPrice);
    earlyBirdNote =
      record.ticketPrice && ebp !== String(record.ticketPrice)
        ? `Early bird ${ebp} (vs ${record.ticketPrice})`
        : `Early bird ${ebp}`;
  }
  const screenshotUrl = record.screenshotPath
    ? `/api/events-finder/big-events/shot/${encodeURIComponent(record.screenshotPath)}`
    : null;
  const sales = buildTicketSalesStatus(record, now);

  return {
    id: `conference-watch:${record.slug}`,
    slug: record.slug,
    query: record.query,
    title: record.name || record.query,
    url: record.homepageUrl || record.url || '',
    homepageUrl: record.homepageUrl || record.url || null,
    ticketUrl: record.ticketUrl || null,
    start: record.eventStart ? `${record.eventStart}T12:00:00.000Z` : null,
    end: record.eventEnd ? `${record.eventEnd}T12:00:00.000Z` : null,
    venue: record.venue || null,
    city: record.city || null,
    whenLabel: whenBits.join(' · '),
    placeLabel: placeBits.join(' · ') || null,
    ticketPrice: record.ticketPrice || null,
    ticketLabel,
    priceEstimated,
    estimatedFromYear: record.estimatedFromYear || null,
    earlyBirdPrice: record.earlyBirdPrice || null,
    earlyBirdNote,
    earlyBirdStart: record.earlyBirdStart || null,
    earlyBirdEnd: record.earlyBirdEnd || null,
    earlyBirdLine: eb?.text || null,
    earlyBirdKind: eb?.kind || null,
    salesStatus: sales.text,
    salesStatusKind: sales.kind,
    screenshotUrl,
    notes: record.notes || null,
    reminderLeadDays: record.reminderLeadDays ?? null,
    researching: record.researching === true,
    error: record.error || null,
    researchedAt: record.researchedAt || null,
    source: 'conference-watch',
    headsUp: true,
    conferenceWatch: true,
  };
}

/**
 * @param {object} record
 * @param {Date} [now]
 */
export function conferenceRecordToWatchItem(record, now = new Date()) {
  const base = conferenceRecordToHeadsUp(record, now);
  const urlFound = Boolean(String(record.url || '').trim());
  const hasPayload = Boolean(
    record.eventStart || record.ticketPrice || record.notes || record.venue || record.city,
  );
  /** @type {'pending' | 'fetching' | 'fetched' | 'failed'} */
  let dataFetched = 'pending';
  if (record.researching) {
    dataFetched = 'fetching';
  } else if (record.researchedAt) {
    dataFetched = record.error && !hasPayload && !urlFound ? 'failed' : 'fetched';
  }
  return {
    ...base,
    urlFound,
    dataFetched,
    displayActive: isConferenceHeadsUpActive(record, now),
  };
}

/**
 * @param {string[]} watchlist
 * @param {Date} [now]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConferenceHeadsUp(watchlist, now = new Date(), env = process.env) {
  const names = normalizeConferenceWatchlist(watchlist);
  const store = await loadConferenceWatchlistStore(env);
  /** @type {object[]} */
  const items = [];
  /** @type {string[]} */
  const needResearch = [];

  for (const name of names) {
    const slug = slugFromQuery(name);
    const rec = store.bySlug[slug];
    if (!rec) {
      needResearch.push(name);
      items.push(conferenceRecordToWatchItem({
        slug,
        query: name,
        name,
        researching: true,
        researchedAt: null,
      }, now));
      continue;
    }
    items.push(conferenceRecordToWatchItem(rec, now));
    const researchedAt = Date.parse(String(rec.researchedAt || ''));
    const stale = !Number.isFinite(researchedAt) || now.getTime() - researchedAt > RESEARCH_STALE_MS;
    const incomplete = !rec.url || !rec.eventStart;
    const retry = Number.isFinite(researchedAt) && now.getTime() - researchedAt > RETRY_MS;
    if ((stale || (incomplete && retry)) && !rec.researching && !researchInFlight.has(slug)) {
      needResearch.push(name);
    }
  }

  return { items, needResearch, watchlist: names };
}

/**
 * Kick off background research for stale / new watchlist names.
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} [env]
 */
export function scheduleConferenceWatchlistResearch(names, env = process.env) {
  const list = normalizeConferenceWatchlist(names);
  if (!list.length) return;
  setImmediate(() => {
    void (async () => {
      for (const name of list.slice(0, 4)) {
        await researchConferenceQuery(name, env);
      }
    })().catch((e) => {
      console.warn('[conference-watch] research failed:', e?.message || e);
    });
  });
}
