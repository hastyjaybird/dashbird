/**
 * Resolve a real public event page URL for Telegram/manual invites.
 * Never keep Telegram placeholders (t.me / telegram.org).
 */
// Desktop Chrome UA (Windows). Datacenter IPs + "X11; Linux" get empty/blocked
// SERP pages from DDG/Yahoo; Bing HTML still returns real results with this UA.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TELEGRAM_HOST_RE = /^(?:www\.)?(?:t\.me|telegram\.(?:me|org)|telegram\.dog)$/i;

/** Prefer these hosts when ranking search hits. */
const EVENT_HOST_BONUS = [
  'luma.com',
  'lu.ma',
  'partiful.com',
  'eventbrite.com',
  'meetup.com',
  'facebook.com',
  'panicbooking.com',
  'secretparty.io',
  'dice.fm',
  'posh.vip',
  'ticketmaster.com',
  'axs.com',
];

const AGGREGATOR_PENALTY = [
  'stayhappening.com',
  'allevents.in',
  'eventful.com',
  'bandsintown.com',
  'songkick.com',
  'funcheap.com',
];

/** Secondary ticket markets — never prefer these over a real event page. */
const RESELLER_HOST_RE =
  /(?:^|\.)(?:stubhub|viagogo|seatgeek|vividseats|gametime|tickpick|ticketnetwork)\./i;

/**
 * @param {unknown} url
 * @returns {boolean}
 */
export function isTelegramPlaceholderUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return true;
  if (/^https?:\/\/t\.me\/?$/i.test(raw)) return true;
  try {
    const u = new URL(raw);
    if (TELEGRAM_HOST_RE.test(u.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * @param {unknown} url
 * @returns {string | null}
 */
export function normalizeEventPageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (TELEGRAM_HOST_RE.test(u.hostname)) return null;
    u.hash = '';
    // Drop tracking junk commonly pasted from shares.
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(key)) u.searchParams.delete(key);
    }
    return u.href.replace(/\/$/, '') === `${u.origin}` ? `${u.origin}/` : u.href;
  } catch {
    return null;
  }
}

/**
 * Pull absolute http(s) URLs from free text / OCR-ish captions.
 * Also upgrades bare ticket-host paths seen in browser chrome (panicbooking.com/...).
 * @param {string} text
 * @returns {string[]}
 */
