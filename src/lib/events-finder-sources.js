/**
 * Events finder — curated sources from Personal bookmarks “Events” section.
 * Each host may use a different ingest strategy; status probes stay strategy-aware.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const BOOKMARKS_PERSONAL = path.join(root, 'public/data/bookmarks-personal.json');

/**
 * @typedef {'reachability' | 'public_pages' | 'official_api' | 'login_walled' | 'unknown'} EventsIngestStrategy
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   host: string,
 *   url: string,
 *   strategy: EventsIngestStrategy,
 *   strategyLabel: string,
 *   strategyDetail: string,
 *   outputHint: string,
 *   icon?: string | null,
 * }} EventsFinderSource
 */

/** @type {Record<string, Omit<EventsFinderSource, 'id' | 'label' | 'url' | 'icon'>>} */
const HOST_STRATEGIES = {
  'partiful.com': {
    host: 'partiful.com',
    strategy: 'public_pages',
    strategyLabel: 'Public pages',
    strategyDetail:
      'Invite/party links are mostly share-URL based. Probe the marketing site; future ingest can follow public event pages (no official list API).',
    outputHint: 'Public event title, date, RSVP link when a share URL is known.',
  },
  'secretparty.io': {
    host: 'secretparty.io',
    strategy: 'public_pages',
    strategyLabel: 'Public pages',
    strategyDetail:
      'Secret Party event pages are mostly share/invite URL based (ticketing + guest-list tools). Probe the marketing site; future ingest via public event pages when URLs are known.',
    outputHint: 'Public event title, date, ticket/RSVP link when a share URL is known.',
  },
  'facebook.com': {
    host: 'facebook.com',
    strategy: 'official_api',
    strategyLabel: 'Apify scraper',
    strategyDetail:
      'Public Facebook Events via Apify actor apify/facebook-events-scraper (APIFY_TOKEN). Cached on disk; not Meta Graph API.',
    outputHint: 'Bay search queries → normalized events in the sidebar feed.',
  },
  'lu.ma': {
    host: 'lu.ma',
    strategy: 'public_pages',
    strategyLabel: 'Public pages',
    strategyDetail:
      'Luma publishes public event and calendar pages. Probe home; future ingest via public event HTML or calendar export where available.',
    outputHint: 'Public event title, when, host, and join URL.',
  },
  'eventbrite.com': {
    host: 'eventbrite.com',
    strategy: 'public_pages',
    strategyLabel: 'Public pages',
    strategyDetail:
      'Explore via public /d/{location}/ listing pages (JSON-LD ItemList + __SERVER_DATA__). Official REST search needs a token and is optional later — not required for discovery.',
    outputHint: 'Listing hits: title, start, venue, ticket URL from public search pages.',
  },
  'meetup.com': {
    host: 'meetup.com',
    strategy: 'official_api',
    strategyLabel: 'Official API (planned)',
    strategyDetail:
      'Meetup GraphQL/API needs credentials. Status uses site reachability until a keyed local search is configured.',
    outputHint: 'Group events near dashboard location: title, time, RSVP URL (API).',
  },
  'fetlife.com': {
    host: 'fetlife.com',
    strategy: 'login_walled',
    strategyLabel: 'Deferred',
    strategyDetail:
      'Auto-ingest deferred. Bookmark + reachability only; no scrape. Reopen later if paste-watch or an official export is wanted.',
    outputHint: 'Deferred — not included in auto-ingest.',
  },
  'mail.google.com': {
    host: 'mail.google.com',
    strategy: 'official_api',
    strategyLabel: 'Gmail API (intake)',
    strategyDetail:
      'Poll intake Gmail(s) via Gmail API (OAuth) — default jay.intake.box@gmail.com + julia.hasty@gmail.com. Parse .ics attachments, Partiful/Secret Party/Luma/Eventbrite/Meetup links, and invite-ish subjects into the shared Events feed.',
    outputHint: 'Event announcements from connected intake inboxes: title, date, venue/link when present.',
  },
};

/**
 * @param {string} href
 * @returns {string}
 */
function hostnameFromHref(href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.hostname.replace(/^www\./, '').toLowerCase();
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * @param {string} host
 * @returns {Omit<EventsFinderSource, 'id' | 'label' | 'url' | 'icon'>}
 */
function strategyForHost(host) {
  const known = HOST_STRATEGIES[host];
  if (known) return known;
  return {
    host: host || 'unknown',
    strategy: 'unknown',
    strategyLabel: 'Unspecified',
    strategyDetail:
      'No ingest strategy registered for this host yet. Status is a basic HTTPS reachability probe.',
    outputHint: 'Not configured — add a host strategy when wiring ingest.',
  };
}

/**
 * @param {string} label
 * @param {string} host
 * @returns {string}
 */
function sourceId(label, host) {
  const slug = String(label || host || 'source')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  return `events_src_${slug || host.replace(/\./g, '_')}`;
}

/**
 * Load the Personal bookmarks “Events” section as Events finder sources.
 * @returns {Promise<EventsFinderSource[]>}
 */
export async function loadEventsFinderSources() {
  let raw;
  try {
    raw = JSON.parse(await readFile(BOOKMARKS_PERSONAL, 'utf8'));
  } catch (e) {
    const err = new Error(`Could not read bookmarks-personal.json: ${e?.message || e}`);
    err.code = 'bookmarks_missing';
    throw err;
  }

  /** @type {Array<{ word?: string, href?: string, title?: string, icon?: string }>} */
  let items = [];
  if (Array.isArray(raw?.sections)) {
    const section = raw.sections.find(
      (s) => String(s?.title || '').trim().toLowerCase() === 'events',
    );
    if (section && Array.isArray(section.items)) items = section.items;
  } else if (Array.isArray(raw)) {
    items = raw;
  }

  /** @type {EventsFinderSource[]} */
  const sources = [];
  for (const item of items) {
    const url = typeof item.href === 'string' ? item.href.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const host = hostnameFromHref(url);
    const label = String(item.word || item.title || host || 'Source').trim();
    const strat = strategyForHost(host);
    sources.push({
      id: sourceId(label, host),
      label,
      url,
      icon: typeof item.icon === 'string' ? item.icon : null,
      ...strat,
      host: host || strat.host,
    });
  }
  return sources;
}

/**
 * Manifest-only rows (no live probe) for Settings pending UI.
 * @returns {Promise<Array<EventsFinderSource & {
 *   pending: true,
 *   status: null,
 *   output: null,
 *   ingestOk: null,
 *   ingestTest: null,
 * }>>}
 */
export async function getEventsFinderSourcesManifest() {
  const sources = await loadEventsFinderSources();
  return sources.map((s) => ({
    ...s,
    pending: true,
    status: null,
    output: null,
    ingestOk: null,
    ingestTest: null,
  }));
}
