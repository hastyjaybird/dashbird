const WINDOW_HOURS = 24;
const GROUPS = ['Sky & space', 'Earth', 'Market & weather'];

/**
 * Rain alert street address (hero line + radar center).
 * @param {HTMLElement} root
 */
function buildRainAlertBlock(root) {
  const block = document.createElement('section');
  block.className = 'settings-page__config-block panel panel--glass settings-page__rain-block';
  block.setAttribute('aria-labelledby', 'settings-rain-heading');

  const h = document.createElement('h2');
  h.id = 'settings-rain-heading';
  h.className = 'settings-page__block-title';
  h.textContent = 'Rain alert & Radar';
  block.append(h);

  const hint = document.createElement('p');
  hint.className = 'settings-page__note settings-page__rain-hint';
  hint.textContent =
    'Used for “Rain expected in N minutes” (next 2 hours) and the Weather Radar map (~5 mi around this point). Radar shows only when precipitation is expected in the next 24 hours.';
  block.append(hint);

  const label = document.createElement('label');
  label.className = 'settings-page__rain-label';
  label.htmlFor = 'settings-rain-address';
  label.textContent = 'Street address';
  block.append(label);

  const input = document.createElement('textarea');
  input.id = 'settings-rain-address';
  input.className = 'settings-page__rain-input';
  input.rows = 2;
  input.spellcheck = false;
  input.autocomplete = 'street-address';
  block.append(input);

  const actions = document.createElement('div');
  actions.className = 'settings-page__rain-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save address';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  actions.append(saveBtn, msg);
  block.append(actions);
  root.insertBefore(block, root.firstChild);

  fetch('/api/rain-alert/address', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (data?.address) input.value = String(data.address);
    })
    .catch(() => {});

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.classList.remove('settings-page__rain-msg--err');
    msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/rain-alert/address', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: input.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      msg.textContent = 'Saved.';
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
 * Secondary ZIP for lightning bugs + fall foliage.
 * @param {HTMLElement} root
 */
function buildSecondaryWatchBlock(root) {
  const block = document.createElement('section');
  block.className =
    'settings-page__config-block panel panel--glass settings-page__secondary-block';
  block.setAttribute('aria-labelledby', 'settings-secondary-heading');

  const h = document.createElement('h2');
  h.id = 'settings-secondary-heading';
  h.className = 'settings-page__block-title';
  h.textContent = 'Secondary location (ZIP)';
  block.append(h);

  const hint = document.createElement('p');
  hint.className = 'settings-page__note settings-page__secondary-hint';
  hint.textContent =
    'Lightning-bug season (Farmers’ Almanac / Virginia Tech) shows on Earth strip 7 days before start through season end. Fall foliage (USA-NPN) uses a 21-day heads-up before start, peak, and end.';
  block.append(hint);

  const label = document.createElement('label');
  label.className = 'settings-page__rain-label';
  label.htmlFor = 'settings-secondary-zip';
  label.textContent = 'US ZIP code';
  block.append(label);

  const input = document.createElement('input');
  input.id = 'settings-secondary-zip';
  input.className = 'settings-page__secondary-zip-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 10;
  input.spellcheck = false;
  input.autocomplete = 'postal-code';
  block.append(input);

  const actions = document.createElement('div');
  actions.className = 'settings-page__rain-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save ZIP';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  actions.append(saveBtn, msg);
  block.append(actions);
  root.insertBefore(block, root.firstChild);

  fetch('/api/secondary-watch/zip', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (data?.zip) input.value = String(data.zip);
    })
    .catch(() => {});

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
      msg.textContent = 'Saved.';
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
 * @param {HTMLElement} root
 * @param {number} windowHours
 */
function buildSettingsShell(root, windowHours) {
  root.replaceChildren();
  root.className = 'settings-page__inner';

  const status = document.createElement('p');
  status.className = 'settings-page__load-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading event types…';
  root.append(status);

  const block = document.createElement('section');
  block.className = 'settings-page__config-block panel panel--glass';
  block.setAttribute('aria-labelledby', 'settings-event-types-heading');

  const h = document.createElement('h2');
  h.id = 'settings-event-types-heading';
  h.className = 'settings-page__block-title';
  h.textContent = 'Event types';
  block.append(h);

  const table = document.createElement('table');
  table.className = 'settings-page__table settings-page__table--events';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['Category', 'Event type', 'Value', 'Active', 'Data source', 'Live feed']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement('tbody');
  table.append(tbody);
  block.append(table);
  root.append(block);

  const meta = document.createElement('p');
  meta.className = 'settings-page__note';
  meta.hidden = true;
  root.append(meta);

  return { tbody, status, meta, table };
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
 * @param {HTMLTableSectionElement} tbody
 * @param {Array<{ id: string, label: string, category?: string, dataSource?: string, liveUrl?: string | null }>} types
 */
function populatePendingRows(tbody, types) {
  tbody.replaceChildren();
  /** @type {Map<string, HTMLTableRowElement>} */
  const rowById = new Map();

  for (const group of GROUPS) {
    const rows = types.filter((t) => (t.category || '') === group);
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'settings-page__row--pending';
      tr.dataset.eventId = row.id;

      const tdCat = document.createElement('td');
      tdCat.className = 'settings-page__category';
      tdCat.textContent = group;

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

      tr.append(tdCat, tdType, tdVal, tdActive, tdSrc, tdLive);
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
 * @param {HTMLElement | null} mount
 */
export async function mountSettingsPage(mount) {
  if (!mount) return;

  const { tbody, status, meta } = buildSettingsShell(mount, WINDOW_HOURS);
  buildSecondaryWatchBlock(mount);
  buildRainAlertBlock(mount);
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
    const skyIds = [...rowMap.keys()].filter((id) => {
      const tr = rowMap.get(id);
      return tr?.querySelector('.settings-page__category')?.textContent === 'Sky & space';
    });
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
      rowById = populatePendingRows(tbody, manifest.types);
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
