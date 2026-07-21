/**
 * Research + 2-month heads-up cards for user-added big conferences / festivals.
 */
import { searchWeb, normalizeEventPageUrl } from './events-finder-event-url.js';
import {
  searchChromeResultUrls,
  searchChromeImageResults,
} from './chrome-web-search.js';
import {
  loadConferenceWatchlistStore,
  slugFromQuery,
  upsertConferenceWatchlistRecords,
  saveBigEventFlier,
} from './events-finder-conference-watchlist-store.js';
import { assertPublicHttpUrl } from './public-http-url.js';
import { braveApiEnabled, braveApiWebSearch, braveApiImageSearch } from './brave-search-api.js';

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
  "ticketSalesStart": "YYYY-MM-DD" | null,
  "earlyBirdPrice": string | null,
  "earlyBirdStart": "YYYY-MM-DD" | null,
  "earlyBirdEnd": "YYYY-MM-DD" | null,
  "notes": string | null
}
Report facts about the NEXT (upcoming) edition of the event.
Use ISO dates only. ticketPrice is the regular/standard ticket price as a short label like "$299" or "$120–$1,553".
ticketSalesStart is the date general/standard tickets go on sale for the upcoming edition (null if unknown or already on sale).
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
 * Pull the social-share / preview image a page advertises for itself
 * (og:image, twitter:image, or <link rel="image_src">). This is the event's
 * own promo graphic and makes a far more reliable sidebar card image than a
 * separate poster image-search. Returns an absolute URL resolved against the
 * page, or null.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string | null}
 */
function extractOgImage(html, baseUrl) {
  const h = String(html || '');
  const patterns = [
    /<meta[^>]+(?:property|name)=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image(?::url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m && m[1]) {
      const raw = m[1].trim();
      if (!raw) continue;
      try {
        return new URL(raw, baseUrl).toString();
      } catch {
        /* try next pattern */
      }
    }
  }
  return null;
}

/**
 * @param {string} url
 * @returns {Promise<{ text: string, ogImage: string | null }>}
 */
