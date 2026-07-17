import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import {
  pushMobileNav,
  mobileNavBack,
  isMobileNavApplying,
} from '../lib/mobile-history.js';
import {
  createCityChecks,
  createRangeCalendar,
  normalizeLocalTime,
} from './events-filter-ui.js';

const EVENTS_CACHE_KEY = 'events-finder:events';
const EVENTS_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const CRITERIA_CACHE_KEY = 'events-finder:criteria';
const CRITERIA_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const SHOW_SKIPPED_KEY = 'dashbird.events.showSkipped';

const DEFAULT_GOOGLE_CALENDAR = {
  name: 'Random Events',
  authuser: '',
  src: '',
};

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
 * @param {unknown} iso
 * @returns {string}
 */
function formatWhen(iso) {
  if (!iso) return 'Date TBD';
  const ms = Date.parse(String(iso));
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
    const city = eventCityLabel(ev);
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(city);
  }
  return out;
}

/**
 * Tiny thumb URL for mobile list cards (prefer low-res CDN params).
 * @param {string} src
 * @returns {string}
 */
function rewriteEventImageSrcTiny(src) {
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
          return `https://partiful.imgix.net/${objectPath}?fit=crop&w=180&h=220&q=60&auto=format`;
        }
      }
    }
    if (/\.imgix\.net$/i.test(u.hostname) || /imgix\.net$/i.test(u.hostname)) {
      u.searchParams.set('w', '180');
      u.searchParams.set('h', '220');
      u.searchParams.set('q', '60');
      u.searchParams.set('auto', 'format');
      u.searchParams.set('fit', 'crop');
      return u.toString();
    }
    if (/fbcdn\.net$/i.test(u.hostname) || /facebook\.com$/i.test(u.hostname)) {
      if (!u.searchParams.has('stp')) {
        u.searchParams.set('w', '180');
        u.searchParams.set('h', '220');
      }
      return u.toString();
    }
  } catch {
    /* keep */
  }
  return raw;
}

/**
 * @param {object} ev
 * @param {{ name: string, authuser: string, src: string }} calTarget
 * @returns {string}
 */
function googleCalendarAddUrl(ev, calTarget) {
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
    const end =
      Number.isFinite(endRaw) && endRaw > startMs
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
  if (calTarget.src) params.set('src', calTarget.src);
  if (calTarget.authuser) params.set('authuser', calTarget.authuser);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * @param {object} ev
 * @returns {object | null}
 */
function skippedRecordFromEvent(ev) {
  const id = String(ev?.id || '').trim();
  if (!id) return null;
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
    seriesKey: String(ev?.seriesKey || '').trim() || null,
    skippedAt: new Date().toISOString(),
  };
}

/**
 * @param {unknown} title
 * @returns {string}
 */
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
 * @returns {boolean}
 */
function eventMatchesSkipRecord(ev, record) {
  if (!ev || !record) return false;
  const id = String(ev?.id || '').trim();
  const recordId = String(record?.id || '').trim();
  if (id && recordId && id === recordId) return true;
  const seriesKey = String(ev?.seriesKey || '').trim();
  const recordSeries = String(record?.seriesKey || '').trim();
  if (seriesKey && recordSeries && seriesKey === recordSeries) return true;
  return eventMatchesSkippedLocal(ev, [record]);
}

/**
 * Slim Events Finder list — filters + tiny icons + skip / heart / add-to-cal.
 * @param {HTMLElement | null} root
 */
