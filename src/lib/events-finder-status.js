/**
 * Events finder — per-source status + ingestion smoke test for Settings.
 * Reachability stays strategy-aware; ingestTest tries a lightweight parse/signal check.
 *
 * Fast path: short timeouts, one outbound fetch per public source (not probe+HTML),
 * skip redundant HTTP for Gmail/Facebook/Telegram, and a short TTL memory cache.
 */
import { probeFacebookEventsIntake } from './events-finder-facebook.js';
import { loadEventsFinderSources } from './events-finder-sources.js';
import {
  normalizeGmailAddress,
  probeGmailMailbox,
} from './events-finder-gmail.js';
import { probeTelegramEventsIntake } from './events-finder-telegram.js';

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 dashbird-events/1.0',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

/** Reachability probe budget (Settings must stay snappy). */
const PROBE_TIMEOUT_MS = 2500;
/** HTML sniff budget for public_pages ingest smoke test. */
const HTML_TIMEOUT_MS = 3500;
/** Serve cached live status this long (ms). */
const STATUS_CACHE_TTL_MS = 90_000;

/** @type {{ at: number, payload: object } | null} */
let statusCache = null;
/** @type {Promise<object> | null} */
let statusInflight = null;

const FETCH_HEADERS_PROBE = {
  ...FETCH_HEADERS,
  Accept: '*/*',
};

/**
 * Probe an external HTTPS URL (same rules as dashboard-check bookmark probes).
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, err?: string }>}
 */
async function probeExternalHttp(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: FETCH_HEADERS_PROBE,
    });
    const reader = r.body?.getReader?.();
    if (reader) {
      try {
        await reader.read();
      } catch {
        /* ignore */
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    const status = r.status;
    const ok =
      (status >= 300 && status < 400) ||
      status === 401 ||
      status === 403 ||
      (status >= 200 && status < 400 && ![404, 410, 429].includes(status));
    return {
      ok: ok && status > 0,
      status,
      err: ok && status > 0 ? undefined : `HTTP ${status}`,
    };
  } catch (e) {
    const msg = e?.cause?.message ? `${e.message}: ${e.cause.message}` : String(e?.message || e);
    return { ok: false, status: 0, err: msg };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch a capped HTML body for ingest smoke tests (follows one redirect hop).
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, finalUrl: string, html: string, err?: string }>}
 */
async function fetchHtmlSnippet(url, timeoutMs = HTML_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let current = url;
    /** @type {Response | null} */
    let r = null;
    for (let hop = 0; hop < 3; hop++) {
      r = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: FETCH_HEADERS,
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) break;
        try {
          current = new URL(loc, current).href;
          continue;
        } catch {
          break;
        }
      }
      break;
    }
    if (!r) {
      return { ok: false, status: 0, finalUrl: current, html: '', err: 'no_response' };
    }
    const status = r.status;
    // Reachable-but-gated still counts as a successful transport for Settings.
    if (status === 401 || status === 403) {
      try {
        r.body?.cancel?.();
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        status,
        finalUrl: current,
        html: '',
        err: `HTTP ${status}`,
        gated: true,
      };
    }
    const ok = status >= 200 && status < 400 && ![404, 410, 429].includes(status);
    if (!ok) {
      try {
        r.body?.cancel?.();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        status,
        finalUrl: current,
        html: '',
        err: `HTTP ${status}`,
      };
    }
    const reader = r.body?.getReader?.();
    const chunks = [];
    let total = 0;
    const maxBytes = 48_000;
    if (reader) {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { ok: true, status, finalUrl: current, html };
  } catch (e) {
    const msg = e?.cause?.message ? `${e.message}: ${e.cause.message}` : String(e?.message || e);
    return { ok: false, status: 0, finalUrl: url, html: '', err: msg };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} html
 */
