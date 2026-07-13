/**
 * Events sidebar — browse filters + list/map (Gmail intake first; more sources later).
 * Browse filters share /api/events-finder-criteria with Settings ingestion criteria
 * (same JSON file; filters vs scrape/lookFor/skip are applied at different stages).
 */
import { createCityChecks, createRangeCalendar, normalizeLocalTime } from './events-filter-ui.js';
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import { beginWaitCursor, endWaitCursor } from '../lib/wait-cursor.js';

const FILTERS_OPEN_KEY = 'dashbird.events.filtersOpen';
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
function readFiltersOpen() {
  try {
    const v = localStorage.getItem(FILTERS_OPEN_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * @param {boolean} open
 */
function writeFiltersOpen(open) {
  try {
    localStorage.setItem(FILTERS_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

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
 * @param {object} event
 * @param {{ lookFor?: string, skip?: string, blacklist?: string } | null | undefined} criteria
 * @returns {boolean}
 */
function eventPassesTasteClient(event, criteria) {
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

  /** @type {{ lookFor: string, skip: string, blacklist: string, scrape?: object, hiddenEventIds: string[], skippedEvents: object[], favoriteEventIds: string[], calendarAddedEventIds: string[] } | null} */
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
      if (!events.length) {
        mapNoteEl.hidden = false;
        mapNoteEl.textContent = 'No events to show on the map.';
      } else if (!mappable.length) {
        mapNoteEl.hidden = false;
        mapNoteEl.textContent = 'No mapped locations for these events (missing coordinates).';
      } else if (unmapped > 0) {
        mapNoteEl.hidden = false;
        mapNoteEl.textContent = `${mappable.length} on map · ${unmapped} without coordinates`;
      } else {
        mapNoteEl.hidden = false;
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
            minZoom: 8,
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
      attendance: 'in_person',
      originZip,
    };
  }

  /**
   * Debounced persist of browse filters so the last state survives reload.
   * @param {{ reload?: boolean }} [opts]
   */
  function scheduleFilterAutosave(opts = {}) {
    if (!filtersReady || applyingCriteria) return;
    if (opts.reload) filterAutosaveReload = true;
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
   * @param {{ lookFor?: string, skip?: string, blacklist?: string, hiddenEventIds?: string[], skippedEvents?: object[], unskipEventIds?: string[], favoriteEventIds?: string[], calendarAddedEventIds?: string[], silent?: boolean, includeFilters?: boolean, filters?: Record<string, unknown>, waitForIdle?: boolean }} [patch]
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
      const favoriteEventIds = patch.favoriteEventIds ?? taste?.favoriteEventIds ?? [];
      const calendarAddedEventIds =
        patch.calendarAddedEventIds ?? taste?.calendarAddedEventIds ?? [];
      /** @type {Record<string, unknown>} */
      const body = {
        lookFor,
        skip,
        blacklist,
        favoriteEventIds,
        calendarAddedEventIds,
        scrape: taste?.scrape,
      };
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
          : favoriteEventIds,
        calendarAddedEventIds: Array.isArray(data.calendarAddedEventIds)
          ? data.calendarAddedEventIds.map(String)
          : calendarAddedEventIds,
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
        filters: data.filters,
        geo: data.geo,
      });
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
   * Catalog reload is fire-and-forget so the Save click returns immediately after
   * the criteria write; paint updates when SQLite read completes.
   * @returns {Promise<boolean>}
   */
  async function saveFilters() {
    const ok = await saveCriteria({ waitForIdle: true });
    if (ok) {
      void loadEvents({ catalogOnly: true, quiet: true });
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
    save.textContent = wantMore ? 'Add to Look for' : 'Save & skip event';

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
      if (!wantMore && !hasGrey && !hasBlack) {
        msg.hidden = false;
        msg.textContent = 'Add at least one grey-list or black-list line (or both).';
        return;
      }
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
          const prevSkipped = Array.isArray(taste?.skippedEvents) ? [...taste.skippedEvents] : [];
          const nextSkipped = [
            record,
            ...prevSkipped.filter((s) => String(s?.id || '') !== id),
          ].filter(Boolean);
          // Upsert only this record — server merges; never send a stale full list.
          patch.skippedEvents = record ? [record] : [];
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
      seriesKey: null,
      skippedAt: new Date().toISOString(),
    };
  }

  /**
   * Client-side skip match (id / url / title+day / series) so filter repaints never revive skips.
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
    for (const s of list) {
      if (id && String(s?.id || '') === id) return true;
      const sSeries = String(s?.seriesKey || '').trim();
      if (seriesKey && sSeries && seriesKey === sSeries) return true;
      const sUrl = String(s?.url || '').trim().toLowerCase();
      if (url && sUrl && (url === sUrl || url.includes(sUrl) || sUrl.includes(url))) return true;
      const sTitle = String(s?.title || '').trim().toLowerCase();
      const sDay = s?.start != null ? String(s.start).slice(0, 10) : '';
      if (title && sTitle && title === sTitle && day && sDay && day === sDay) return true;
    }
    return false;
  }

  /**
   * @param {object} ev
   * @param {{ series?: boolean }} [opts]
   */
  async function hideEvent(ev, opts = {}) {
    const id = String(ev.id || '').trim();
    if (!id) return;
    if (!filtersReady) return;
    if (opts.series && !ev.isSeries) return;
    // Zoom/pan stay put via mapDidInitialFit (do not touch mapViewBeforePopup —
    // that stash is only for restoring the pre-pin-popup view).
    const record = skippedRecordFromEventLocal(ev, { series: Boolean(opts.series) });
    if (!record) return;
    const recordId = String(record.id || '');
    const seriesKey = String(record.seriesKey || '').trim();
    const prevSkipped = Array.isArray(taste?.skippedEvents) ? [...taste.skippedEvents] : [];
    const nextSkipped = [
      record,
      ...prevSkipped.filter((s) => String(s?.id || '') !== recordId),
    ].filter(Boolean);
    const nextHidden = nextSkipped.map((s) => String(s.id));
    if (taste) {
      taste = { ...taste, skippedEvents: nextSkipped, hiddenEventIds: nextHidden };
    }
    // Optimistic remove from main feed (whole series when requested).
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events)) {
      const removed = lastEventsPayload.events.filter((e) => {
        if (String(e?.id || '') === id) return true;
        if (seriesKey && String(e?.seriesKey || '') === seriesKey) return true;
        return false;
      });
      const removedIds = new Set(removed.map((e) => String(e?.id || '')).filter(Boolean));
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter((e) => {
          if (removedIds.has(String(e?.id || ''))) return false;
          if (seriesKey && String(e?.seriesKey || '') === seriesKey) return false;
          return true;
        }),
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
    const ok = await saveCriteria({
      skippedEvents: [record],
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
    const ok = await saveCriteria({
      unskipEventIds: [id],
      silent: true,
      waitForIdle: true,
    });
    if (ok) void loadEvents();
    else void loadEvents();
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

    const ok = await saveCriteria({
      favoriteEventIds: nextFavs,
      silent: true,
      waitForIdle: true,
    });
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
    const prev = [...(taste?.calendarAddedEventIds || [])].map(String);
    if (prev.includes(id)) {
      paintCalButton(calBtn, true);
      // Already tracked — still hide from the main feed.
      if (lastEventsPayload && Array.isArray(lastEventsPayload.events) && !showSkipped) {
        lastEventsPayload = {
          ...lastEventsPayload,
          events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
        };
        paintEvents(lastEventsPayload);
      }
      return;
    }
    const next = [...prev, id];
    if (taste) taste = { ...taste, calendarAddedEventIds: next };
    paintCalButton(calBtn, true);
    // Hide from the main feed right away.
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events) && !showSkipped) {
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
      };
      paintEvents(lastEventsPayload);
    }
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
    const priceLabel = String(ev.priceLabel || '').trim();
    if (priceLabel) metaBits.push(priceLabel);
    const going = Number(ev.usersGoing ?? ev.raw?.usersGoing);
    if (Number.isFinite(going) && going > 0) metaBits.push(`${going} going`);
    meta.textContent = metaBits.filter(Boolean).join(' · ');

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
      hideBtn.title = 'Not interested — skip this occurrence';
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

    card.append(snap, head, placeEl, cityEl, meta, blurb, actions, footer);
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
      selectedForUi = savedCitySelection;
      // Newly seen cities default to checked.
      for (const city of available) {
        if (!prevAvailable.includes(city) && !selectedForUi.includes(city)) {
          selectedForUi = [...selectedForUi, city];
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

    /**
     * @param {object} ev
     * @returns {boolean}
     */
    function passesCity(ev) {
      if (allChecked) return true;
      return selected.has(eventCityLabel(ev).toLowerCase());
    }

    const mainEvents = (Array.isArray(data.events) ? data.events : [])
      .filter(passesCity)
      .filter((ev) => {
        // Never show skipped in the main feed, even if a stale payload still lists them.
        const skippedPool = [
          ...(Array.isArray(data.skippedEvents) ? data.skippedEvents : []),
          ...(Array.isArray(taste?.skippedEvents) ? taste.skippedEvents : []),
        ];
        return !eventMatchesSkippedLocal(ev, skippedPool);
      });
    const skippedList = (Array.isArray(data.skippedEvents) ? data.skippedEvents : [])
      .filter(passesCity)
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
    const gmail = data.sources?.gmail;
    const facebook = data.sources?.facebook;
    const hadCards = listEl.querySelector('.events-finder__card') != null;
    listEl.replaceChildren();
    if (data.ingestPending === true && !showSkipped) {
      const updating = document.createElement('p');
      updating.className = 'events-finder__stub events-finder__updating muted';
      updating.textContent = 'Updating from sources…';
      listEl.append(updating);
    }
    if (!events.length) {
      if ((opts.fromCache || data.ingestPending) && !showSkipped) {
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
    writeFiltersOpen(open);
  }

  setFiltersOpen(readFiltersOpen());
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

  const controls = [zipInput, milesInput, timeInput, saveBtn];
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
      };
      applyGoogleCalendarConfig(data.googleCalendar);
      syncShowSkippedButton();

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
      if (Array.isArray(data.filters?.cities) && data.filters.cities.length) {
        savedCitySelection = data.filters.cities.map(String);
      } else {
        savedCitySelection = null;
      }

      if (opts.enable !== false) {
        for (const el of controls) el.disabled = false;
        calendar.setDisabled(false);
        cityChecks.setDisabled(false);
        filtersReady = true;
        filterMsg.hidden = true;
        filterMsg.textContent = '';
      }

      if (lastEventsPayload) refilterFeedForTaste(taste);
    } finally {
      applyingCriteria = false;
    }
  }

  const cachedCriteria = readPanelCache(CRITERIA_CACHE_KEY, CRITERIA_CACHE_MAX_MS);
  if (cachedCriteria && typeof cachedCriteria === 'object') {
    // Enable filters UI from cache, but do not paint events until network criteria
    // arrives — stale localStorage skip lists were reviving already-skipped cards.
    applyCriteria(cachedCriteria, { enable: true });
  }

  const cachedEvents = readPanelCache(EVENTS_CACHE_KEY, EVENTS_CACHE_MAX_MS);

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
      if (cachedEvents && typeof cachedEvents === 'object' && !lastEventsPayload) {
        const painted = taste
          ? applyTasteToEventsPayload(cachedEvents, taste)
          : cachedEvents;
        paintEvents(painted, { fromCache: true });
      }
    })
    .catch((e) => {
      if (filtersReady) {
        // Criteria fetch failed but cache enabled UI — still show cached events.
        if (cachedEvents && typeof cachedEvents === 'object' && !lastEventsPayload) {
          const painted = taste
            ? applyTasteToEventsPayload(cachedEvents, taste)
            : cachedEvents;
          paintEvents(painted, { fromCache: true });
        }
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
    const ok = await saveFilters();
    if (ok) setFiltersOpen(false);
  });

  zipInput.addEventListener('input', () => {
    scheduleFilterAutosave({ reload: true });
  });
  milesInput.addEventListener('input', () => {
    scheduleFilterAutosave({ reload: true });
  });
  timeInput.addEventListener('change', () => {
    scheduleFilterAutosave({ reload: true });
  });
  timeInput.addEventListener('input', () => {
    scheduleFilterAutosave({ reload: true });
  });
}