export function mountEventsFinderMobile(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-events');

  const toolbar = document.createElement('div');
  toolbar.className = 'mobile-events__toolbar';

  const filterToggle = document.createElement('button');
  filterToggle.type = 'button';
  filterToggle.className = 'mobile-events__filter-toggle';
  filterToggle.setAttribute('aria-expanded', 'false');
  filterToggle.innerHTML =
    '<span class="mobile-events__filter-toggle-label">Filters</span><span class="mobile-events__filter-toggle-arrow" aria-hidden="true">▾</span>';

  toolbar.append(filterToggle);

  const filterPanel = document.createElement('div');
  filterPanel.className = 'mobile-events__filters';
  filterPanel.hidden = true;

  const areaRow = document.createElement('div');
  areaRow.className = 'mobile-events__filter-row';

  const zipField = document.createElement('label');
  zipField.className = 'mobile-events__filter';
  const zipLabel = document.createElement('span');
  zipLabel.textContent = 'ZIP';
  const zipInput = document.createElement('input');
  zipInput.className = 'mobile-events__filter-input';
  zipInput.type = 'text';
  zipInput.inputMode = 'numeric';
  zipInput.autocomplete = 'postal-code';
  zipInput.maxLength = 5;
  zipInput.placeholder = '94608';
  zipInput.setAttribute('aria-label', 'ZIP');
  zipField.append(zipLabel, zipInput);

  const milesField = document.createElement('label');
  milesField.className = 'mobile-events__filter';
  const milesLabel = document.createElement('span');
  milesLabel.textContent = 'Radius (mi)';
  const milesInput = document.createElement('input');
  milesInput.className = 'mobile-events__filter-input';
  milesInput.type = 'number';
  milesInput.min = '1';
  milesInput.max = '100';
  milesInput.step = '0.5';
  milesInput.placeholder = '25';
  milesInput.setAttribute('aria-label', 'Radius in miles');
  milesField.append(milesLabel, milesInput);

  areaRow.append(zipField, milesField);
  filterPanel.append(areaRow);

  const citiesField = document.createElement('div');
  citiesField.className = 'mobile-events__filter mobile-events__filter--block';
  const citiesLabel = document.createElement('span');
  citiesLabel.textContent = 'Cities';
  /** @type {string[] | null} */
  let savedCitySelection = null;
  const cityChecks = createCityChecks({
    idPrefix: 'mobile-events-city',
    classPrefix: 'mobile-events',
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
      paint(lastEventsPayload);
      scheduleFilterAutosave();
    },
  });
  const citiesEmpty = document.createElement('p');
  citiesEmpty.className = 'mobile-events__cities-empty';
  citiesEmpty.textContent = 'Cities appear when events load.';
  citiesField.append(citiesLabel, cityChecks.root, citiesEmpty);
  filterPanel.append(citiesField);

  const datesField = document.createElement('div');
  datesField.className = 'mobile-events__filter mobile-events__filter--block';
  const datesLabel = document.createElement('span');
  datesLabel.textContent = 'Dates';
  const calendar = createRangeCalendar({
    idPrefix: 'mobile-events-cal',
    classPrefix: 'events-cal',
    onChange: () => {
      if (lastEventsPayload) paint(lastEventsPayload);
      scheduleFilterAutosave({ reload: true });
    },
  });
  datesField.append(datesLabel, calendar.root);
  filterPanel.append(datesField);

  const timeField = document.createElement('label');
  timeField.className = 'mobile-events__filter mobile-events__filter--block';
  const timeLabel = document.createElement('span');
  timeLabel.textContent = 'Earliest (optional)';
  const timeInput = document.createElement('input');
  timeInput.className = 'mobile-events__filter-input mobile-events__filter-input--time';
  timeInput.type = 'time';
  timeInput.step = '60';
  timeInput.value = '';
  timeInput.setAttribute('aria-label', 'Earliest local start time');
  timeField.append(timeLabel, timeInput);
  filterPanel.append(timeField);

  const conferenceField = document.createElement('div');
  conferenceField.className = 'mobile-events__filter mobile-events__filter--block mobile-events__filter--conferences';

  const conferenceToggle = document.createElement('button');
  conferenceToggle.type = 'button';
  conferenceToggle.className = 'mobile-events__conferences-toggle';
  conferenceToggle.setAttribute('aria-expanded', 'false');
  conferenceToggle.setAttribute('aria-haspopup', 'dialog');
  conferenceToggle.textContent = 'Big conferences & festivals';

  const conferenceInput = document.createElement('textarea');
  conferenceInput.className = 'mobile-events__conferences-input';
  conferenceInput.hidden = true;
  conferenceInput.tabIndex = -1;
  conferenceInput.setAttribute('aria-hidden', 'true');
  conferenceInput.placeholder = 'e.g. open sauce';

  conferenceField.append(conferenceToggle, conferenceInput);
  filterPanel.append(conferenceField);

  /** @type {HTMLElement | null} */
  let conferencePopoutBackdrop = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let conferencePopoutKeyHandler = null;
  /** @type {HTMLElement | null} */
  let conferencePopoutStatusList = null;

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
    conferenceToggle.classList.remove('mobile-events__conferences-toggle--open');
  }

  /**
   * @param {{ title: string, body: HTMLElement, onClose?: () => void }} opts
   */
  function openConferencePopout(opts) {
    if (conferencePopoutBackdrop) closeConferencePopout();

    const backdrop = document.createElement('div');
    backdrop.className = 'events-finder__conference-popout-backdrop mobile-events__conference-popout-backdrop';
    const shell = document.createElement('div');
    shell.className = 'events-finder__conference-popout mobile-events__conference-popout';
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
    conferenceToggle.classList.add('mobile-events__conferences-toggle--open');

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
    conferenceToggle.textContent =
      count > 0
        ? `Big conferences & festivals (${count})`
        : 'Big conferences & festivals';
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

  /**
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildConferenceWatchStatusRow(item) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'events-finder__conference-status-row';
    row.title = 'View details';

    const name = document.createElement('span');
    name.className = 'events-finder__conference-status-name';
    name.textContent = String(item.title || item.query || 'Conference');

    const status = document.createElement('span');
    status.className = 'events-finder__conference-status-meta';
    status.textContent = [
      `URL ${conferenceUrlStatusLabel(item)}`,
      `Data ${conferenceDataStatusLabel(item)}`,
      `Display ${conferenceDisplayStatusLabel(item)}`,
    ].join(' · ');

    const summary = document.createElement('span');
    summary.className = 'events-finder__conference-status-summary muted';
    const bits = [String(item.whenLabel || '')];
    if (item.earlyBirdLine) bits.push(String(item.earlyBirdLine));
    else if (item.ticketPrice) bits.push(String(item.ticketPrice));
    summary.textContent = bits.filter(Boolean).join(' · ');

    row.append(name, status, summary);
    row.addEventListener('click', () => openConferenceDetailPopout(item));
    return row;
  }

  /**
   * @param {object[]} items
   * @param {HTMLElement} listEl
   */
  function paintConferenceWatchStatusList(items, listEl) {
    listEl.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'events-finder__conference-status-empty muted';
      empty.textContent = 'No conferences tracked yet — add names below.';
      listEl.append(empty);
      return;
    }
    for (const item of items) {
      listEl.append(buildConferenceWatchStatusRow(item));
    }
  }

  /**
   * @returns {object[]}
   */
  function conferenceWatchItemsFromPayload() {
    const raw = lastEventsPayload?.conferenceWatchlistItems;
    if (Array.isArray(raw)) return raw;
    return [];
  }

  function refreshConferencePopoutIfOpen() {
    if (!conferencePopoutStatusList) return;
    paintConferenceWatchStatusList(conferenceWatchItemsFromPayload(), conferencePopoutStatusList);
  }

  function openConferenceWatchlistPopout() {
    const wrap = document.createElement('div');
    wrap.className = 'events-finder__conference-popout-manage';

    const listHeading = document.createElement('p');
    listHeading.className = 'events-finder__conference-popout-section-title';
    listHeading.textContent = 'Tracked conferences';

    const statusList = document.createElement('div');
    statusList.className = 'events-finder__conference-status-list';
    conferencePopoutStatusList = statusList;
    paintConferenceWatchStatusList(conferenceWatchItemsFromPayload(), statusList);

    const editHeading = document.createElement('p');
    editHeading.className = 'events-finder__conference-popout-section-title';
    editHeading.textContent = 'Add or edit names';

    const hint = document.createElement('p');
    hint.className = 'mobile-events__conferences-hint muted';
    hint.textContent = 'One name per line — ~2 month heads-up with ticket and early bird dates.';

    const area = document.createElement('textarea');
    area.className = 'mobile-events__conferences-input mobile-events__conferences-input--popout';
    area.rows = 8;
    area.placeholder = 'e.g. open sauce';
    area.value = conferenceInput.value;

    wrap.append(listHeading, statusList, editHeading, hint, area);

    openConferencePopout({
      title: 'Big conferences & festivals',
      body: wrap,
      onClose: () => {
        conferenceInput.value = area.value;
        conferencePopoutStatusList = null;
        syncConferenceToggleLabel();
      },
    });

    area.addEventListener('input', () => {
      conferenceInput.value = area.value;
      syncConferenceToggleLabel();
      if (!criteriaReady || applyingCriteria) return;
      if (conferenceAutosaveTimer) clearTimeout(conferenceAutosaveTimer);
      conferenceAutosaveTimer = setTimeout(() => {
        conferenceAutosaveTimer = null;
        void autosaveConferenceWatchlist();
      }, 650);
    });
    area.focus();
  }

  conferenceToggle.addEventListener('click', () => {
    if (conferencePopoutBackdrop) closeConferencePopout();
    else openConferenceWatchlistPopout();
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let conferenceAutosaveTimer = null;
  conferenceInput.addEventListener('input', () => {
    if (!criteriaReady || applyingCriteria) return;
    if (conferenceAutosaveTimer) clearTimeout(conferenceAutosaveTimer);
    conferenceAutosaveTimer = setTimeout(() => {
      conferenceAutosaveTimer = null;
      void autosaveConferenceWatchlist();
    }, 650);
  });

  const filterActions = document.createElement('div');
  filterActions.className = 'mobile-events__filter-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mobile-events__filter-save';
  saveBtn.textContent = 'Save';

  const showSkippedBtn = document.createElement('button');
  showSkippedBtn.type = 'button';
  showSkippedBtn.className = 'mobile-events__show-skipped';
  showSkippedBtn.textContent = 'Show skipped';
  showSkippedBtn.title = 'Recover events you accidentally skipped';
  showSkippedBtn.setAttribute('aria-pressed', 'false');

  const filterMsg = document.createElement('p');
  filterMsg.className = 'mobile-events__filter-msg';
  filterMsg.hidden = true;
  filterMsg.setAttribute('aria-live', 'polite');

  filterActions.append(saveBtn, showSkippedBtn, filterMsg);
  filterPanel.append(filterActions);

  const status = document.createElement('p');
  status.className = 'mobile-events__status';
  status.textContent = 'Loading events…';

  const list = document.createElement('div');
  list.className = 'mobile-events__list';

  root.append(toolbar, filterPanel, status, list);

  /** @type {{ lookFor: string, skip: string, blacklist: string, scrape?: object, favoriteEventIds: string[], calendarAddedEventIds: string[], conferenceWatchlist: string[], skippedEvents: object[] } | null} */
  let taste = null;
  /** @type {{ name: string, authuser: string, src: string }} */
  let googleCalendarTarget = { ...DEFAULT_GOOGLE_CALENDAR };
  /** @type {object | null} */
  let lastEventsPayload = null;
  let criteriaReady = false;
  let applyingCriteria = false;
  let saveInFlight = false;
  let showSkipped = readShowSkipped();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let filterAutosaveTimer = null;
  let filterAutosaveReload = false;

  filterToggle.addEventListener('click', () => {
    const open = filterPanel.hidden;
    filterPanel.hidden = !open;
    filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    filterToggle.classList.toggle('mobile-events__filter-toggle--open', open);
    if (open && !isMobileNavApplying()) {
      pushMobileNav({ tab: 'events', pane: 'list', overlay: 'filters' });
    } else if (!open && history.state?.overlay === 'filters') {
      mobileNavBack();
    }
  });

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

  function syncShowSkippedButton() {
    const n = Array.isArray(taste?.skippedEvents)
      ? taste.skippedEvents.length
      : Number(lastEventsPayload?.skippedCount) || 0;
    showSkippedBtn.textContent = showSkipped
      ? `Hide skipped${n ? ` (${n})` : ''}`
      : `Show skipped${n ? ` (${n})` : ''}`;
    showSkippedBtn.setAttribute('aria-pressed', showSkipped ? 'true' : 'false');
    showSkippedBtn.classList.toggle('mobile-events__show-skipped--on', showSkipped);
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
   * @returns {Record<string, unknown> | null}
   */
  function readFiltersFromForm() {
    const originZipDigits = String(zipInput.value || '').replace(/\D/g, '').slice(0, 5);
    if (originZipDigits && originZipDigits.length !== 5) return null;
    const milesRaw = milesInput.value.trim();
    const maxMiles = milesRaw === '' ? 25 : Number(milesRaw);
    if (!Number.isFinite(maxMiles) || maxMiles <= 0 || maxMiles > 100) return null;
    const earliestRaw = String(timeInput.value || '').trim();
    if (earliestRaw && !normalizeLocalTime(earliestRaw)) return null;
    const available = lastEventsPayload ? citiesFromPayload(lastEventsPayload) : [];
    const selected = cityChecks.getSelected();
    const cities =
      available.length && selected.length && selected.length < available.length
        ? selected
        : [];
    const range = calendar.getRange();
    return {
      cities,
      maxMiles,
      dates: range.dates || [],
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      earliestLocalTime: normalizeLocalTime(earliestRaw) || null,
      attendance: 'in_person',
      originZip: originZipDigits || null,
    };
  }

  /**
   * @param {object} data
   */
  function applyFiltersToForm(data) {
    applyingCriteria = true;
    try {
      const filters = data.filters && typeof data.filters === 'object' ? data.filters : {};
      const miles = filters.maxMiles;
      milesInput.value = miles == null || miles === '' ? '25' : String(miles);
      zipInput.value =
        typeof filters.originZip === 'string' && filters.originZip
          ? filters.originZip
          : typeof data.geo?.zip === 'string' && data.geo.zip
            ? data.geo.zip
            : '';
      calendar.setRange(
        filters.dateFrom || null,
        filters.dateTo || null,
        filters.dates || [],
      );
      timeInput.value = normalizeLocalTime(filters.earliestLocalTime) || '';
      if (Array.isArray(filters.cities) && filters.cities.length) {
        savedCitySelection = filters.cities.map(String);
      } else {
        savedCitySelection = null;
      }
    } finally {
      applyingCriteria = false;
    }
  }

  /**
   * @param {object} data
   */
  function applyTaste(data) {
    taste = {
      lookFor: typeof data.lookFor === 'string' ? data.lookFor : '',
      skip: typeof data.skip === 'string' ? data.skip : '',
      blacklist: typeof data.blacklist === 'string' ? data.blacklist : '',
      scrape: data.scrape && typeof data.scrape === 'object' ? data.scrape : undefined,
      favoriteEventIds: Array.isArray(data.favoriteEventIds)
        ? data.favoriteEventIds.map(String)
        : [],
      calendarAddedEventIds: Array.isArray(data.calendarAddedEventIds)
        ? data.calendarAddedEventIds.map(String)
        : [],
      conferenceWatchlist: Array.isArray(data.conferenceWatchlist)
        ? data.conferenceWatchlist.map(String)
        : [],
      skippedEvents: Array.isArray(data.skippedEvents) ? data.skippedEvents : [],
    };
    applyGoogleCalendarConfig(data.googleCalendar);
    applyFiltersToForm(data);
    conferenceInput.value = (taste.conferenceWatchlist || []).join('\n');
    syncConferenceToggleLabel();
    criteriaReady = true;
    syncShowSkippedButton();
  }

  /**
   * @param {{ skippedEvents?: object[], unskipEventIds?: string[], favoriteEventIds?: string[], calendarAddedEventIds?: string[], conferenceWatchlist?: string[], includeFilters?: boolean, silent?: boolean }} [patch]
   * @returns {Promise<boolean>}
   */
  async function saveCriteria(patch = {}) {
    if (!criteriaReady || !taste) return false;
    if (saveInFlight) {
      const started = Date.now();
      while (saveInFlight && Date.now() - started < 4000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (saveInFlight) return false;
    }
    saveInFlight = true;
    const silent = patch.silent !== false;
    if (!silent) {
      saveBtn.disabled = true;
      filterMsg.hidden = false;
      filterMsg.classList.remove('mobile-events__filter-msg--err');
      filterMsg.textContent = 'Saving…';
    }
    try {
      /** @type {Record<string, unknown>} */
      const body = {
        lookFor: taste.lookFor,
        skip: taste.skip,
        blacklist: taste.blacklist,
        scrape: taste.scrape,
      };
      // Only write favorites / calendar-added when this patch intends to change them.
      // Filter autosave must omit these so it cannot clobber a concurrent heart / Cal tap.
      if (patch.favoriteEventIds !== undefined) {
        body.favoriteEventIds = patch.favoriteEventIds;
      }
      if (patch.calendarAddedEventIds !== undefined) {
        body.calendarAddedEventIds = patch.calendarAddedEventIds;
      }
      if (patch.conferenceWatchlist !== undefined) {
        body.conferenceWatchlist = patch.conferenceWatchlist;
      }
      if (patch.includeFilters) {
        const filters = readFiltersFromForm();
        if (!filters) {
          throw new Error('Check ZIP (5 digits), radius (1–100), and earliest time.');
        }
        body.filters = filters;
      }
      if (Array.isArray(patch.unskipEventIds) && patch.unskipEventIds.length) {
        body.unskipEventIds = patch.unskipEventIds.map(String).filter(Boolean);
      }
      if (patch.skippedEvents !== undefined) {
        body.skippedEvents = patch.skippedEvents;
        body.hiddenEventIds = patch.skippedEvents.map((s) => String(s?.id || '')).filter(Boolean);
      }
      const r = await fetch('/api/events-finder-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      if (typeof data.lookFor === 'string') taste.lookFor = data.lookFor;
      if (typeof data.skip === 'string') taste.skip = data.skip;
      if (typeof data.blacklist === 'string') taste.blacklist = data.blacklist;
      if (data.scrape && typeof data.scrape === 'object') taste.scrape = data.scrape;
      if (Array.isArray(data.favoriteEventIds)) {
        taste.favoriteEventIds = data.favoriteEventIds.map(String);
      } else if (patch.favoriteEventIds) {
        taste.favoriteEventIds = patch.favoriteEventIds.map(String);
      }
      if (Array.isArray(data.calendarAddedEventIds)) {
        taste.calendarAddedEventIds = data.calendarAddedEventIds.map(String);
      } else if (patch.calendarAddedEventIds) {
        taste.calendarAddedEventIds = patch.calendarAddedEventIds.map(String);
      }
      if (Array.isArray(data.conferenceWatchlist)) {
        taste.conferenceWatchlist = data.conferenceWatchlist.map(String);
      } else if (patch.conferenceWatchlist) {
        taste.conferenceWatchlist = patch.conferenceWatchlist.map(String);
      }
      if (Array.isArray(data.skippedEvents)) {
        taste.skippedEvents = data.skippedEvents;
      }
      if (data.filters && typeof data.filters === 'object' && patch.includeFilters) {
        applyFiltersToForm({ ...data, geo: data.geo });
      }
      writePanelCache(CRITERIA_CACHE_KEY, {
        lookFor: taste.lookFor,
        skip: taste.skip,
        blacklist: taste.blacklist,
        scrape: taste.scrape,
        filters: data.filters || body.filters,
        favoriteEventIds: taste.favoriteEventIds,
        calendarAddedEventIds: taste.calendarAddedEventIds,
        conferenceWatchlist: taste.conferenceWatchlist,
        skippedEvents: taste.skippedEvents,
        googleCalendar: googleCalendarTarget,
      });
      if (patch.conferenceWatchlist !== undefined) {
        conferenceInput.value = (taste.conferenceWatchlist || []).join('\n');
    syncConferenceToggleLabel();
      }
      syncShowSkippedButton();
      if (!silent) {
        filterMsg.textContent = 'Saved';
        filterPanel.hidden = true;
        filterToggle.setAttribute('aria-expanded', 'false');
        filterToggle.classList.remove('mobile-events__filter-toggle--open');
        setTimeout(() => {
          if (filterMsg.textContent === 'Saved') filterMsg.hidden = true;
        }, 1500);
      }
      return true;
    } catch (e) {
      if (!silent) {
        filterMsg.hidden = false;
        filterMsg.classList.add('mobile-events__filter-msg--err');
        filterMsg.textContent = e?.message || String(e);
      }
      return false;
    } finally {
      saveInFlight = false;
      if (!silent) saveBtn.disabled = false;
    }
  }

  /**
   * @param {{ reload?: boolean }} [opts]
   */
  function scheduleFilterAutosave(opts = {}) {
    if (applyingCriteria || !criteriaReady) return;
    if (opts.reload) filterAutosaveReload = true;
    if (filterAutosaveTimer) clearTimeout(filterAutosaveTimer);
    filterAutosaveTimer = setTimeout(async () => {
      filterAutosaveTimer = null;
      const shouldReload = filterAutosaveReload;
      filterAutosaveReload = false;
      const ok = await saveCriteria({ includeFilters: true, silent: true });
      if (ok && shouldReload) void loadEvents();
      else if (ok && lastEventsPayload) paint(lastEventsPayload);
    }, 650);
  }

  /**
   * @param {HTMLButtonElement} favBtn
   * @param {boolean} on
   */
  function paintFavButton(favBtn, on) {
    favBtn.classList.toggle('mobile-events__fav--on', on);
    favBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    favBtn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    favBtn.title = on ? 'Remove favorite' : 'Favorite';
    favBtn.textContent = on ? '♥' : '♡';
  }

  /**
   * @param {HTMLAnchorElement} calBtn
   * @param {boolean} added
   */
  function paintCalButton(calBtn, added) {
    const calName = googleCalendarTarget.name || 'Random Events';
    calBtn.classList.toggle('mobile-events__action--cal-added', added);
    if (added) {
      calBtn.textContent = 'Added to Cal';
      calBtn.setAttribute('aria-label', `Already added to ${calName}`);
      calBtn.title = `Already on ${calName}`;
    } else {
      calBtn.textContent = 'Add to Cal';
      calBtn.setAttribute('aria-label', `Add to ${calName}`);
      calBtn.title = `Add to ${calName}`;
    }
  }

  /**
   * @param {object} ev
   * @param {HTMLButtonElement} favBtn
   */
  async function toggleFavorite(ev, favBtn) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    if (favBtn.dataset.busy === '1') return;
    favBtn.dataset.busy = '1';
    favBtn.disabled = true;

    const prev = [...taste.favoriteEventIds];
    const nextOn = !prev.includes(id);
    const nextFavs = nextOn ? [...prev, id] : prev.filter((x) => x !== id);
    taste.favoriteEventIds = nextFavs;
    paintFavButton(favBtn, nextOn);

    const ok = await saveCriteria({ favoriteEventIds: nextFavs, silent: true });
    if (!ok) {
      taste.favoriteEventIds = prev;
      paintFavButton(favBtn, prev.includes(id));
    }

    favBtn.disabled = false;
    delete favBtn.dataset.busy;
  }

  /**
   * @param {object} ev
   */
  async function hideEvent(ev) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    const record = skippedRecordFromEvent(ev);
    if (!record) return;
    /** @type {object[]} */
    const skipBatch = [record];
    const seriesKey = String(record.seriesKey || '').trim();
    if (seriesKey) {
      skipBatch.push({
        id: `series:${seriesKey}`.slice(0, 400),
        key: null,
        url: null,
        title: record.title,
        start: record.start,
        source: record.source,
        venue: record.venue,
        city: record.city,
        imageUrl: record.imageUrl,
        seriesKey,
        skippedAt: record.skippedAt,
      });
    }
    const batchIds = new Set(skipBatch.map((s) => String(s?.id || '')).filter(Boolean));
    const prevSkipped = [...taste.skippedEvents];
    taste.skippedEvents = [
      ...skipBatch,
      ...prevSkipped.filter((s) => !batchIds.has(String(s?.id || ''))),
    ];
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events)) {
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter(
          (e) => !skipBatch.some((rec) => eventMatchesSkipRecord(e, rec)),
        ),
        skippedEvents: [
          { ...ev, skipped: true, skippedAt: record.skippedAt },
          ...(Array.isArray(lastEventsPayload.skippedEvents)
            ? lastEventsPayload.skippedEvents.filter((e) => !batchIds.has(String(e?.id || '')))
            : []),
        ],
        skippedCount: taste.skippedEvents.length,
      };
      paint(lastEventsPayload);
    }
    const ok = await saveCriteria({ skippedEvents: skipBatch, silent: true });
    if (!ok) {
      taste.skippedEvents = prevSkipped;
      void loadEvents();
    } else {
      if (lastEventsPayload) writePanelCache(EVENTS_CACHE_KEY, lastEventsPayload);
      syncShowSkippedButton();
    }
  }

  /**
   * @param {object} ev
   */
  async function unskipEvent(ev) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    const prevSkipped = [...taste.skippedEvents];
    taste.skippedEvents = prevSkipped.filter((s) => String(s?.id || '') !== id);
    if (lastEventsPayload) {
      lastEventsPayload = {
        ...lastEventsPayload,
        skippedEvents: (Array.isArray(lastEventsPayload.skippedEvents)
          ? lastEventsPayload.skippedEvents
          : []
        ).filter((e) => String(e?.id || '') !== id),
        skippedCount: taste.skippedEvents.length,
      };
      paint(lastEventsPayload);
    }
    const ok = await saveCriteria({ unskipEventIds: [id], silent: true });
    if (!ok) {
      taste.skippedEvents = prevSkipped;
    } else if (lastEventsPayload) {
      writePanelCache(EVENTS_CACHE_KEY, lastEventsPayload);
    }
    syncShowSkippedButton();
    void loadEvents();
  }

  /**
   * @param {object} ev
   * @param {HTMLAnchorElement} calBtn
   */
  async function markCalendarAdded(ev, calBtn) {
    const id = String(ev.id || '').trim();
    if (!id || !taste || !criteriaReady) return;
    const prev = [...taste.calendarAddedEventIds];
    if (prev.includes(id)) {
      paintCalButton(calBtn, true);
      if (lastEventsPayload && Array.isArray(lastEventsPayload.events) && !showSkipped) {
        lastEventsPayload = {
          ...lastEventsPayload,
          events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
        };
        paint(lastEventsPayload);
      }
      return;
    }
    const next = [...prev, id];
    taste.calendarAddedEventIds = next;
    paintCalButton(calBtn, true);
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events) && !showSkipped) {
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
      };
      paint(lastEventsPayload);
    }
    const ok = await saveCriteria({ calendarAddedEventIds: next, silent: true });
    if (!ok) {
      taste.calendarAddedEventIds = prev;
      void loadEvents();
    }
  }

  async function autosaveConferenceWatchlist() {
    const ok = await saveCriteria({
      silent: true,
      conferenceWatchlist: readConferenceWatchlistFromForm(),
    });
    if (ok) void loadEvents();
    return ok;
  }

  /**
   * @param {object} item
   */
  function openConferenceDetailPopout(item) {
    const eventUrl = String(item.url || '').trim();
    const body = document.createElement('div');
    body.className = 'events-finder__conference-detail';

    const badge = document.createElement('p');
    badge.className = 'mobile-events__conference-badge';
    badge.textContent = '2-month heads-up';

    const statusRow = document.createElement('p');
    statusRow.className = 'events-finder__conference-detail-status';
    statusRow.textContent = [
      `URL ${conferenceUrlStatusLabel(item)}`,
      `Data ${conferenceDataStatusLabel(item)}`,
      `Display ${conferenceDisplayStatusLabel(item)}`,
    ].join(' · ');

    const title = document.createElement('h3');
    title.className = 'events-finder__conference-detail-title';
    title.textContent = String(item.title || item.query || 'Conference');

    const whenEl = document.createElement('p');
    whenEl.className = 'events-finder__conference-detail-when';
    whenEl.textContent = String(item.whenLabel || 'Dates TBD');

    body.append(badge, statusRow, title, whenEl);

    if (item.placeLabel) {
      const placeEl = document.createElement('p');
      placeEl.className = 'events-finder__conference-detail-place';
      placeEl.textContent = String(item.placeLabel);
      body.append(placeEl);
    }

    const ticket = document.createElement('p');
    ticket.className = 'mobile-events__conference-ticket';
    if (item.researching) {
      ticket.textContent = 'Looking up dates and tickets…';
    } else if (item.earlyBirdLine) {
      ticket.textContent = String(item.earlyBirdLine);
    } else if (item.ticketPrice) {
      ticket.textContent = String(item.ticketPrice);
    } else {
      ticket.hidden = true;
    }
    if (!ticket.hidden) body.append(ticket);

    if (item.notes && !item.researching) {
      const notesEl = document.createElement('p');
      notesEl.className = 'events-finder__conference-detail-notes';
      notesEl.textContent = String(item.notes);
      body.append(notesEl);
    }

    if (eventUrl) {
      const link = document.createElement('a');
      link.className = 'events-finder__conference-detail-link';
      link.href = eventUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Official site';
      body.append(link);
    }

    openConferencePopout({
      title: String(item.title || item.query || 'Conference'),
      body,
    });
  }

  /**
   * @param {object} ev
   * @returns {HTMLElement}
   */
  function buildCard(ev) {
    const card = document.createElement('article');
    card.className = 'mobile-events__card';

    const eventUrl = String(ev.url || '').trim();
    const eventId = String(ev.id || '').trim();
    const imageUrl =
      String(ev.imageUrl || ev.raw?.imageUrl || ev.raw?.coverUrl || '').trim() || '';

    const row = document.createElement('div');
    row.className = 'mobile-events__row';

    const icon = document.createElement('div');
    icon.className = 'mobile-events__icon';
    const resolvedImage = rewriteEventImageSrcTiny(imageUrl);
    if (resolvedImage) {
      const img = document.createElement('img');
      img.src = resolvedImage;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        icon.replaceChildren();
        icon.classList.add('mobile-events__icon--empty');
        icon.textContent = String(ev.source || 'E').slice(0, 1).toUpperCase();
      });
      icon.append(img);
    } else {
      icon.classList.add('mobile-events__icon--empty');
      icon.textContent = String(ev.source || 'E').slice(0, 1).toUpperCase();
    }

    const body = document.createElement('div');
    body.className = 'mobile-events__body';

    const head = document.createElement('div');
    head.className = 'mobile-events__head';

    const title = document.createElement(eventUrl ? 'a' : 'h3');
    title.className = 'mobile-events__title';
    title.textContent = String(ev.title || '').trim() || 'Untitled event';
    if (eventUrl && title instanceof HTMLAnchorElement) {
      title.href = eventUrl;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'mobile-events__fav';
    const isFav = Boolean(eventId && taste?.favoriteEventIds?.includes(eventId));
    paintFavButton(favBtn, isFav);
    favBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void toggleFavorite(ev, favBtn);
    });

    head.append(title, favBtn);

    const meta = document.createElement('p');
    meta.className = 'mobile-events__meta';
    const bits = [formatWhen(ev.start)];
    const place = String(ev.venue || ev.location || '').trim();
    if (place) bits.push(place);
    if (ev.online || ev.isOnline) bits.push('Online');
    else if (ev.city) bits.push(String(ev.city));
    if (Number.isFinite(ev.distanceMiles)) bits.push(`${Math.round(ev.distanceMiles)} mi`);
    meta.textContent = bits.filter(Boolean).join(' · ');

    const actions = document.createElement('div');
    actions.className = 'mobile-events__actions';

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    if (showSkipped) {
      hideBtn.className = 'mobile-events__action mobile-events__action--unskip';
      hideBtn.setAttribute('aria-label', 'Restore this event');
      hideBtn.title = 'Unskip — show in feed again';
      hideBtn.textContent = 'Unskip';
      hideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void unskipEvent(ev);
      });
    } else {
      hideBtn.className = 'mobile-events__action mobile-events__action--skip';
      hideBtn.setAttribute('aria-label', 'Skip this event');
      hideBtn.title = 'Not interested — skip';
      hideBtn.textContent = 'Skip';
      hideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void hideEvent(ev);
      });
    }

    const calBtn = document.createElement('a');
    calBtn.className = 'mobile-events__action mobile-events__action--cal';
    calBtn.href = googleCalendarAddUrl(ev, googleCalendarTarget);
    calBtn.target = '_blank';
    calBtn.rel = 'noopener noreferrer';
    const calAdded = Boolean(eventId && taste?.calendarAddedEventIds?.includes(eventId));
    paintCalButton(calBtn, calAdded);
    calBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void markCalendarAdded(ev, calBtn);
    });

    actions.append(hideBtn, calBtn);
    body.append(head, meta, actions);
    row.append(icon, body);
    card.append(row);

    if (eventUrl) {
      card.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('a, button')) return;
        window.open(eventUrl, '_blank', 'noopener,noreferrer');
      });
    }
    return card;
  }

  /**
   * @param {object} data
   */
  function paint(data) {
    lastEventsPayload = data;
    syncShowSkippedButton();

    const available = citiesFromPayload(data);
    const prevSelected = cityChecks.getSelected();
    const prevAvailable = [...cityChecks.root.querySelectorAll('input[type="checkbox"]')].map(
      (el) => /** @type {HTMLInputElement} */ (el).value,
    );
    /** @type {string[] | null} */
    let selectedForUi = null;
    if (savedCitySelection && savedCitySelection.length) {
      selectedForUi = [...savedCitySelection];
      if (prevAvailable.length) {
        for (const city of available) {
          if (!prevAvailable.includes(city) && !selectedForUi.includes(city)) {
            selectedForUi = [...selectedForUi, city];
          }
        }
      }
    } else if (
      prevAvailable.length
      && prevSelected.length
      && prevSelected.length < prevAvailable.length
    ) {
      selectedForUi = prevSelected;
      for (const city of available) {
        if (!prevAvailable.includes(city)) selectedForUi = [...selectedForUi, city];
      }
    }
    cityChecks.setCities(available, selectedForUi);
    citiesEmpty.hidden = available.length > 0;
    cityChecks.root.hidden = available.length === 0;

    const selected = new Set(cityChecks.getSelected().map((c) => c.toLowerCase()));
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
    function passesClientFilters(ev) {
      if (!allChecked && !selected.has(eventCityLabel(ev).toLowerCase())) return false;
      if (!selectedDates.size && earliestMins == null) return true;
      const local = eventLocalDayAndMinutes(ev?.start);
      if (selectedDates.size) {
        if (!local?.day || !selectedDates.has(local.day)) return false;
      }
      if (earliestMins != null) {
        if (local == null || local.minutes < earliestMins) return false;
      }
      return true;
    }

    const mainEvents = (Array.isArray(data?.events) ? data.events : []).filter((ev) => {
      const skippedPool = [
        ...(Array.isArray(data?.skippedEvents) ? data.skippedEvents : []),
        ...(Array.isArray(taste?.skippedEvents) ? taste.skippedEvents : []),
      ];
      return !eventMatchesSkippedLocal(ev, skippedPool);
    });
    const skippedList = Array.isArray(data?.skippedEvents)
      ? data.skippedEvents
      : Array.isArray(taste?.skippedEvents)
        ? taste.skippedEvents
        : [];
    const pool = showSkipped ? skippedList : mainEvents;
    const events = pool.filter(passesClientFilters);

    list.replaceChildren();
    refreshConferencePopoutIfOpen();
    if (!events.length) {
      status.hidden = false;
      status.textContent = showSkipped
        ? 'No skipped events match these filters.'
        : 'No upcoming events match these filters.';
      return;
    }
    status.hidden = true;
    for (const ev of events) {
      list.append(buildCard(ev));
    }
  }

  saveBtn.addEventListener('click', async () => {
    const ok = await saveCriteria({ includeFilters: true, silent: false });
    if (ok) void loadEvents();
  });

  showSkippedBtn.addEventListener('click', () => {
    showSkipped = !showSkipped;
    writeShowSkipped(showSkipped);
    syncShowSkippedButton();
    if (lastEventsPayload) paint(lastEventsPayload);
  });

  zipInput.addEventListener('change', () => scheduleFilterAutosave({ reload: true }));
  milesInput.addEventListener('change', () => scheduleFilterAutosave({ reload: true }));
  timeInput.addEventListener('change', () => {
    if (lastEventsPayload) paint(lastEventsPayload);
    scheduleFilterAutosave();
  });

  const cachedEvents = readPanelCache(EVENTS_CACHE_KEY, EVENTS_CACHE_MAX_MS);
  const cachedCriteria = readPanelCache(CRITERIA_CACHE_KEY, CRITERIA_CACHE_MAX_MS);
  if (cachedCriteria && typeof cachedCriteria === 'object') {
    applyTaste(cachedCriteria);
  }
  if (cachedEvents && typeof cachedEvents === 'object') {
    paint(cachedEvents);
    status.hidden = false;
    status.textContent = 'Refreshing…';
  }

  async function loadCriteria() {
    try {
      const r = await fetch('/api/events-finder-criteria', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      applyTaste(data);
      writePanelCache(CRITERIA_CACHE_KEY, {
        lookFor: taste?.lookFor || '',
        skip: taste?.skip || '',
        blacklist: taste?.blacklist || '',
        scrape: taste?.scrape,
        filters: data.filters,
        geo: data.geo,
        favoriteEventIds: taste?.favoriteEventIds || [],
        calendarAddedEventIds: taste?.calendarAddedEventIds || [],
        conferenceWatchlist: taste?.conferenceWatchlist || [],
        skippedEvents: taste?.skippedEvents || [],
        googleCalendar: googleCalendarTarget,
      });
      if (lastEventsPayload) paint(lastEventsPayload);
    } catch {
      if (!criteriaReady) {
        taste = {
          lookFor: '',
          skip: '',
          blacklist: '',
          favoriteEventIds: [],
          calendarAddedEventIds: [],
          skippedEvents: [],
        };
        criteriaReady = true;
      }
    }
  }

  async function loadEvents() {
    try {
      const r = await fetch('/api/events-finder/events?catalogOnly=1', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      writePanelCache(EVENTS_CACHE_KEY, data);
      paint(data);
    } catch (e) {
      if (!list.childElementCount) {
        status.hidden = false;
        status.textContent = `Could not load events: ${e?.message || e}`;
      } else {
        status.hidden = false;
        status.textContent = 'Showing cached events (refresh failed).';
      }
    }
  }

  void Promise.all([loadCriteria(), loadEvents()]);

  document.addEventListener('dashbird:mobile-nav', (e) => {
    const s = e.detail;
    if (!s || s.tab !== 'events') return;
    if (s.overlay === 'filters') {
      filterPanel.hidden = true;
      filterToggle.setAttribute('aria-expanded', 'false');
      filterToggle.classList.remove('mobile-events__filter-toggle--open');
      return;
    }
    if (s.pane === 'list') {
      filterPanel.hidden = true;
      filterToggle.setAttribute('aria-expanded', 'false');
      filterToggle.classList.remove('mobile-events__filter-toggle--open');
    }
  });
}
