const WINDOW_HOURS = 24;
const GROUPS = ['Sky & space', 'Earth', 'Market & weather'];

/**
 * Collapsible settings section (open by default).
 * @param {{ title: string, headingId: string, className?: string, open?: boolean }} opts
 * @returns {{ details: HTMLDetailsElement, body: HTMLDivElement, summary: HTMLElement }}
 */
function createCollapsibleSection({ title, headingId, className = '', open = true }) {
  const details = document.createElement('details');
  details.className = `settings-page__config-block panel panel--glass settings-page__section${
    className ? ` ${className}` : ''
  }`;
  details.open = open !== false;

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
 * @param {HTMLElement | null} mount
 */
export async function mountSettingsPage(mount) {
  if (!mount) return;

  const { tbodyByGroup, status, meta } = buildSettingsShell(mount, WINDOW_HOURS);
  buildSecondaryWatchBlock(mount);
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
