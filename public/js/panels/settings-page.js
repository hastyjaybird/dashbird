import { createRangeCalendar } from './events-filter-ui.js';

const WINDOW_HOURS = 24;
const GROUPS = ['Sky & space', 'Earth', 'Market & weather'];

/**
 * Collapsible settings section (collapsed by default).
 * @param {{ title: string, headingId: string, className?: string, open?: boolean }} opts
 * @returns {{ details: HTMLDetailsElement, body: HTMLDivElement, summary: HTMLElement }}
 */
function createCollapsibleSection({ title, headingId, className = '', open = false }) {
  const details = document.createElement('details');
  details.className = `settings-page__config-block panel panel--glass settings-page__section${
    className ? ` ${className}` : ''
  }`;
  details.open = open === true;

  const summary = document.createElement('summary');
  summary.className = 'settings-page__block-title settings-page__section-summary';
  summary.id = headingId;
  summary.textContent = title;
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'settings-page__config-block-inner settings-page__section-body';
  details.append(body);

  return { details, body, summary };
}

/**
 * Secondary ZIP for lightning bugs + fall foliage.
 * Shows the stored ZIP; “Change secondary ZIP” reveals the editor.
 * @param {HTMLElement} root
 */
function buildSecondaryWatchBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Secondary ZIP',
    headingId: 'settings-secondary-heading',
    className: 'settings-page__secondary-block',
  });

  const currentRow = document.createElement('p');
  currentRow.className = 'settings-page__secondary-current';
  const currentLabel = document.createElement('span');
  currentLabel.className = 'settings-page__secondary-current-label';
  currentLabel.textContent = 'Stored ZIP: ';
  const currentValue = document.createElement('strong');
  currentValue.className = 'settings-page__secondary-current-value';
  currentValue.textContent = '…';
  currentRow.append(currentLabel, currentValue);
  body.append(currentRow);

  const changeBtn = document.createElement('button');
  changeBtn.type = 'button';
  changeBtn.className = 'settings-page__rain-save settings-page__secondary-change';
  changeBtn.textContent = 'Change secondary ZIP';
  body.append(changeBtn);

  const editor = document.createElement('div');
  editor.className = 'settings-page__secondary-editor';
  editor.hidden = true;

  const label = document.createElement('label');
  label.className = 'settings-page__rain-label';
  label.htmlFor = 'settings-secondary-zip';
  label.textContent = 'US ZIP code';
  editor.append(label);

  const input = document.createElement('input');
  input.id = 'settings-secondary-zip';
  input.className = 'settings-page__secondary-zip-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 10;
  input.spellcheck = false;
  input.autocomplete = 'postal-code';
  editor.append(input);

  const actions = document.createElement('div');
  actions.className = 'settings-page__rain-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save ZIP';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-page__secondary-cancel';
  cancelBtn.textContent = 'Cancel';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  actions.append(saveBtn, cancelBtn, msg);
  editor.append(actions);
  body.append(editor);

  const firstSection = root.querySelector('.settings-page__section');
  if (firstSection) root.insertBefore(block, firstSection);
  else root.append(block);

  /** @type {string} */
  let storedZip = '';

  function showEditor(open) {
    editor.hidden = !open;
    changeBtn.hidden = open;
    if (open) {
      input.value = storedZip;
      input.focus();
      input.select();
    }
    msg.hidden = true;
    msg.textContent = '';
  }

  changeBtn.addEventListener('click', () => showEditor(true));
  cancelBtn.addEventListener('click', () => showEditor(false));

  fetch('/api/secondary-watch/zip', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (data?.zip) {
        storedZip = String(data.zip);
        currentValue.textContent = storedZip;
        input.value = storedZip;
      } else {
        currentValue.textContent = '—';
      }
    })
    .catch(() => {
      currentValue.textContent = '—';
    });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.classList.remove('settings-page__rain-msg--err');
    msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/secondary-watch/zip', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip: input.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      storedZip = String(data.zip || input.value).replace(/\D/g, '').slice(0, 5);
      currentValue.textContent = storedZip || '—';
      msg.textContent = 'Saved.';
      showEditor(false);
    } catch (e) {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save.';
    } finally {
      saveBtn.disabled = false;
    }
  });
}

/**
 * @param {string} group
 * @returns {string}
 */
