/**
 * Events sidebar — browse filters + list/map (Gmail intake first; more sources later).
 * Browse filters share /api/events-finder-criteria with Settings ingestion criteria
 * (same JSON file; filters vs scrape/lookFor/skip are applied at different stages).
 */
import {
  createAttendanceChecks,
  createCityChecks,
  createRangeCalendar,
  normalizeLocalTime,
} from './events-filter-ui.js?v=attendance-online-1';
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import { beginWaitCursor, endWaitCursor } from '../lib/wait-cursor.js';

const SHOW_SKIPPED_KEY = 'dashbird.events.showSkipped';
const FILTER_AUTOSAVE_MS = 650;
const EVENTS_CACHE_KEY = 'events-finder:events';
const EVENTS_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const CRITERIA_CACHE_KEY = 'events-finder:criteria';
const CRITERIA_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {Promise<any> | null} */
let leafletPromise = null;

/**
 * @returns {Promise<any>}
 */
function loadLeaflet() {
  if (leafletPromise) return leafletPromise;
  leafletPromise = (async () => {
    if (!document.querySelector('link[data-dashbird-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/leaflet/leaflet.css';
      link.dataset.dashbirdLeaflet = '1';
      document.head.append(link);
    }
    if (/** @type {any} */ (window).L) return /** @type {any} */ (window).L;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/leaflet/leaflet.js';
      s.async = true;
      s.onload = () => resolve(undefined);
      s.onerror = () => reject(new Error('leaflet_load_failed'));
      document.head.append(s);
    });
    const L = /** @type {any} */ (window).L;
    if (!L) throw new Error('leaflet_missing');
    return L;
  })();
  return leafletPromise;
}

/** Soft cap before we punch-summarize a description. */
const BLURB_FULL_MAX = 240;

const PUNCHY_RE =
  /\b(free|\$\d+|ticket|limited|rare|first|only|special|guest|featuring|immersive|interactive|workshop|hack|climate|queer|pride|nightlife|21\+|sold out|space is limited|peer[- ]to[- ]peer|salon|retreat|festival|maker|circus|burlesque|comedy|founder|startup|ai)\b/i;

/**
 * @returns {boolean}
 */
