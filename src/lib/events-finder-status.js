/**
 * Events finder — per-source status + ingestion smoke test for Settings.
 * Reachability stays strategy-aware; ingestTest tries a lightweight parse/signal check.
 */
import { probeFacebookEventsIntake } from './events-finder-facebook.js';
import { loadEventsFinderSources } from './events-finder-sources.js';
import {
  gmailIntakeAddress,
  probeGmailEventsIntake,
} from './events-finder-gmail.js';

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

/**
 * Probe an external HTTPS URL (same rules as dashboard-check bookmark probes).
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, err?: string }>}
 */
async function probeExternalHttp(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: FETCH_HEADERS,
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
 * @returns {Promise<{ ok: boolean, status: number, finalUrl: string, html: string, err?: string }>}
 */
async function fetchHtmlSnippet(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 14_000);
  try {
    let current = url;
    /** @type {Response | null} */
    let r = null;
    for (let hop = 0; hop < 3; hop += 1) {
      r = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: FETCH_HEADERS,
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) break;
        current = new URL(loc, current).href;
        continue;
      }
      break;
    }
    if (!r) {
      return { ok: false, status: 0, finalUrl: url, html: '', err: 'no response' };
    }
    const status = r.status;
    if (status === 401 || status === 403) {
      return { ok: false, status, finalUrl: current, html: '', err: `HTTP ${status}` };
    }
    if (!(status >= 200 && status < 300)) {
      return { ok: false, status, finalUrl: current, html: '', err: `HTTP ${status}` };
    }
    const raw = await r.text();
    const html = String(raw || '').slice(0, 180_000);
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
 * @returns {{
 *   title: string,
 *   schemaEvents: number,
 *   timeTags: number,
 *   eventWordHits: number,
 *   calendarLinks: number,
 *   loginSignals: number,
 * }}
 */
function scanEventSignals(html) {
  const lower = html.toLowerCase();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '';

  const schemaEvents = (lower.match(/itemtype=["'][^"']*schema\.org\/event/g) || []).length
    + (lower.match(/"@type"\s*:\s*"event"/g) || []).length
    + (lower.match(/"@type"\s*:\s*\[\s*"[^"]*event/g) || []).length;

  const timeTags = (lower.match(/<time[\s>]/g) || []).length;
  const eventWordHits = (lower.match(/\bevents?\b/g) || []).length;
  const calendarLinks = (lower.match(/\.ics\b|text\/calendar|webcal:|google\.com\/calendar/g) || [])
    .length;
  const loginSignals = (
    lower.match(/\blog[\s-]?in\b|\bsign[\s-]?in\b|\bcreate account\b|\bpassword\b/g) || []
  ).length;

  return { title, schemaEvents, timeTags, eventWordHits, calendarLinks, loginSignals };
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
      // Filled by Gmail probe in buildEventsFinderStatus — placeholders only.
      if (probe.ok) {
        return {
          active: true,
          value: `Gmail host up (${httpBit}) · checking OAuth…`,
          output: `Intake inbox ${gmailIntakeAddress()}`,
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
        value: `Reachable (${httpBit}) · page ingest pending`,
        output: '0 public events parsed — page/calendar ingest not implemented yet.',
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
 * Strategy-aware ingestion smoke test (not full feed ingest).
 * @param {import('./events-finder-sources.js').EventsFinderSource} source
 * @param {{ ok: boolean, status: number, err?: string }} probe
 * @returns {Promise<{ ingestOk: boolean | null, ingestTest: string }>}
 */
async function runIngestionTest(source, probe) {
  if (source.host === 'fetlife.com') {
    if (!probe.ok) {
      return {
        ingestOk: false,
        ingestTest: `Fail — host unreachable (${probe.status || probe.err || 'no response'})`,
      };
    }
    return {
      ingestOk: null,
      ingestTest: 'Deferred — no auto-ingest for now',
    };
  }

  if (source.strategy === 'login_walled') {
    if (!probe.ok) {
      return {
        ingestOk: false,
        ingestTest: `Fail — host unreachable (${probe.status || probe.err || 'no response'})`,
      };
    }
    return {
      ingestOk: null,
      ingestTest: 'Blocked — login required (expected; no anonymous ingest)',
    };
  }

  if (source.strategy === 'official_api') {
    if (source.host === 'mail.google.com') {
      const g = await probeGmailEventsIntake();
      return {
        ingestOk: g.ingestOk,
        ingestTest: g.ingestTest,
        _gmailProbe: g,
      };
    }
    if (source.host === 'facebook.com') {
      const f = await probeFacebookEventsIntake();
      return {
        ingestOk: f.ingestOk,
        ingestTest: f.ingestTest,
        _facebookProbe: f,
      };
    }
    if (!probe.ok) {
      return {
        ingestOk: false,
        ingestTest: `Fail — host unreachable (${probe.status || probe.err || 'no response'})`,
      };
    }
    return {
      ingestOk: null,
      ingestTest: 'Not wired — official API key / local search not configured',
    };
  }

  // public_pages + unknown: fetch HTML and look for event-ish signals
  const page = await fetchHtmlSnippet(source.url);
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
 * Live status for each Events bookmark source.
 * @returns {Promise<{
 *   ok: true,
 *   checkedAt: string,
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
export async function buildEventsFinderStatus() {
  const sources = await loadEventsFinderSources();
  const checkedAt = new Date().toISOString();

  const rows = await Promise.all(
    sources.map(async (source) => {
      const probe = await probeExternalHttp(source.url);
      const interpreted = interpretProbe(source, probe);
      const ingest = await runIngestionTest(source, probe);
      if (source.host === 'mail.google.com' && ingest._gmailProbe) {
        const g = ingest._gmailProbe;
        return {
          ...source,
          pending: false,
          active: g.active,
          value: g.value,
          output: g.output,
          httpStatus: probe.status,
          ingestOk: ingest.ingestOk,
          ingestTest: ingest.ingestTest,
        };
      }
      if (source.host === 'facebook.com' && ingest._facebookProbe) {
        const f = ingest._facebookProbe;
        return {
          ...source,
          pending: false,
          active: f.active,
          value: f.value,
          output: f.output,
          httpStatus: probe.status,
          ingestOk: ingest.ingestOk,
          ingestTest: ingest.ingestTest,
        };
      }
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
    }),
  );

  return { ok: true, checkedAt, sources: rows };
}