function groupHeadingId(group) {
  return `settings-events-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * @param {HTMLElement} root
 * @param {number} _windowHours
 */
function buildSettingsShell(root, _windowHours) {
  root.replaceChildren();
  root.className = 'settings-page__body settings-page__inner';

  const status = document.createElement('p');
  status.className = 'settings-page__load-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading event types…';
  root.append(status);

  /** @type {Map<string, HTMLTableSectionElement>} */
  const tbodyByGroup = new Map();

  for (const group of GROUPS) {
    const { details, body } = createCollapsibleSection({
      title: group,
      headingId: groupHeadingId(group),
      className: 'settings-page__events-block',
    });

    const table = document.createElement('table');
    table.className = 'settings-page__table settings-page__table--events';
    table.setAttribute('aria-labelledby', groupHeadingId(group));

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['Event type', 'Value', 'Active', 'Data source', 'Live feed']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = document.createElement('tbody');
    table.append(tbody);
    body.append(table);
    root.append(details);
    tbodyByGroup.set(group, tbody);
  }

  const meta = document.createElement('p');
  meta.className = 'settings-page__note';
  meta.hidden = true;
  root.append(meta);

  return { tbodyByGroup, status, meta };
}

/**
 * @param {string | null | undefined} url
 * @returns {HTMLTableCellElement}
 */
function buildLiveFeedCell(url) {
  const td = document.createElement('td');
  td.className = 'settings-page__live';
  const raw = typeof url === 'string' ? url.trim() : '';
  if (raw && /^https?:\/\//i.test(raw)) {
    const a = document.createElement('a');
    a.href = raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    try {
      a.textContent = new URL(raw).hostname.replace(/^www\./, '');
    } catch {
      a.textContent = 'Open';
    }
    a.title = raw;
    td.append(a);
  } else {
    td.textContent = '—';
  }
  return td;
}

/**
 * @param {Map<string, HTMLTableSectionElement>} tbodyByGroup
 * @param {Array<{ id: string, label: string, category?: string, dataSource?: string, liveUrl?: string | null }>} types
 */
function populatePendingRows(tbodyByGroup, types) {
  /** @type {Map<string, HTMLTableRowElement>} */
  const rowById = new Map();

  for (const group of GROUPS) {
    const tbody = tbodyByGroup.get(group);
    if (!tbody) continue;
    tbody.replaceChildren();
    const rows = types.filter((t) => (t.category || '') === group);
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'settings-page__row--pending';
      tr.dataset.eventId = row.id;
      tr.dataset.category = group;

      const tdType = document.createElement('td');
      tdType.className = 'settings-page__type-label';
      tdType.textContent = row.label || row.id;

      const tdVal = document.createElement('td');
      tdVal.className = 'settings-page__value settings-page__value--loading';
      tdVal.textContent = 'Loading…';

      const tdActive = document.createElement('td');
      tdActive.className = 'settings-page__active settings-page__value--loading';
      tdActive.textContent = '…';

      const tdSrc = document.createElement('td');
      tdSrc.className = 'settings-page__source';
      tdSrc.textContent = row.dataSource || '—';

      const tdLive = buildLiveFeedCell(row.liveUrl);

      tr.append(tdType, tdVal, tdActive, tdSrc, tdLive);
      tbody.append(tr);
      rowById.set(row.id, tr);
    }
  }

  return rowById;
}

/**
 * @param {HTMLTableRowElement} tr
 * @param {{ active?: boolean | null, value?: string | null, pending?: boolean }} row
 */
function updateEventRow(tr, row) {
  const pending = row.pending === true;
  tr.classList.remove('settings-page__row--pending', 'settings-page__row--active', 'settings-page__row--inactive');
  if (pending) {
    tr.classList.add('settings-page__row--pending');
  } else if (row.active) {
    tr.classList.add('settings-page__row--active');
  } else {
    tr.classList.add('settings-page__row--inactive');
  }

  const tdVal = tr.querySelector('.settings-page__value');
  const tdActive = tr.querySelector('.settings-page__active');
  if (tdVal instanceof HTMLElement) {
    tdVal.classList.toggle('settings-page__value--loading', pending);
    tdVal.textContent = pending ? 'Loading…' : row.value || '—';
  }
  if (tdActive instanceof HTMLElement) {
    tdActive.classList.toggle('settings-page__value--loading', pending);
    tdActive.classList.remove('settings-page__active--yes', 'settings-page__active--no');
    if (pending) {
      tdActive.textContent = '…';
    } else {
      tdActive.textContent = row.active ? 'Yes' : 'No';
      tdActive.classList.add(row.active ? 'settings-page__active--yes' : 'settings-page__active--no');
    }
  }
}

/**
 * @param {Map<string, HTMLTableRowElement>} rowById
 * @param {Array<{ id: string, active?: boolean, value?: string, pending?: boolean, liveUrl?: string | null }>} types
 */
function applyTypeUpdates(rowById, types) {
  for (const row of types) {
    const tr = rowById.get(row.id);
    if (!tr) continue;
    updateEventRow(tr, row);
    const tdLive = tr.querySelector('.settings-page__live');
    if (tdLive instanceof HTMLTableCellElement) {
      const fresh = buildLiveFeedCell(row.liveUrl);
      tdLive.replaceWith(fresh);
    }
  }
}

async function fetchEventTypesPart(part, windowHours) {
  const q = new URLSearchParams({ part, windowHours: String(windowHours) });
  const r = await fetch(`/api/event-types-status?${q}`, { cache: 'no-store' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return data;
}

/**
 * Modal to edit Look for / Skip + city / distance / date-time filters.
 */
function openEventsFilterCriteriaModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'settings-page__modal-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const modal = document.createElement('div');
  modal.className = 'settings-page__modal settings-page__modal--criteria';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'settings-events-criteria-title');

  const title = document.createElement('h3');
  title.id = 'settings-events-criteria-title';
  title.className = 'settings-page__modal-title';
  title.textContent = 'Filter criteria';

  const hint = document.createElement('p');
  hint.className = 'settings-page__modal-hint';
  hint.textContent =
    'Three discovery paths: (1) Gmail invites, (2) Apify keyword search from Look for, (3) pinned Facebook pages/groups. Scrape budget controls Apify cost.';

  const geoRow = document.createElement('p');
  geoRow.className = 'settings-page__modal-geo';
  geoRow.textContent = 'Area: …';

  const scrapeHeading = document.createElement('h4');
  scrapeHeading.className = 'settings-page__modal-subheading';
  scrapeHeading.textContent = 'Facebook scrape budget (Apify)';

  const scrapeHint = document.createElement('p');
  scrapeHint.className = 'settings-page__modal-field-hint';
  scrapeHint.textContent =
    'Each Look for line can become one paid search. Cap how many run, how many events each returns, and how long results are reused.';

  const maxQueriesLabel = document.createElement('label');
  maxQueriesLabel.className = 'settings-page__modal-field-label';
  maxQueriesLabel.htmlFor = 'settings-events-scrape-max-queries';
  maxQueriesLabel.textContent = 'Max search queries per scrape';

  const maxQueriesHint = document.createElement('p');
  maxQueriesHint.className = 'settings-page__modal-field-hint';
  maxQueriesHint.textContent = 'Uses the first N Look for lines (1–12). Default 3 keeps cost down.';

  const maxQueriesInput = document.createElement('input');
  maxQueriesInput.id = 'settings-events-scrape-max-queries';
  maxQueriesInput.className = 'settings-page__modal-input';
  maxQueriesInput.type = 'number';
  maxQueriesInput.min = '1';
  maxQueriesInput.max = '12';
  maxQueriesInput.step = '1';
  maxQueriesInput.value = '3';

  const maxPerLabel = document.createElement('label');
  maxPerLabel.className = 'settings-page__modal-field-label';
  maxPerLabel.htmlFor = 'settings-events-scrape-max-per';
  maxPerLabel.textContent = 'Max events per query';

  const maxPerHint = document.createElement('p');
  maxPerHint.className = 'settings-page__modal-field-hint';
  maxPerHint.textContent = 'Apify bills per event returned. Lower = cheaper (1–100). Default 15.';

  const maxPerInput = document.createElement('input');
  maxPerInput.id = 'settings-events-scrape-max-per';
  maxPerInput.className = 'settings-page__modal-input';
  maxPerInput.type = 'number';
  maxPerInput.min = '1';
  maxPerInput.max = '100';
  maxPerInput.step = '1';
  maxPerInput.value = '15';

  const cacheHoursLabel = document.createElement('label');
  cacheHoursLabel.className = 'settings-page__modal-field-label';
  cacheHoursLabel.htmlFor = 'settings-events-scrape-cache-hours';
  cacheHoursLabel.textContent = 'Reuse cache for (hours)';

  const cacheHoursHint = document.createElement('p');
  cacheHoursHint.className = 'settings-page__modal-field-hint';
  cacheHoursHint.textContent =
    'Skip paid scrapes while cache is fresh (1–168). Default 6. Force refresh still available via API.';

  const cacheHoursInput = document.createElement('input');
  cacheHoursInput.id = 'settings-events-scrape-cache-hours';
  cacheHoursInput.className = 'settings-page__modal-input';
  cacheHoursInput.type = 'number';
  cacheHoursInput.min = '1';
  cacheHoursInput.max = '168';
  cacheHoursInput.step = '1';
  cacheHoursInput.value = '6';

  const pinnedLabel = document.createElement('label');
  pinnedLabel.className = 'settings-page__modal-field-label';
  pinnedLabel.htmlFor = 'settings-events-scrape-pinned';
  pinnedLabel.textContent = 'Pinned Facebook hosts';

  const pinnedHint = document.createElement('p');
  pinnedHint.className = 'settings-page__modal-field-hint';
  pinnedHint.textContent =
    'Pages/groups your circle follows — one per line. Use PageName, groups/GroupName, or a full Facebook URL. We scrape upcoming hosted events (counts toward Apify results).';

  const pinnedArea = document.createElement('textarea');
  pinnedArea.id = 'settings-events-scrape-pinned';
  pinnedArea.className = 'settings-page__modal-textarea';
  pinnedArea.rows = 4;
  pinnedArea.spellcheck = false;
  pinnedArea.placeholder = 'Noisebridge\ngroups/sfhardware\nhttps://www.facebook.com/SomePage';

  const filtersHeading = document.createElement('h4');
  filtersHeading.className = 'settings-page__modal-subheading';
  filtersHeading.textContent = 'Feed filters (after scrape — free)';

  const citiesLabel = document.createElement('p');
  citiesLabel.className = 'settings-page__modal-field-label';
  citiesLabel.textContent = 'Cities';

  const citiesHint = document.createElement('p');
  citiesHint.className = 'settings-page__modal-field-hint';
  citiesHint.textContent = 'Show events in these cities (Bay set when you’re local).';

  const citiesBox = document.createElement('div');
  citiesBox.className = 'settings-page__modal-checkboxes';
  citiesBox.setAttribute('role', 'group');
  citiesBox.setAttribute('aria-label', 'Cities');

  /** @type {Map<string, HTMLInputElement>} */
  const cityChecks = new Map();

  const milesLabel = document.createElement('label');
  milesLabel.className = 'settings-page__modal-field-label';
  milesLabel.htmlFor = 'settings-events-criteria-miles';
  milesLabel.textContent = 'Max distance (miles)';

  const milesHint = document.createElement('p');
  milesHint.className = 'settings-page__modal-field-hint';
  milesHint.textContent =
    'Optional. Leave blank for city-only. Events without coordinates still pass if the city matches.';

  const milesInput = document.createElement('input');
  milesInput.id = 'settings-events-criteria-miles';
  milesInput.className = 'settings-page__modal-input';
  milesInput.type = 'number';
  milesInput.min = '1';
  milesInput.max = '100';
  milesInput.step = '0.5';
  milesInput.placeholder = 'Any';

  const datesLabel = document.createElement('p');
  datesLabel.className = 'settings-page__modal-field-label';
  datesLabel.textContent = 'Dates';

  const datesHint = document.createElement('p');
  datesHint.className = 'settings-page__modal-field-hint';
  datesHint.textContent =
    'Pick days (toggle individual dates) or switch to Date range for a contiguous span.';

  const calendar = createRangeCalendar({
    idPrefix: 'settings-events-cal',
    classPrefix: 'events-cal',
  });

  const timeLabel = document.createElement('label');
  timeLabel.className = 'settings-page__modal-field-label';
  timeLabel.htmlFor = 'settings-events-criteria-earliest';
  timeLabel.textContent = 'Earliest start time';

  const timeHint = document.createElement('p');
  timeHint.className = 'settings-page__modal-field-hint';
  timeHint.textContent = 'Skip events that start before this local time (default 11:00).';

  const timeInput = document.createElement('input');
  timeInput.id = 'settings-events-criteria-earliest';
  timeInput.className = 'settings-page__modal-input settings-page__modal-input--time';
  timeInput.type = 'time';
  timeInput.value = '11:00';

  const lookLabel = document.createElement('label');
  lookLabel.className = 'settings-page__modal-field-label';
  lookLabel.htmlFor = 'settings-events-criteria-look';
  lookLabel.textContent = 'Look for';

  const lookHint = document.createElement('p');
  lookHint.className = 'settings-page__modal-field-hint';
  lookHint.textContent =
    'Themes you want. For Facebook, each line can become a paid Apify search (capped by Max search queries above). Put the best terms first.';

  const lookArea = document.createElement('textarea');
  lookArea.id = 'settings-events-criteria-look';
  lookArea.className = 'settings-page__modal-textarea settings-page__modal-textarea--look';
  lookArea.rows = 12;
  lookArea.spellcheck = true;
  lookArea.placeholder = 'Loading…';

  const skipLabel = document.createElement('label');
  skipLabel.className = 'settings-page__modal-field-label';
  skipLabel.htmlFor = 'settings-events-criteria-skip';
  skipLabel.textContent = 'Skip';

  const skipHint = document.createElement('p');
  skipHint.className = 'settings-page__modal-field-hint';
  skipHint.textContent =
    'Things to leave out of the feed (post-filter; does not reduce Apify cost yet).';

  const skipArea = document.createElement('textarea');
  skipArea.id = 'settings-events-criteria-skip';
  skipArea.className = 'settings-page__modal-textarea';
  skipArea.rows = 6;
  skipArea.spellcheck = true;
  skipArea.placeholder = 'Loading…';

  const actions = document.createElement('div');
  actions.className = 'settings-page__modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-page__secondary-cancel';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  actions.append(cancelBtn, saveBtn);

  const tasteHeading = document.createElement('h4');
  tasteHeading.className = 'settings-page__modal-subheading';
  tasteHeading.textContent = 'Taste (Look for / Skip)';

  // Taste + feed filters first — scrape budget / pins are long and used to bury these.
  modal.append(
    title,
    hint,
    geoRow,
    tasteHeading,
    lookLabel,
    lookHint,
    lookArea,
    skipLabel,
    skipHint,
    skipArea,
    filtersHeading,
    citiesLabel,
    citiesHint,
    citiesBox,
    milesLabel,
    milesHint,
    milesInput,
    datesLabel,
    datesHint,
    calendar.root,
    timeLabel,
    timeHint,
    timeInput,
    scrapeHeading,
    scrapeHint,
    maxQueriesLabel,
    maxQueriesHint,
    maxQueriesInput,
    maxPerLabel,
    maxPerHint,
    maxPerInput,
    cacheHoursLabel,
    cacheHoursHint,
    cacheHoursInput,
    pinnedLabel,
    pinnedHint,
    pinnedArea,
    actions,
    msg,
  );
  backdrop.append(modal);
  document.body.append(backdrop);

  /**
   * @param {string[]} cities
   * @param {string[]} selected
   */
  function renderCityChecks(cities, selected) {
    citiesBox.replaceChildren();
    cityChecks.clear();
    const selectedSet = new Set((selected || []).map((c) => c.toLowerCase()));
    for (const city of cities) {
      const id = `settings-events-city-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const row = document.createElement('label');
      row.className = 'settings-page__modal-check';
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

  /**
   * @param {{
   *   city?: string | null,
   *   place?: string | null,
   *   zip?: string | null,
   *   bayArea?: boolean,
   *   homeCities?: string[],
   * } | null | undefined} geo
   */
  function renderGeo(geo) {
    if (!geo || typeof geo !== 'object') {
      geoRow.textContent = 'Area: city of dashboard ZIP (when set)';
      return;
    }
    const label = geo.place || geo.city || (geo.zip ? `ZIP ${geo.zip}` : null);
    const homes = Array.isArray(geo.homeCities) ? geo.homeCities.join(', ') : '';
    if (geo.bayArea && homes) {
      geoRow.textContent = `Bay Area (${label || 'local'}) · showing ${homes}`;
    } else if (label) {
      geoRow.textContent = `Area: ${label} (city-first)`;
    } else {
      geoRow.textContent = 'Area: set WEATHER_ZIP for city-based filtering';
    }
  }

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const filterControls = [
    milesInput,
    timeInput,
    lookArea,
    skipArea,
    maxQueriesInput,
    maxPerInput,
    cacheHoursInput,
    pinnedArea,
  ];
  for (const el of filterControls) el.disabled = true;
  calendar.setDisabled(true);
  saveBtn.disabled = true;
  msg.hidden = false;
  msg.textContent = 'Loading…';

  // Paint Bay defaults immediately so Look for / cities aren't blank while the API loads.
  const defaultCities = ['San Francisco', 'Oakland', 'Emeryville', 'Berkeley'];
  renderCityChecks(defaultCities, defaultCities);
  for (const input of cityChecks.values()) input.disabled = true;

  fetch('/api/events-finder-criteria', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      lookArea.value = typeof data.lookFor === 'string' ? data.lookFor : '';
      lookArea.placeholder = 'One idea per line…';
      skipArea.value = typeof data.skip === 'string' ? data.skip : '';
      skipArea.placeholder = 'One idea per line…';
      renderGeo(data.geo);

      const scrape = data.scrape && typeof data.scrape === 'object' ? data.scrape : {};
      maxQueriesInput.value = String(scrape.maxQueries ?? 3);
      maxPerInput.value = String(scrape.maxEventsPerQuery ?? 15);
      cacheHoursInput.value = String(scrape.cacheHours ?? 6);
      pinnedArea.value = typeof scrape.pinnedHosts === 'string' ? scrape.pinnedHosts : '';

      const homeCities =
        (Array.isArray(data.geo?.homeCities) && data.geo.homeCities.length
          ? data.geo.homeCities
          : null) ||
        (Array.isArray(data.geo?.bayAreaHomeCities) ? data.geo.bayAreaHomeCities : null) ||
        defaultCities;
      const selectedCities = Array.isArray(data.filters?.cities) ? data.filters.cities : homeCities;
      renderCityChecks(homeCities, selectedCities);

      const miles = data.filters?.maxMiles;
      milesInput.value = miles == null || miles === '' ? '' : String(miles);
      calendar.setRange(
        data.filters?.dateFrom || null,
        data.filters?.dateTo || null,
        data.filters?.dates || [],
      );
      timeInput.value = data.filters?.earliestLocalTime || '11:00';

      for (const el of filterControls) el.disabled = false;
      calendar.setDisabled(false);
      for (const input of cityChecks.values()) input.disabled = false;
      saveBtn.disabled = false;
      msg.hidden = true;
      msg.textContent = '';
      lookArea.focus();
    })
    .catch((e) => {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load.';
      cancelBtn.focus();
    });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.classList.remove('settings-page__rain-msg--err');
    msg.textContent = 'Saving…';
    try {
      const cities = [...cityChecks.entries()]
        .filter(([, input]) => input.checked)
        .map(([city]) => city);
      if (!cities.length) {
        throw new Error('Pick at least one city.');
      }
      const milesRaw = milesInput.value.trim();
      const range = calendar.getRange();
      const r = await fetch('/api/events-finder-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lookFor: lookArea.value,
          skip: skipArea.value,
          filters: {
            cities,
            maxMiles: milesRaw === '' ? null : Number(milesRaw),
            dates: range.dates || [],
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
            earliestLocalTime: timeInput.value || null,
            attendance: 'in_person',
          },
          scrape: {
            maxQueries: Number(maxQueriesInput.value) || 3,
            maxEventsPerQuery: Number(maxPerInput.value) || 15,
            cacheHours: Number(cacheHoursInput.value) || 6,
            pinnedHosts: pinnedArea.value,
          },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      close();
    } catch (e) {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save.';
      saveBtn.disabled = false;
    }
  });
}