async function fetchPage(url) {
  const href = String(url || '').trim();
  if (!href) return { text: '', ogImage: null };
  // URLs here are user-pasted (manual add) or scraped from search results —
  // block private/link-local/metadata targets before requesting (SSRF).
  let safeHref;
  try {
    safeHref = await assertPublicHttpUrl(href);
  } catch {
    return { text: '', ogImage: null };
  }
  try {
    const r = await fetch(safeHref, {
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return { text: '', ogImage: null };
    const html = await r.text();
    return { text: htmlToText(html), ogImage: extractOgImage(html, r.url || href) };
  } catch {
    return { text: '', ogImage: null };
  }
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPageText(url) {
  return (await fetchPage(url)).text;
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
    /* fall through to API / HTML scrapers */
  }
  // Brave Search API: reliable from a datacenter IP / the slim cloud image where
  // headless Chrome can't run. Only hit it when the browser path came up short.
  if (out.length < 3 && braveApiEnabled(env)) {
    try {
      const api = await braveApiWebSearch(q, 8, env);
      for (const h of api) push(h.url, h.title);
    } catch {
      /* fall through to HTML scrapers */
    }
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
 * Add whole years to a YYYY-MM-DD date string.
 * @param {string | null | undefined} ymd
 * @param {number} years
 * @returns {string | null}
 */
function addYearsToYmd(ymd, years) {
  const s = String(ymd || '').trim().slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]) + Math.round(years);
  return `${String(y).padStart(4, '0')}-${m[2]}-${m[3]}`;
}

/** How many years to add so a past date lands on/after `nowMs`. */
function yearsUntilFuture(ymd, nowMs) {
  const ms = parseYmd(ymd);
  if (ms == null) return 0;
  if (ms >= nowMs) return 0;
  let add = 1;
  while (add < 25) {
    const rolled = parseYmd(addYearsToYmd(ymd, add));
    if (rolled != null && rolled >= nowMs) return add;
    add += 1;
  }
  return 1;
}

const FLIER_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i;
const MAX_FLIER_BYTES = 6 * 1024 * 1024;

/**
 * Fetch an image URL into a Buffer, returning bytes + extension. Rejects
 * non-images, huge files, and tiny (likely-icon) payloads.
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, ext: string } | null>}
 */
async function fetchImageBuffer(url) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//i.test(href)) return null;
  // The URL comes from image search or a scraped og:image tag (untrusted), so
  // block private/link-local/metadata targets before making the request (SSRF).
  let safeHref;
  try {
    safeHref = await assertPublicHttpUrl(href);
  } catch {
    return null;
  }
  try {
    const r = await fetch(safeHref, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const type = String(r.headers.get('content-type') || '').toLowerCase();
    if (type && !type.startsWith('image/')) return null;
    const ab = await r.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length < 3000 || buffer.length > MAX_FLIER_BYTES) return null;
    let ext = 'jpg';
    if (type.includes('png')) ext = 'png';
    else if (type.includes('webp')) ext = 'webp';
    else if (type.includes('gif')) ext = 'gif';
    else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
    else {
      const m = href.match(FLIER_IMAGE_EXT_RE);
      if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    }
    return { buffer, ext };
  } catch {
    return null;
  }
}

/**
 * Find a flier / promotional graphic for the upcoming edition and download it.
 * @param {string} name
 * @param {number | null} eventYear
 * @param {string} slug
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string | null>} saved flier filename, or null
 */
async function findAndSaveFlier(name, eventYear, slug, env) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const yr = Number.isFinite(Number(eventYear)) ? Number(eventYear) : new Date().getFullYear();
  const queries = [
    `${nm} ${yr} official poster flyer`,
    `${nm} ${yr} lineup poster`,
    `${nm} festival flyer`,
  ];
  for (const q of queries) {
    let hits = [];
    try {
      hits = await searchChromeImageResults(q, 8, {}, env);
    } catch {
      hits = [];
    }
    // Browser image search is empty on the slim cloud image — fall back to the
    // Brave image API (keyless-from-datacenter) so cloud can still grab a flier.
    if (!hits.length && braveApiEnabled(env)) {
      try {
        hits = await braveApiImageSearch(q, 8, env);
      } catch {
        hits = [];
      }
    }
    for (const hit of hits) {
      const img = await fetchImageBuffer(hit.url);
      if (!img) continue;
      const saved = await saveBigEventFlier(slug, img.buffer, img.ext, env).catch(() => null);
      if (saved) return saved;
    }
  }
  return null;
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
 * Search the web for a Big Event's official site (URL only — no snapshot). Used
 * by the "Add event → Search" preview step. In `deep` mode it runs more query
 * variants and inspects more hits so a "search again" can dig deeper when the
 * first pass could not find an official URL.
 * @param {string} query
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ deep?: boolean }} [opts]
 */