function scanEventSignals(html) {
  const body = String(html || '');
  const lower = body.toLowerCase();
  const schemaEvents =
    (lower.match(/itemtype=["'][^"']*schema\.org\/event/g) || []).length
    + (lower.match(/"@type"\s*:\s*"event"/g) || []).length
    + (lower.match(/"@type"\s*:\s*\[\s*"[^"]*event/g) || []).length;
  const timeTags = (lower.match(/<time[\s>]/g) || []).length;
  const calendarLinks = (lower.match(/\.ics\b|text\/calendar|webcal:|google\.com\/calendar/g) || [])
    .length;
  const eventWordHits = (lower.match(/\bevents?\b/g) || []).length;
  const loginSignals = (
    lower.match(/\blog[\s-]?in\b|\bsign[\s-]?in\b|\bcreate account\b|\bpassword\b/g) || []
  ).length;
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return { schemaEvents, timeTags, calendarLinks, eventWordHits, loginSignals, title };
}

/**
 * @param {import('./events-finder-sources.js').EventsFinderSource} source
 * @param {{ ok: boolean, status: number, err?: string }} probe
 * @returns {{ active: boolean, value: string, output: string }}
 */
function interpretProbe(source, probe) {
  const httpBit =
    probe.status > 0 ? `HTTP ${probe.status}` : probe.err ? String(probe.err).slice(0, 80) : 'no response';

  if (source.strategy === 'login_walled') {
    if (probe.ok) {
      return {
        active: true,
        value: `Reachable (${httpBit}) · login required for listings`,
        output: 'No anonymous events — wire Graph API / session or paste URLs.',
      };
    }
    return {
      active: false,
      value: `Unreachable (${httpBit})`,
      output: 'Site probe failed; cannot confirm login wall.',
    };
  }

  if (source.strategy === 'official_api') {
    if (source.host === 'mail.google.com') {
      const inbox = normalizeGmailAddress(source.gmailEmail) || 'intake';
      if (probe.ok) {
        return {
          active: true,
          value: `Gmail host up (${httpBit}) · checking OAuth…`,
          output: `Intake inbox ${inbox}`,
        };
      }
      return {
        active: false,
        value: `Gmail host down (${httpBit})`,
        output: 'Cannot reach mail.google.com; OAuth still may work via API.',
      };
    }
    if (source.host === 'facebook.com') {
      if (probe.ok) {
        return {
          active: true,
          value: `Site up (${httpBit}) · checking Apify…`,
          output: 'Public Events via apify/facebook-events-scraper.',
        };
      }
      return {
        active: false,
        value: `Site down (${httpBit})`,
        output: 'facebook.com probe failed; Apify scrape may still work.',
      };
    }
    if (probe.ok) {
      return {
        active: true,
        value: `Site up (${httpBit}) · API not wired yet`,
        output: '0 matches — official API credentials / local search not configured.',
      };
    }
    return {
      active: false,
      value: `Site down (${httpBit})`,
      output: 'Cannot reach host; API search skipped.',
    };
  }

  if (source.strategy === 'public_pages') {
    if (probe.ok) {
      return {
        active: true,
        value: `Reachable (${httpBit}) · public-page ingest wired`,
        output: 'Public listing/watchlist ingest is live (JSON-LD + /e/ + __NEXT_DATA__).',
      };
    }
    return {
      active: false,
      value: `Unreachable (${httpBit})`,
      output: 'Public page probe failed.',
    };
  }

  if (probe.ok) {
    return {
      active: true,
      value: `Reachable (${httpBit})`,
      output: source.outputHint,
    };
  }
  return {
    active: false,
    value: `Unreachable (${httpBit})`,
    output: 'Probe failed.',
  };
}

/**
 * Build ingestTest from an already-fetched HTML snippet (no second network hop).
 * @param {{ ok: boolean, status: number, html: string, err?: string }} page
 */
function ingestFromHtmlPage(page) {
  if (page.gated || page.status === 401 || page.status === 403) {
    return {
      ingestOk: false,
      ingestTest: `Fail — page looks login-gated (HTTP ${page.status})`,
    };
  }
  if (!page.ok) {
    return {
      ingestOk: false,
      ingestTest: `Fail — could not fetch page (${page.err || `HTTP ${page.status}`})`,
    };
  }

  const signals = scanEventSignals(page.html);
  const bits = [];
  if (signals.schemaEvents) bits.push(`${signals.schemaEvents} schema Event`);
  if (signals.timeTags) bits.push(`${signals.timeTags} <time>`);
  if (signals.calendarLinks) bits.push(`${signals.calendarLinks} calendar link`);
  if (signals.eventWordHits >= 3) bits.push(`${signals.eventWordHits} “event” hits`);

  if (bits.length) {
    const titleBit = signals.title ? ` · “${signals.title}”` : '';
    return {
      ingestOk: true,
      ingestTest: `Pass — signals: ${bits.join(', ')}${titleBit}`,
    };
  }

  if (signals.loginSignals >= 3 && signals.eventWordHits < 2) {
    return {
      ingestOk: false,
      ingestTest: `Fail — page looks login-gated (HTTP ${page.status})`,
    };
  }

  if (page.html.length < 400) {
    return {
      ingestOk: false,
      ingestTest: `Fail — empty/thin HTML (${page.html.length} chars, HTTP ${page.status})`,
    };
  }

  return {
    ingestOk: false,
    ingestTest: `Weak — HTML ok (HTTP ${page.status}) but no clear event markers yet`,
  };
}

/**
 * Probe + ingest one Events bookmark source (optimized for Settings latency).
 * @param {import('./events-finder-sources.js').EventsFinderSource} source
 */
async function statusForSource(source) {
  // Dedicated intake probes — no outbound website GET.
  if (source.host === 'mail.google.com') {
    const email = normalizeGmailAddress(source.gmailEmail);
    if (!email) {
      return {
        ...source,
        pending: false,
        active: false,
        value: 'Not wired — missing gmailEmail',
        output: 'Add gmailEmail on the source row.',
        httpStatus: 0,
        ingestOk: null,
        ingestTest: 'Not wired — missing gmailEmail on source row',
      };
    }
    const g = await probeGmailMailbox(email, process.env, { quick: true });
    return {
      ...source,
      pending: false,
      active: g.active,
      value: g.value,
      output: g.output,
      httpStatus: 0,
      ingestOk: g.ingestOk,
      ingestTest: g.ingestTest,
    };
  }

  if (source.host === 'facebook.com') {
    const f = await probeFacebookEventsIntake();
    return {
      ...source,
      pending: false,
      active: f.active,
      value: f.value,
      output: f.output,
      httpStatus: 0,
      ingestOk: f.ingestOk,
      ingestTest: f.ingestTest,
    };
  }

  if (source.host === 't.me' || source.host === 'telegram.org') {
    const t = await probeTelegramEventsIntake();
    return {
      ...source,
      pending: false,
      active: t.active,
      value: t.value,
      output: t.output,
      httpStatus: 0,
      ingestOk: t.ingestOk,
      ingestTest: t.ingestTest,
    };
  }

  if (source.host === 'fetlife.com' || source.strategy === 'login_walled') {
    const probe = await probeExternalHttp(source.url);
    const interpreted = interpretProbe(source, probe);
    return {
      ...source,
      pending: false,
      active: interpreted.active,
      value: interpreted.value,
      output: interpreted.output,
      httpStatus: probe.status,
      ingestOk: probe.ok ? null : false,
      ingestTest: probe.ok
        ? source.host === 'fetlife.com'
          ? 'Deferred — no auto-ingest for now'
          : 'Blocked — login required (expected; no anonymous ingest)'
        : `Fail — host unreachable (${probe.status || probe.err || 'no response'})`,
    };
  }

  if (source.strategy === 'public_pages') {
    // One fetch serves reachability + ingest smoke test (was two sequential hops).
    const page = await fetchHtmlSnippet(source.url);
    const probe = {
      ok: page.ok,
      status: page.status,
      err: page.err,
    };
    const interpreted = interpretProbe(source, probe);
    const ingest = ingestFromHtmlPage(page);
    return {
      ...source,
      pending: false,
      active: interpreted.active,
      value: interpreted.value,
      output: interpreted.output,
      httpStatus: probe.status,
      ingestOk: ingest.ingestOk,
      ingestTest: ingest.ingestTest,
    };
  }

  // Fallback official_api / unknown: cheap reachability only.
  const probe = await probeExternalHttp(source.url);
  const interpreted = interpretProbe(source, probe);
  return {
    ...source,
    pending: false,
    active: interpreted.active,
    value: interpreted.value,
    output: interpreted.output,
    httpStatus: probe.status,
    ingestOk: probe.ok ? null : false,
    ingestTest: probe.ok
      ? 'Not wired — official API key / local search not configured'
      : `Fail — host unreachable (${probe.status || probe.err || 'no response'})`,
  };
}

/**
 * Live status for each Events bookmark source.
 * @param {{ fresh?: boolean }} [opts]
 * @returns {Promise<{
 *   ok: true,
 *   checkedAt: string,
 *   cached?: boolean,
 *   cacheAgeMs?: number,
 *   sources: Array<import('./events-finder-sources.js').EventsFinderSource & {
 *     pending: false,
 *     active: boolean,
 *     value: string,
 *     output: string,
 *     httpStatus: number,
 *     ingestOk: boolean | null,
 *     ingestTest: string,
 *   }>
 * }>}
 */
export async function buildEventsFinderStatus(opts = {}) {
  const fresh = Boolean(opts.fresh);
  const now = Date.now();
  if (!fresh && statusCache && now - statusCache.at < STATUS_CACHE_TTL_MS) {
    return {
      ...statusCache.payload,
      cached: true,
      cacheAgeMs: now - statusCache.at,
    };
  }

  if (!fresh && statusInflight) {
    const payload = await statusInflight;
    return {
      ...payload,
      cached: true,
      cacheAgeMs: statusCache ? Date.now() - statusCache.at : 0,
    };
  }

  statusInflight = (async () => {
    const sources = await loadEventsFinderSources();
    const checkedAt = new Date().toISOString();
    const rows = await Promise.all(sources.map((source) => statusForSource(source)));
    const payload = { ok: true, checkedAt, sources: rows };
    statusCache = { at: Date.now(), payload };
    return payload;
  })();

  try {
    const payload = await statusInflight;
    return { ...payload, cached: false, cacheAgeMs: 0 };
  } finally {
    statusInflight = null;
  }
}