function readShowSkipped() {
  try {
    return localStorage.getItem(SHOW_SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {boolean} on
 */
function writeShowSkipped(on) {
  try {
    localStorage.setItem(SHOW_SKIPPED_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * @param {HTMLElement} parent
 * @param {string} labelText
 * @param {string} forId
 * @returns {HTMLLabelElement}
 */
function fieldLabel(parent, labelText, forId) {
  const label = document.createElement('label');
  label.className = 'events-finder__label';
  label.htmlFor = forId;
  label.textContent = labelText;
  parent.append(label);
  return label;
}

/**
 * Local calendar day + minutes-from-midnight for an event start (dashboard TZ).
 * @param {string | Date | null | undefined} start
 * @param {string} [timeZone]
 * @returns {{ day: string, minutes: number } | null}
 */
function eventLocalDayAndMinutes(start, timeZone = 'America/Los_Angeles') {
  if (!start) return null;
  const d = start instanceof Date ? start : new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const get = (/** @type {Intl.DateTimeFormatPartTypes} */ type) =>
      parts.find((p) => p.type === type)?.value;
    const y = get('year');
    const m = get('month');
    const day = get('day');
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (!y || !m || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { day: `${y}-${m}-${day}`, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * Keep the punchiest bits of a long event description; leave short ones intact.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
function summarizeDescription(text, maxChars = BLURB_FULL_MAX) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;

  /** @type {{ s: string, score: number, i: number }[]} */
  const ranked = sentences.map((s, i) => {
    let score = 0;
    if (PUNCHY_RE.test(s)) score += 4;
    if (/\$\d+|\bfree\b|\b21\+?\b/i.test(s)) score += 3;
    if (/\b(featuring|special guests?|presented|bringing)\b/i.test(s)) score += 2;
    if (s.length >= 40 && s.length <= 160) score += 1;
    if (s.length > 220) score -= 2;
    score += Math.max(0, 2 - i * 0.15);
    return { s, score, i };
  });
  ranked.sort((a, b) => b.score - a.score || a.i - b.i);

  const picked = [];
  let used = 0;
  for (const row of ranked) {
    if (picked.length >= 3) break;
    const next = row.s;
    if (used + next.length + (picked.length ? 1 : 0) > maxChars && picked.length) break;
    if (used + next.length > maxChars + 40 && picked.length) continue;
    picked.push(row);
    used += next.length + (picked.length > 1 ? 1 : 0);
  }
  if (!picked.length) {
    return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
  }
  picked.sort((a, b) => a.i - b.i);
  let out = picked.map((p) => p.s).join(' ');
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  } else if (cleaned.length > out.length + 20 && !/[.!?]$/.test(out)) {
    out += '…';
  }
  return out;
}

/**
 * Suggest look-for / skip lines from an event.
 * @param {object} ev
 * @param {'up' | 'down'} vibe
 * @returns {string}
 */
function suggestPreferenceLines(ev, vibe) {
  const title = String(ev.title || '').trim();
  const venue = String(ev.venue || ev.location || '').trim();
  const desc = String(ev.description || ev.raw?.description || '')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = [];
  if (title) {
    const shortTitle = title
      .replace(/\s*[-–—|].*$/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .slice(0, 60);
    if (shortTitle) lines.push(shortTitle);
  }
  const blob = `${title} ${desc}`;
  const hits = blob.match(
    /\b(hack[- ]?a[- ]?thons?|climate|sustainability|immersive|acro|yoga|founder|startup|ai|comedy|circus|burlesque|queer|pride|maker|festival|salon|retreat|nightlife)\b/gi,
  );
  if (hits) {
    for (const h of hits) {
      const n = h.toLowerCase();
      if (!lines.some((l) => l.toLowerCase() === n)) lines.push(n);
      if (lines.length >= 5) break;
    }
  }
  if (vibe === 'down' && venue) {
    const vShort = venue.split(',')[0].trim().slice(0, 40);
    if (vShort && !lines.some((l) => l.toLowerCase() === vShort.toLowerCase())) {
      lines.push(vShort);
    }
  }
  return lines.slice(0, 6).join('\n');
}

/**
 * Append unique lines to a newline-separated taste list.
 * @param {string} existing
 * @param {string} additions
 * @returns {string}
 */
function mergeTasteLines(existing, additions) {
  const seen = new Set();
  const out = [];
  for (const line of String(existing || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  for (const line of String(additions || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

/**
 * @param {string} block
 * @returns {string[]}
 */
function tasteLinesFromBlock(block) {
  return String(block || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('//'));
}

/**
 * Client mirror of server taste matching (events-finder-taste.js).
 * Used to refilter the cached feed immediately when Skip words change.
 * @param {string} block
 * @returns {string[]}
 */
function parseTasteLinesClient(block) {
  return String(block || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('//'));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function foldTasteTextClient(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @param {object} event
 * @returns {string}
 */
function eventHaystackClient(event) {
  const parts = [
    event?.title,
    event?.venue,
    event?.location,
    event?.city,
    event?.description,
    event?.url,
  ];
  return foldTasteTextClient(parts.map((p) => String(p || '')).join(' \n '));
}

/**
 * @param {string} hay
 * @param {string} line
 * @returns {boolean}
 */
function tasteLineMatchesClient(hay, line) {
  const original = String(line || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!original) return false;
  const quoted = original.match(/^"([^"]+)"$/);
  if (quoted) {
    const q = foldTasteTextClient(quoted[1]);
    return Boolean(q) && hay.includes(q);
  }
  const folded = foldTasteTextClient(original);
  if (!folded) return false;
  if (hay.includes(folded)) return true;
  const compactLine = folded.replace(/\s+/g, '');
  const compactHay = hay.replace(/\s+/g, '');
  if (compactLine.length >= 4 && compactHay.includes(compactLine)) return true;
  const tokens = folded.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return hay.includes(folded);
  return tokens.every((t) => hay.includes(t));
}

/**
 * Deliberate Telegram intake — only date filters should hide these in the feed.
 * @param {object} ev
 * @returns {boolean}
 */
function isTelegramIntakeEvent(ev) {
  if (String(ev?.source || '').trim().toLowerCase() === 'telegram') return true;
  const id = String(ev?.id || '').trim();
  return id.startsWith('telegram:');
}

/**
 * @param {object} event
 * @param {{ lookFor?: string, skip?: string, blacklist?: string } | null | undefined} criteria
 * @returns {boolean}
 */
function eventPassesTasteClient(event, criteria) {
  if (isTelegramIntakeEvent(event)) return true;
  if (!criteria) return true;
  const hay = eventHaystackClient(event);
  const lookFor = parseTasteLinesClient(criteria.lookFor);
  const skip = parseTasteLinesClient(criteria.skip);
  const blacklist = parseTasteLinesClient(criteria.blacklist);
  const matchedLookFor = lookFor.filter((line) => tasteLineMatchesClient(hay, line));
  const matchedSkip = skip.filter((line) => tasteLineMatchesClient(hay, line));
  const matchedBlacklist = blacklist.filter((line) => tasteLineMatchesClient(hay, line));
  // Blacklist always hides, even when Look for also matches.
  if (matchedBlacklist.length) return false;
  // Grey list (skip) only hides when nothing on Look for also matches.
  if (matchedSkip.length && !matchedLookFor.length) return false;
  return true;
}

/**
 * Drop feed events that fail current grey / black / Look for taste rules, or that were
 * already added to Google Calendar (tracked ids — not Skip).
 * @param {object} data
 * @param {{ lookFor?: string, skip?: string, blacklist?: string, calendarAddedEventIds?: string[] } | null | undefined} criteria
 * @returns {object}
 */
function applyTasteToEventsPayload(data, criteria) {
  if (!data || typeof data !== 'object' || !criteria) return data;
  const calAdded = new Set(
    (Array.isArray(criteria.calendarAddedEventIds) ? criteria.calendarAddedEventIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  const events = (Array.isArray(data.events) ? data.events : []).filter((ev) => {
    const id = String(ev?.id || '').trim();
    if (isTelegramIntakeEvent(ev)) return true;
    if (id && calAdded.has(id)) return false;
    return eventPassesTasteClient(ev, criteria);
  });
  return { ...data, events };
}

const DEFAULT_GOOGLE_CALENDAR = {
  name: 'Random Events',
  authuser: 'julia.hasty@gmail.com',
  src: '',
};

/**
 * @type {{ name: string, authuser: string, src: string }}
 */
let googleCalendarTarget = { ...DEFAULT_GOOGLE_CALENDAR };

/**
 * @param {unknown} raw
 */
function applyGoogleCalendarConfig(raw) {
  if (!raw || typeof raw !== 'object') return;
  const o = /** @type {Record<string, unknown>} */ (raw);
  googleCalendarTarget = {
    name: String(o.name || '').trim() || DEFAULT_GOOGLE_CALENDAR.name,
    authuser: String(o.authuser || '').trim() || DEFAULT_GOOGLE_CALENDAR.authuser,
    src: String(o.src || '').trim(),
  };
}

const SOURCE_LABELS = {
  facebook: 'Facebook',
  gmail: 'Gmail',
  eventbrite: 'Eventbrite',
  meetup: 'Meetup',
  luma: 'Luma',
  partiful: 'Partiful',
  secretparty: 'Secret Party',
  telegram: 'Telegram',
  public: 'Web',
};

/**
 * Human label for the site/source an event came from.
 * @param {object} ev
 * @returns {string}
 */
function eventSourceLabel(ev) {
  const url = String(ev.url || '').trim();
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./i, '');
      if (host) {
        if (/facebook\.com$/i.test(host)) return 'Facebook';
        if (/eventbrite\./i.test(host)) return 'Eventbrite';
        if (/meetup\.com$/i.test(host)) return 'Meetup';
        if (/lu\.ma$/i.test(host) || /^luma\./i.test(host)) return 'Luma';
        if (/partiful\.com$/i.test(host)) return 'Partiful';
        if (/secretparty\.io$/i.test(host)) return 'Secret Party';
        return host;
      }
    } catch {
      /* ignore bad urls */
    }
  }
  const raw = String(ev.source || '').trim().toLowerCase();
  if (!raw) return '';
  if (SOURCE_LABELS[raw]) return SOURCE_LABELS[raw];
  if (raw.startsWith('gmail')) return 'Gmail';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Google Calendar “create event” URL — defaults to Random Events for julia.hasty.
 * @param {object} ev
 * @returns {string}
 */
function googleCalendarAddUrl(ev) {
  const title = String(ev.title || 'Event').trim() || 'Event';
  const startMs = Date.parse(String(ev.start || ''));
  const endRaw = Date.parse(String(ev.end || ''));
  /** @param {Date} d */
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text', title);
  if (Number.isFinite(startMs)) {
    const start = new Date(startMs);
    const end = Number.isFinite(endRaw) && endRaw > startMs
      ? new Date(endRaw)
      : new Date(startMs + 2 * 60 * 60 * 1000);
    params.set('dates', `${fmt(start)}/${fmt(end)}`);
  }
  const place = String(ev.venue || ev.location || '').trim();
  if (place) params.set('location', place.slice(0, 500));
  const details = [String(ev.description || '').replace(/\s+/g, ' ').trim(), String(ev.url || '').trim()]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 6000);
  if (details) params.set('details', details);
  // Preselect the Random Events (or configured) calendar when we have its Calendar ID.
  if (googleCalendarTarget.src) params.set('src', googleCalendarTarget.src);
  if (googleCalendarTarget.authuser) params.set('authuser', googleCalendarTarget.authuser);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * @param {HTMLElement | null} root
 */
export function mountEventsFinder(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('events-finder');

  const toolbar = document.createElement('div');
  toolbar.className = 'events-finder__toolbar';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'events-finder__toggle';
  toggleBtn.setAttribute('aria-controls', 'events-finder-filters');
  toggleBtn.setAttribute('aria-label', 'Browse filters');
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'events-finder__toggle-label';
  toggleLabel.textContent = 'Filters';
  toggleBtn.title =
    'Browse filters for the saved catalog (ZIP, dates, cities). Ingestion criteria live under Settings → Edit criteria.';
  const toggleArrow = document.createElement('span');
  toggleArrow.className = 'events-finder__toggle-arrow';
  toggleArrow.setAttribute('aria-hidden', 'true');
  toggleBtn.append(toggleLabel, toggleArrow);

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'events-finder__view-toggle';
  viewBtn.textContent = 'Map';
  viewBtn.setAttribute('aria-pressed', 'false');
  viewBtn.setAttribute('aria-label', 'Open events map');
  viewBtn.title = 'Open events on a map';

  toolbar.append(toggleBtn, viewBtn);

  const filterPanel = document.createElement('div');
  filterPanel.id = 'events-finder-filters';
  filterPanel.className = 'events-finder__filters';
  filterPanel.hidden = true;

  const areaRow = document.createElement('div');
  areaRow.className = 'events-finder__field-row';

  const zipField = document.createElement('div');
  zipField.className = 'events-finder__field';
  fieldLabel(zipField, 'ZIP', 'events-finder-zip');
  const zipInput = document.createElement('input');
  zipInput.id = 'events-finder-zip';
  zipInput.className = 'events-finder__input events-finder__input--zip';
  zipInput.type = 'text';
  zipInput.inputMode = 'numeric';
  zipInput.autocomplete = 'postal-code';
  zipInput.maxLength = 5;
  zipInput.placeholder = '94608';
  zipInput.title = 'Center ZIP for distance filter';
  zipField.append(zipInput);

  const milesField = document.createElement('div');
  milesField.className = 'events-finder__field';
  fieldLabel(milesField, 'Radius (mi)', 'events-finder-miles');
  const milesInput = document.createElement('input');
  milesInput.id = 'events-finder-miles';
  milesInput.className = 'events-finder__input events-finder__input--miles';
  milesInput.type = 'number';
  milesInput.min = '1';
  milesInput.max = '100';
  milesInput.step = '0.5';
  milesInput.placeholder = '25';
  milesInput.title = 'Radius in miles from the ZIP';
  milesField.append(milesInput);

  areaRow.append(zipField, milesField);
  filterPanel.append(areaRow);

  const attendanceField = document.createElement('div');
  attendanceField.className = 'events-finder__field';
  const attendanceLabel = document.createElement('p');
  attendanceLabel.className = 'events-finder__label';
  attendanceLabel.textContent = 'Attendance';
  attendanceField.append(attendanceLabel);
  const attendanceChecks = createAttendanceChecks({
    idPrefix: 'events-finder-att',
    classPrefix: 'events-finder',
    attendance: 'any',
  });
  attendanceField.append(attendanceChecks.root);
  filterPanel.append(attendanceField);

  const citiesField = document.createElement('div');
  citiesField.className = 'events-finder__field';
  const citiesLabel = document.createElement('p');
  citiesLabel.className = 'events-finder__label';
  citiesLabel.textContent = 'Cities';
  citiesField.append(citiesLabel);
  /** @type {string[] | null} null = all cities checked */
  let savedCitySelection = null;
  const cityChecks = createCityChecks({
    idPrefix: 'events-finder-city',
    cities: [],
    selected: null,
    onChange: () => {
      if (!lastEventsPayload) return;
      const available = citiesFromPayload(lastEventsPayload);
      const selected = cityChecks.getSelected();
      savedCitySelection =
        available.length && selected.length && selected.length < available.length
          ? selected
          : null;
      paintEvents(lastEventsPayload);
      scheduleFilterAutosave();
    },
  });
  citiesField.append(cityChecks.root);
  const citiesEmpty = document.createElement('p');
  citiesEmpty.className = 'events-finder__cities-empty muted';
  citiesEmpty.textContent = 'Cities appear when events load.';
  citiesField.append(citiesEmpty);
  filterPanel.append(citiesField);

  const datesField = document.createElement('div');
  datesField.className = 'events-finder__field';
  const datesLabel = document.createElement('p');
  datesLabel.className = 'events-finder__label';
  datesLabel.textContent = 'Dates';
  datesField.append(datesLabel);

  const calendar = createRangeCalendar({
    idPrefix: 'events-finder-cal',
    classPrefix: 'events-cal',
    onChange: () => {
      // Instant client refilter so picking a date updates the list before Save/reload.
      if (lastEventsPayload) paintEvents(lastEventsPayload);
      scheduleFilterAutosave({ reload: true });
    },
  });
  datesField.append(calendar.root);
  filterPanel.append(datesField);

  const timeField = document.createElement('div');
  timeField.className = 'events-finder__field';
  fieldLabel(timeField, 'Earliest (optional)', 'events-finder-earliest');
  const timeInput = document.createElement('input');
  timeInput.id = 'events-finder-earliest';
  timeInput.className = 'events-finder__input events-finder__input--time';
  timeInput.type = 'time';
  timeInput.step = '60';
  timeInput.value = '';
  timeInput.title =
    'Browse filter: hide catalog events that start before this local time. Clear to allow any time. Separate from Settings ingestion earliest.';
  timeField.append(timeInput);
  filterPanel.append(timeField);

  const conferenceField = document.createElement('div');
  conferenceField.className = 'events-finder__field events-finder__field--conferences';

  const conferenceToggle = document.createElement('button');
  conferenceToggle.type = 'button';
  conferenceToggle.className = 'events-finder__conferences-toggle';
  conferenceToggle.setAttribute('aria-expanded', 'false');
  conferenceToggle.setAttribute('aria-haspopup', 'dialog');
  conferenceToggle.textContent = 'Big events';
  conferenceToggle.title =
    'Track big conferences & festivals — search a name, preview the site, then log dates, ticket price, and early bird windows.';

  const conferenceInput = document.createElement('textarea');
  conferenceInput.id = 'events-finder-conferences';
  conferenceInput.className = 'events-finder__conferences-input';
  conferenceInput.hidden = true;
  conferenceInput.tabIndex = -1;
  conferenceInput.setAttribute('aria-hidden', 'true');
  conferenceInput.placeholder = 'e.g. open sauce';
  conferenceInput.spellcheck = true;
  conferenceInput.title = 'Big event names being tracked';

  conferenceField.append(conferenceToggle, conferenceInput);
  filterPanel.append(conferenceField);

  /** @type {HTMLElement | null} */
  let conferencePopoutBackdrop = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let conferencePopoutKeyHandler = null;
  /** @type {HTMLElement | null} */
  let conferencePopoutStatusList = null;
  /**
   * Slugs pending a soft-delete. Value is the timeout id that will commit the
   * DELETE unless the user hits Undo first. Repaints render these rows in the
   * "removing" state so the undo affordance survives table refreshes.
   * @type {Map<string, ReturnType<typeof setTimeout>>}
   */
  const pendingBigEventDeletes = new Map();
  const BIG_EVENT_DELETE_DELAY_MS = 3000;

  function closeConferencePopout() {
    if (!conferencePopoutBackdrop) return;
    if (conferencePopoutKeyHandler) {
      document.removeEventListener('keydown', conferencePopoutKeyHandler);
      conferencePopoutKeyHandler = null;
    }
    conferencePopoutBackdrop.remove();
    conferencePopoutBackdrop = null;
    conferencePopoutStatusList = null;
    conferenceToggle.setAttribute('aria-expanded', 'false');
    conferenceToggle.classList.remove('events-finder__conferences-toggle--open');
  }

  /**
   * @param {{ title: string, body: HTMLElement, onClose?: () => void }} opts
   */
  function openConferencePopout(opts) {
    if (conferencePopoutBackdrop) closeConferencePopout();

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__conference-popout-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__conference-popout';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');

    const bar = document.createElement('div');
    bar.className = 'events-finder__conference-popout-bar';
    const title = document.createElement('h2');
    title.className = 'events-finder__conference-popout-title';
    title.textContent = opts.title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'events-finder__conference-popout-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.title = 'Close';
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    bar.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'events-finder__conference-popout-body';
    body.append(opts.body);

    shell.append(bar, body);
    backdrop.append(shell);
    document.body.append(backdrop);
    conferencePopoutBackdrop = backdrop;
    conferenceToggle.setAttribute('aria-expanded', 'true');
    conferenceToggle.classList.add('events-finder__conferences-toggle--open');

    const finishClose = () => {
      opts.onClose?.();
      closeConferencePopout();
    };
    closeBtn.addEventListener('click', finishClose);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finishClose();
    });
    conferencePopoutKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finishClose();
      }
    };
    document.addEventListener('keydown', conferencePopoutKeyHandler);
    closeBtn.focus();
  }

  function syncConferenceToggleLabel() {
    const count = readConferenceWatchlistFromForm().length;
    conferenceToggle.textContent = count > 0 ? `Big events (${count})` : 'Big events';
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function conferenceUrlStatusLabel(item) {
    return item.urlFound ? 'Found' : 'Not found';
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function conferenceDataStatusLabel(item) {
    switch (item.dataFetched) {
      case 'fetching':
        return 'Fetching…';
      case 'fetched':
        return 'Fetched';
      case 'failed':
        return 'Failed';
      default:
        return 'Pending';
    }
  }

  /**
   * @param {object} item
   * @returns {string}
   */
  function conferenceDisplayStatusLabel(item) {
    return item.displayActive ? 'Active' : 'Inactive';
  }

  /** Ticket text for a table row / detail. */
  function bigEventTicketText(item) {
    if (item.researching) return 'Looking up…';
    if (item.ticketLabel) return String(item.ticketLabel);
    if (item.ticketPrice) return String(item.ticketPrice);
    if (item.dataFetched === 'failed' || item.error) return 'Not found';
    return '—';
  }

  /**
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildBigEventRow(item) {
    if (pendingBigEventDeletes.has(String(item?.slug || ''))) {
      return buildBigEventRemovingRow(item);
    }
    const row = document.createElement('tr');
    row.className = 'events-finder__big-events-row';

    // Event name (+ optional flier thumb) links straight to the official site —
    // no secondary detail popup.
    const nameCell = document.createElement('td');
    nameCell.className = 'events-finder__big-events-cell events-finder__big-events-cell--name';
    const rowUrl = String(item.homepageUrl || item.url || '').trim();
    const nameEl = document.createElement(rowUrl ? 'a' : 'span');
    nameEl.className = 'events-finder__big-events-name';
    if (rowUrl) {
      nameEl.href = rowUrl;
      nameEl.target = '_blank';
      nameEl.rel = 'noopener noreferrer';
      nameEl.title = 'Open official site';
    }
    const rowThumb = item.flierImageUrl || item.flierUrl || item.screenshotUrl;
    if (rowThumb) {
      const thumb = document.createElement('img');
      thumb.className = 'events-finder__big-events-thumb';
      thumb.src = String(rowThumb);
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      nameEl.append(thumb);
    }
    const nameText = document.createElement('span');
    nameText.className = 'events-finder__big-events-name-text';
    nameText.textContent = String(item.title || item.query || 'Big event');
    nameEl.append(nameText);
    nameCell.append(nameEl);

    // Dates — stack the end date on its own line so this column stays narrow.
    const dateCell = document.createElement('td');
    dateCell.className = 'events-finder__big-events-cell events-finder__big-events-cell--dates';
    const whenLabel = String(item.whenLabel || (item.researching ? 'Looking up…' : 'Dates TBD'));
    const dateParts = whenLabel.split(' – ');
    if (dateParts.length === 2) {
      const startLine = document.createElement('span');
      startLine.className = 'events-finder__big-events-date-line';
      startLine.textContent = dateParts[0];
      const endLine = document.createElement('span');
      endLine.className = 'events-finder__big-events-date-line';
      endLine.textContent = `– ${dateParts[1]}`;
      dateCell.append(startLine, endLine);
    } else {
      dateCell.textContent = whenLabel;
    }

    // Ticket price (+ estimated badge + early bird note).
    const priceCell = document.createElement('td');
    priceCell.className = 'events-finder__big-events-cell events-finder__big-events-cell--price';
    const priceWrap = document.createElement('div');
    priceWrap.className = 'events-finder__big-events-pricewrap';
    const priceMain = document.createElement('span');
    priceMain.className = 'events-finder__big-events-price';
    priceMain.textContent = item.priceEstimated && item.ticketPrice
      ? String(item.ticketPrice)
      : bigEventTicketText(item);
    priceWrap.append(priceMain);
    if (item.priceEstimated) {
      const badge = document.createElement('span');
      badge.className = 'events-finder__big-events-badge events-finder__big-events-badge--est';
      badge.textContent = 'estimated from last year';
      priceWrap.append(badge);
    }
    if (item.earlyBirdNote) {
      const eb = document.createElement('span');
      eb.className = 'events-finder__big-events-earlybird';
      eb.textContent = String(item.earlyBirdNote);
      priceWrap.append(eb);
    } else if (item.earlyBirdLine && item.earlyBirdKind !== 'price') {
      const eb = document.createElement('span');
      eb.className = 'events-finder__big-events-earlybird';
      eb.textContent = String(item.earlyBirdLine);
      priceWrap.append(eb);
    } else if (item.salesStartLine) {
      const sl = document.createElement('span');
      sl.className = 'events-finder__big-events-earlybird';
      sl.textContent = String(item.salesStartLine);
      priceWrap.append(sl);
    }
    if (item.ticketUrl) {
      const tlink = document.createElement('a');
      tlink.className = 'events-finder__big-events-ticketlink';
      tlink.href = String(item.ticketUrl);
      tlink.target = '_blank';
      tlink.rel = 'noopener noreferrer';
      tlink.textContent = 'Tickets ↗';
      tlink.addEventListener('click', (e) => e.stopPropagation());
      priceWrap.append(tlink);
    }
    priceCell.append(priceWrap);

    // Ticket sales status.
    const statusCell = document.createElement('td');
    statusCell.className = 'events-finder__big-events-cell events-finder__big-events-cell--status';
    const statusPill = document.createElement('span');
    statusPill.className = `events-finder__big-events-status events-finder__big-events-status--${item.salesStatusKind || 'unknown'}`;
    statusPill.textContent = String(item.salesStatus || '—');
    statusCell.append(statusPill);

    // Edit + Remove.
    const actionCell = document.createElement('td');
    actionCell.className = 'events-finder__big-events-cell events-finder__big-events-cell--action';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'events-finder__big-events-edit-btn';
    editBtn.setAttribute('aria-label', `Edit ${item.title || item.query || 'event'}`);
    editBtn.title = 'Edit details';
    editBtn.textContent = 'Edit';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'events-finder__big-events-remove';
    del.setAttribute('aria-label', `Remove ${item.title || item.query || 'event'}`);
    del.title = 'Remove';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      scheduleBigEventDelete(item);
    });
    actionCell.append(editBtn, del);

    // Description.
    const descCell = document.createElement('td');
    descCell.className = 'events-finder__big-events-cell events-finder__big-events-cell--desc';
    const descText = String(item.notes || '').trim();
    if (descText) {
      descCell.textContent = descText;
    } else {
      descCell.textContent = item.researching ? 'Looking up…' : '—';
      descCell.classList.add('muted');
    }
    if (item.manualEdit) {
      const editedTag = document.createElement('span');
      editedTag.className = 'events-finder__big-events-edited-tag';
      editedTag.textContent = 'edited';
      editedTag.title = 'Hand-edited — auto research is paused for this event';
      descCell.append(document.createElement('br'), editedTag);
    }

    row.append(nameCell, dateCell, priceCell, statusCell, descCell, actionCell);

    // Inline editor row (spans the full table), toggled by the Edit button.
    const editorRow = buildBigEventEditorRow(item);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editorRow.hidden = !editorRow.hidden;
      editBtn.classList.toggle('events-finder__big-events-edit-btn--on', !editorRow.hidden);
      if (!editorRow.hidden) {
        const first = editorRow.querySelector('input, textarea');
        if (first instanceof HTMLElement) first.focus();
      }
    });

    const frag = document.createDocumentFragment();
    frag.append(row, editorRow);
    return frag;
  }

  /**
   * Compact inline editor row for one big event's metadata. Saving hand-edits
   * the record (locks it from auto-research); "Re-research" discards edits.
   * @param {object} item
   * @returns {HTMLTableRowElement}
   */
  function buildBigEventEditorRow(item) {
    const tr = document.createElement('tr');
    tr.className = 'events-finder__big-events-editrow';
    tr.hidden = true;
    const td = document.createElement('td');
    td.colSpan = 6;
    const wrap = document.createElement('div');
    wrap.className = 'events-finder__big-events-edit';

    /**
     * @param {string} label
     * @param {'text'|'url'|'date'|'textarea'} type
     * @param {string} value
     * @param {boolean} [wide]
     */
    const field = (label, type, value, wide) => {
      const lab = document.createElement('label');
      lab.className = `events-finder__big-events-edit-field${wide ? ' events-finder__big-events-edit-field--wide' : ''}`;
      const span = document.createElement('span');
      span.className = 'events-finder__big-events-edit-label';
      span.textContent = label;
      const input =
        type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
      if (input instanceof HTMLInputElement) input.type = type;
      input.className = 'events-finder__big-events-edit-input';
      input.value = value == null ? '' : String(value);
      lab.append(span, input);
      wrap.append(lab);
      return input;
    };

    const startVal = item.eventStart || (item.start ? String(item.start).slice(0, 10) : '');
    const endVal = item.eventEnd || (item.end ? String(item.end).slice(0, 10) : '');

    const nameI = field('Name', 'text', item.title || item.query || '', true);
    const urlI = field('Official site URL', 'url', item.homepageUrl || item.url || '', true);
    const ticketI = field('Tickets URL', 'url', item.ticketUrl || '', true);
    const startI = field('Start date', 'date', startVal);
    const endI = field('End date', 'date', endVal);
    const venueI = field('Venue', 'text', item.venue || '');
    const cityI = field('City', 'text', item.city || '');
    const priceI = field('Ticket price', 'text', item.ticketPrice || '');
    const salesI = field('On-sale date', 'date', item.ticketSalesStart || '');
    const ebPriceI = field('Early bird price', 'text', item.earlyBirdPrice || '');
    const ebStartI = field('Early bird start', 'date', item.earlyBirdStart || '');
    const ebEndI = field('Early bird end', 'date', item.earlyBirdEnd || '');
    const notesI = field('Description', 'textarea', item.notes || '', true);

    const actions = document.createElement('div');
    actions.className = 'events-finder__big-events-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'events-finder__big-events-confirm';
    saveBtn.textContent = 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'events-finder__big-events-again';
    cancelBtn.textContent = 'Cancel';
    const researchBtn = document.createElement('button');
    researchBtn.type = 'button';
    researchBtn.className = 'events-finder__big-events-again';
    researchBtn.textContent = 'Enrich';
    researchBtn.title = 'Discard manual edits and re-fetch from the web';
    const editMsg = document.createElement('span');
    editMsg.className = 'events-finder__big-events-edit-msg muted';
    actions.append(saveBtn, cancelBtn, researchBtn, editMsg);
    wrap.append(actions);

    const setMsg = (text, kind) => {
      editMsg.textContent = text || '';
      editMsg.className = `events-finder__big-events-edit-msg${kind === 'error' ? ' events-finder__big-events-edit-msg--error' : ' muted'}`;
    };

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tr.hidden = true;
    });

    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      setMsg('');
      try {
        const body = {
          name: nameI.value.trim(),
          homepageUrl: urlI.value.trim(),
          ticketUrl: ticketI.value.trim(),
          eventStart: startI.value,
          eventEnd: endI.value,
          venue: venueI.value.trim(),
          city: cityI.value.trim(),
          ticketPrice: priceI.value.trim(),
          ticketSalesStart: salesI.value,
          earlyBirdPrice: ebPriceI.value.trim(),
          earlyBirdStart: ebStartI.value,
          earlyBirdEnd: ebEndI.value,
          notes: notesI.value.trim(),
        };
        const res = await fetch(
          `/api/events-finder/big-events/${encodeURIComponent(item.slug)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        tr.hidden = true; // close editor so the refresh below can repaint
        void refreshBigEventsFromStore();
        reloadBigEventsSoon();
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        setMsg(`Could not save: ${String(err?.message || err)}`, 'error');
      }
    });

    researchBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm('Discard manual edits and re-fetch this event from the web?')) return;
      researchBtn.disabled = true;
      setMsg('Enriching… this can take a moment.');
      try {
        const res = await fetch('/api/events-finder/big-events/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: item.query || item.title }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setTimeout(() => {
          tr.hidden = true; // close editor so the refresh can repaint
          void refreshBigEventsFromStore();
          reloadBigEventsSoon();
        }, 4000);
      } catch (err) {
        researchBtn.disabled = false;
        setMsg(`Could not enrich: ${String(err?.message || err)}`, 'error');
      }
    });

    td.append(wrap);
    tr.append(td);
    return tr;
  }

  /**
   * @param {object[]} items
   * @param {HTMLElement} tbody
   */
  function paintBigEventsTable(items, tbody) {
    tbody.replaceChildren();
    if (!items.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'events-finder__big-events-empty muted';
      td.textContent = 'No big events tracked yet — add one above.';
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const item of items) tbody.append(buildBigEventRow(item));
  }

  /**
   * @returns {object[]}
   */
  function conferenceWatchItemsFromPayload() {
    const raw = lastEventsPayload?.conferenceWatchlistItems;
    if (Array.isArray(raw)) return raw;
    return [];
  }

  function syncConferenceNamesFromPayload() {
    const names = Array.isArray(lastEventsPayload?.conferenceWatchlist)
      ? lastEventsPayload.conferenceWatchlist.map(String)
      : null;
    if (names) {
      conferenceInput.value = names.join('\n');
      if (taste) taste.conferenceWatchlist = names;
      syncConferenceToggleLabel();
    }
  }

  /**
   * True while the user has a row's edit form open. Background refreshes must
   * not repaint the table then, or they'd collapse the form and wipe edits.
   */
  function isBigEventEditorOpen() {
    return Boolean(
      conferencePopoutStatusList
        && conferencePopoutStatusList.querySelector(
          '.events-finder__big-events-editrow:not([hidden])',
        ),
    );
  }

  function refreshConferencePopoutIfOpen() {
    syncConferenceNamesFromPayload();
    if (!conferencePopoutStatusList || isBigEventEditorOpen()) return;
    paintBigEventsTable(conferenceWatchItemsFromPayload(), conferencePopoutStatusList);
  }

  /**
   * Load the tracked Big Events straight from their own persistent store. This
   * keeps the list visible across page refreshes / deploys and even when the
   * main events feed hasn't loaded yet (or failed), because it reads the saved
   * watchlist directly instead of waiting on a full scrape.
   */
  async function refreshBigEventsFromStore() {
    try {
      const res = await fetch('/api/events-finder/big-events/', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !Array.isArray(data.items)) return;
      if (lastEventsPayload) lastEventsPayload.conferenceWatchlistItems = data.items;
      // Don't clobber an open edit form; the fresh data is cached above and
      // will paint once the form closes.
      if (conferencePopoutStatusList && !isBigEventEditorOpen()) {
        paintBigEventsTable(data.items, conferencePopoutStatusList);
      }
    } catch {
      /* keep whatever is already painted from cache */
    }
  }

  /**
   * Re-pull the tracked list + feed a few times so async research (dates, price,
   * flier) fills the popout table and surfaces the sidebar card once ready.
   */
  function reloadBigEventsSoon() {
    void refreshBigEventsFromStore();
    void loadEvents({ catalogOnly: true, quiet: true });
    for (const delay of [5000, 12000, 25000, 40000]) {
      setTimeout(() => {
        if (conferencePopoutStatusList) void refreshBigEventsFromStore();
        void loadEvents({ catalogOnly: true, quiet: true });
      }, delay);
    }
  }

  /**
   * POST a big-event feed-card action (snooze / skip / restore), then refresh
   * the tracked table + feed so the card disappears (or returns) immediately.
   * @param {object} item
   * @param {'snooze' | 'skip' | 'restore'} action
   */
  async function bigEventCardAction(item, action) {
    const slug = String(item?.slug || '').trim();
    if (!slug) return;
    try {
      const res = await fetch(
        `/api/events-finder/big-events/${encodeURIComponent(slug)}/${action}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      void refreshBigEventsFromStore();
      void loadEvents({ catalogOnly: true, quiet: true });
    } catch (e) {
      console.warn('[big-events] action failed:', action, e?.message || e);
    }
  }

  /** Repaint the tracked table from the cached payload (instant, no network). */
  function repaintBigEventsTable() {
    if (conferencePopoutStatusList) {
      paintBigEventsTable(conferenceWatchItemsFromPayload(), conferencePopoutStatusList);
    }
  }

  /**
   * "Removing" placeholder row shown for the 3s undo window. Renders inside the
   * table so it survives repaints.
   * @param {object} item
   * @returns {HTMLTableRowElement}
   */
  function buildBigEventRemovingRow(item) {
    const row = document.createElement('tr');
    row.className = 'events-finder__big-events-row events-finder__big-events-row--removing';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'events-finder__big-events-removing';
    const label = document.createElement('span');
    label.className = 'events-finder__big-events-removing-label';
    label.textContent = `Removed “${item.title || item.query || 'event'}”`;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'events-finder__big-events-undo';
    undo.textContent = 'Undo';
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      undoBigEventDelete(item);
    });
    cell.append(label, undo);
    row.append(cell);
    return row;
  }

  /** Start a 3s soft-delete for one event (no confirm dialog; Undo available). */
  function scheduleBigEventDelete(item) {
    const slug = String(item?.slug || '').trim();
    if (!slug || pendingBigEventDeletes.has(slug)) return;
    const timer = setTimeout(() => {
      void commitBigEventDelete(item);
    }, BIG_EVENT_DELETE_DELAY_MS);
    pendingBigEventDeletes.set(slug, timer);
    repaintBigEventsTable();
  }

  /** Cancel a pending soft-delete and restore the row. */
  function undoBigEventDelete(item) {
    const slug = String(item?.slug || '').trim();
    const timer = pendingBigEventDeletes.get(slug);
    if (timer) clearTimeout(timer);
    pendingBigEventDeletes.delete(slug);
    repaintBigEventsTable();
  }

  /** Actually delete the event once the undo window elapses. */
  async function commitBigEventDelete(item) {
    const slug = String(item?.slug || '').trim();
    if (!slug) return;
    pendingBigEventDeletes.delete(slug);
    try {
      const res = await fetch(`/api/events-finder/big-events/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      void refreshBigEventsFromStore();
      void loadEvents({ catalogOnly: true, quiet: true });
    } catch (e) {
      window.alert(`Could not remove: ${String(e?.message || e)}`);
      void refreshBigEventsFromStore();
    }
  }

  function openConferenceWatchlistPopout() {
    const wrap = document.createElement('div');
    wrap.className = 'events-finder__big-events';

    // --- Add event flow ---------------------------------------------------
    const addBar = document.createElement('div');
    addBar.className = 'events-finder__big-events-addbar';
    const addToggle = document.createElement('button');
    addToggle.type = 'button';
    addToggle.className = 'events-finder__big-events-add';
    addToggle.textContent = '+ Add event';

    const form = document.createElement('div');
    form.className = 'events-finder__big-events-form';
    form.hidden = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'events-finder__big-events-input';
    input.placeholder = 'e.g. open sauce';
    input.autocomplete = 'off';
    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.className = 'events-finder__big-events-input events-finder__big-events-input--url';
    urlInput.placeholder = 'Event URL (optional — paste if you already have it)';
    urlInput.autocomplete = 'off';
    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'events-finder__big-events-search';
    searchBtn.textContent = 'Search';
    const manualBtn = document.createElement('button');
    manualBtn.type = 'button';
    manualBtn.className = 'events-finder__big-events-again';
    manualBtn.textContent = 'Add manually';
    manualBtn.title = 'Skip search — add by name (and optional URL), then fill details in Edit';
    form.append(input, searchBtn, manualBtn, urlInput);

    const msg = document.createElement('p');
    msg.className = 'events-finder__big-events-msg muted';
    msg.hidden = true;

    const preview = document.createElement('div');
    preview.className = 'events-finder__big-events-preview';
    preview.hidden = true;

    addBar.append(addToggle);

    // --- Tracked table ----------------------------------------------------
    const tableWrap = document.createElement('div');
    tableWrap.className = 'events-finder__big-events-table-wrap';
    const table = document.createElement('table');
    table.className = 'events-finder__big-events-table';
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr><th>Event</th><th>Dates</th><th>Ticket price</th><th>Ticket sales</th><th>Description</th><th aria-label="Remove"></th></tr>';
    const tbody = document.createElement('tbody');
    conferencePopoutStatusList = tbody;
    paintBigEventsTable(conferenceWatchItemsFromPayload(), tbody);
    // Always confirm against the persistent store so a stale/empty feed payload
    // never leaves the list looking wiped after a refresh or deploy.
    void refreshBigEventsFromStore();
    table.append(thead, tbody);
    tableWrap.append(table);

    wrap.append(addBar, form, msg, preview, tableWrap);

    /** @type {{ query: string, url: string|null, homepageUrl?: string|null, ticketUrl?: string|null, screenshotPath?: string|null, manual?: boolean }|null} */
    let pendingPreview = null;

    function setMsg(text, kind) {
      msg.hidden = !text;
      msg.textContent = text || '';
      msg.className = `events-finder__big-events-msg${kind ? ` events-finder__big-events-msg--${kind}` : ' muted'}`;
    }

    function showAddForm() {
      form.hidden = false;
      addToggle.hidden = true;
      input.focus();
    }

    /** Prefix a bare host with https:// so a pasted URL is usable. */
    function normalizeManualUrl(raw) {
      const v = String(raw || '').trim();
      if (!v) return '';
      return /^https?:\/\//i.test(v) ? v : `https://${v}`;
    }

    function resetAddFlow() {
      form.hidden = true;
      addToggle.hidden = false;
      preview.hidden = true;
      preview.replaceChildren();
      pendingPreview = null;
      input.value = '';
      urlInput.value = '';
      setMsg('');
    }

    /**
     * Skip web search — add by name (optional URL). Use for invite-only /
     * unlisted events that search cannot find.
     */
    function startManualAdd() {
      const query = input.value.trim();
      if (!query) {
        input.focus();
        return;
      }
      const manualUrl = normalizeManualUrl(urlInput.value) || null;
      pendingPreview = {
        query,
        url: manualUrl,
        homepageUrl: manualUrl,
        ticketUrl: null,
        manual: true,
      };
      renderPreview({
        name: query,
        query,
        url: manualUrl,
        homepageUrl: manualUrl,
        urlFound: Boolean(manualUrl),
        manual: true,
        deep: true,
        candidates: [],
        confident: true,
      });
      setMsg('');
    }

    /** Search the web for an official site (default add path). */
    function submitAdd() {
      void runSearch();
    }

    async function runSearch(deep = false) {
      const query = input.value.trim();
      if (!query) {
        input.focus();
        return;
      }
      searchBtn.disabled = true;
      searchBtn.textContent = 'Searching…';
      setMsg(deep ? 'Digging deeper for the official site…' : 'Searching the web for the official site…');
      preview.hidden = true;
      preview.replaceChildren();
      try {
        const res = await fetch('/api/events-finder/big-events/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, deep }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const candidates = Array.isArray(data.preview?.candidates) ? data.preview.candidates : [];
        const pickUrl = data.preview?.homepageUrl || data.preview?.url || candidates[0]?.url || null;
        pendingPreview = {
          query,
          url: pickUrl,
          homepageUrl: pickUrl,
          ticketUrl: data.preview?.ticketUrl || null,
        };
        renderPreview({ ...(data.preview || {}), deep, candidates });
        setMsg('');
      } catch (e) {
        setMsg(`Search failed: ${String(e?.message || e)}`, 'error');
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
      }
    }

    function renderPreview(p) {
      preview.replaceChildren();
      preview.hidden = false;
      const isManual = p.manual === true || pendingPreview?.manual === true;

      const nameEl = document.createElement('p');
      nameEl.className = 'events-finder__big-events-preview-name';
      nameEl.textContent = String(p.name || p.query || '');
      preview.append(nameEl);

      const candidates = Array.isArray(p.candidates)
        ? p.candidates.filter((c) => c && c.url)
        : [];
      const unsure = !isManual && p.confident !== true && candidates.length >= 2;
      const urlFound = Boolean(p.url) || candidates.length > 0;

      if (isManual) {
        const hint = document.createElement('p');
        hint.className = 'events-finder__big-events-preview-hint muted';
        hint.textContent = urlFound
          ? 'Manual add — will scrape this URL for details (no web search).'
          : 'Manual add — no site yet. Add it, then use Edit to fill dates, price, and a URL.';
        preview.append(hint);
        if (urlFound) {
          const link = document.createElement('a');
          link.className = 'events-finder__big-events-preview-url';
          link.href = String(p.url || '');
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = String(p.url || '');
          preview.append(link);
        }
      } else if (unsure) {
        const hint = document.createElement('p');
        hint.className = 'events-finder__big-events-preview-hint muted';
        hint.textContent = 'Not sure which site is official — pick one:';
        preview.append(hint);
        const list = document.createElement('div');
        list.className = 'events-finder__big-events-candidates';
        list.setAttribute('role', 'radiogroup');
        list.setAttribute('aria-label', 'Official site candidates');
        const selected = String(pendingPreview?.homepageUrl || pendingPreview?.url || candidates[0].url);
        candidates.forEach((c, i) => {
          const label = document.createElement('label');
          label.className = 'events-finder__big-events-candidate';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'big-event-site-candidate';
          radio.value = String(c.url);
          radio.checked = String(c.url) === selected || (!selected && i === 0);
          radio.addEventListener('change', () => {
            if (!pendingPreview || !radio.checked) return;
            pendingPreview.url = String(c.url);
            pendingPreview.homepageUrl = String(c.url);
          });
          const body = document.createElement('span');
          body.className = 'events-finder__big-events-candidate-body';
          const title = document.createElement('span');
          title.className = 'events-finder__big-events-candidate-title';
          title.textContent = String(c.title || c.url);
          const link = document.createElement('a');
          link.className = 'events-finder__big-events-candidate-url';
          link.href = String(c.url);
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = String(c.url);
          link.addEventListener('click', (e) => e.stopPropagation());
          body.append(title, link);
          label.append(radio, body);
          list.append(label);
        });
        preview.append(list);
        if (pendingPreview && !pendingPreview.homepageUrl) {
          pendingPreview.url = String(candidates[0].url);
          pendingPreview.homepageUrl = String(candidates[0].url);
        }
      } else if (urlFound) {
        const link = document.createElement('a');
        link.className = 'events-finder__big-events-preview-url';
        link.href = String(p.url || candidates[0]?.url || '');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = String(p.url || candidates[0]?.url || '');
        preview.append(link);
      } else {
        const noUrl = document.createElement('p');
        noUrl.className = 'events-finder__big-events-preview-url muted';
        noUrl.textContent = p.deep
          ? 'Still no official site found. Add anyway, or switch to manual and paste a URL.'
          : 'No official site found — try “Search deeper”, or add manually.';
        preview.append(noUrl);
      }

      if (!isManual && p.ticketUrl && p.ticketUrl !== (pendingPreview?.url || p.url)) {
        const tlink = document.createElement('a');
        tlink.className = 'events-finder__big-events-preview-url events-finder__big-events-preview-tickets';
        tlink.href = String(p.ticketUrl);
        tlink.target = '_blank';
        tlink.rel = 'noopener noreferrer';
        tlink.textContent = 'Tickets ↗';
        preview.append(tlink);
      }

      const actions = document.createElement('div');
      actions.className = 'events-finder__big-events-preview-actions';
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'events-finder__big-events-confirm';
      confirmBtn.textContent = isManual
        ? 'Add event'
        : unsure
          ? 'Add selected'
          : 'Add event';
      confirmBtn.addEventListener('click', () => void confirmAdd(confirmBtn));
      actions.append(confirmBtn);

      // Offer a deeper search when unsure or when nothing was found.
      if (!isManual && (!urlFound || unsure) && !p.deep) {
        const deeperBtn = document.createElement('button');
        deeperBtn.type = 'button';
        deeperBtn.className = 'events-finder__big-events-again';
        deeperBtn.textContent = 'Search deeper';
        deeperBtn.addEventListener('click', () => void runSearch(true));
        actions.append(deeperBtn);
      }

      // Wrong / missing search hits → bail to name±URL without picking a junk site.
      if (!isManual && (unsure || !urlFound)) {
        const noneBtn = document.createElement('button');
        noneBtn.type = 'button';
        noneBtn.className = 'events-finder__big-events-again';
        noneBtn.textContent = unsure ? 'None of these' : 'Add manually';
        noneBtn.title = 'Skip these results — add by name (optional URL)';
        noneBtn.addEventListener('click', () => {
          urlInput.value = '';
          startManualAdd();
          urlInput.focus();
        });
        actions.append(noneBtn);
      }

      const againBtn = document.createElement('button');
      againBtn.type = 'button';
      againBtn.className = 'events-finder__big-events-again';
      againBtn.textContent = isManual ? 'Cancel' : 'Edit search';
      againBtn.addEventListener('click', () => {
        preview.hidden = true;
        preview.replaceChildren();
        pendingPreview = null;
        input.focus();
        input.select();
      });
      actions.append(againBtn);
      preview.append(actions);
    }

    async function confirmAdd(btn) {
      if (!pendingPreview) return;
      btn.disabled = true;
      btn.textContent = 'Adding…';
      const wasManual = pendingPreview.manual === true;
      const hadUrl = Boolean(pendingPreview.url || pendingPreview.homepageUrl);
      try {
        const res = await fetch('/api/events-finder/big-events/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pendingPreview),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        resetAddFlow();
        if (wasManual && !hadUrl) {
          setMsg('Added — open Edit on the row to fill dates, price, and a URL.');
        } else {
          setMsg('Added — looking up dates, price, and early bird…');
        }
        setTimeout(() => setMsg(''), 8000);
        reloadBigEventsSoon();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Add event';
        setMsg(`Could not add: ${String(e?.message || e)}`, 'error');
      }
    }

    addToggle.addEventListener('click', showAddForm);
    searchBtn.addEventListener('click', () => submitAdd());
    manualBtn.addEventListener('click', () => startManualAdd());
    const onAddEnter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // URL field focus → treat as manual (paste-then-enter); name field → search.
        if (document.activeElement === urlInput) startManualAdd();
        else submitAdd();
      }
    };
    input.addEventListener('keydown', onAddEnter);
    urlInput.addEventListener('keydown', onAddEnter);

    openConferencePopout({
      title: 'Big events',
      body: wrap,
      onClose: () => {
        conferencePopoutStatusList = null;
      },
    });
  }

  conferenceToggle.addEventListener('click', () => {
    if (conferencePopoutBackdrop) closeConferencePopout();
    else openConferenceWatchlistPopout();
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let conferenceAutosaveTimer = null;

  conferenceInput.addEventListener('input', () => {
    if (!filtersReady || applyingCriteria) return;
    if (conferenceAutosaveTimer) clearTimeout(conferenceAutosaveTimer);
    conferenceAutosaveTimer = setTimeout(() => {
      conferenceAutosaveTimer = null;
      void autosaveConferenceWatchlist();
    }, FILTER_AUTOSAVE_MS);
  });

  const filterActions = document.createElement('div');
  filterActions.className = 'events-finder__filter-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'events-finder__save';
  saveBtn.textContent = 'Save';

  const showSkippedBtn = document.createElement('button');
  showSkippedBtn.type = 'button';
  showSkippedBtn.className = 'events-finder__show-skipped';
  showSkippedBtn.textContent = 'Show skipped';
  showSkippedBtn.title = 'Recover events you accidentally skipped';
  showSkippedBtn.setAttribute('aria-pressed', 'false');

  const filterMsg = document.createElement('p');
  filterMsg.className = 'events-finder__msg';
  filterMsg.hidden = true;
  filterMsg.setAttribute('aria-live', 'polite');

  filterActions.append(saveBtn, showSkippedBtn, filterMsg);
  filterPanel.append(filterActions);

  const listEl = document.createElement('div');
  listEl.className = 'events-finder__list';
  listEl.setAttribute('aria-live', 'polite');
  const listStatus = document.createElement('p');
  listStatus.className = 'events-finder__stub muted';
  listStatus.textContent = 'Loading events…';
  listEl.append(listStatus);

  root.append(toolbar, filterPanel, listEl);

  /** @type {{ lookFor: string, skip: string, blacklist: string, scrape?: object, hiddenEventIds: string[], skippedEvents: object[], favoriteEventIds: string[], calendarAddedEventIds: string[], conferenceWatchlist: string[] } | null} */
  let taste = null;
  let filtersReady = false;
  /** Suppress autosave while applying server/cache criteria into the form. */
  let applyingCriteria = false;
  let showSkipped = readShowSkipped();
  let saveInFlight = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let filterAutosaveTimer = null;
  /** @type {boolean} */
  let filterAutosaveReload = false;
  /** @type {any} */
  let mapInstance = null;
  /** @type {any} */
  let markersLayer = null;
  /** @type {{ lat: number, lng: number, zoom: number } | null} */
  let mapViewBeforePopup = null;
  /** True after the first fitBounds/setView for this map instance. */
  let mapDidInitialFit = false;
  /** @type {number} */
  let mapSyncGen = 0;
  /** @type {HTMLElement | null} */
  let mapBackdrop = null;
  /** @type {HTMLElement | null} */
  let mapNoteEl = null;
  /** @type {HTMLElement | null} */
  let mapMountEl = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let mapKeyHandler = null;
  /** @type {object[]} */
  let lastFilteredEvents = [];
  /** @type {string} */
  let lastCriteriaSaveError = '';
  /** @type {Promise<void>} */
  let saveIdleWait = Promise.resolve();
  /** @type {(() => void) | null} */
  let saveIdleResolve = null;
  /** @type {object | null} */
  let lastEventsPayload = null;

  /**
   * @param {string} iso
   */
  function formatWhen(iso) {
    if (!iso) return 'Date TBD';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return 'Date TBD';
    try {
      return new Date(ms).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return String(iso);
    }
  }

  /**
   * @param {object} ev
   * @returns {{ lat: number, lon: number } | null}
   */
  function eventCoords(ev) {
    const lat = Number(ev?.lat);
    const lon = Number(ev?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    // Null Island (0,0) = missing geo from APIs — do not pin the map in the Atlantic.
    if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return null;
    return { lat, lon };
  }

  /** Round coords so near-identical venue pins group together (~11 m). */
  function coordGroupKey(lat, lon) {
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
  }

  /**
   * Fan co-located pins into a small circle so each is clickable.
   * @param {number} lat
   * @param {number} lon
   * @param {number} index
   * @param {number} total
   * @returns {[number, number]}
   */
  function offsetCoLocatedPin(lat, lon, index, total) {
    if (total <= 1) return [lat, lon];
    // ~28 m base radius; grow slightly when many share a spot so markers don't stack.
    const radiusM = 28 + Math.max(0, total - 4) * 6;
    const angle = (2 * Math.PI * index) / total - Math.PI / 2;
    const metersPerDegLat = 111320;
    const metersPerDegLon = Math.max(1e-6, 111320 * Math.cos((lat * Math.PI) / 180));
    return [
      lat + (radiusM * Math.sin(angle)) / metersPerDegLat,
      lon + (radiusM * Math.cos(angle)) / metersPerDegLon,
    ];
  }

  /**
   * @param {object} ev
   * @returns {HTMLElement}
   */
  function buildMapPopup(ev) {
    const wrap = document.createElement('div');
    wrap.className = 'events-finder__map-popup';
    wrap.append(buildEventCard(ev, { skippedMode: showSkipped, mapPopup: true }));
    return wrap;
  }

  /**
   * @param {object[]} events
   * @param {object | null} data
   * @returns {Promise<void>}
   */
  function syncMap(events, data) {
    if (!mapBackdrop || !mapMountEl) return Promise.resolve();
    const gen = ++mapSyncGen;
    const mappable = events.filter((ev) => eventCoords(ev));
    const unmapped = events.length - mappable.length;
    if (mapNoteEl) {
      mapNoteEl.hidden = false;
      if (!events.length) {
        mapNoteEl.textContent = 'No events to show on the map.';
      } else if (!mappable.length) {
        mapNoteEl.textContent = 'No mapped locations for these events (missing coordinates).';
      } else if (unmapped > 0) {
        mapNoteEl.textContent = `${mappable.length} on map · ${unmapped} without coordinates`;
      } else {
        mapNoteEl.textContent = `${mappable.length} event${mappable.length === 1 ? '' : 's'} on map`;
      }
    }
    if (!mappable.length) {
      if (markersLayer) markersLayer.clearLayers();
      return Promise.resolve();
    }

    return loadLeaflet()
      .then((L) => {
        if (gen !== mapSyncGen || !mapBackdrop || !mapMountEl) return;
        if (!mapInstance) {
          mapInstance = L.map(mapMountEl, {
            zoomControl: true,
            attributionControl: false,
          });
          L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '',
            subdomains: 'abcd',
            maxZoom: 18,
            minZoom: 3,
          }).addTo(mapInstance);
          markersLayer = L.layerGroup().addTo(mapInstance);
          // After a pin popup closes, return to the zoom/center from before the pin was opened.
          mapInstance.on('popupclose', () => {
            const saved = mapViewBeforePopup;
            if (!saved) return;
            requestAnimationFrame(() => {
              if (!mapInstance) return;
              // Switching pins closes then opens another popup — keep the original view.
              if (mapInstance.isPopupOpen()) return;
              mapViewBeforePopup = null;
              mapInstance.setView([saved.lat, saved.lng], saved.zoom, { animate: true });
            });
          });
        }
        markersLayer.clearLayers();
        /** @type {Map<string, { ev: object, c: { lat: number, lon: number } }[]>} */
        const byLocation = new Map();
        for (const ev of mappable) {
          const c = eventCoords(ev);
          if (!c) continue;
          const key = coordGroupKey(c.lat, c.lon);
          let group = byLocation.get(key);
          if (!group) {
            group = [];
            byLocation.set(key, group);
          }
          group.push({ ev, c });
        }
        /** @type {any[]} */
        const latLngs = [];
        for (const group of byLocation.values()) {
          const total = group.length;
          group.forEach(({ ev, c }, index) => {
            const ll = offsetCoLocatedPin(c.lat, c.lon, index, total);
            latLngs.push(ll);
            // Thin stem from true venue to offset pin when fanned out.
            if (total > 1) {
              L.polyline([[c.lat, c.lon], ll], {
                color: '#6ec8ff',
                weight: 1.5,
                opacity: 0.55,
                interactive: false,
              }).addTo(markersLayer);
            }
            const marker = L.circleMarker(ll, {
              radius: 8,
              color: '#6ec8ff',
              weight: 2,
              fillColor: '#7bffce',
              fillOpacity: 0.85,
            });
            marker.on('click', () => {
              if (!mapInstance || mapViewBeforePopup) return;
              const center = mapInstance.getCenter();
              mapViewBeforePopup = {
                lat: center.lat,
                lng: center.lng,
                zoom: mapInstance.getZoom(),
              };
            });
            marker.bindPopup(buildMapPopup(ev), {
              maxWidth: 340,
              minWidth: 280,
              className: 'events-finder__map-popup-tip',
              autoPanPadding: [36, 36],
            });
            markersLayer.addLayer(marker);
          });
        }
        const homeLat = Number(data?.geo?.lat);
        const homeLon = Number(data?.geo?.lon);
        // Keep the user's zoom/pan when markers refresh (e.g. Skip). Only frame once.
        if (!mapDidInitialFit) {
          const fit = () => {
            if (gen !== mapSyncGen || !mapInstance) return;
            mapInstance.invalidateSize();
            if (latLngs.length === 1) {
              mapInstance.setView(latLngs[0], 13);
            } else if (latLngs.length > 1) {
              mapInstance.fitBounds(L.latLngBounds(latLngs).pad(0.18), { maxZoom: 14 });
            } else if (Number.isFinite(homeLat) && Number.isFinite(homeLon)) {
              mapInstance.setView([homeLat, homeLon], 11);
            }
            mapDidInitialFit = true;
          };
          requestAnimationFrame(() => {
            fit();
            setTimeout(fit, 50);
            setTimeout(fit, 200);
          });
        } else {
          requestAnimationFrame(() => mapInstance?.invalidateSize());
        }
      })
      .catch(() => {
        if (gen !== mapSyncGen || !mapNoteEl) return;
        mapNoteEl.hidden = false;
        mapNoteEl.textContent = 'Could not load map library.';
      });
  }

  function destroyMapInstance() {
    mapSyncGen += 1;
    mapViewBeforePopup = null;
    mapDidInitialFit = false;
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
    markersLayer = null;
  }

  function closeMapWindow() {
    if (!mapBackdrop) return;
    endWaitCursor();
    destroyMapInstance();
    if (mapKeyHandler) {
      document.removeEventListener('keydown', mapKeyHandler);
      mapKeyHandler = null;
    }
    mapBackdrop.remove();
    mapBackdrop = null;
    mapNoteEl = null;
    mapMountEl = null;
    viewBtn.classList.remove('events-finder__view-toggle--on');
    viewBtn.setAttribute('aria-pressed', 'false');
    viewBtn.setAttribute('aria-label', 'Open events map');
  }

  /**
   * @param {MouseEvent | PointerEvent | null} [ev]
   */
  function openMapWindow(ev = null) {
    if (mapBackdrop) {
      void syncMap(lastFilteredEvents, lastEventsPayload);
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__map-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__map-window';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-labelledby', 'events-finder-map-title');

    const bar = document.createElement('div');
    bar.className = 'events-finder__map-window-bar';
    const title = document.createElement('h2');
    title.id = 'events-finder-map-title';
    title.className = 'events-finder__map-window-title';
    title.textContent = 'Events map';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'events-finder__map-window-close';
    closeBtn.setAttribute('aria-label', 'Close events map');
    closeBtn.title = 'Close';
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    bar.append(title, closeBtn);

    const note = document.createElement('p');
    note.className = 'events-finder__map-note muted';
    note.textContent = 'Loading map…';

    const mount = document.createElement('div');
    mount.className = 'events-finder__map';
    mount.setAttribute('role', 'img');
    mount.setAttribute('aria-label', 'Events map');

    shell.append(bar, note, mount);
    backdrop.append(shell);
    document.body.append(backdrop);

    mapBackdrop = backdrop;
    mapNoteEl = note;
    mapMountEl = mount;

    viewBtn.classList.add('events-finder__view-toggle--on');
    viewBtn.setAttribute('aria-pressed', 'true');
    viewBtn.setAttribute('aria-label', 'Close events map');

    closeBtn.addEventListener('click', closeMapWindow);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeMapWindow();
    });
    mapKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMapWindow();
      }
    };
    document.addEventListener('keydown', mapKeyHandler);
    closeBtn.focus();
    beginWaitCursor(ev);
    void syncMap(lastFilteredEvents, lastEventsPayload).finally(() => {
      endWaitCursor();
    });
  }

  function markSaveBusy() {
    if (!saveInFlight) {
      saveInFlight = true;
      saveIdleWait = new Promise((resolve) => {
        saveIdleResolve = resolve;
      });
    }
  }

  function markSaveIdle() {
    saveInFlight = false;
    const done = saveIdleResolve;
    saveIdleResolve = null;
    if (done) done();
    saveIdleWait = Promise.resolve();
  }

  /**
   * @returns {string[]}
   */
  function readConferenceWatchlistFromForm() {
    return String(conferenceInput.value || '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 30);
  }

  /**
   * Build browse filters from the form, or null if values are incomplete/invalid
   * (e.g. user still typing a ZIP).
   * @returns {Record<string, unknown> | null}
   */
  function readFiltersFromForm() {
    const originZipDigits = String(zipInput.value || '').replace(/\D/g, '').slice(0, 5);
    if (originZipDigits && originZipDigits.length !== 5) return null;
    const originZip = originZipDigits.length === 5 ? originZipDigits : '';
    const milesRaw = milesInput.value.trim();
    const maxMiles = milesRaw === '' ? 25 : Number(milesRaw);
    if (!Number.isFinite(maxMiles) || maxMiles <= 0 || maxMiles > 100) return null;
    const range = calendar.getRange();
    const earliestRaw = String(timeInput.value || '').trim();
    const earliest = normalizeLocalTime(earliestRaw);
    if (earliestRaw && !earliest) return null;
    return {
      cities: (() => {
        const selected = cityChecks.getSelected();
        const available = Array.isArray(lastEventsPayload?.availableCities)
          ? lastEventsPayload.availableCities
          : [];
        // Empty = all cities (no city filter). Only persist when a subset is checked.
        if (!available.length || selected.length === available.length) return [];
        return selected;
      })(),
      maxMiles,
      dates: range.dates || [],
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      earliestLocalTime: earliest || null,
      attendance: attendanceChecks.getAttendance(),
      originZip,
    };
  }

  /**
   * Debounced persist of browse filters so the last state survives reload.
   * @param {{ reload?: boolean }} [opts]
   */
  function scheduleFilterAutosave(opts = {}) {
    // Remember reload even if filters aren't ready yet (rapid date picks during boot).
    if (opts.reload) filterAutosaveReload = true;
    if (!filtersReady || applyingCriteria) return;
    if (filterAutosaveTimer) clearTimeout(filterAutosaveTimer);
    filterAutosaveTimer = setTimeout(() => {
      filterAutosaveTimer = null;
      void autosaveFilters();
    }, FILTER_AUTOSAVE_MS);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function autosaveFilters() {
    if (!filtersReady || applyingCriteria) return false;
    const reload = filterAutosaveReload;
    filterAutosaveReload = false;
    const filters = readFiltersFromForm();
    if (!filters) return false;
    const ok = await saveCriteria({
      silent: true,
      includeFilters: true,
      waitForIdle: true,
      filters,
    });
    if (ok && reload) {
      // Browse filters only — re-read SQLite catalog. Never kick off live ingest.
      void loadEvents({ catalogOnly: true, quiet: true });
    }
    return ok;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function autosaveConferenceWatchlist() {
    const conferenceWatchlist = readConferenceWatchlistFromForm();
    const ok = await saveCriteria({
      silent: true,
      conferenceWatchlist,
    });
    if (ok) void loadEvents({ catalogOnly: true, quiet: true });
    return ok;
  }

  /**
   * Wait until any in-flight criteria save finishes (for silent favorite/hide patches).
   * @param {number} [timeoutMs]
   */
  async function waitForSaveIdle(timeoutMs = 8000) {
    if (!saveInFlight) return;
    await Promise.race([
      saveIdleWait,
      new Promise((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  /**
   * Persist current taste + feed filters (and optional hidden/favorite ids).
   * @param {{ lookFor?: string, skip?: string, blacklist?: string, hiddenEventIds?: string[], skippedEvents?: object[], unskipEventIds?: string[], favoriteEventIds?: string[], calendarAddedEventIds?: string[], conferenceWatchlist?: string[], silent?: boolean, includeFilters?: boolean, filters?: Record<string, unknown>, waitForIdle?: boolean }} [patch]
   * @returns {Promise<boolean>}
   */
  async function saveCriteria(patch = {}) {
    if (!filtersReady) {
      lastCriteriaSaveError = 'Filters still loading — try again in a moment.';
      return false;
    }
    if (saveInFlight) {
      if (patch.waitForIdle || patch.silent) {
        await waitForSaveIdle();
        if (saveInFlight) {
          lastCriteriaSaveError = 'Another save is still running — try again.';
          return false;
        }
      } else {
        lastCriteriaSaveError = 'Another save is still running — try again.';
        return false;
      }
    }
    markSaveBusy();
    lastCriteriaSaveError = '';
    if (!patch.silent) {
      saveBtn.disabled = true;
      filterMsg.hidden = false;
      filterMsg.classList.remove('events-finder__msg--err');
      filterMsg.textContent = 'Saving…';
    }
    try {
      const lookFor = patch.lookFor ?? taste?.lookFor ?? '';
      const skip = patch.skip ?? taste?.skip ?? '';
      const blacklist = patch.blacklist ?? taste?.blacklist ?? '';
      /** @type {Record<string, unknown>} */
      const body = {
        lookFor,
        skip,
        blacklist,
        scrape: taste?.scrape,
      };
      // Only write favorites / calendar-added when this patch intends to change them
      // (or on explicit non-silent Save). Silent filter autosave must omit these so it
      // cannot clobber a concurrent heart / Add-to-Cal tap (lost-update race).
      if (patch.favoriteEventIds !== undefined) {
        body.favoriteEventIds = patch.favoriteEventIds;
      } else if (!patch.silent) {
        body.favoriteEventIds = taste?.favoriteEventIds ?? [];
      }
      if (patch.calendarAddedEventIds !== undefined) {
        body.calendarAddedEventIds = patch.calendarAddedEventIds;
      } else if (!patch.silent) {
        body.calendarAddedEventIds = taste?.calendarAddedEventIds ?? [];
      }
      if (patch.conferenceWatchlist !== undefined) {
        body.conferenceWatchlist = patch.conferenceWatchlist;
      } else if (!patch.silent) {
        body.conferenceWatchlist = taste?.conferenceWatchlist ?? readConferenceWatchlistFromForm();
      }
      // Silent taste/skip saves omit filters so they don't clobber ZIP/radius/dates.
      // Autosave and explicit Save pass includeFilters (or non-silent) to persist browse state.
      const writeFilters = !patch.silent || patch.includeFilters === true;
      if (writeFilters) {
        let filters = patch.filters || null;
        if (!filters) {
          filters = readFiltersFromForm();
          if (!filters) {
            const originZipDigits = String(zipInput.value || '').replace(/\D/g, '').slice(0, 5);
            if (originZipDigits && originZipDigits.length !== 5) {
              throw new Error('Enter a 5-digit ZIP (or leave blank).');
            }
            const milesRaw = milesInput.value.trim();
            const maxMiles = milesRaw === '' ? 25 : Number(milesRaw);
            if (!Number.isFinite(maxMiles) || maxMiles <= 0 || maxMiles > 100) {
              throw new Error('Set radius (1–100 miles), or leave blank for 25.');
            }
            const earliestRaw = String(timeInput.value || '').trim();
            if (earliestRaw && !normalizeLocalTime(earliestRaw)) {
              throw new Error('Earliest time must look like 11:00.');
            }
            throw new Error('Could not read filters.');
          }
        }
        body.filters = filters;
      }
      // Only send skip mutations when explicitly patching — filter-only saves must not
      // touch SQLite skips. Skips upsert; unskips delete by id (never full-table replace).
      if (Array.isArray(patch.unskipEventIds) && patch.unskipEventIds.length) {
        body.unskipEventIds = patch.unskipEventIds.map(String).filter(Boolean);
      }
      if (patch.skippedEvents !== undefined) {
        body.skippedEvents = patch.skippedEvents;
        body.hiddenEventIds =
          patch.hiddenEventIds
          ?? (Array.isArray(patch.skippedEvents)
            ? patch.skippedEvents.map((s) => String(s?.id || '')).filter(Boolean)
            : []);
      } else if (patch.hiddenEventIds !== undefined) {
        body.hiddenEventIds = patch.hiddenEventIds;
      }
      const r = await fetch('/api/events-finder-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      taste = {
        lookFor: typeof data.lookFor === 'string' ? data.lookFor : lookFor,
        skip: typeof data.skip === 'string' ? data.skip : skip,
        blacklist: typeof data.blacklist === 'string' ? data.blacklist : blacklist,
        scrape: data.scrape && typeof data.scrape === 'object' ? data.scrape : taste?.scrape,
        hiddenEventIds: Array.isArray(data.hiddenEventIds)
          ? data.hiddenEventIds.map(String)
          : (Array.isArray(data.skippedEvents)
            ? data.skippedEvents.map((s) => String(s?.id || '')).filter(Boolean)
            : (taste?.hiddenEventIds || [])),
        skippedEvents: Array.isArray(data.skippedEvents)
          ? data.skippedEvents
          : (taste?.skippedEvents || []),
        favoriteEventIds: Array.isArray(data.favoriteEventIds)
          ? data.favoriteEventIds.map(String)
          : (patch.favoriteEventIds !== undefined
            ? patch.favoriteEventIds.map(String)
            : (taste?.favoriteEventIds || [])),
        calendarAddedEventIds: Array.isArray(data.calendarAddedEventIds)
          ? data.calendarAddedEventIds.map(String)
          : (patch.calendarAddedEventIds !== undefined
            ? patch.calendarAddedEventIds.map(String)
            : (taste?.calendarAddedEventIds || [])),
        conferenceWatchlist: Array.isArray(data.conferenceWatchlist)
          ? data.conferenceWatchlist.map(String)
          : (patch.conferenceWatchlist !== undefined
            ? patch.conferenceWatchlist.map(String)
            : (taste?.conferenceWatchlist || [])),
      };
      writePanelCache(CRITERIA_CACHE_KEY, {
        lookFor: taste.lookFor,
        skip: taste.skip,
        blacklist: taste.blacklist,
        scrape: taste.scrape,
        hiddenEventIds: taste.hiddenEventIds,
        skippedEvents: taste.skippedEvents,
        favoriteEventIds: taste.favoriteEventIds,
        calendarAddedEventIds: taste.calendarAddedEventIds,
        conferenceWatchlist: taste.conferenceWatchlist,
        filters: data.filters,
        geo: data.geo,
      });
      if (patch.conferenceWatchlist !== undefined) {
        conferenceInput.value = taste.conferenceWatchlist.join('\n');
        syncConferenceToggleLabel();
      }
      if (data.filters?.earliestLocalTime) {
        timeInput.value = normalizeLocalTime(data.filters.earliestLocalTime) || data.filters.earliestLocalTime;
      }
      if (Array.isArray(data.filters?.cities) && data.filters.cities.length) {
        savedCitySelection = data.filters.cities.map(String);
      } else if (writeFilters) {
        savedCitySelection = null;
      }
      if (!patch.silent) {
        filterMsg.hidden = true;
        filterMsg.textContent = '';
        saveBtn.disabled = false;
      }
      markSaveIdle();
      return true;
    } catch (e) {
      lastCriteriaSaveError =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save.';
      if (!patch.silent) {
        filterMsg.classList.add('events-finder__msg--err');
        filterMsg.textContent = lastCriteriaSaveError;
        saveBtn.disabled = false;
      }
      markSaveIdle();
      return false;
    }
  }

  /**
   * Immediately drop feed cards that match current grey / black list words (before slow server refresh).
   * @param {{ lookFor?: string, skip?: string, blacklist?: string } | null} [criteria]
   */
  function refilterFeedForTaste(criteria) {
    const c = criteria || taste;
    if (!lastEventsPayload || !c) return;
    const filtered = applyTasteToEventsPayload(lastEventsPayload, c);
    writePanelCache(EVENTS_CACHE_KEY, filtered);
    paintEvents(filtered);
  }

  /**
   * Persist browse filters and refresh the feed from the saved catalog.
   * Does not start a live source ingest (that made Save feel stuck for minutes).
   * @returns {Promise<boolean>}
   */
  async function saveFilters() {
    const ok = await saveCriteria({ waitForIdle: true });
    if (ok) {
      await loadEvents({ catalogOnly: true, quiet: true });
    }
    return ok;
  }

  /**
   * @param {object} ev
   * @param {'up' | 'down'} vibe
   */
  function openPreferenceModal(ev, vibe) {
    const wantMore = vibe === 'up';
    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__modal-backdrop';
    const modal = document.createElement('div');
    modal.className = wantMore
      ? 'events-finder__modal'
      : 'events-finder__modal events-finder__modal--taste-down';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = document.createElement('h3');
    title.className = 'events-finder__modal-title';
    title.textContent = wantMore ? 'See more like this?' : 'See less like this?';

    const hint = document.createElement('p');
    hint.className = 'events-finder__modal-hint';
    hint.textContent = wantMore
      ? 'Add ideas to Look for (one per line). These steer discovery toward similar events.'
      : 'This event is skipped. Add grey-list and/or black-list words (one per line). Grey hides only when no Look for word matches; black always hides.';

    const eventLabel = document.createElement('p');
    eventLabel.className = 'events-finder__modal-event';
    eventLabel.textContent = ev.title || 'Untitled event';

    /** @type {HTMLTextAreaElement} */
    let area;
    /** @type {HTMLTextAreaElement | null} */
    let greyArea = null;
    /** @type {HTMLTextAreaElement | null} */
    let blackArea = null;
    /** @type {HTMLElement[]} */
    const fieldNodes = [];

    if (wantMore) {
      area = document.createElement('textarea');
      area.className = 'events-finder__modal-textarea';
      area.rows = 6;
      area.spellcheck = true;
      area.placeholder = 'One idea per line…';
      area.value = suggestPreferenceLines(ev, vibe);
      fieldNodes.push(area);
    } else {
      const suggested = suggestPreferenceLines(ev, vibe);

      const greyLabel = document.createElement('label');
      greyLabel.className = 'events-finder__modal-field-label';
      greyLabel.htmlFor = 'events-finder-pref-grey';
      greyLabel.textContent = 'Grey list';
      const greyHint = document.createElement('p');
      greyHint.className = 'events-finder__modal-field-hint';
      greyHint.textContent = 'Hide matching events only if no Look for word also matches.';
      greyArea = document.createElement('textarea');
      greyArea.id = 'events-finder-pref-grey';
      greyArea.className = 'events-finder__modal-textarea events-finder__modal-textarea--compact';
      greyArea.rows = 4;
      greyArea.spellcheck = true;
      greyArea.placeholder = 'One idea per line…';
      greyArea.value = suggested;

      const blackLabel = document.createElement('label');
      blackLabel.className = 'events-finder__modal-field-label';
      blackLabel.htmlFor = 'events-finder-pref-black';
      blackLabel.textContent = 'Black list';
      const blackHint = document.createElement('p');
      blackHint.className = 'events-finder__modal-field-hint';
      blackHint.textContent = 'Always hide matching events, even if a Look for word matches.';
      blackArea = document.createElement('textarea');
      blackArea.id = 'events-finder-pref-black';
      blackArea.className = 'events-finder__modal-textarea events-finder__modal-textarea--compact';
      blackArea.rows = 4;
      blackArea.spellcheck = true;
      blackArea.placeholder = 'One idea per line…';
      blackArea.value = '';

      fieldNodes.push(greyLabel, greyHint, greyArea, blackLabel, blackHint, blackArea);
      area = greyArea;
    }

    const msg = document.createElement('p');
    msg.className = 'events-finder__modal-msg';
    msg.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'events-finder__modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'events-finder__modal-btn';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'events-finder__modal-btn events-finder__modal-btn--primary';
    save.textContent = wantMore ? 'Add to Look for' : 'Skip event';

    const close = () => backdrop.remove();
    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    save.addEventListener('click', async () => {
      if (!filtersReady) {
        msg.hidden = false;
        msg.textContent = 'Filters still loading — try again in a moment.';
        return;
      }
      const lookAdditions = wantMore ? area.value : '';
      const greyAdditions = wantMore ? '' : (greyArea?.value || '');
      const blackAdditions = wantMore ? '' : (blackArea?.value || '');
      const hasLook = Boolean(String(lookAdditions).trim());
      const hasGrey = Boolean(String(greyAdditions).trim());
      const hasBlack = Boolean(String(blackAdditions).trim());
      if (wantMore && !hasLook) {
        msg.hidden = false;
        msg.textContent = 'Add at least one preference line.';
        return;
      }
      // Skip the event even when no taste lines are added — optional grey/black refine the feed.
      save.disabled = true;
      msg.hidden = false;
      msg.textContent = 'Saving…';
      const nextLook = wantMore
        ? mergeTasteLines(taste?.lookFor ?? '', lookAdditions)
        : taste?.lookFor ?? '';
      const nextSkip = wantMore
        ? taste?.skip ?? ''
        : hasGrey
          ? mergeTasteLines(taste?.skip ?? '', greyAdditions)
          : taste?.skip ?? '';
      const nextBlacklist = wantMore
        ? taste?.blacklist ?? ''
        : hasBlack
          ? mergeTasteLines(taste?.blacklist ?? '', blackAdditions)
          : taste?.blacklist ?? '';

      /** @type {{ lookFor: string, skip: string, blacklist: string, skippedEvents?: object[], hiddenEventIds?: string[], silent: boolean, waitForIdle: boolean }} */
      const patch = {
        lookFor: nextLook,
        skip: nextSkip,
        blacklist: nextBlacklist,
        silent: true,
        waitForIdle: true,
      };

      // Thumbs-down: also skip this event, then refilter the whole feed for new list words.
      if (!wantMore) {
        const id = String(ev.id || '').trim();
        if (id) {
          const record = skippedRecordFromEventLocal(ev);
          /** @type {object[]} */
          const skipBatch = record ? [record] : [];
          const seriesKey = String(record?.seriesKey || '').trim();
          if (record && seriesKey) {
            const seriesRecord = skippedRecordFromEventLocal(ev, { series: true });
            if (seriesRecord) skipBatch.push(seriesRecord);
          }
          if (record) {
            if (hasGrey) record.tasteGrey = tasteLinesFromBlock(greyAdditions);
            if (hasBlack) record.tasteBlack = tasteLinesFromBlock(blackAdditions);
          }
          const batchIds = new Set(skipBatch.map((s) => String(s?.id || '')).filter(Boolean));
          const prevSkipped = Array.isArray(taste?.skippedEvents) ? [...taste.skippedEvents] : [];
          const nextSkipped = [
            ...skipBatch,
            ...prevSkipped.filter((s) => !batchIds.has(String(s?.id || ''))),
          ].filter(Boolean);
          // Upsert only this batch — server merges + expands series; never send a stale full list.
          patch.skippedEvents = skipBatch;
          if (taste) {
            taste = {
              ...taste,
              skippedEvents: nextSkipped,
              hiddenEventIds: nextSkipped.map((s) => String(s.id)),
            };
          }
        }
      }

      const ok = await saveCriteria(patch);
      if (!ok) {
        msg.textContent = lastCriteriaSaveError || 'Could not save preferences.';
        save.disabled = false;
        return;
      }
      close();
      // Optimistic: hide this card + any others matching new grey/black words; server refresh confirms.
      if (!wantMore && lastEventsPayload) {
        const id = String(ev.id || '').trim();
        if (id && Array.isArray(lastEventsPayload.events)) {
          const removed = lastEventsPayload.events.find((e) => String(e?.id || '') === id);
          lastEventsPayload = {
            ...lastEventsPayload,
            events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
            skippedEvents: [
              removed
                ? { ...removed, skipped: true, skippedAt: new Date().toISOString() }
                : null,
              ...(Array.isArray(lastEventsPayload.skippedEvents)
                ? lastEventsPayload.skippedEvents.filter((e) => String(e?.id || '') !== id)
                : []),
            ].filter(Boolean),
            skippedCount: Array.isArray(taste?.skippedEvents)
              ? taste.skippedEvents.length
              : (Array.isArray(lastEventsPayload.skippedEvents)
                  ? lastEventsPayload.skippedEvents.length
                  : 0) + 1,
          };
        }
      }
      refilterFeedForTaste(taste);
      void loadEvents();
    });

    actions.append(cancel, save);
    modal.append(title, hint, eventLabel, ...fieldNodes, msg, actions);
    backdrop.append(modal);
    document.body.append(backdrop);
    area.focus();
  }

  /**
   * @param {object} ev
   */
  function skippedRecordFromEventLocal(ev, opts = {}) {
    const id = String(ev?.id || '').trim();
    if (!id) return null;
    const seriesKey = String(ev?.seriesKey || '').trim() || null;
    if (opts.series) {
      if (!seriesKey) return null;
      return {
        id: `series:${seriesKey}`.slice(0, 400),
        key: null,
        url: null,
        title: String(ev.title || '').trim() || null,
        start: ev.start != null ? String(ev.start) : null,
        source: ev.source != null ? String(ev.source) : null,
        venue: String(ev.venue || ev.location || '').trim() || null,
        city: ev.city != null ? String(ev.city) : null,
        imageUrl: String(ev.imageUrl || '').trim() || null,
        seriesKey,
        skippedAt: new Date().toISOString(),
      };
    }
    return {
      id,
      key: null,
      url: String(ev.url || '').trim() || null,
      title: String(ev.title || '').trim() || null,
      start: ev.start != null ? String(ev.start) : null,
      source: ev.source != null ? String(ev.source) : null,
      venue: String(ev.venue || ev.location || '').trim() || null,
      city: ev.city != null ? String(ev.city) : null,
      imageUrl: String(ev.imageUrl || '').trim() || null,
      seriesKey,
      skippedAt: new Date().toISOString(),
    };
  }

  function normalizeSkipTitleFuzzyKey(title) {
    const base = String(title || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!base) return '';
    return base
      .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/g, ' ')
      .replace(/\bfrom\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+)?to\b/g, 'from-to')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Client-side skip match (id / url / title+day / series / fuzzy title) so filter repaints never revive skips.
   * @param {object} event
   * @param {object[]} skipped
   * @returns {boolean}
   */
  function eventMatchesSkippedLocal(event, skipped) {
    const list = Array.isArray(skipped) ? skipped : [];
    if (!list.length || !event) return false;
    const id = String(event.id || '').trim();
    const url = String(event.url || '').trim().toLowerCase();
    const title = String(event.title || '').trim().toLowerCase();
    const day = event.start != null ? String(event.start).slice(0, 10) : '';
    const seriesKey = String(event.seriesKey || '').trim();
    const source = String(event.source || '').trim().toLowerCase();
    const fuzzy = normalizeSkipTitleFuzzyKey(event.title);
    const fuzzyKey = fuzzy.length >= 24 && source ? `${source}|${fuzzy}` : '';
    for (const s of list) {
      if (id && String(s?.id || '') === id) return true;
      const sSeries = String(s?.seriesKey || '').trim();
      if (seriesKey && sSeries && seriesKey === sSeries) return true;
      const sUrl = String(s?.url || '').trim().toLowerCase();
      if (url && sUrl && (url === sUrl || url.includes(sUrl) || sUrl.includes(url))) return true;
      const sTitle = String(s?.title || '').trim().toLowerCase();
      const sDay = s?.start != null ? String(s.start).slice(0, 10) : '';
      if (title && sTitle && title === sTitle && day && sDay && day === sDay) return true;
      if (fuzzyKey) {
        const sSource = String(s?.source || '').trim().toLowerCase();
        const sFuzzy = normalizeSkipTitleFuzzyKey(s?.title);
        if (sSource && sFuzzy.length >= 24 && `${sSource}|${sFuzzy}` === fuzzyKey) return true;
      }
    }
    return false;
  }

  /**
   * @param {object} ev
   * @param {object} record
   */
  function eventMatchesSkipRecord(ev, record) {
    if (!ev || !record) return false;
    const id = String(ev?.id || '').trim();
    const recordId = String(record?.id || '').trim();
    if (id && recordId && id === recordId) return true;
    const seriesKey = String(ev?.seriesKey || '').trim();
    const recordSeries = String(record?.seriesKey || '').trim();
    if (seriesKey && recordSeries && seriesKey === recordSeries) return true;
    if (recordId.startsWith('series:') && recordSeries && seriesKey === recordSeries) return true;
    return eventMatchesSkippedLocal(ev, [record]);
  }

  /**
   * @param {object} ev
   * @param {{ series?: boolean }} [opts]
   */
  async function hideEvent(ev, opts = {}) {
    const id = String(ev.id || '').trim();
    if (!id) return;
    if (!filtersReady) return;
    if (opts.series && !String(ev.seriesKey || '').trim()) return;
    // Zoom/pan stay put via mapDidInitialFit (do not touch mapViewBeforePopup —
    // that stash is only for restoring the pre-pin-popup view).
    const record = skippedRecordFromEventLocal(ev, { series: Boolean(opts.series) });
    if (!record) return;
    const recordId = String(record.id || '');
    const seriesKey = String(record.seriesKey || '').trim();
    /** @type {object[]} */
    const skipBatch = [record];
    if (!opts.series && seriesKey) {
      const seriesRecord = skippedRecordFromEventLocal(ev, { series: true });
      if (seriesRecord) skipBatch.push(seriesRecord);
    }
    const prevSkipped = Array.isArray(taste?.skippedEvents) ? [...taste.skippedEvents] : [];
    const batchIds = new Set(skipBatch.map((s) => String(s?.id || '')).filter(Boolean));
    const nextSkipped = [
      ...skipBatch,
      ...prevSkipped.filter((s) => !batchIds.has(String(s?.id || ''))),
    ].filter(Boolean);
    const nextHidden = nextSkipped.map((s) => String(s.id));
    if (taste) {
      taste = { ...taste, skippedEvents: nextSkipped, hiddenEventIds: nextHidden };
    }
    // Optimistic remove from main feed (whole series when requested).
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events)) {
      const removed = lastEventsPayload.events.filter((e) =>
        skipBatch.some((rec) => eventMatchesSkipRecord(e, rec)),
      );
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter(
          (e) => !skipBatch.some((rec) => eventMatchesSkipRecord(e, rec)),
        ),
        skippedEvents: [
          {
            ...(removed[0] || ev),
            id: recordId,
            skipped: true,
            skippedAt: record.skippedAt,
            seriesKey: seriesKey || null,
            isSeries: Boolean(opts.series),
          },
          ...(Array.isArray(lastEventsPayload.skippedEvents)
            ? lastEventsPayload.skippedEvents.filter((e) => String(e?.id || '') !== recordId)
            : []),
        ],
        skippedCount: nextSkipped.length,
      };
      paintEvents(lastEventsPayload);
    }
    // #region agent log
    fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '25d735' },
      body: JSON.stringify({
        sessionId: '25d735',
        runId: 'pre-fix',
        hypothesisId: 'A-D',
        location: 'events-finder.js:hideEvent',
        message: 'client skip',
        data: {
          id: recordId,
          title: record.title || null,
          seriesKey: seriesKey || null,
          seriesMode: Boolean(opts.series),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const ok = await saveCriteria({
      skippedEvents: skipBatch,
      silent: true,
      waitForIdle: true,
    });
    if (!ok && lastEventsPayload) {
      void loadEvents();
    }
  }

  /**
   * @param {object} ev
   */
  async function unskipEvent(ev) {
    const id = String(ev.id || '').trim();
    if (!id || !filtersReady) return;
    const prevSkipped = Array.isArray(taste?.skippedEvents) ? [...taste.skippedEvents] : [];
    const nextSkipped = prevSkipped.filter((s) => String(s?.id || '') !== id);
    const nextHidden = nextSkipped.map((s) => String(s.id));
    if (taste) {
      taste = { ...taste, skippedEvents: nextSkipped, hiddenEventIds: nextHidden };
    }
    if (lastEventsPayload) {
      lastEventsPayload = {
        ...lastEventsPayload,
        skippedEvents: (Array.isArray(lastEventsPayload.skippedEvents)
          ? lastEventsPayload.skippedEvents
          : []
        ).filter((e) => String(e?.id || '') !== id),
        skippedCount: nextSkipped.length,
      };
      paintEvents(lastEventsPayload);
    }
    await saveCriteria({
      unskipEventIds: [id],
      silent: true,
      waitForIdle: true,
    });
    void loadEvents();
  }

  function syncShowSkippedButton() {
    const n = Array.isArray(taste?.skippedEvents)
      ? taste.skippedEvents.length
      : Number(lastEventsPayload?.skippedCount) || 0;
    showSkippedBtn.textContent = showSkipped
      ? `Hide skipped${n ? ` (${n})` : ''}`
      : `Show skipped${n ? ` (${n})` : ''}`;
    showSkippedBtn.setAttribute('aria-pressed', showSkipped ? 'true' : 'false');
    showSkippedBtn.classList.toggle('events-finder__show-skipped--on', showSkipped);
  }

  showSkippedBtn.addEventListener('click', () => {
    showSkipped = !showSkipped;
    writeShowSkipped(showSkipped);
    syncShowSkippedButton();
    if (lastEventsPayload) paintEvents(lastEventsPayload);
  });

  /**
   * @param {HTMLButtonElement} favBtn
   * @param {boolean} on
   */
  function paintFavButton(favBtn, on) {
    favBtn.classList.toggle('events-finder__card-fav--on', on);
    favBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    favBtn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    favBtn.title = on ? 'Remove favorite' : 'Favorite';
    favBtn.textContent = on ? '♥' : '♡';
  }

  /**
   * @param {object} ev
   * @param {HTMLButtonElement} favBtn
   */
  async function toggleFavorite(ev, favBtn) {
    const id = String(ev.id || '').trim();
    if (!id || !filtersReady) return;
    if (favBtn.dataset.busy === '1') return;
    favBtn.dataset.busy = '1';
    favBtn.disabled = true;

    const prev = [...(taste?.favoriteEventIds || [])].map(String);
    const nextOn = !prev.includes(id);
    const nextFavs = nextOn ? [...prev, id] : prev.filter((x) => x !== id);
    if (taste) taste = { ...taste, favoriteEventIds: nextFavs };
    paintFavButton(favBtn, nextOn);

    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      ok = await saveCriteria({
        favoriteEventIds: nextFavs,
        silent: true,
        waitForIdle: true,
      });
      if (!ok && attempt < 2) {
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
      }
    }
    if (!ok) {
      if (taste) taste = { ...taste, favoriteEventIds: prev };
      paintFavButton(favBtn, prev.includes(id));
    } else {
      // Trust server list so heart / unheart stays in sync.
      const saved = Array.isArray(taste?.favoriteEventIds)
        ? taste.favoriteEventIds.map(String)
        : nextFavs;
      paintFavButton(favBtn, saved.includes(id));
    }

    favBtn.disabled = false;
    delete favBtn.dataset.busy;
  }

  /**
   * @param {HTMLAnchorElement} calBtn
   * @param {boolean} added
   */
  function paintCalButton(calBtn, added) {
    const calName = googleCalendarTarget.name || 'Random Events';
    calBtn.classList.toggle('events-finder__card-action--cal-added', added);
    if (added) {
      calBtn.textContent = 'Added to Cal.';
      calBtn.setAttribute('aria-label', `Already added to ${calName} — open again`);
      calBtn.title = `Already on ${calName} — click to open again`;
    } else {
      calBtn.textContent = 'Add to Cal.';
      calBtn.setAttribute(
        'aria-label',
        `Add to ${calName}${googleCalendarTarget.authuser ? ` (${googleCalendarTarget.authuser})` : ''}`,
      );
      calBtn.title = googleCalendarTarget.src
        ? `Add to ${calName}`
        : `Add to ${calName} — set EVENTS_FINDER_GOOGLE_CALENDAR_SRC to preselect this calendar`;
    }
  }

  /**
   * Mark event as added to calendar after the user opens the Google Calendar create link.
   * @param {object} ev
   * @param {HTMLAnchorElement} calBtn
   */
  async function markCalendarAdded(ev, calBtn) {
    const id = String(ev.id || '').trim();
    if (!id || !filtersReady) return;

    const hideFromMainFeed = () => {
      if (lastEventsPayload && Array.isArray(lastEventsPayload.events) && !showSkipped) {
        lastEventsPayload = {
          ...lastEventsPayload,
          events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
        };
        paintEvents(lastEventsPayload);
      }
    };

    const prev = [...(taste?.calendarAddedEventIds || [])].map(String);
    if (prev.includes(id)) {
      paintCalButton(calBtn, true);
      hideFromMainFeed();
      return;
    }
    const next = [...prev, id];
    if (taste) taste = { ...taste, calendarAddedEventIds: next };
    paintCalButton(calBtn, true);
    hideFromMainFeed();
    const ok = await saveCriteria({
      calendarAddedEventIds: next,
      silent: true,
      waitForIdle: true,
    });
    if (!ok) {
      if (taste) taste = { ...taste, calendarAddedEventIds: prev };
      void loadEvents();
    }
  }

  /**
   * @param {object} item
   */
  function openConferenceDetailPopout(item) {
    const eventUrl = String(item.homepageUrl || item.url || '').trim();
    const ticketHref = String(item.ticketUrl || '').trim();
    const body = document.createElement('div');
    body.className = 'events-finder__conference-detail';

    const title = document.createElement('h3');
    title.className = 'events-finder__conference-detail-title';
    const detailTitleText = item.title || item.query || 'Big event';
    if (eventUrl) {
      const titleLink = document.createElement('a');
      titleLink.className = 'events-finder__card-title-link';
      titleLink.href = eventUrl;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = detailTitleText;
      title.append(titleLink);
    } else {
      title.textContent = detailTitleText;
    }

    body.append(title);

    const detailImage = item.flierImageUrl || item.flierUrl || item.screenshotUrl;
    if (detailImage) {
      const shot = document.createElement('img');
      shot.className = 'events-finder__conference-detail-shot';
      shot.src = String(detailImage);
      shot.alt = `Flier for ${item.title || item.query}`;
      shot.loading = 'lazy';
      body.append(shot);
    }

    const whenEl = document.createElement('p');
    whenEl.className = 'events-finder__conference-detail-when';
    whenEl.textContent = String(item.whenLabel || 'Dates TBD');
    body.append(whenEl);

    if (item.placeLabel) {
      const placeEl = document.createElement('p');
      placeEl.className = 'events-finder__conference-detail-place';
      placeEl.textContent = String(item.placeLabel);
      body.append(placeEl);
    }

    if (item.salesStatus) {
      const statusWrap = document.createElement('p');
      statusWrap.className = 'events-finder__conference-detail-place';
      const statusPill = document.createElement('span');
      statusPill.className = `events-finder__big-events-status events-finder__big-events-status--${item.salesStatusKind || 'unknown'}`;
      statusPill.textContent = String(item.salesStatus);
      statusWrap.append(statusPill);
      body.append(statusWrap);
    }

    const ticketEl = document.createElement('p');
    ticketEl.className = 'events-finder__conference-ticket';
    if (item.researching) {
      ticketEl.textContent = 'Looking up dates and tickets…';
      ticketEl.classList.add('muted');
    } else if (item.ticketLabel) {
      ticketEl.textContent = String(item.ticketLabel);
    } else if (item.error) {
      ticketEl.textContent = 'Could not find ticket details yet — will retry.';
      ticketEl.classList.add('muted');
    } else {
      ticketEl.textContent = 'Ticket price not found yet.';
      ticketEl.classList.add('muted');
    }
    body.append(ticketEl);

    if (item.earlyBirdNote) {
      const ebNote = document.createElement('p');
      ebNote.className = 'events-finder__conference-ticket events-finder__conference-ticket--active';
      ebNote.textContent = String(item.earlyBirdNote);
      body.append(ebNote);
    } else if (item.earlyBirdLine && item.earlyBirdKind !== 'price') {
      const ebNote = document.createElement('p');
      ebNote.className = 'events-finder__conference-ticket';
      if (item.earlyBirdKind === 'active') {
        ebNote.classList.add('events-finder__conference-ticket--active');
      }
      ebNote.textContent = String(item.earlyBirdLine);
      body.append(ebNote);
    }

    if (item.salesStartLine) {
      const sl = document.createElement('p');
      sl.className = 'events-finder__conference-ticket';
      sl.textContent = String(item.salesStartLine);
      body.append(sl);
    }

    if (item.earlyBirdStart || item.earlyBirdEnd) {
      const eb = document.createElement('dl');
      eb.className = 'events-finder__conference-detail-dates';
      if (item.earlyBirdStart) {
        const dt = document.createElement('dt');
        dt.textContent = 'Early bird starts';
        const dd = document.createElement('dd');
        dd.textContent = String(item.earlyBirdStart);
        eb.append(dt, dd);
      }
      if (item.earlyBirdEnd) {
        const dt = document.createElement('dt');
        dt.textContent = 'Early bird ends';
        const dd = document.createElement('dd');
        dd.textContent = String(item.earlyBirdEnd);
        eb.append(dt, dd);
      }
      body.append(eb);
    }

    if (item.notes && !item.researching) {
      const notesEl = document.createElement('p');
      notesEl.className = 'events-finder__conference-detail-notes';
      notesEl.textContent = String(item.notes);
      body.append(notesEl);
    }

    if (eventUrl || ticketHref) {
      const links = document.createElement('div');
      links.className = 'events-finder__conference-detail-links';
      if (eventUrl) {
        const link = document.createElement('a');
        link.className = 'events-finder__conference-detail-link';
        link.href = eventUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Official site';
        links.append(link);
      }
      if (ticketHref && ticketHref !== eventUrl) {
        const tlink = document.createElement('a');
        tlink.className = 'events-finder__conference-detail-link events-finder__conference-detail-link--tickets';
        tlink.href = ticketHref;
        tlink.target = '_blank';
        tlink.rel = 'noopener noreferrer';
        tlink.textContent = 'Tickets ↗';
        links.append(tlink);
      }
      body.append(links);
    }

    if (item.skipped || item.snoozed) {
      const hiddenNote = document.createElement('p');
      hiddenNote.className = 'events-finder__conference-ticket muted';
      hiddenNote.textContent = item.skipped
        ? 'Skipped — hidden from the events feed.'
        : `Snoozed — hidden from the feed until ${formatWhen(item.snoozedUntil) || 'later'}.`;
      body.append(hiddenNote);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'events-finder__conference-detail-link';
      restore.textContent = 'Restore to feed';
      restore.addEventListener('click', () => {
        void bigEventCardAction(item, 'restore');
        closeConferencePopout();
      });
      body.append(restore);
    }

    openConferencePopout({
      title: String(item.title || item.query || 'Conference'),
      body,
    });
  }

  /**
   * A big-event heads-up card for the sidebar feed (flier + dates + ticket
   * status). Clicking the card opens the official event site; clicking the
   * ticket-status pill opens the ticket page. It deliberately omits the
   * fav/skip/calendar actions that only apply to regular feed events.
   * @param {object} item conference-watch heads-up item
   * @returns {HTMLElement}
   */
  function buildBigEventFeedCard(item) {
    const card = document.createElement('article');
    card.className = 'events-finder__card events-finder__card--big-event';
    const eventHref = String(item.url || item.homepageUrl || '').trim();
    const ticketHref = String(item.ticketUrl || item.homepageUrl || item.url || '').trim();
    if (eventHref) card.title = 'Open event site';

    const snap = document.createElement('div');
    snap.className = 'events-finder__card-snap';
    const flier = item.flierImageUrl || item.flierUrl || item.screenshotUrl;
    if (flier) {
      const img = document.createElement('img');
      img.src = String(flier);
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        snap.replaceChildren();
        snap.classList.add('events-finder__card-snap--empty');
        const ph = document.createElement('span');
        ph.className = 'events-finder__card-snap-label';
        ph.textContent = String(item.title || 'B').slice(0, 1).toUpperCase();
        snap.append(ph);
      });
      snap.append(img);
    } else {
      snap.classList.add('events-finder__card-snap--empty');
      const ph = document.createElement('span');
      ph.className = 'events-finder__card-snap-label';
      ph.textContent = String(item.title || 'B').slice(0, 1).toUpperCase();
      snap.append(ph);
    }

    const head = document.createElement('div');
    head.className = 'events-finder__card-head';
    const title = document.createElement('div');
    title.className = 'events-finder__card-title';
    const titleText = item.title || item.query || 'Big event';
    const titleUrl = String(item.url || item.homepageUrl || '').trim();
    if (titleUrl) {
      const titleLink = document.createElement('a');
      titleLink.className = 'events-finder__card-title-link';
      titleLink.href = titleUrl;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = titleText;
      titleLink.title = 'Open event site';
      titleLink.addEventListener('click', (e) => e.stopPropagation());
      title.append(titleLink);
    } else {
      title.textContent = titleText;
    }
    const badge = document.createElement('span');
    badge.className = 'events-finder__card-bigbadge';
    badge.textContent = 'Big event';
    head.append(title, badge);

    const cityEl = document.createElement('p');
    cityEl.className = 'events-finder__card-city';
    if (item.placeLabel) cityEl.textContent = String(item.placeLabel);
    else cityEl.hidden = true;

    const meta = document.createElement('p');
    meta.className = 'events-finder__card-meta';
    meta.textContent = item.whenLabel || 'Dates TBD';

    // Price on its own line, green + bold (see buildEventCard for the shared look).
    const priceEl = document.createElement('p');
    priceEl.className = 'events-finder__card-price';
    if (item.ticketLabel) priceEl.textContent = String(item.ticketLabel);
    else priceEl.hidden = true;

    const status = document.createElement('p');
    status.className = 'events-finder__card-meta';
    const statusPill = document.createElement(ticketHref ? 'a' : 'span');
    statusPill.className = `events-finder__big-events-status events-finder__big-events-status--${item.salesStatusKind || 'unknown'}`;
    statusPill.textContent = String(item.salesStatus || '—');
    if (ticketHref) {
      statusPill.href = ticketHref;
      statusPill.target = '_blank';
      statusPill.rel = 'noopener noreferrer';
      statusPill.title = 'Open ticket page';
      statusPill.addEventListener('click', (e) => e.stopPropagation());
    }
    status.append(statusPill);
    // Keep genuinely-different early-bird notes, but never repeat the plain
    // price (shown on the price line) nor the on-sale date (shown in the pill).
    const extraLine =
      item.earlyBirdNote
      || (item.earlyBirdKind !== 'price' ? item.earlyBirdLine : null);
    if (extraLine) {
      const ex = document.createElement('span');
      ex.className = 'events-finder__big-events-earlybird';
      ex.textContent = String(extraLine);
      status.append(ex);
    }

    const actions = document.createElement('div');
    actions.className = 'events-finder__card-actions';

    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.className = 'events-finder__card-action events-finder__card-action--snooze';
    snoozeBtn.title = 'Snooze — hide for one week, then bring it back';
    snoozeBtn.setAttribute('aria-label', 'Snooze this big event for one week');
    snoozeBtn.textContent = 'Snooze';
    snoozeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void bigEventCardAction(item, 'snooze');
    });

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'events-finder__card-action events-finder__card-action--hide';
    skipBtn.title = 'Skip — dismiss this big event';
    skipBtn.setAttribute('aria-label', 'Skip this big event');
    skipBtn.textContent = 'Skip';
    skipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void bigEventCardAction(item, 'skip');
    });

    const calBtn = document.createElement('a');
    calBtn.className = 'events-finder__card-action events-finder__card-action--cal';
    calBtn.href = googleCalendarAddUrl(item);
    calBtn.target = '_blank';
    calBtn.rel = 'noopener noreferrer';
    calBtn.title = 'Add to calendar';
    calBtn.setAttribute('aria-label', 'Add this big event to calendar');
    calBtn.textContent = 'Add to cal';
    calBtn.addEventListener('click', (e) => e.stopPropagation());

    actions.append(snoozeBtn, skipBtn, calBtn);

    card.append(snap, head, cityEl, meta, priceEl, status, actions);
    if (eventHref) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        window.open(eventHref, '_blank', 'noopener,noreferrer');
      });
    }
    return card;
  }

  /**
   * @param {object} ev
   * @param {{ fromCache?: boolean, skippedMode?: boolean, mapPopup?: boolean }} [opts]
   */
  function buildEventCard(ev, opts = {}) {
    const card = document.createElement('article');
    card.className = 'events-finder__card';
    if (opts.fromCache) card.classList.add('events-finder__card--stale');
    if (opts.mapPopup) card.classList.add('events-finder__card--map-popup');
    const eventUrl = String(ev.url || '').trim();
    if (eventUrl) card.title = 'Click to open';

    const imageUrl =
      String(ev.imageUrl || ev.raw?.imageUrl || ev.raw?.coverUrl || '').trim() || '';
    const snap = document.createElement('div');
    snap.className = 'events-finder__card-snap';
    /**
     * Partiful stores private Firebase URLs; rewrite to their public imgix CDN.
     * @param {string} src
     * @returns {string}
     */
    function rewriteEventImageSrc(src) {
      const raw = String(src || '').trim();
      if (!raw) return '';
      try {
        const u = new URL(raw);
        if (
          u.hostname === 'firebasestorage.googleapis.com'
          && /getpartiful\.appspot\.com/i.test(u.pathname)
        ) {
          const m = u.pathname.match(/\/o\/(.+)$/);
          if (m) {
            const objectPath = decodeURIComponent(m[1]).replace(/^\/+/, '');
            if (objectPath) {
              return `https://partiful.imgix.net/${objectPath}?fit=clip&w=640&auto=format`;
            }
          }
        }
      } catch {
        /* keep */
      }
      return raw;
    }
    const resolvedImage = rewriteEventImageSrc(imageUrl);
    if (resolvedImage) {
      const img = document.createElement('img');
      img.src = resolvedImage;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        snap.replaceChildren();
        snap.classList.add('events-finder__card-snap--empty');
        const placeholder = document.createElement('span');
        placeholder.className = 'events-finder__card-snap-label';
        placeholder.textContent = String(ev.source || 'event').slice(0, 1).toUpperCase();
        snap.append(placeholder);
      });
      snap.append(img);
    } else {
      snap.classList.add('events-finder__card-snap--empty');
      const placeholder = document.createElement('span');
      placeholder.className = 'events-finder__card-snap-label';
      placeholder.textContent = String(ev.source || 'event').slice(0, 1).toUpperCase();
      snap.append(placeholder);
    }

    const head = document.createElement('div');
    head.className = 'events-finder__card-head';
    const title = document.createElement(eventUrl ? 'a' : 'div');
    title.className = 'events-finder__card-title';
    title.textContent = ev.title || 'Untitled event';
    if (eventUrl && title instanceof HTMLAnchorElement) {
      title.href = eventUrl;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }

    const eventId = String(ev.id || '').trim();
    const isFav = Boolean(eventId && taste?.favoriteEventIds?.includes(eventId));
    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'events-finder__card-fav';
    paintFavButton(favBtn, isFav);
    favBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void toggleFavorite(ev, favBtn);
    });
    head.append(title, favBtn);

    const place = String(ev.venue || ev.location || '').trim();
    const placeEl = document.createElement('p');
    placeEl.className = 'events-finder__card-place';
    if (place) {
      placeEl.textContent = place;
    } else {
      placeEl.hidden = true;
    }

    const cityEl = document.createElement('p');
    cityEl.className = 'events-finder__card-city';
    if (ev.online || ev.isOnline) {
      cityEl.textContent = 'Online';
    } else if (ev.city) {
      cityEl.textContent = String(ev.city);
    } else {
      cityEl.hidden = true;
    }

    const meta = document.createElement('p');
    meta.className = 'events-finder__card-meta';
    const metaBits = [formatWhen(ev.start)];
    if (Number.isFinite(ev.distanceMiles)) {
      metaBits.push(`${Math.round(ev.distanceMiles)} mi`);
    }
    const going = Number(ev.usersGoing ?? ev.raw?.usersGoing);
    if (Number.isFinite(going) && going > 0) metaBits.push(`${going} going`);
    meta.textContent = metaBits.filter(Boolean).join(' · ');

    // Price on its own line, green + bold (consistent across all event cards).
    const priceLabel = String(ev.priceLabel || '').trim();
    const priceEl = document.createElement('p');
    priceEl.className = 'events-finder__card-price';
    if (priceLabel) priceEl.textContent = priceLabel;
    else priceEl.hidden = true;

    const blurb = document.createElement('p');
    blurb.className = 'events-finder__card-blurb';
    const desc = String(ev.description || ev.raw?.description || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (desc) {
      // Map pin cards prioritize the full write-up; list cards stay punchy.
      blurb.textContent = opts.mapPopup ? desc : summarizeDescription(desc);
    } else {
      blurb.hidden = true;
    }

    const actions = document.createElement('div');
    actions.className = 'events-finder__card-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'events-finder__card-action events-finder__card-action--up';
    upBtn.setAttribute('aria-label', 'See more like this');
    upBtn.title = 'See more like this?';
    upBtn.textContent = '👍';
    upBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPreferenceModal(ev, 'up');
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'events-finder__card-action events-finder__card-action--down';
    downBtn.setAttribute('aria-label', 'See less like this');
    downBtn.title = 'See less like this?';
    downBtn.textContent = '👎';
    downBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPreferenceModal(ev, 'down');
    });

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    if (opts.skippedMode) {
      hideBtn.className = 'events-finder__card-action events-finder__card-action--unskip';
      hideBtn.setAttribute('aria-label', 'Restore this event');
      hideBtn.title = 'Unskip — show in feed again';
      hideBtn.textContent = 'Unskip';
      hideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void unskipEvent(ev);
      });
    } else {
      hideBtn.className = 'events-finder__card-action events-finder__card-action--hide';
      hideBtn.setAttribute('aria-label', 'Skip this event');
      hideBtn.title = ev.seriesKey
        ? 'Not interested — skip this and future dates at this venue'
        : 'Not interested — skip this event';
      hideBtn.textContent = 'Skip';
      hideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void hideEvent(ev);
      });
    }

    /** @type {HTMLButtonElement | null} */
    let seriesBtn = null;
    if (!opts.skippedMode && ev.isSeries && String(ev.seriesKey || '').trim()) {
      seriesBtn = document.createElement('button');
      seriesBtn.type = 'button';
      seriesBtn.className = 'events-finder__card-action events-finder__card-action--hide-series';
      seriesBtn.setAttribute('aria-label', 'Skip this series');
      seriesBtn.title = 'Skip this recurring series (all upcoming occurrences)';
      seriesBtn.textContent = 'Skip series';
      seriesBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void hideEvent(ev, { series: true });
      });
    }

    const calBtn = document.createElement('a');
    calBtn.className = 'events-finder__card-action events-finder__card-action--cal';
    calBtn.href = googleCalendarAddUrl(ev);
    calBtn.target = '_blank';
    calBtn.rel = 'noopener noreferrer';
    const calAdded = Boolean(eventId && taste?.calendarAddedEventIds?.includes(eventId));
    paintCalButton(calBtn, calAdded);
    calBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Mark as added when the user opens Google Calendar to save the event.
      void markCalendarAdded(ev, calBtn);
    });

    if (seriesBtn) actions.append(upBtn, downBtn, hideBtn, seriesBtn, calBtn);
    else actions.append(upBtn, downBtn, hideBtn, calBtn);

    const footerBits = [];
    const sourceLabel = eventSourceLabel(ev);
    if (sourceLabel) footerBits.push(sourceLabel);
    if (opts.skippedMode && (ev.seriesKey || String(ev.id || '').startsWith('series:'))) {
      footerBits.push('series skip');
    } else if (!opts.skippedMode && ev.isSeries) {
      footerBits.push('series');
    }
    const footer = document.createElement('p');
    footer.className = 'events-finder__card-footer';
    if (footerBits.length) {
      footer.textContent = footerBits.join(' · ');
    } else {
      footer.hidden = true;
    }

    card.append(snap, head, placeEl, cityEl, meta, priceEl, blurb, actions, footer);
    if (eventUrl) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        window.open(eventUrl, '_blank', 'noopener,noreferrer');
      });
    }
    return card;
  }

  /**
   * @param {object} ev
   * @returns {string}
   */
  function eventCityLabel(ev) {
    const raw = [ev?.city, ev?.venueCity, ev?.listingCity]
      .map((c) => String(c || '').trim().replace(/\s+/g, ' '))
      .find(Boolean);
    return raw || 'Unknown';
  }

  /**
   * @param {object} data
   * @returns {string[]}
   */
  function citiesFromPayload(data) {
    if (Array.isArray(data?.availableCities) && data.availableCities.length) {
      return data.availableCities.map(String).filter(Boolean);
    }
    const pool = [
      ...(Array.isArray(data?.events) ? data.events : []),
      ...(Array.isArray(data?.skippedEvents) ? data.skippedEvents : []),
    ];
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    for (const ev of pool) {
      const label = eventCityLabel(ev);
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(label);
    }
    out.sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return out;
  }

  /**
   * @param {object} data
   * @param {{ fromCache?: boolean }} [opts]
   */
  function paintEvents(data, opts = {}) {
    lastEventsPayload = data;
    syncShowSkippedButton();

    const available = citiesFromPayload(data);
    const prevSelected = cityChecks.getSelected();
    const prevAvailable = [...cityChecks.root.querySelectorAll('input[type="checkbox"]')].map(
      (el) => /** @type {HTMLInputElement} */ (el).value,
    );
    // Prefer saved subset; otherwise keep current checks when refreshing the same set;
    // null/empty saved → all checked.
    /** @type {string[] | null} */
    let selectedForUi = null;
    if (savedCitySelection && savedCitySelection.length) {
      selectedForUi = [...savedCitySelection];
      // Newly seen cities default to checked — but only on a refresh when we already
      // had a checklist. On first paint prevAvailable is empty, so treating every
      // city as "new" would expand a saved subset to all cities and disable filtering.
      if (prevAvailable.length) {
        for (const city of available) {
          if (!prevAvailable.includes(city) && !selectedForUi.includes(city)) {
            selectedForUi = [...selectedForUi, city];
          }
        }
      }
    } else if (prevAvailable.length && prevSelected.length && prevSelected.length < prevAvailable.length) {
      selectedForUi = prevSelected;
      for (const city of available) {
        if (!prevAvailable.includes(city)) selectedForUi = [...selectedForUi, city];
      }
    }
    cityChecks.setCities(available, selectedForUi);
    citiesEmpty.hidden = available.length > 0;
    cityChecks.root.hidden = available.length === 0;

    const selected = new Set(
      cityChecks.getSelected().map((c) => c.toLowerCase()),
    );
    const allChecked = selected.size === 0 || selected.size === available.length;
    const dateRange = calendar.getRange();
    const selectedDates = new Set(
      Array.isArray(dateRange.dates) ? dateRange.dates.map(String) : [],
    );
    const earliest = normalizeLocalTime(timeInput.value);
    const earliestMins = earliest
      ? (() => {
          const [eh, em] = earliest.split(':').map(Number);
          return eh * 60 + em;
        })()
      : null;

    /**
     * @param {object} ev
     * @returns {boolean}
     */
    function passesCity(ev) {
      if (isTelegramIntakeEvent(ev)) return true;
      if (allChecked) return true;
      return selected.has(eventCityLabel(ev).toLowerCase());
    }

    const rawEvents = Array.isArray(data.events) ? data.events : [];
    /** @type {Set<string>} */
    const payloadDays = new Set();
    for (const ev of rawEvents) {
      const day = eventLocalDayAndMinutes(ev?.start)?.day;
      if (day) payloadDays.add(day);
    }
    // Compare UI picks to the criteria that produced this catalog payload — not to
    // event days present (empty days never appear in payloadDays and would loop).
    const criteriaDates = new Set(
      (Array.isArray(data.filters?.dates) ? data.filters.dates : []).map(String).filter(Boolean),
    );
    const selectedInPayload = [...selectedDates].filter((d) => payloadDays.has(d));
    const dateReloadPending =
      selectedDates.size > 0 && [...selectedDates].some((d) => !criteriaDates.has(d));

    /**
     * Client mirror of browse date/time filters (instant while Save/reload runs).
     * @param {object} ev
     * @returns {boolean}
     */
    function passesDateTime(ev) {
      const telegramIntake = isTelegramIntakeEvent(ev);
      if (!selectedDates.size && (telegramIntake || earliestMins == null)) return true;
      const local = eventLocalDayAndMinutes(ev?.start);
      if (selectedDates.size) {
        // While some selected days are still loading, keep showing days we already have.
        const activeDates =
          dateReloadPending && selectedInPayload.length
            ? new Set(selectedInPayload)
            : selectedDates;
        if (!local?.day || !activeDates.has(local.day)) return false;
      }
      if (!telegramIntake && earliestMins != null && local?.minutes != null && local.minutes < earliestMins) {
        return false;
      }
      return true;
    }

    const mainEvents = rawEvents
      .filter(passesCity)
      .filter(passesDateTime)
      .filter((ev) => {
        if (isTelegramIntakeEvent(ev)) return true;
        // Never show skipped in the main feed, even if a stale payload still lists them.
        const skippedPool = [
          ...(Array.isArray(data.skippedEvents) ? data.skippedEvents : []),
          ...(Array.isArray(taste?.skippedEvents) ? taste.skippedEvents : []),
        ];
        return !eventMatchesSkippedLocal(ev, skippedPool);
      });
    const skippedList = (Array.isArray(data.skippedEvents) ? data.skippedEvents : [])
      .filter(passesCity)
      .filter(passesDateTime)
      .slice()
      .sort((a, b) => {
        const ta = Date.parse(String(a?.skippedAt || ''));
        const tb = Date.parse(String(b?.skippedAt || ''));
        const aOk = Number.isFinite(ta);
        const bOk = Number.isFinite(tb);
        if (aOk && bOk && ta !== tb) return tb - ta;
        if (aOk && !bOk) return -1;
        if (!aOk && bOk) return 1;
        return 0;
      });
    const events = showSkipped ? skippedList : mainEvents;
    lastFilteredEvents = events;
    // Active tracked big events surface at the top of the feed with their flier.
    const bigEventItems = Array.isArray(data.conferenceWatchlistItems)
      ? data.conferenceWatchlistItems
      : [];
    const activeBigEvents = showSkipped
      ? []
      : bigEventItems.filter(
          (it) => it && it.displayActive && !it.researching && !it.skipped && !it.snoozed,
        );
    const gmail = data.sources?.gmail;
    const facebook = data.sources?.facebook;
    const hadCards = listEl.querySelector('.events-finder__card') != null;
    listEl.replaceChildren();
    refreshConferencePopoutIfOpen();
    if (data.ingestPending === true && !showSkipped) {
      const updating = document.createElement('p');
      updating.className = 'events-finder__stub events-finder__updating muted';
      updating.textContent = 'Updating from sources…';
      listEl.append(updating);
    }
    if (!events.length && !activeBigEvents.length) {
      if ((opts.fromCache || data.ingestPending || dateReloadPending) && !showSkipped) {
        if (dateReloadPending) {
          // Ensure catalog reload catches up when UI dates aren't in this payload yet.
          scheduleFilterAutosave({ reload: true });
        }
        listStatus.className = 'events-finder__stub muted';
        listStatus.textContent = data.ingestPending
          ? 'Updating from sources…'
          : 'Refreshing events…';
        if (!listEl.contains(listStatus) && !listEl.querySelector('.events-finder__updating')) {
          listEl.append(listStatus);
        }
        if (mapBackdrop) syncMap([], data);
        return;
      }
      const empty = document.createElement('p');
      empty.className = 'events-finder__stub muted';
      if (showSkipped) {
        empty.textContent = 'No skipped events. Skips are remembered so they stay out of the feed.';
      } else if (available.length && !allChecked) {
        empty.textContent = 'No events in the selected cities. Check a city above to show more.';
      } else if (facebook && facebook.ok === false && facebook.hint) {
        empty.textContent = facebook.hint;
      } else if (gmail && gmail.ok === false && (!facebook || facebook.count === 0)) {
        empty.textContent =
          gmail.hint ||
          'Connect Intake Gmail (invites) in Settings → Events sources, set APIFY_TOKEN, and/or pin Facebook hosts in Filter criteria.';
      } else if (facebook?.refreshing || data.ingestPending) {
        empty.textContent = 'Updating from sources…';
      } else {
        empty.textContent =
          'No upcoming events matched your filters. Add Look for terms, pin hosts, or connect Gmail for invites.';
      }
      listEl.append(empty);
      if (mapBackdrop) syncMap([], data);
      return;
    }
    if (showSkipped) {
      const note = document.createElement('p');
      note.className = 'events-finder__skipped-note muted';
      note.textContent = `${events.length} skipped — Unskip to bring one back.`;
      listEl.append(note);
    }
    for (const item of activeBigEvents) {
      listEl.append(buildBigEventFeedCard(item));
    }
    for (const ev of events) {
      listEl.append(buildEventCard(ev, { ...opts, skippedMode: showSkipped }));
    }
    if (mapBackdrop && (hadCards || !opts.fromCache || events.length)) {
      syncMap(events, data);
    }
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let ingestPollTimer = null;
  let ingestPollGen = 0;

  function stopIngestPoll() {
    if (ingestPollTimer != null) {
      clearTimeout(ingestPollTimer);
      ingestPollTimer = null;
    }
    ingestPollGen += 1;
  }

  /**
   * Poll catalog-only while background ingest upserts sources progressively.
   */
  function startIngestPoll() {
    const gen = ++ingestPollGen;
    if (ingestPollTimer != null) {
      clearTimeout(ingestPollTimer);
      ingestPollTimer = null;
    }
    let attempts = 0;
    const maxAttempts = 24;

    const tick = () => {
      if (gen !== ingestPollGen) return;
      attempts += 1;
      void loadEvents({ catalogOnly: true, quiet: true, pollAttempt: attempts }).then((pending) => {
        if (gen !== ingestPollGen) return;
        if (pending && attempts < maxAttempts) {
          ingestPollTimer = setTimeout(tick, attempts < 4 ? 1500 : 3000);
        } else {
          ingestPollTimer = null;
        }
      });
    };
    ingestPollTimer = setTimeout(tick, 1500);
  }

  /**
   * @param {{ catalogOnly?: boolean, quiet?: boolean, pollAttempt?: number }} [opts]
   * @returns {Promise<boolean>} whether ingest is still pending
   */
  async function loadEvents(opts = {}) {
    const quiet = opts.quiet === true;
    const catalogOnly = opts.catalogOnly === true;
    const hadDomCache = listEl.querySelector('.events-finder__card') != null;
    const hadStorageCache = Boolean(readPanelCache(EVENTS_CACHE_KEY, EVENTS_CACHE_MAX_MS));
    const hasSomething = hadDomCache || Boolean(lastEventsPayload) || hadStorageCache;

    if (!quiet && !hasSomething) {
      listStatus.hidden = false;
      listStatus.className = 'events-finder__stub muted';
      listStatus.textContent = 'Loading events…';
      if (!listEl.contains(listStatus)) listEl.replaceChildren(listStatus);
    }

    try {
      const url = catalogOnly
        ? '/api/events-finder/events?catalogOnly=1'
        : '/api/events-finder/events';
      const r = await fetch(url, { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || data.hint || `HTTP ${r.status}`);
      }
      writePanelCache(EVENTS_CACHE_KEY, data);
      paintEvents(data, { fromCache: quiet && data.ingestPending === true });
      if (data.ingestPending === true) {
        if (!catalogOnly || opts.pollAttempt == null) startIngestPoll();
        return true;
      }
      if (!catalogOnly) stopIngestPoll();
      return false;
    } catch (e) {
      if (hasSomething) return Boolean(opts.pollAttempt);
      listEl.replaceChildren();
      const err = document.createElement('p');
      err.className = 'events-finder__stub events-finder__msg--err';
      err.textContent =
        e && typeof e === 'object' && 'message' in e
          ? String(e.message)
          : 'Could not load events.';
      listEl.append(err);
      return false;
    }
  }

  /**
   * @param {boolean} open
   */
  function setFiltersOpen(open) {
    filterPanel.hidden = !open;
    toggleBtn.classList.toggle('events-finder__toggle--open', open);
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // Always start collapsed (including bfcache restore).
  setFiltersOpen(false);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) setFiltersOpen(false);
  });
  viewBtn.addEventListener('click', (ev) => {
    if (mapBackdrop) closeMapWindow();
    else openMapWindow(ev);
  });

  /** @type {HTMLElement | null} */
  let expandedBackdrop = null;
  /** @type {HTMLElement | null} */
  let expandedPlaceholder = null;
  /** @type {HTMLElement | null} */
  let expandHomeParent = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let expandedKeyHandler = null;

  const expandBtn =
    document.getElementById('events-finder-expand') ||
    root.closest('.life-sidebar__card--events')?.querySelector('.life-sidebar__card-expand');

  function closeExpanded() {
    if (!expandedBackdrop) return;
    const home = expandHomeParent;
    const placeholder = expandedPlaceholder;
    root.classList.remove('events-finder--expanded');
    if (home && placeholder && placeholder.isConnected) {
      home.insertBefore(root, placeholder);
      placeholder.remove();
    } else if (home) {
      home.append(root);
    }
    if (expandedKeyHandler) {
      document.removeEventListener('keydown', expandedKeyHandler);
      expandedKeyHandler = null;
    }
    expandedBackdrop.remove();
    expandedBackdrop = null;
    expandedPlaceholder = null;
    expandHomeParent = null;
    if (expandBtn instanceof HTMLButtonElement) {
      expandBtn.setAttribute('aria-expanded', 'false');
      expandBtn.title = 'Pop out events';
      expandBtn.setAttribute('aria-label', 'Pop out events');
    }
  }

  function openExpanded() {
    if (expandedBackdrop) return;
    expandHomeParent = root.parentElement;
    if (!expandHomeParent) return;

    const placeholder = document.createElement('p');
    placeholder.className = 'events-finder__expanded-placeholder muted';
    placeholder.textContent = 'Events are open in the large window.';
    expandHomeParent.insertBefore(placeholder, root);
    expandedPlaceholder = placeholder;

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__expanded-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__expanded';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-labelledby', 'events-finder-expanded-title');

    const bar = document.createElement('div');
    bar.className = 'events-finder__expanded-bar';
    const title = document.createElement('h2');
    title.id = 'events-finder-expanded-title';
    title.className = 'events-finder__expanded-title';
    title.textContent = 'Events';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'events-finder__expanded-close';
    closeBtn.setAttribute('aria-label', 'Close expanded events');
    closeBtn.title = 'Close';
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
    bar.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'events-finder__expanded-body';
    root.classList.add('events-finder--expanded');
    body.append(root);
    shell.append(bar, body);
    backdrop.append(shell);
    document.body.append(backdrop);
    expandedBackdrop = backdrop;

    if (expandBtn instanceof HTMLButtonElement) {
      expandBtn.setAttribute('aria-expanded', 'true');
      expandBtn.title = 'Events popped out';
      expandBtn.setAttribute('aria-label', 'Events popped out');
    }

    closeBtn.addEventListener('click', closeExpanded);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeExpanded();
    });
    expandedKeyHandler = (e) => {
      if (e.key === 'Escape') {
        if (mapBackdrop) return;
        e.preventDefault();
        closeExpanded();
      }
    };
    document.addEventListener('keydown', expandedKeyHandler);
    closeBtn.focus();
  }

  if (expandBtn instanceof HTMLButtonElement) {
    expandBtn.addEventListener('click', () => {
      if (expandedBackdrop) closeExpanded();
      else openExpanded();
    });
  }

  toggleBtn.addEventListener('click', async () => {
    const opening = filterPanel.hidden;
    if (opening) {
      setFiltersOpen(true);
      return;
    }
    if (filtersReady) {
      if (filterAutosaveTimer) {
        clearTimeout(filterAutosaveTimer);
        filterAutosaveTimer = null;
      }
      const ok = await saveFilters();
      if (!ok) return;
    }
    setFiltersOpen(false);
  });

  const controls = [zipInput, milesInput, timeInput, conferenceInput, saveBtn];
  for (const el of controls) el.disabled = true;
  calendar.setDisabled(true);
  cityChecks.setDisabled(true);
  filterMsg.hidden = false;
  filterMsg.textContent = 'Loading…';

  /**
   * @param {object} data
   * @param {{ enable?: boolean }} [opts]
   */
  function applyCriteria(data, opts = {}) {
    applyingCriteria = true;
    try {
      taste = {
        lookFor: typeof data.lookFor === 'string' ? data.lookFor : '',
        skip: typeof data.skip === 'string' ? data.skip : '',
        blacklist: typeof data.blacklist === 'string' ? data.blacklist : '',
        scrape: data.scrape && typeof data.scrape === 'object' ? data.scrape : undefined,
        hiddenEventIds: Array.isArray(data.hiddenEventIds)
          ? data.hiddenEventIds.map(String)
          : [],
        skippedEvents: Array.isArray(data.skippedEvents) ? data.skippedEvents : [],
        favoriteEventIds: Array.isArray(data.favoriteEventIds)
          ? data.favoriteEventIds.map(String)
          : [],
        calendarAddedEventIds: Array.isArray(data.calendarAddedEventIds)
          ? data.calendarAddedEventIds.map(String)
          : [],
        conferenceWatchlist: Array.isArray(data.conferenceWatchlist)
          ? data.conferenceWatchlist.map(String)
          : [],
      };
      applyGoogleCalendarConfig(data.googleCalendar);
      syncShowSkippedButton();
      conferenceInput.value = (taste.conferenceWatchlist || []).join('\n');
      syncConferenceToggleLabel();

      const miles = data.filters?.maxMiles;
      milesInput.value = miles == null || miles === '' ? '25' : String(miles);
      zipInput.value =
        typeof data.filters?.originZip === 'string' && data.filters.originZip
          ? data.filters.originZip
          : typeof data.geo?.zip === 'string' && data.geo.zip
            ? data.geo.zip
            : '';
      calendar.setRange(
        data.filters?.dateFrom || null,
        data.filters?.dateTo || null,
        data.filters?.dates || [],
      );
      timeInput.value = normalizeLocalTime(data.filters?.earliestLocalTime) || '';
      attendanceChecks.setAttendance(data.filters?.attendance || 'any');
      if (Array.isArray(data.filters?.cities) && data.filters.cities.length) {
        savedCitySelection = data.filters.cities.map(String);
      } else {
        savedCitySelection = null;
      }

      if (opts.enable !== false) {
        for (const el of controls) el.disabled = false;
        calendar.setDisabled(false);
        cityChecks.setDisabled(false);
        attendanceChecks.setDisabled(false);
        filtersReady = true;
        filterMsg.hidden = true;
        filterMsg.textContent = '';
      }

      if (lastEventsPayload) refilterFeedForTaste(taste);
    } finally {
      applyingCriteria = false;
      if (filtersReady && filterAutosaveReload) {
        scheduleFilterAutosave({ reload: true });
      }
    }
  }

  const cachedCriteria = readPanelCache(CRITERIA_CACHE_KEY, CRITERIA_CACHE_MAX_MS);
  if (cachedCriteria && typeof cachedCriteria === 'object') {
    // Enable filters UI from cache, but do not paint events until network criteria
    // arrives — stale localStorage skip lists were reviving already-skipped cards.
    applyCriteria(cachedCriteria, { enable: true });
  }

  const cachedEvents = readPanelCache(EVENTS_CACHE_KEY, EVENTS_CACHE_MAX_MS);

  function paintCachedEventsIfNeeded() {
    if (!cachedEvents || typeof cachedEvents !== 'object' || lastEventsPayload) return;
    const painted = taste ? applyTasteToEventsPayload(cachedEvents, taste) : cachedEvents;
    paintEvents(painted, { fromCache: true });
  }

  void loadEvents();

  fetch('/api/events-finder-criteria', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      writePanelCache(CRITERIA_CACHE_KEY, data);
      applyCriteria(data, { enable: true });
      // Paint cached events only after authoritative skips are loaded.
      paintCachedEventsIfNeeded();
    })
    .catch((e) => {
      if (filtersReady) {
        // Criteria fetch failed but cache enabled UI — still show cached events.
        paintCachedEventsIfNeeded();
        return;
      }
      filterMsg.classList.add('events-finder__msg--err');
      filterMsg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load filters.';
      saveBtn.disabled = true;
    });

  saveBtn.addEventListener('click', async () => {
    if (filterAutosaveTimer) {
      clearTimeout(filterAutosaveTimer);
      filterAutosaveTimer = null;
    }
    filterAutosaveReload = false;
    const ok = await saveFilters();
    if (!ok) {
      filterMsg.hidden = false;
      filterMsg.classList.add('events-finder__msg--err');
      filterMsg.textContent = lastCriteriaSaveError || 'Could not save filters.';
      return;
    }
    setFiltersOpen(false);
  });

  zipInput.addEventListener('input', () => {
    scheduleFilterAutosave({ reload: true });
  });
  milesInput.addEventListener('input', () => {
    scheduleFilterAutosave({ reload: true });
  });
  const onTimeFilterChange = () => {
    if (lastEventsPayload) paintEvents(lastEventsPayload);
    scheduleFilterAutosave({ reload: true });
  };
  timeInput.addEventListener('input', onTimeFilterChange);
  attendanceChecks.root.addEventListener('change', () => {
    if (lastEventsPayload) paintEvents(lastEventsPayload);
    scheduleFilterAutosave({ reload: true });
  });
}