/**
 * Events finder sources from Personal bookmarks “Events” — one row per site,
 * with strategy / status / output (strategies differ by host).
 * @param {HTMLElement} root
 */
function buildEventsFinderSourcesBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Events sources',
    headingId: 'settings-events-sources-heading',
    className: 'settings-page__events-sources-block',
  });

  const toolbar = document.createElement('div');
  toolbar.className = 'settings-page__events-toolbar';

  const criteriaBtn = document.createElement('button');
  criteriaBtn.type = 'button';
  criteriaBtn.className = 'settings-page__rain-save';
  criteriaBtn.textContent = 'Filter criteria';
  criteriaBtn.addEventListener('click', () => openEventsFilterCriteriaModal());
  toolbar.append(criteriaBtn);

  const gmailConnectHost = document.createElement('span');
  gmailConnectHost.className = 'settings-page__gmail-connect-host';
  toolbar.append(gmailConnectHost);
  body.append(toolbar);

  /**
   * Per-inbox Connect / Reconnect links from Gmail status API.
   */
  function renderGmailConnectButtons(summary) {
    gmailConnectHost.replaceChildren();
    const accounts = Array.isArray(summary?.accounts) && summary.accounts.length
      ? summary.accounts
      : (Array.isArray(summary?.addresses) ? summary.addresses.map((email) => ({
          email,
          tokenOnDisk: false,
          oauthStartPath: `/api/events-finder-gmail/oauth/start?email=${encodeURIComponent(email)}`,
        })) : [{
          email: 'jay.intake.box@gmail.com',
          tokenOnDisk: false,
          oauthStartPath: '/api/events-finder-gmail/oauth/start?email=jay.intake.box%40gmail.com',
        }, {
          email: 'julia.hasty@gmail.com',
          tokenOnDisk: false,
          oauthStartPath: '/api/events-finder-gmail/oauth/start?email=julia.hasty%40gmail.com',
        }]);
    for (const acct of accounts) {
      const email = String(acct.email || '').trim();
      if (!email) continue;
      const btn = document.createElement('a');
      btn.className = 'settings-page__rain-save';
      btn.href = acct.oauthStartPath
        || `/api/events-finder-gmail/oauth/start?email=${encodeURIComponent(email)}`;
      btn.textContent = acct.tokenOnDisk ? `Reconnect ${email}` : `Connect ${email}`;
      btn.title = `OAuth readonly Gmail for ${email} event announcements`;
      gmailConnectHost.append(btn);
    }
  }

  // Fallback buttons immediately; refresh labels after status fetch.
  renderGmailConnectButtons(null);
  fetch('/api/events-finder-gmail/status', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok !== false) renderGmailConnectButtons(data);
    })
    .catch(() => { /* keep fallback buttons */ });

  const intro = document.createElement('p');
  intro.className = 'settings-page__intro';
  intro.textContent =
    'From Personal bookmarks → Events. Each site uses its own ingest strategy; status and output update after a live probe. Intake Gmail uses the Gmail API (Connect each inbox) — not page scraping.';
  body.append(intro);

  const loadStatus = document.createElement('p');
  loadStatus.className = 'settings-page__load-status';
  loadStatus.setAttribute('aria-live', 'polite');
  loadStatus.textContent = 'Loading Events sources…';
  body.append(loadStatus);

  const table = document.createElement('table');
  table.className = 'settings-page__table settings-page__table--events-sources';
  table.setAttribute('aria-labelledby', 'settings-events-sources-heading');

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['Source', 'Strategy', 'Status', 'Output', 'Ingestion test', 'Site']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement('tbody');
  table.append(tbody);
  body.append(table);

  const note = document.createElement('p');
  note.className = 'settings-page__note';
  note.hidden = true;
  body.append(note);

  const firstEventsGroup = root.querySelector('.settings-page__events-block');
  if (firstEventsGroup) root.insertBefore(block, firstEventsGroup);
  else root.append(block);

  /** @type {Map<string, HTMLTableRowElement>} */
  const rowById = new Map();

  /**
   * @param {Array<{
   *   id: string,
   *   label: string,
   *   url: string,
   *   strategyLabel?: string,
   *   strategyDetail?: string,
   *   strategy?: string,
   *   pending?: boolean,
   *   active?: boolean | null,
   *   value?: string | null,
   *   output?: string | null,
   *   ingestOk?: boolean | null,
   *   ingestTest?: string | null,
   * }>} sources
   */
  function populateRows(sources) {
    tbody.replaceChildren();
    rowById.clear();
    for (const src of sources) {
      const tr = document.createElement('tr');
      tr.className = 'settings-page__row--pending';
      tr.dataset.sourceId = src.id;

      const tdName = document.createElement('td');
      tdName.className = 'settings-page__type-label';
      tdName.textContent = src.label || src.id;

      const tdStrat = document.createElement('td');
      tdStrat.className = 'settings-page__strategy';
      const stratLabel = document.createElement('div');
      stratLabel.className = 'settings-page__strategy-label';
      stratLabel.textContent = src.strategyLabel || src.strategy || '—';
      tdStrat.append(stratLabel);
      if (src.strategyDetail) {
        const detail = document.createElement('p');
        detail.className = 'settings-page__strategy-detail';
        detail.textContent = src.strategyDetail;
        tdStrat.append(detail);
      }

      const tdStatus = document.createElement('td');
      tdStatus.className = 'settings-page__value settings-page__value--loading settings-page__source-status';
      tdStatus.textContent = 'Loading…';

      const tdOut = document.createElement('td');
      tdOut.className = 'settings-page__value settings-page__value--loading settings-page__source-output';
      tdOut.textContent = '…';

      const tdIngest = document.createElement('td');
      tdIngest.className =
        'settings-page__value settings-page__value--loading settings-page__source-ingest';
      tdIngest.textContent = '…';

      const tdLive = buildLiveFeedCell(src.url);

      tr.append(tdName, tdStrat, tdStatus, tdOut, tdIngest, tdLive);
      tbody.append(tr);
      rowById.set(src.id, tr);
    }
  }

  /**
   * @param {HTMLTableRowElement} tr
   * @param {{
   *   pending?: boolean,
   *   active?: boolean | null,
   *   value?: string | null,
   *   output?: string | null,
   *   ingestOk?: boolean | null,
   *   ingestTest?: string | null,
   * }} row
   */
  function updateSourceRow(tr, row) {
    const pending = row.pending === true;
    tr.classList.remove(
      'settings-page__row--pending',
      'settings-page__row--active',
      'settings-page__row--inactive',
    );
    if (pending) tr.classList.add('settings-page__row--pending');
    else if (row.active) tr.classList.add('settings-page__row--active');
    else tr.classList.add('settings-page__row--inactive');

    const tdStatus = tr.querySelector('.settings-page__source-status');
    const tdOut = tr.querySelector('.settings-page__source-output');
    const tdIngest = tr.querySelector('.settings-page__source-ingest');
    if (tdStatus instanceof HTMLElement) {
      tdStatus.classList.toggle('settings-page__value--loading', pending);
      tdStatus.classList.remove('settings-page__active--yes', 'settings-page__active--no');
      if (pending) {
        tdStatus.textContent = 'Loading…';
      } else {
        tdStatus.textContent = row.value || '—';
        tdStatus.classList.add(row.active ? 'settings-page__active--yes' : 'settings-page__active--no');
      }
    }
    if (tdOut instanceof HTMLElement) {
      tdOut.classList.toggle('settings-page__value--loading', pending);
      tdOut.textContent = pending ? '…' : row.output || '—';
    }
    if (tdIngest instanceof HTMLElement) {
      tdIngest.classList.toggle('settings-page__value--loading', pending);
      tdIngest.classList.remove(
        'settings-page__active--yes',
        'settings-page__active--no',
        'settings-page__ingest--na',
      );
      if (pending) {
        tdIngest.textContent = '…';
      } else {
        tdIngest.textContent = row.ingestTest || '—';
        if (row.ingestOk === true) tdIngest.classList.add('settings-page__active--yes');
        else if (row.ingestOk === false) tdIngest.classList.add('settings-page__active--no');
        else tdIngest.classList.add('settings-page__ingest--na');
      }
    }
  }

  fetch('/api/events-finder-status?manifest=1', { cache: 'no-store' })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false || !Array.isArray(data.sources)) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      if (!data.sources.length) {
        loadStatus.textContent = 'No Events bookmarks found in Personal bookmarks.';
        return;
      }
      populateRows(data.sources);
      loadStatus.textContent = 'Probing sources…';
      return fetch('/api/events-finder-status', { cache: 'no-store' });
    })
    .then(async (r) => {
      if (!r) return;
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false || !Array.isArray(data.sources)) {
        throw new Error(data.error || `Live HTTP ${r.status}`);
      }
      for (const src of data.sources) {
        const tr = rowById.get(src.id);
        if (tr) updateSourceRow(tr, src);
      }
      loadStatus.textContent = '';
      loadStatus.hidden = true;
      note.hidden = false;
      const when = data.checkedAt ? new Date(data.checkedAt).toLocaleString() : new Date().toLocaleString();
      note.textContent = `Events sources snapshot: ${when}`;
    })
    .catch((e) => {
      loadStatus.className = 'settings-page__err';
      loadStatus.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    });
}