export async function previewBigEvent(query, env = process.env, opts = {}) {
  const q = String(query || '').trim().slice(0, 120);
  const slug = slugFromQuery(q);
  if (!slug) return { ok: false, error: 'invalid_query' };
  const deep = opts.deep === true;
  const year = new Date().getFullYear();
  const queries = deep
    ? [
        `${q} official website`,
        `${q} official site tickets ${year}`,
        `${q} ${year} tickets buy passes`,
        `${q} ${year + 1} tickets`,
        `${q} conference festival homepage`,
        `${q} event dates lineup ${year}`,
        `"${q}" official`,
      ]
    : [
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
    // Brave queries that would trip its rate limit and fall back to weaker
    // engines). A deep pass keeps going even when confident, to surface a
    // stronger homepage/ticket pair.
    if (pair.confident && !deep) break;
  }

  const homepageUrl =
    pair.homepageUrl || homepageRootFromUrl(pickOfficialSiteUrl(q, hits)) || hits[0]?.url || null;
  const ticketUrl = pair.ticketUrl || null;
  return {
    ok: true,
    slug,
    query: q,
    name: q,
    url: homepageUrl,
    homepageUrl,
    ticketUrl,
    deep,
    urlFound: Boolean(homepageUrl),
  };
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
 * @param {{ url?: string, homepageUrl?: string, ticketUrl?: string, screenshotPath?: string, force?: boolean }} [opts]
 *   Seed from the Add-event preview. `force` re-researches even a hand-edited
 *   (manualEdit) record, clearing the lock.
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

  // Hand-edited records are locked: auto/daily research must not overwrite the
  // user's corrections. A forced re-research (opts.force) clears the lock.
  if (existing.manualEdit === true && opts.force !== true) {
    researchInFlight.delete(slug);
    return { ok: true, slug, skipped: true, manualEdit: true };
  }
  const seedHomepage =
    homepageRootFromUrl(opts.homepageUrl)
    || homepageRootFromUrl(existing.homepageUrl)
    || homepageRootFromUrl(opts.url)
    || homepageRootFromUrl(existing.url)
    || null;
  const seedTicket = normalizeEventPageUrl(opts.ticketUrl) || existing.ticketUrl || null;
  // The exact URL the user pasted (preserving its path) — a manually-added link
  // may point at a specific event page (Partiful/Luma/etc.) whose facts and
  // og:image live on that page, not the bare domain root.
  const seedExact = normalizeEventPageUrl(opts.url) || null;
  const seedUrl = seedHomepage || seedExact || existing.url || null;
  // A URL was handed to us for THIS call (manual entry or a confirmed preview) —
  // scrape it directly instead of spending web searches to rediscover it.
  const urlProvidedNow = Boolean(
    normalizeEventPageUrl(opts.url) || homepageRootFromUrl(opts.homepageUrl),
  );
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
    if (seedExact && seedExact !== seedHomepage) hits.push({ url: seedExact, title: q });
    if (seedTicket) hits.push({ url: seedTicket, title: `${q} tickets` });
    // Re-fetch known pages without searching once BOTH URLs are known — dates /
    // price changes show up on the same pages, and this keeps the recurring
    // daily poll well under any bot-rate limit. Still search when the ticket URL
    // hasn't been discovered yet so it can be filled in.
    if ((!seedHomepage || !seedTicket) && !urlProvidedNow) {
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
    // Each fetched page advertises its own share graphic (og:image); collect them
    // in fetch order so a reliable event image can back the sidebar card when the
    // separate poster image-search comes up empty. The exact page the user linked
    // (seedExact) is fetched via the backfill loop, so its image is captured too.
    /** @type {string[]} */
    const ogImageCandidates = [];
    const pushOgImage = (src) => {
      const s = String(src || '').trim();
      if (s && !ogImageCandidates.includes(s)) ogImageCandidates.push(s);
    };
    if (homepageUrl) {
      const page = await fetchPage(homepageUrl);
      pushOgImage(page.ogImage);
      if (page.text.length > 120) homePages.push({ url: homepageUrl, title: q, text: page.text });
    }
    if (ticketUrl && ticketUrl !== homepageUrl) {
      const page = await fetchPage(ticketUrl);
      pushOgImage(page.ogImage);
      if (page.text.length > 120) {
        ticketPages.push({ url: ticketUrl, title: `${q} tickets`, text: page.text });
      }
    }
    // Backfill from other hits so extraction still has material if a primary
    // page is JS-heavy / empty.
    for (const h of hits) {
      if (homePages.length + ticketPages.length >= 5) break;
      if (h.url === homepageUrl || h.url === ticketUrl) continue;
      const page = await fetchPage(h.url);
      pushOgImage(page.ogImage);
      if (page.text.length <= 120) continue;
      if (TICKET_PATH_RE.test(h.url) && ticketPages.length < 2) {
        ticketPages.push({ url: h.url, title: h.title || `${q} tickets`, text: page.text });
      } else if (homePages.length < 3) {
        homePages.push({ url: h.url, title: h.title || q, text: page.text });
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
    let ticketSalesStart = normalizeYmd(
      firstNonEmpty(ticketParsed?.ticketSalesStart, homeParsed?.ticketSalesStart),
    );

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

    // Resolve the NEXT edition's dates. If the best dates we found are already in
    // the past, first try a targeted next-year lookup; if that turns up nothing,
    // estimate the next edition as exactly one year after the previous one.
    const nowMs = Date.now();
    let finalStart = eventStart || existing.eventStart || null;
    let finalEnd = eventEnd || existing.eventEnd || null;
    let nextEditionEstimated = false;
    if (finalStart && parseYmd(finalStart) != null && parseYmd(finalStart) < nowMs) {
      const pastYear = Number(finalStart.slice(0, 4));
      const lookupYear = Math.max(pastYear + 1, new Date().getFullYear());
      let nextStart = null;
      let nextEnd = null;
      try {
        const nextHits = await searchConferenceHits(`${q} ${lookupYear} dates`, env);
        /** @type {Array<{ url: string, title: string, text: string }>} */
        const nextPages = [];
        for (const h of nextHits.slice(0, 4)) {
          const text = await fetchPageText(h.url);
          if (text.length > 120) nextPages.push({ url: h.url, title: h.title || q, text });
          if (nextPages.length >= 3) break;
        }
        const nextParsed = nextPages.length
          ? (await extractWithOpenRouter(`${q} ${lookupYear}`, nextPages, env))
            || extractHeuristic(`${q} ${lookupYear}`, nextPages)
          : null;
        const ns = normalizeYmd(nextParsed?.eventStart);
        if (ns && parseYmd(ns) != null && parseYmd(ns) >= nowMs) {
          nextStart = ns;
          nextEnd = normalizeYmd(nextParsed?.eventEnd);
        }
      } catch {
        /* fall through to estimate */
      }
      if (nextStart) {
        finalStart = nextStart;
        finalEnd = nextEnd || null;
      } else {
        // No announced next edition → assume one year (or more) after the last.
        const add = yearsUntilFuture(finalStart, nowMs) || 1;
        finalStart = addYearsToYmd(finalStart, add) || finalStart;
        finalEnd = finalEnd ? addYearsToYmd(finalEnd, add) : null;
        nextEditionEstimated = true;
      }
    }

    // Nail down WHEN tickets go on sale for the upcoming edition — this is what
    // the sidebar status pill shows. Only worth a targeted pass when the primary
    // pages didn't state it AND tickets aren't clearly on sale yet (price only
    // estimated from last year, or no price found). Keep it only if it lands in
    // the future so the pill can show a real "Tickets <date>" instead of the
    // generic "Not on sale yet".
    if (!ticketSalesStart && (ticketPriceEstimated || !ticketPrice)) {
      const salesYear = finalStart ? Number(finalStart.slice(0, 4)) : year;
      try {
        const salesHits = await searchConferenceHits(
          `${q} ${salesYear} when do tickets go on sale date`,
          env,
        );
        /** @type {Array<{ url: string, title: string, text: string }>} */
        const salesPages = [];
        for (const h of salesHits.slice(0, 4)) {
          const text = await fetchPageText(h.url);
          if (text.length > 120) salesPages.push({ url: h.url, title: h.title || q, text });
          if (salesPages.length >= 3) break;
        }
        const salesParsed = salesPages.length
          ? (await extractWithOpenRouter(`${q} ${salesYear}`, salesPages, env))
            || extractHeuristic(`${q} ${salesYear}`, salesPages)
          : null;
        const ss = normalizeYmd(salesParsed?.ticketSalesStart);
        // Only trust a genuinely future date — the point is to say when tickets
        // WILL go on sale. A past/"today" value is almost always a hallucination.
        if (ss && parseYmd(ss) != null && parseYmd(ss) > nowMs) ticketSalesStart = ss;
      } catch {
        /* leave ticketSalesStart null — pill falls back to a generic label */
      }
    }

    // Resolve the sidebar card image. Retry at most daily so polls stay cheap.
    // Prefer the event page's own og:image (its real promo graphic, always the
    // right edition and reliably fetchable), then fall back to a poster
    // image-search when the page advertises no share image.
    let flierPath = existing.flierPath || null;
    let flierCheckedAt = existing.flierCheckedAt || null;
    const flierCheckedMs = Date.parse(String(flierCheckedAt || ''));
    const flierStale =
      !Number.isFinite(flierCheckedMs) || nowMs - flierCheckedMs > RETRY_MS;
    if (!flierPath && flierStale) {
      for (const candidate of ogImageCandidates) {
        const img = await fetchImageBuffer(candidate);
        if (!img) continue;
        const saved = await saveBigEventFlier(slug, img.buffer, img.ext, env).catch(() => null);
        if (saved) {
          flierPath = saved;
          break;
        }
      }
      if (!flierPath) {
        const flierYear = finalStart ? Number(finalStart.slice(0, 4)) : new Date().getFullYear();
        const found = await findAndSaveFlier(parsedName || existing.name || q, flierYear, slug, env);
        if (found) flierPath = found;
      }
      flierCheckedAt = new Date().toISOString();
    }

    const resolvedHomepage = homepageUrl || seedHomepage || existing.homepageUrl || null;
    const record = {
      slug,
      query: q,
      name: parsedName || existing.name || q,
      url: resolvedHomepage || existing.url || null,
      homepageUrl: resolvedHomepage,
      ticketUrl: ticketUrl || existing.ticketUrl || null,
      eventStart: finalStart,
      eventEnd: finalEnd,
      venue: venue || existing.venue || null,
      city: city || existing.city || null,
      ticketPrice,
      ticketPriceEstimated,
      estimatedFromYear,
      earlyBirdPrice: earlyBirdPrice || existing.earlyBirdPrice || null,
      earlyBirdStart: earlyBirdStart || existing.earlyBirdStart || null,
      earlyBirdEnd: earlyBirdEnd || existing.earlyBirdEnd || null,
      ticketSalesStart: ticketSalesStart || existing.ticketSalesStart || null,
      screenshotPath: screenshotPath || existing.screenshotPath || null,
      flierPath,
      flierCheckedAt,
      nextEditionEstimated,
      notes: notes || existing.notes || null,
      researching: false,
      // Preserve user snooze/skip state across background re-research.
      snoozedUntil: existing.snoozedUntil || null,
      skipped: existing.skipped === true,
      error:
        finalStart || ticketPrice || allPages.length ? null : 'no_pages_found',
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

  const salesStart = parseYmd(record.ticketSalesStart);

  if (endMs && t > endMs + DAY) return { text: 'Event passed', kind: 'ended' };
  if (ebStart && t < ebStart) return { text: 'Early bird soon', kind: 'soon' };
  if (ebStart && ebEnd && t >= ebStart && t < ebEnd) {
    return { text: 'Early bird on sale', kind: 'earlybird' };
  }
  // A known future on-sale date → show WHEN tickets go on sale.
  if (salesStart && t < salesStart) {
    return { text: `On sale ${formatMd(record.ticketSalesStart)}`, kind: 'soon' };
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
    const range =
      endMs && endMs !== startMs
        ? `${formatMd(record.eventStart)} – ${formatMd(record.eventEnd)}`
        : formatMd(record.eventStart);
    whenBits.push(record.nextEditionEstimated ? `${range} (est.)` : range);
  } else {
    whenBits.push('Dates TBD');
  }
  const placeBits = [record.venue, record.city].filter(Boolean);

  // "Tickets go on sale …" line for the upcoming edition, when known & future.
  let salesStartLine = null;
  const salesStartMs = parseYmd(record.ticketSalesStart);
  if (salesStartMs && now.getTime() < salesStartMs) {
    salesStartLine = `Tickets on sale ${formatMd(record.ticketSalesStart)}`;
  }

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
  const flierUrl = record.flierPath
    ? `/api/events-finder/big-events/shot/${encodeURIComponent(record.flierPath)}`
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
    // Raw YYYY-MM-DD values for the edit form.
    eventStart: record.eventStart || null,
    eventEnd: record.eventEnd || null,
    manualEdit: record.manualEdit === true,
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
    ticketSalesStart: record.ticketSalesStart || null,
    salesStartLine,
    salesStatus: sales.text,
    salesStatusKind: sales.kind,
    screenshotUrl,
    flierUrl,
    flierImageUrl: flierUrl || screenshotUrl,
    nextEditionEstimated: record.nextEditionEstimated === true,
    notes: record.notes || null,
    reminderLeadDays: record.reminderLeadDays ?? null,
    researching: record.researching === true,
    error: record.error || null,
    researchedAt: record.researchedAt || null,
    snoozedUntil: record.snoozedUntil || null,
    snoozed: Boolean(record.snoozedUntil) && Date.parse(String(record.snoozedUntil)) > now.getTime(),
    skipped: record.skipped === true,
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
    // Hand-edited records are locked — never queue them for auto-research.
    if (
      (stale || (incomplete && retry))
      && !rec.researching
      && !rec.manualEdit
      && !researchInFlight.has(slug)
    ) {
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
