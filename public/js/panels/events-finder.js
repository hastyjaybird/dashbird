/**
 * Events sidebar — feed filters + list (Gmail intake first; more sources later).
 * Filters share /api/events-finder-criteria with Settings.
 */
import { createRangeCalendar } from './events-filter-ui.js';
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const FILTERS_OPEN_KEY = 'dashbird.events.filtersOpen';
const EVENTS_CACHE_KEY = 'events-finder:events';
const EVENTS_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const CRITERIA_CACHE_KEY = 'events-finder:criteria';
const CRITERIA_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

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
  toggleBtn.setAttribute('aria-label', 'Filters');
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'events-finder__toggle-label';
  toggleLabel.textContent = 'Filters';
  const toggleArrow = document.createElement('span');
  toggleArrow.className = 'events-finder__toggle-arrow';
  toggleArrow.setAttribute('aria-hidden', 'true');
  toggleBtn.append(toggleLabel, toggleArrow);
  toolbar.append(toggleBtn);

  const filterPanel = document.createElement('div');
  filterPanel.id = 'events-finder-filters';
  filterPanel.className = 'events-finder__filters';
  filterPanel.hidden = true;

  fieldLabel(filterPanel, 'ZIP', 'events-finder-zip');
  const zipRow = document.createElement('div');
  zipRow.className = 'events-finder__zip-row';

  const zipInput = document.createElement('input');
  zipInput.id = 'events-finder-zip';
  zipInput.className = 'events-finder__input events-finder__input--zip';
  zipInput.type = 'text';
  zipInput.inputMode = 'numeric';
  zipInput.autocomplete = 'postal-code';
  zipInput.maxLength = 5;
  zipInput.placeholder = '94608';
  zipInput.title = 'Center ZIP for city radius';
  zipRow.append(zipInput);

  fieldLabel(zipRow, 'Max miles', 'events-finder-miles');
  const milesInput = document.createElement('input');
  milesInput.id = 'events-finder-miles';
  milesInput.className = 'events-finder__input events-finder__input--miles';
  milesInput.type = 'number';
  milesInput.min = '1';
  milesInput.max = '100';
  milesInput.step = '0.5';
  milesInput.placeholder = '25';
  milesInput.title = 'Radius from ZIP — Apply checks cities in range';
  zipRow.append(milesInput);

  const applyRadiusBtn = document.createElement('button');
  applyRadiusBtn.type = 'button';
  applyRadiusBtn.className = 'events-finder__radius-btn';
  applyRadiusBtn.textContent = 'Apply radius';
  applyRadiusBtn.title = 'Find cities within max miles of ZIP and check those boxes';
  zipRow.append(applyRadiusBtn);

  filterPanel.append(zipRow);

  const radiusMsg = document.createElement('p');
  radiusMsg.className = 'events-finder__radius-msg muted';
  radiusMsg.hidden = true;
  radiusMsg.setAttribute('aria-live', 'polite');
  filterPanel.append(radiusMsg);

  const citiesLabel = document.createElement('p');
  citiesLabel.className = 'events-finder__label';
  citiesLabel.textContent = 'Cities';
  filterPanel.append(citiesLabel);

  const citiesBox = document.createElement('div');
  citiesBox.className = 'events-finder__checkboxes';
  citiesBox.setAttribute('role', 'group');
  citiesBox.setAttribute('aria-label', 'Cities');
  filterPanel.append(citiesBox);

  /** @type {Map<string, HTMLInputElement>} */
  const cityChecks = new Map();
  /** @type {string[]} */
  let cityOptions = [];

  const datesLabel = document.createElement('p');
  datesLabel.className = 'events-finder__label';
  datesLabel.textContent = 'Dates';
  filterPanel.append(datesLabel);

  const calendar = createRangeCalendar({
    idPrefix: 'events-finder-cal',
    classPrefix: 'events-cal',
  });
  filterPanel.append(calendar.root);

  fieldLabel(filterPanel, 'Earliest time', 'events-finder-earliest');
  const timeInput = document.createElement('input');
  timeInput.id = 'events-finder-earliest';
  timeInput.className = 'events-finder__input events-finder__input--time';
  timeInput.type = 'time';
  timeInput.step = '300';
  timeInput.value = '11:00';
  timeInput.title = 'Skip events that start before this local time';
  filterPanel.append(timeInput);

  const filterActions = document.createElement('div');
  filterActions.className = 'events-finder__filter-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'events-finder__save';
  saveBtn.textContent = 'Save filters';

  const filterMsg = document.createElement('p');
  filterMsg.className = 'events-finder__msg';
  filterMsg.hidden = true;
  filterMsg.setAttribute('aria-live', 'polite');

  filterActions.append(saveBtn, filterMsg);
  filterPanel.append(filterActions);

  const listEl = document.createElement('div');
  listEl.className = 'events-finder__list';
  listEl.setAttribute('aria-live', 'polite');
  const listStatus = document.createElement('p');
  listStatus.className = 'events-finder__stub muted';
  listStatus.textContent = 'Loading events…';
  listEl.append(listStatus);

  root.append(toolbar, filterPanel, listEl);

  /** @type {{ lookFor: string, skip: string, scrape?: object, hiddenEventIds: string[] } | null} */
  let taste = null;
  let filtersReady = false;
  let saveInFlight = false;
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
   * Persist current taste + feed filters (and optional hidden ids).
   * @param {{ lookFor?: string, skip?: string, hiddenEventIds?: string[], silent?: boolean }} [patch]
   * @returns {Promise<boolean>}
   */
  async function saveCriteria(patch = {}) {
    if (!filtersReady || saveInFlight) return false;
    saveInFlight = true;
    if (!patch.silent) {
      saveBtn.disabled = true;
      filterMsg.hidden = false;
      filterMsg.classList.remove('events-finder__msg--err');
      filterMsg.textContent = 'Saving…';
    }
    try {
      const cities = [...cityChecks.entries()]
        .filter(([, input]) => input.checked)
        .map(([city]) => city);
      if (!cities.length) throw new Error('Pick at least one city.');
      const milesRaw = milesInput.value.trim();
      const range = calendar.getRange();
      const earliest = String(timeInput.value || '').trim();
      const lookFor = patch.lookFor ?? taste?.lookFor ?? '';
      const skip = patch.skip ?? taste?.skip ?? '';
      const hiddenEventIds = patch.hiddenEventIds ?? taste?.hiddenEventIds ?? [];
      const r = await fetch('/api/events-finder-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lookFor,
          skip,
          hiddenEventIds,
          filters: {
            cities,
            maxMiles: milesRaw === '' ? null : Number(milesRaw),
            dates: range.dates || [],
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
            earliestLocalTime: earliest || null,
            attendance: 'in_person',
            originZip: String(zipInput.value || '').replace(/\D/g, '').slice(0, 5) || null,
          },
          scrape: taste?.scrape,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      taste = {
        lookFor: typeof data.lookFor === 'string' ? data.lookFor : lookFor,
        skip: typeof data.skip === 'string' ? data.skip : skip,
        scrape: data.scrape && typeof data.scrape === 'object' ? data.scrape : taste?.scrape,
        hiddenEventIds: Array.isArray(data.hiddenEventIds)
          ? data.hiddenEventIds.map(String)
          : hiddenEventIds,
      };
      writePanelCache(CRITERIA_CACHE_KEY, {
        lookFor: taste.lookFor,
        skip: taste.skip,
        scrape: taste.scrape,
        hiddenEventIds: taste.hiddenEventIds,
        filters: data.filters,
        geo: data.geo,
      });
      if (data.filters?.earliestLocalTime) {
        timeInput.value = data.filters.earliestLocalTime;
      }
      if (!patch.silent) {
        filterMsg.hidden = true;
        filterMsg.textContent = '';
        saveBtn.disabled = false;
      }
      saveInFlight = false;
      return true;
    } catch (e) {
      if (!patch.silent) {
        filterMsg.classList.add('events-finder__msg--err');
        filterMsg.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save.';
        saveBtn.disabled = false;
      }
      saveInFlight = false;
      return false;
    }
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function saveFilters() {
    const ok = await saveCriteria();
    if (ok) void loadEvents();
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
    modal.className = 'events-finder__modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = document.createElement('h3');
    title.className = 'events-finder__modal-title';
    title.textContent = wantMore ? 'See more like this?' : 'See less like this?';

    const hint = document.createElement('p');
    hint.className = 'events-finder__modal-hint';
    hint.textContent = wantMore
      ? 'Add ideas to Look for (one per line). These steer discovery toward similar events.'
      : 'Add ideas to Skip (one per line). These steer discovery away from similar events.';

    const eventLabel = document.createElement('p');
    eventLabel.className = 'events-finder__modal-event';
    eventLabel.textContent = ev.title || 'Untitled event';

    const area = document.createElement('textarea');
    area.className = 'events-finder__modal-textarea';
    area.rows = 6;
    area.spellcheck = true;
    area.placeholder = 'One idea per line…';
    area.value = suggestPreferenceLines(ev, vibe);

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
    save.textContent = wantMore ? 'Add to Look for' : 'Add to Skip';

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
      const additions = area.value;
      if (!String(additions).trim()) {
        msg.hidden = false;
        msg.textContent = 'Add at least one preference line.';
        return;
      }
      save.disabled = true;
      msg.hidden = false;
      msg.textContent = 'Saving…';
      const nextLook = wantMore
        ? mergeTasteLines(taste?.lookFor ?? '', additions)
        : taste?.lookFor ?? '';
      const nextSkip = wantMore
        ? taste?.skip ?? ''
        : mergeTasteLines(taste?.skip ?? '', additions);
      const ok = await saveCriteria({
        lookFor: nextLook,
        skip: nextSkip,
        silent: true,
      });
      if (!ok) {
        msg.textContent = 'Could not save preferences.';
        save.disabled = false;
        return;
      }
      close();
      void loadEvents();
    });

    actions.append(cancel, save);
    modal.append(title, hint, eventLabel, area, msg, actions);
    backdrop.append(modal);
    document.body.append(backdrop);
    area.focus();
  }

  /**
   * @param {object} ev
   */
  async function hideEvent(ev) {
    const id = String(ev.id || '').trim();
    if (!id) return;
    if (!filtersReady) return;
    const nextHidden = [...(taste?.hiddenEventIds || [])];
    if (!nextHidden.includes(id)) nextHidden.push(id);
    // Optimistic remove from UI
    if (lastEventsPayload && Array.isArray(lastEventsPayload.events)) {
      lastEventsPayload = {
        ...lastEventsPayload,
        events: lastEventsPayload.events.filter((e) => String(e?.id || '') !== id),
      };
      paintEvents(lastEventsPayload);
    }
    const ok = await saveCriteria({ hiddenEventIds: nextHidden, silent: true });
    if (!ok && lastEventsPayload) {
      void loadEvents();
    }
  }

  /**
   * @param {object} ev
   * @param {{ fromCache?: boolean }} [opts]
   */
  function buildEventCard(ev, opts = {}) {
    const card = document.createElement('article');
    card.className = 'events-finder__card';
    if (opts.fromCache) card.classList.add('events-finder__card--stale');
    const eventUrl = String(ev.url || '').trim();
    if (eventUrl) card.title = 'Click to open';

    const imageUrl =
      String(ev.imageUrl || ev.raw?.imageUrl || ev.raw?.coverUrl || '').trim() || '';
    const snap = document.createElement('div');
    snap.className = 'events-finder__card-snap';
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
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
    head.append(title);

    const meta = document.createElement('p');
    meta.className = 'events-finder__card-meta';
    const metaBits = [formatWhen(ev.start)];
    if (Number.isFinite(ev.distanceMiles)) {
      metaBits.push(`${Math.round(ev.distanceMiles)} mi`);
    }
    const going = Number(ev.usersGoing ?? ev.raw?.usersGoing);
    if (Number.isFinite(going) && going > 0) metaBits.push(`${going} going`);
    meta.textContent = metaBits.filter(Boolean).join(' · ');

    const cats = [];
    const sourceLabel = String(ev.source || '').trim();
    if (sourceLabel) cats.push(sourceLabel);
    if (ev.online || ev.isOnline) cats.push('Online');
    else if (ev.city) cats.push(String(ev.city));
    let catRow = null;
    if (cats.length) {
      catRow = document.createElement('div');
      catRow.className = 'events-finder__card-cats';
      for (const cat of cats.slice(0, 3)) {
        const tag = document.createElement('span');
        tag.className = 'events-finder__card-cat';
        tag.textContent = cat;
        catRow.append(tag);
      }
    }

    const blurb = document.createElement('p');
    blurb.className = 'events-finder__card-blurb';
    const desc = String(ev.description || ev.raw?.description || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (desc) {
      blurb.textContent = summarizeDescription(desc);
    } else {
      blurb.hidden = true;
    }

    const place = String(ev.venue || ev.location || '').trim();
    const placeEl = document.createElement('p');
    placeEl.className = 'events-finder__card-place';
    if (place) {
      placeEl.textContent = place;
    } else {
      placeEl.hidden = true;
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
    hideBtn.className = 'events-finder__card-action events-finder__card-action--hide';
    hideBtn.setAttribute('aria-label', 'Skip this event');
    hideBtn.title = 'Not interested — skip';
    hideBtn.textContent = 'Skip';
    hideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void hideEvent(ev);
    });

    actions.append(upBtn, downBtn, hideBtn);

    card.append(snap, head, meta, ...(catRow ? [catRow] : []), blurb, placeEl, actions);
    if (eventUrl) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        window.open(eventUrl, '_blank', 'noopener,noreferrer');
      });
    }
    return card;
  }

  /**
   * @param {object} data
   * @param {{ fromCache?: boolean }} [opts]
   */
  function paintEvents(data, opts = {}) {
    lastEventsPayload = data;
    const hidden = new Set((taste?.hiddenEventIds || []).map((id) => String(id)));
    const events = (Array.isArray(data.events) ? data.events : []).filter((ev) => {
      const id = String(ev?.id || '').trim();
      return !id || !hidden.has(id);
    });
    const gmail = data.sources?.gmail;
    const facebook = data.sources?.facebook;
    listEl.replaceChildren();
    if (!events.length) {
      if (opts.fromCache) {
        listStatus.className = 'events-finder__stub muted';
        listStatus.textContent = 'Refreshing events…';
        listEl.append(listStatus);
        return;
      }
      const empty = document.createElement('p');
      empty.className = 'events-finder__stub muted';
      if (facebook && facebook.ok === false && facebook.hint) {
        empty.textContent = facebook.hint;
      } else if (gmail && gmail.ok === false && (!facebook || facebook.count === 0)) {
        empty.textContent =
          gmail.hint ||
          'Connect Intake Gmail (invites) in Settings → Events sources, set APIFY_TOKEN, and/or pin Facebook hosts in Filter criteria.';
      } else if (facebook?.refreshing) {
        empty.textContent = 'Facebook scrape running — refresh in a minute.';
      } else {
        empty.textContent =
          'No upcoming events matched your filters. Add Look for terms, pin hosts, or connect Gmail for invites.';
      }
      listEl.append(empty);
      return;
    }
    for (const ev of events) {
      listEl.append(buildEventCard(ev, opts));
    }
  }

  async function loadEvents() {
    const hadCache = listEl.querySelector('.events-finder__card') != null;
    if (!hadCache) {
      listStatus.hidden = false;
      listStatus.className = 'events-finder__stub muted';
      listStatus.textContent = 'Loading events…';
      if (!listEl.contains(listStatus)) listEl.replaceChildren(listStatus);
    }
    try {
      const r = await fetch('/api/events-finder/events', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || data.hint || `HTTP ${r.status}`);
      }
      writePanelCache(EVENTS_CACHE_KEY, data);
      paintEvents(data);
    } catch (e) {
      if (hadCache) return;
      listEl.replaceChildren();
      const err = document.createElement('p');
      err.className = 'events-finder__stub events-finder__msg--err';
      err.textContent =
        e && typeof e === 'object' && 'message' in e
          ? String(e.message)
          : 'Could not load events.';
      listEl.append(err);
    }
  }

  const cachedEvents = readPanelCache(EVENTS_CACHE_KEY, EVENTS_CACHE_MAX_MS);
  if (cachedEvents && typeof cachedEvents === 'object') {
    paintEvents(cachedEvents, { fromCache: true });
  }

  void loadEvents();

  /**
   * @param {boolean} open
   */
  function setFiltersOpen(open) {
    filterPanel.hidden = !open;
    toggleBtn.classList.toggle('events-finder__toggle--open', open);
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    writeFiltersOpen(open);
  }

  /**
   * @param {string[]} cities
   * @param {string[]} selected
   */
  function renderCityChecks(cities, selected) {
    citiesBox.replaceChildren();
    cityChecks.clear();
    const selectedSet = new Set((selected || []).map((c) => c.toLowerCase()));
    for (const city of cities) {
      const id = `events-finder-city-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const row = document.createElement('label');
      row.className = 'events-finder__check';
      row.htmlFor = id;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.value = city;
      input.checked = selectedSet.size ? selectedSet.has(city.toLowerCase()) : true;
      cityChecks.set(city, input);
      const span = document.createElement('span');
      span.textContent = city;
      row.append(input, span);
      citiesBox.append(row);
    }
  }

  applyRadiusBtn.addEventListener('click', async () => {
    const zip = String(zipInput.value || '').replace(/\D/g, '');
    const milesRaw = milesInput.value.trim();
    const miles = milesRaw === '' ? NaN : Number(milesRaw);
    radiusMsg.classList.remove('events-finder__radius-msg--err');
    if (zip.length !== 5) {
      radiusMsg.hidden = false;
      radiusMsg.classList.add('events-finder__radius-msg--err');
      radiusMsg.textContent = 'Enter a 5-digit ZIP.';
      return;
    }
    if (!Number.isFinite(miles) || miles <= 0) {
      radiusMsg.hidden = false;
      radiusMsg.classList.add('events-finder__radius-msg--err');
      radiusMsg.textContent = 'Set max miles (1–100).';
      return;
    }
    applyRadiusBtn.disabled = true;
    radiusMsg.hidden = false;
    radiusMsg.textContent = 'Scanning cities…';
    try {
      const r = await fetch(
        `/api/events-finder-criteria/cities-in-radius?zip=${encodeURIComponent(zip)}&miles=${encodeURIComponent(String(miles))}`,
        { cache: 'no-store' },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.hint || data.error || `HTTP ${r.status}`);
      }
      const names = Array.isArray(data.cityNames) ? data.cityNames.map(String) : [];
      if (!names.length) {
        radiusMsg.classList.add('events-finder__radius-msg--err');
        radiusMsg.textContent = `No catalog cities within ${miles} mi of ${data.place || zip}.`;
        return;
      }
      cityOptions = names;
      renderCityChecks(names, names);
      for (const input of cityChecks.values()) input.disabled = false;
      radiusMsg.textContent = `${names.length} cities within ${miles} mi of ${data.place || zip} — checked.`;
    } catch (e) {
      radiusMsg.classList.add('events-finder__radius-msg--err');
      radiusMsg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Radius lookup failed.';
    } finally {
      applyRadiusBtn.disabled = false;
    }
  });

  setFiltersOpen(readFiltersOpen());
  toggleBtn.addEventListener('click', async () => {
    const opening = filterPanel.hidden;
    if (opening) {
      setFiltersOpen(true);
      return;
    }
    if (filtersReady) {
      const ok = await saveFilters();
      if (!ok) return;
    }
    setFiltersOpen(false);
  });

  const controls = [zipInput, milesInput, timeInput, applyRadiusBtn, saveBtn];
  for (const el of controls) el.disabled = true;
  calendar.setDisabled(true);
  filterMsg.hidden = false;
  filterMsg.textContent = 'Loading…';

  /**
   * @param {object} data
   * @param {{ enable?: boolean }} [opts]
   */
  function applyCriteria(data, opts = {}) {
    taste = {
      lookFor: typeof data.lookFor === 'string' ? data.lookFor : '',
      skip: typeof data.skip === 'string' ? data.skip : '',
      scrape: data.scrape && typeof data.scrape === 'object' ? data.scrape : undefined,
      hiddenEventIds: Array.isArray(data.hiddenEventIds)
        ? data.hiddenEventIds.map(String)
        : [],
    };

    const homeCities =
      (Array.isArray(data.geo?.homeCities) && data.geo.homeCities.length
        ? data.geo.homeCities
        : null) ||
      (Array.isArray(data.geo?.bayAreaHomeCities) ? data.geo.bayAreaHomeCities : null) ||
      ['San Francisco', 'Oakland', 'Emeryville', 'Berkeley'];
    const selectedCities = Array.isArray(data.filters?.cities) ? data.filters.cities : homeCities;
    // Keep any previously radius-expanded cities in the checkbox list.
    const optionSet = new Set([...(cityOptions.length ? cityOptions : homeCities), ...selectedCities]);
    cityOptions = [...optionSet];
    renderCityChecks(cityOptions, selectedCities);

    const miles = data.filters?.maxMiles;
    milesInput.value = miles == null || miles === '' ? '' : String(miles);
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
    timeInput.value = data.filters?.earliestLocalTime || '11:00';

    if (opts.enable !== false) {
      for (const el of controls) el.disabled = false;
      calendar.setDisabled(false);
      for (const input of cityChecks.values()) input.disabled = false;
      filtersReady = true;
      filterMsg.hidden = true;
      filterMsg.textContent = '';
    }

    if (lastEventsPayload) paintEvents(lastEventsPayload);
  }

  const cachedCriteria = readPanelCache(CRITERIA_CACHE_KEY, CRITERIA_CACHE_MAX_MS);
  if (cachedCriteria && typeof cachedCriteria === 'object') {
    applyCriteria(cachedCriteria, { enable: true });
  }

  fetch('/api/events-finder-criteria', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      writePanelCache(CRITERIA_CACHE_KEY, data);
      applyCriteria(data, { enable: true });
    })
    .catch((e) => {
      if (filtersReady) return;
      filterMsg.classList.add('events-finder__msg--err');
      filterMsg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load filters.';
      saveBtn.disabled = true;
    });

  saveBtn.addEventListener('click', async () => {
    const ok = await saveFilters();
    if (ok) setFiltersOpen(false);
  });
}