/**
 * @param {HTMLElement | null} mount
 */
export async function mountSettingsPage(mount) {
  if (!mount) return;

  const { tbodyByGroup, status, meta } = buildSettingsShell(mount, WINDOW_HOURS);
  buildSecondaryWatchBlock(mount);
  buildEventsFinderSourcesBlock(mount);
  mount.setAttribute('aria-busy', 'true');

  /** @type {Map<string, HTMLTableRowElement>} */
  let rowById = new Map();
  let pendingParts = 4;
  let failedParts = 0;

  function refreshStatus() {
    if (pendingParts > 0) {
      status.textContent = `Loading live values (${4 - pendingParts}/4 ready)…`;
    } else if (failedParts > 0) {
      status.textContent = `Finished with ${failedParts} source(s) failed.`;
    } else {
      status.textContent = '';
      status.hidden = true;
    }
  }

  function partDone() {
    pendingParts -= 1;
    refreshStatus();
    if (pendingParts <= 0) {
      mount.removeAttribute('aria-busy');
      meta.hidden = false;
      meta.textContent = `Snapshot: ${new Date().toLocaleString()}`;
    }
  }

  function markPartFailed(ids) {
    failedParts += 1;
    for (const id of ids) {
      const tr = rowById.get(id);
      if (!tr) continue;
      updateEventRow(tr, {
        active: false,
        value: 'Could not load',
        pending: false,
      });
    }
  }

  function startLiveFetches(rowMap) {
    const skyIds = [...rowMap.keys()].filter((id) => rowMap.get(id)?.dataset.category === 'Sky & space');
    const earthCoreIds = [
      'yosemite_moonbow',
      'usa_npn_spring',
      'monarch_spring',
      'monarch_fall',
      'diablo_tarantula',
      'oakland_salamander',
      'wild_edible',
      'salmon_run',
      'nasturtium_bloom',
      'firefly_season',
      'fall_foliage_season',
    ];
    const slowIds = ['usgs_quake_week', 'goes_glm_lightning', 'goes_glm_sprite'];
    const serviceIds = ['fear_greed_index', 'weather_radar'];

    fetchEventTypesPart('sky', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(skyIds))
      .finally(partDone);

    fetchEventTypesPart('earth', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(earthCoreIds))
      .finally(partDone);

    fetchEventTypesPart('slow', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(slowIds))
      .finally(partDone);

    fetchEventTypesPart('services', WINDOW_HOURS)
      .then((data) => applyTypeUpdates(rowMap, data.types))
      .catch(() => markPartFailed(serviceIds))
      .finally(partDone);
  }

  fetch('/api/event-types-status?manifest=1', { cache: 'no-store' })
    .then(async (manifestR) => {
      const manifest = await manifestR.json().catch(() => ({}));
      if (!manifestR.ok || manifest.ok === false || !Array.isArray(manifest.types)) {
        throw new Error(manifest.error || `Manifest HTTP ${manifestR.status}`);
      }
      rowById = populatePendingRows(tbodyByGroup, manifest.types);
      refreshStatus();
      startLiveFetches(rowById);
    })
    .catch((e) => {
      mount.removeAttribute('aria-busy');
      status.className = 'settings-page__err';
      status.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    });
}