export function extractHttpUrls(text) {
  const raw = String(text || '');
  const found = raw.match(/https?:\/\/[^\s<>"']+/gi) || [];
  /** @type {string[]} */
  const out = [];
  for (const hit of found) {
    const cleaned = hit.replace(/[),.]+$/g, '');
    const n = normalizeEventPageUrl(cleaned);
    if (n && !out.includes(n)) out.push(n);
  }
  const bareRe =
    /\b((?:(?:www\.)?(?:panicbooking|partiful|eventbrite|meetup|luma|lu\.ma|secretparty|dice|posh)\.[a-z.]+)\/[^\s<>"']+)/gi;
  for (const m of raw.matchAll(bareRe)) {
    const n = normalizeEventPageUrl(`https://${m[1].replace(/[),.]+$/g, '')}`);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * @param {string} host
 */
function hostBonus(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (RESELLER_HOST_RE.test(h) || RESELLER_HOST_RE.test(`.${h}`)) return -80;
  for (const b of EVENT_HOST_BONUS) {
    if (h === b || h.endsWith(`.${b}`)) return 50;
  }
  if (/mab|venue|theater|theatre|club|garden/i.test(h)) return 35;
  for (const p of AGGREGATOR_PENALTY) {
    if (h === p || h.endsWith(`.${p}`)) return -15;
  }
  return 0;
}

/**
 * @param {string} title
 * @param {string} hay
 */
function titleOverlapScore(title, hay) {
  const tokens = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (!tokens.length) return 0;
  const h = String(hay || '').toLowerCase();
  let hit = 0;
  for (const t of tokens) {
    if (h.includes(t)) hit += 1;
  }
  return (hit / tokens.length) * 40;
}

/**
 * @param {string} html
 * @returns {Array<{ url: string, title: string }>}
 */
function parseDdgResults(html) {
  /** @type {Array<{ url: string, title: string }>} */
  const results = [];
  const seen = new Set();
  const re = /<a([^>]+)class="[^"]*result__a[^"]*"([^>]*)>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = `${m[1]} ${m[2]}`;
    const title = String(m[3] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    const hrefMatch = attrs.match(/href="([^"]+)"/i);
    if (!hrefMatch) continue;
    let href = hrefMatch[1];
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch {
      /* keep */
    }
    const normalized = normalizeEventPageUrl(href);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push({ url: normalized, title });
    if (results.length >= 12) break;
  }
  if (results.length < 4) {
    for (const m2 of html.matchAll(/uddg=([^&"]+)/gi)) {
      try {
        const normalized = normalizeEventPageUrl(decodeURIComponent(m2[1]));
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        results.push({ url: normalized, title: '' });
        if (results.length >= 12) break;
      } catch {
        /* ignore */
      }
    }
  }
  return results;
}

/**
 * @param {string} query
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
async function searchDuckDuckGo(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!r.ok) return [];
    return parseDdgResults(await r.text());
  } catch {
    return [];
  }
}

/**
 * @param {string} html
 * @returns {Array<{ url: string, title: string }>}
 */
function parseYahooResults(html) {
  /** @type {Array<{ url: string, title: string }>} */
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1];
    try {
      const u = new URL(href);
      if (u.hostname.includes('yahoo.') || u.hostname.includes('bing.')) {
        const ru = u.searchParams.get('RU') || u.searchParams.get('u');
        if (ru) href = decodeURIComponent(ru);
      }
    } catch {
      continue;
    }
    const title = String(m[2] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const normalized = normalizeEventPageUrl(href);
    if (!normalized || seen.has(normalized)) continue;
    let host = '';
    try {
      host = new URL(normalized).hostname;
    } catch {
      continue;
    }
    if (/yahoo\.|bing\.|microsoft\.com/i.test(host)) continue;
    seen.add(normalized);
    results.push({ url: normalized, title });
    if (results.length >= 12) break;
  }
  return results;
}

/**
 * @param {string} query
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
async function searchYahoo(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!r.ok) return [];
    return parseYahooResults(await r.text());
  } catch {
    return [];
  }
}

/**
 * Bing wraps results in /ck/a redirects; destination is base64url in `u`
 * (often prefixed with "a1").
 * @param {string} href
 * @returns {string}
 */
function decodeBingRedirect(href) {
  const s = String(href || '').trim();
  if (!s) return s;
  try {
    const u = new URL(s, 'https://www.bing.com');
    if (!/(^|\.)bing\.com$/i.test(u.hostname)) return s;
    const p = u.searchParams.get('u');
    if (!p) return s;
    let b64 = p.startsWith('a1') ? p.slice(2) : p;
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : s;
  } catch {
    return s;
  }
}

/**
 * Plain-HTTP Bing HTML search — works from datacenter IPs / the slim cloud
 * image where Playwright Chromium is unavailable and DDG/Yahoo often return
 * empty challenge pages.
 * @param {string} query
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
async function searchBingHtml(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-us&cc=US`;
  try {
    const r = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': BROWSER_UA,
      },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!r.ok) return [];
    const html = await r.text();
    if (/captcha|unusual traffic|not a bot/i.test(html) && !/b_algo/i.test(html)) {
      return [];
    }
    /** @type {Array<{ url: string, title: string }>} */
    const results = [];
    const seen = new Set();
    const re = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = decodeBingRedirect(m[1].replace(/&amp;/g, '&'));
      const title = String(m[2] || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      const normalized = normalizeEventPageUrl(href);
      if (!normalized || seen.has(normalized)) continue;
      let host = '';
      try {
        host = new URL(normalized).hostname;
      } catch {
        continue;
      }
      if (/bing\.|microsoft\.com|duckduckgo\.|yahoo\./i.test(host)) continue;
      seen.add(normalized);
      results.push({ url: normalized, title });
      if (results.length >= 12) break;
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * @param {string} query
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
export async function searchWeb(query) {
  // Bing HTML first on purpose: from cloud/VPS, DDG often serves an empty 202
  // challenge page and Yahoo 500s, while Bing still returns real result links.
  const [bing, ddg, yahoo] = await Promise.all([
    searchBingHtml(query),
    searchDuckDuckGo(query),
    searchYahoo(query),
  ]);
  /** @type {Array<{ url: string, title: string }>} */
  const out = [];
  for (const hit of [...bing, ...ddg, ...yahoo]) {
    if (!out.some((x) => x.url === hit.url)) out.push(hit);
  }
  return out;
}

/**
 * @param {{
 *   title?: unknown,
 *   venue?: unknown,
 *   city?: unknown,
 *   start?: unknown,
 *   description?: unknown,
 *   urlHints?: unknown[],
 * }} event
 * @returns {string[]}
 */
function buildSearchQueries(event) {
  const title = String(event.title || '').trim();
  const venue = String(event.venue || '').trim();
  const city = String(event.city || '').trim();
  const start = String(event.start || '').trim();
  const day = start ? start.slice(0, 10) : '';
  /** @type {string[]} */
  const queries = [];
  const push = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s && !queries.includes(s)) queries.push(s);
  };
  if (title && venue) push(`"${title}" ${venue} tickets`);
  if (title && venue && day) push(`"${title}" ${venue} ${day}`);
  if (title && city) push(`"${title}" ${city} event`);
  if (title) push(`"${title}" event tickets`);
  if (title && venue) push(`${title} ${venue} panicbooking OR luma OR partiful OR eventbrite`);
  return queries.slice(0, 4);
}

/**
 * Rank candidates and return the best event page URL.
 * @param {Array<{ url: string, title?: string }>} candidates
 * @param {{ title?: unknown, venue?: unknown }} event
 * @returns {string | null}
 */
export function pickBestEventPageUrl(candidates, event = {}) {
  const title = String(event.title || '').trim();
  const venue = String(event.venue || '').trim().toLowerCase();
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates || []) {
    const url = normalizeEventPageUrl(c?.url);
    if (!url) continue;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    let score = hostBonus(host);
    score += titleOverlapScore(title, `${c.title || ''} ${url}`);
    if (venue && (`${c.title || ''} ${url}`).toLowerCase().includes(venue.split(/\s+/)[0] || venue)) {
      score += 12;
    }
    // Prefer deep event pages over bare homepages.
    try {
      const path = new URL(url).pathname || '/';
      if (path.length > 2) score += 8;
      if (/event|ticket|show|slug/i.test(path)) score += 6;
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

/**
 * Fetch a page and collect outbound ticket/event links (aggregators often deep-link).
 * @param {string} pageUrl
 * @returns {Promise<string[]>}
 */
async function extractOutboundEventLinks(pageUrl) {
  const normalized = normalizeEventPageUrl(pageUrl);
  if (!normalized) return [];
  try {
    const r = await fetch(normalized, {
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!r.ok) return [];
    const html = await r.text();
    /** @type {string[]} */
    const out = [];
    const push = (u) => {
      const n = normalizeEventPageUrl(u);
      if (!n || out.includes(n)) return;
      let host = '';
      try {
        host = new URL(n).hostname;
      } catch {
        return;
      }
      if (RESELLER_HOST_RE.test(host)) return;
      if (hostBonus(host) >= 0 || /ticket|event|show|booking|panic|luma|partiful|meetup|eventbrite|dice/i.test(n)) {
        out.push(n);
      }
    };
    for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      push(m[0].replace(/[),.]+$/g, ''));
      if (out.length >= 20) break;
    }
    // Relative ticket paths on the same host.
    try {
      const base = new URL(normalized);
      for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
        const abs = new URL(m[1], base).href;
        if (/ticket|event|book|slug|show/i.test(abs)) push(abs);
        if (out.length >= 24) break;
      }
    } catch {
      /* ignore */
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Ensure an event has a real public page URL (never Telegram).
 * @param {{
 *   title?: unknown,
 *   venue?: unknown,
 *   city?: unknown,
 *   start?: unknown,
 *   description?: unknown,
 *   url?: unknown,
 * }} event
 * @param {{ urlHints?: unknown[], textHint?: string }} [opts]
 * @returns {Promise<{ url: string | null, via: string, candidates: string[] }>}
 */
export async function resolveEventPageUrl(event, opts = {}) {
  const hints = [
    ...extractHttpUrls(String(opts.textHint || '')),
    ...extractHttpUrls(String(event?.description || '')),
    ...(Array.isArray(opts.urlHints) ? opts.urlHints : []).map((u) => String(u || '')),
    String(event?.url || ''),
  ]
    .map((u) => normalizeEventPageUrl(u))
    .filter(Boolean);

  /** @type {string[]} */
  const uniqueHints = [...new Set(hints)];
  if (uniqueHints.length) {
    const picked = pickBestEventPageUrl(
      uniqueHints.map((url) => ({ url, title: String(event?.title || '') })),
      event,
    );
    if (picked) return { url: picked, via: 'hint', candidates: uniqueHints };
  }

  const queries = buildSearchQueries(event);
  /** @type {Array<{ url: string, title: string }>} */
  const hits = [];
  for (const q of queries) {
    const batch = await searchWeb(q);
    for (const h of batch) {
      if (!hits.some((x) => x.url === h.url)) hits.push(h);
    }
    if (hits.length >= 8) break;
  }

  // Follow aggregator pages for deeper ticket links (Panic Booking, Luma, etc.).
  const follow = hits.slice(0, 4);
  for (const h of follow) {
    const outbound = await extractOutboundEventLinks(h.url);
    for (const u of outbound) {
      if (!hits.some((x) => x.url === u)) hits.push({ url: u, title: h.title || '' });
    }
  }

  const filtered = hits.filter((h) => {
    try {
      return !RESELLER_HOST_RE.test(new URL(h.url).hostname);
    } catch {
      return false;
    }
  });
  const pool = filtered.length ? filtered : hits;
  const picked = pickBestEventPageUrl(pool, event);
  return {
    url: picked,
    via: picked ? 'web_search' : 'none',
    candidates: pool.map((h) => h.url).slice(0, 10),
  };
}
