/**
 * Events finder — curated sources from Personal bookmarks “Events” section.
 * Each host may use a different ingest strategy; status probes stay strategy-aware.
 * Intake Gmail expands to one row per configured mailbox.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gmailIntakeAddresses } from './events-finder-gmail.js';
import { isWebpageListingHost } from './events-finder-webpage-listings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const BOOKMARKS_PERSONAL = path.join(root, 'public/data/bookmarks-personal.json');

/**
 * @typedef {'reachability' | 'public_pages' | 'official_api' | 'login_walled' | 'unknown'} EventsIngestStrategy
 *
 * @typedef {'wired' | 'partial' | 'deferred' | 'unspecified'} EventsDevStatusKind
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
 *   devStatus: string,
 *   devStatusKind: EventsDevStatusKind,
 *   missingEvents: string,
 *   icon?: string | null,
 *   gmailEmail?: string | null,
 * }} EventsFinderSource
 */

/** @type {Record<string, Omit<EventsFinderSource, 'id' | 'label' | 'url' | 'icon' | 'gmailEmail'>>} */
const HOST_STRATEGIES = {
  'partiful.com': {
    host: 'partiful.com',
    strategy: 'public_pages',
    strategyLabel: 'Public pages',
    strategyDetail:
      'Bay Area public discovery via partiful.com/explore/sf (__NEXT_DATA__). Optional watchlist URLs in docs/events-sample-urls.md. No official list API.',
    outputHint: 'Public Explore + watchlist: title, date, venue, RSVP link.',
    devStatus: 'Wired — Explore SF + watchlist',
    devStatusKind: 'wired',
    missingEvents:
      'Private / invite-only parties (public HTML cannot see them — route invites to intake Gmail). Events outside Explore SF / watchlist.',
  },
  'secretparty.io': {
    host: 'secretparty.io',
    strategy: 'public_pages',
    strategyLabel: 'Gmail + watchlist',
    strategyDetail:
      'No public city explore (robots Disallow + API auth). Primary: Intake Gmail (from:secretparty.io + *.secretparty.io links). Optional public event subdomains in docs/events-sample-urls.md.',
    outputHint: 'Invite mailers + known public event subdomains → title, date when present, ticket URL.',
    devStatus: 'Wired — Gmail primary + watchlist',
    devStatusKind: 'wired',
    missingEvents:
      'Private / semi-private parties without invite email to intake. No city-wide discovery. Public pages often SSR-empty (dates need mail/.ics or watchlist enrichment).',
  },
  'facebook.com': {
    host: 'facebook.com',
    strategy: 'official_api',
    strategyLabel: 'Apify scraper',
    strategyDetail:
      'Public Facebook Events via Apify actor apify/facebook-events-scraper (APIFY_TOKEN). Cached on disk; not Meta Graph API.',
    outputHint: 'Bay search queries → normalized events in the sidebar feed.',
    devStatus: 'Wired — Apify + Gmail invites + pins',
    devStatusKind: 'wired',
    missingEvents:
      'Events outside Look-for search queries and pinned hosts/pages. Private events you were not invited to (unless the invite lands in intake Gmail). Meta Graph API not used.',
  },
  'lu.ma': {
    host: 'lu.ma',
    strategy: 'public_pages',
    strategyLabel: 'Pinned calendars + city discover',
    strategyDetail:
      'Upcoming events from docs/luma-calendar-pins.md via HTML (__NEXT_DATA__) + calendar get-items and discover get-paginated-events (e.g. luma.com/sf). Event page pins also accepted. Cached on disk. Gmail catches Luma invite mailers.',
    outputHint: 'Pinned calendar/discover/event: title, when, venue, Luma URL, price when public.',
    devStatus: 'Wired — pins + SF discover + Gmail',
    devStatusKind: 'wired',
    missingEvents:
      'Calendars/discover places/events not listed in luma-calendar-pins.md. Private / members-only Luma events (unless invite lands in intake Gmail).',
  },
  'luma.com': {
    host: 'luma.com',
    strategy: 'public_pages',
    strategyLabel: 'Pinned calendars + city discover',
    strategyDetail:
      'Same as lu.ma — canonical host is luma.com. Pins in docs/luma-calendar-pins.md; calendar get-items + discover get-paginated-events.',
    outputHint: 'Pinned calendar/discover/event: title, when, venue, Luma URL, price when public.',
    devStatus: 'Wired — pins + SF discover + Gmail',
    devStatusKind: 'wired',
    missingEvents:
      'Calendars/discover places/events not listed in luma-calendar-pins.md. Private / members-only Luma events (unless invite lands in intake Gmail).',
  },
  'eventbrite.com': {
    host: 'eventbrite.com',
    strategy: 'public_pages',
    strategyLabel: 'Public pages',
    strategyDetail:
      'Explore via public /d/{location}/ listing pages plus /b/{location}/{category}/ browse pages (JSON-LD). Official REST search needs a token and is optional later — not required for discovery.',
    outputHint: 'Listing hits: title, start, venue, ticket URL from public search + category pages.',
    devStatus: 'Wired — city + category listings',
    devStatusKind: 'wired',
    missingEvents:
      'Deep pagination beyond first page of each category. Organizer-only inventory that never appears on public /d/ or /b/ listings. Official REST search unused.',
  },
  'meetup.com': {
    host: 'meetup.com',
    strategy: 'public_pages',
    strategyLabel: 'Pinned groups (public pages)',
    strategyDetail:
      'Upcoming events from docs/meetup-group-pins.md via each group’s public /events/ page (__NEXT_DATA__ / Apollo). Cached on disk. Official GraphQL optional later for /find/ discovery.',
    outputHint: 'Pinned group events: title, time, venue, Meetup URL.',
    devStatus: 'Wired — pinned groups + Gmail',
    devStatusKind: 'wired',
    missingEvents:
      'Groups not listed in meetup-group-pins.md (e.g. SF Hardware still unpinned). City-wide /find discovery. Invites/digests only if notification email is routed to intake Gmail.',
  },
  'themultiverse.school': {
    host: 'themultiverse.school',
    strategy: 'public_pages',
    strategyLabel: 'Public Google Calendar (ICS)',
    strategyDetail:
      'All-school calendar at /calendar embeds a public Google Calendar; Dashbird fetches the public basic.ics feed (classes, standups, immersives). Cached on disk.',
    outputHint: 'Upcoming Multiverse classes & standups: title, time, link.',
    devStatus: 'Wired — public ICS',
    devStatusKind: 'wired',
    missingEvents:
      'Private / unlisted calendar items. Events only on other Multiverse calendars not embedded on /calendar.',
  },
  'dorkbotsf.org': {
    host: 'dorkbotsf.org',
    strategy: 'public_pages',
    strategyLabel: 'Public homepage (HTML)',
    strategyDetail:
      'Fetches https://dorkbotsf.org/ for the featured next meetup (time, venue, talks, flyer). Cached on disk. Google Calendar embed on /calendar.html is not publicly ICS-exportable.',
    outputHint: 'Next dorkbotSF meetup: title, time, venue, archive URL.',
    devStatus: 'Wired — public HTML',
    devStatusKind: 'wired',
    missingEvents:
      'Past archive meetups (homepage only surfaces the next one). Related tours listed only under archives.',
  },
  'coolstuff.ju.mp': {
    host: 'coolstuff.ju.mp',
    strategy: 'public_pages',
    strategyLabel: 'Cool Happenings list (HTML)',
    strategyDetail:
      'Fetches https://coolstuff.ju.mp/ — Richie Rhombus’s curated under-$30/free Bay Area arts list. Parses outbound event links + nearby dates. Cached on disk.',
    outputHint: 'Listed happenings: title, optional date/city, outbound URL.',
    devStatus: 'Wired — public HTML',
    devStatusKind: 'wired',
    missingEvents:
      'Items without outbound links. Events only on other lists not linked from Cool Happenings.',
  },
  'artisansasylum.com': {
    host: 'artisansasylum.com',
    strategy: 'public_pages',
    strategyLabel: 'Public Google Calendar (ICS)',
    strategyDetail:
      'Class / community calendar page embeds public Google Calendars; Dashbird pulls the public basic.ics feeds (same pattern as Multiverse). Cached with other webpage listings.',
    outputHint: 'Upcoming classes & shop nights: title, time, calendar page link.',
    devStatus: 'Wired — public ICS from page',
    devStatusKind: 'wired',
    missingEvents:
      'Members-only / Nexudus portal events. Items not on the embedded public calendars.',
  },
  'prescottmarket.com': {
    host: 'prescottmarket.com',
    strategy: 'public_pages',
    strategyLabel: 'Public events page (HTML)',
    strategyDetail:
      'Fetches https://www.prescottmarket.com/events (Squarespace event list). Parses upcoming articles + times. Cached with other webpage listings.',
    outputHint: 'Market / music / community events: title, start, event URL.',
    devStatus: 'Wired — public HTML',
    devStatusKind: 'wired',
    missingEvents: 'Past events. Occurrences not listed on the public /events page.',
  },
  'fetlife.com': {
    host: 'fetlife.com',
    strategy: 'login_walled',
    strategyLabel: 'Deferred',
    strategyDetail:
      'Auto-ingest deferred. Bookmark + reachability only; no scrape. Reopen later if paste-watch or an official export is wanted.',
    outputHint: 'Deferred — not included in auto-ingest.',
    devStatus: 'Deferred — no auto-ingest',
    devStatusKind: 'deferred',
    missingEvents:
      'Everything — login-walled; no scrape or export. Bookmark/reachability only until reopened.',
  },
  'mail.google.com': {
    host: 'mail.google.com',
    strategy: 'official_api',
    strategyLabel: 'Gmail API (intake)',
    strategyDetail:
      'Poll this intake inbox via Gmail API (OAuth). Parse .ics attachments, Partiful/Secret Party/Luma/Eventbrite/Meetup links, and invite-ish subjects into the shared Events feed.',
    outputHint: 'Event announcements from this inbox: title, date, venue/link when present.',
    devStatus: 'Wired — OAuth / IMAP',
    devStatusKind: 'wired',
    missingEvents:
      'Mail that never reaches this inbox (platform notifications still on another address). Non-event mail filtered out by the intake query. Platforms that do not email invites.',
  },
  't.me': {
    host: 't.me',
    strategy: 'official_api',
    strategyLabel: 'Telegram bot (intake)',
    strategyDetail:
      'Long-poll Telegram Bot API. Classifies messages as event / todo / note / contact. Events: flyer screenshots (vision; albums merge), voice, or text invites. Todos → Vikunja. Notes → Keep Notes (mobile/desktop Notes tab). Contacts → Network CRM. Overrides: /event /todo /note /contact.',
    outputHint: 'Events, todos, notes, and contacts from one allowlisted chat.',
    devStatus: 'Wired — bot poll + classifier + OpenRouter',
    devStatusKind: 'wired',
    missingEvents:
      'Chats not in TELEGRAM_ALLOWED_CHAT_IDS. Low-confidence messages without /event|/todo|/note|/contact override.',
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
 * @returns {Omit<EventsFinderSource, 'id' | 'label' | 'url' | 'icon' | 'gmailEmail'>}
 */
function strategyForHost(host) {
  const known = HOST_STRATEGIES[host];
  if (known) return known;
  // Venue / community calendars added via Settings → + Event source.
  if (isWebpageListingHost(host)) {
    return {
      host: host || 'unknown',
      strategy: 'public_pages',
      strategyLabel: 'Public events page (HTML / ICS)',
      strategyDetail:
        'Generic webpage listing ingest: Google Calendar public ICS embeds, Squarespace event lists, and JSON-LD Event blocks. Cached on disk with other webpage sources.',
      outputHint: 'Upcoming events parsed from the bookmarked page.',
      devStatus: 'Wired — webpage listing',
      devStatusKind: 'wired',
      missingEvents:
        'Login-walled calendars, JS-only widgets without ICS/JSON-LD/eventlist markup, and events not listed on this URL.',
    };
  }
  return {
    host: host || 'unknown',
    strategy: 'unknown',
    strategyLabel: 'Unspecified',
    strategyDetail:
      'No ingest strategy registered for this host yet. Status is a basic HTTPS reachability probe.',
    outputHint: 'Not configured — add a host strategy when wiring ingest.',
    devStatus: 'Unspecified',
    devStatusKind: 'unspecified',
    missingEvents: 'Unknown — no ingest strategy registered for this host yet.',
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
 * One Settings row per configured intake mailbox.
 * @param {{ word?: string, href?: string, title?: string, icon?: string }} item
 * @param {string} url
 * @param {Omit<EventsFinderSource, 'id' | 'label' | 'url' | 'icon' | 'gmailEmail'>} strat
 * @returns {EventsFinderSource[]}
 */
function expandGmailIntakeSources(item, url, strat) {
  const addresses = gmailIntakeAddresses();
  const icon = typeof item.icon === 'string' ? item.icon : null;
  return addresses.map((email) => {
    const local = email.split('@')[0] || email;
    return {
      id: sourceId(`gmail_${local}`, 'mail.google.com'),
      label: email,
      url,
      icon,
      ...strat,
      host: 'mail.google.com',
      gmailEmail: email,
      strategyDetail: `Poll ${email} via Gmail API (OAuth). Parse .ics, Partiful/Secret Party/Luma/Eventbrite/Meetup/Facebook invite mail into the shared Events feed.`,
      outputHint: `Event announcements from ${email}: title, date, venue/link when present.`,
    };
  });
}

/**
 * Load the Personal bookmarks “Events” section as Events finder sources.
 * The single mail.google.com bookmark expands into one row per intake address.
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
  let gmailExpanded = false;
  for (const item of items) {
    const url = typeof item.href === 'string' ? item.href.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const host = hostnameFromHref(url);
    const strat = strategyForHost(host);

    if (host === 'mail.google.com') {
      if (gmailExpanded) continue;
      gmailExpanded = true;
      sources.push(...expandGmailIntakeSources(item, url, strat));
      continue;
    }

    const label = String(item.word || item.title || host || 'Source').trim();
    sources.push({
      id: sourceId(label, host),
      label,
      url,
      icon: typeof item.icon === 'string' ? item.icon : null,
      ...strat,
      host: host || strat.host,
      gmailEmail: null,
    });
  }

  // If bookmarks omit Gmail but addresses are configured, still show rows.
  if (!gmailExpanded) {
    const strat = strategyForHost('mail.google.com');
    sources.push(...expandGmailIntakeSources({}, 'https://mail.google.com/', strat));
  }

  // Always surface Telegram intake (env-gated at probe/poll time).
  if (!sources.some((s) => s.host === 't.me' || s.host === 'telegram.org')) {
    const strat = strategyForHost('t.me');
    sources.push({
      id: sourceId('Telegram', 't.me'),
      label: 'Telegram',
      url: 'https://t.me/',
      icon: '/assets/tile-telegram.svg',
      ...strat,
      host: 't.me',
      gmailEmail: null,
    });
  }

  // Deferred sources (e.g. Fet) always last — active ingest rows stay above.
  sources.sort((a, b) => {
    const aDef = a.devStatusKind === 'deferred' ? 1 : 0;
    const bDef = b.devStatusKind === 'deferred' ? 1 : 0;
    return aDef - bDef;
  });

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
