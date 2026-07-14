import { normalizeLocalTime } from './events-filter-ui.js';

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

const COST_CADENCE_LABELS = {
  usage: 'Usage',
  fixed_weekly: 'Fixed / wk',
  fixed_monthly: 'Fixed / mo',
  free_tier: 'Free tier',
  optional: 'Optional',
};

/**
 * @param {number} n
 * @param {string} [currency]
 */
function formatCostUsd(n, currency = 'USD') {
  const v = Number(n);
  const amount = Number.isFinite(v) ? v : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

/**
 * Financial tracking for Dashbird spend (weekly budgets + measured Apify).
 * @param {HTMLElement} root
 */
function buildCostsBlock(root) {
  const { details: block, body } = createCollapsibleSection({
    title: 'Costs',
    headingId: 'settings-costs-heading',
    className: 'settings-page__costs-block',
    open: true,
  });

  const intro = document.createElement('p');
  intro.className = 'settings-page__intro';
  intro.textContent =
    'Everything Dashbird spends money on — weekly budgets you can edit, plus measured Apify charges from the Facebook scrape log. Inactive rows stay listed but are excluded from totals.';
  body.append(intro);

  const kpi = document.createElement('div');
  kpi.className = 'settings-page__costs-kpi';
  kpi.setAttribute('aria-label', 'Weekly cost summary');
  body.append(kpi);

  const categories = document.createElement('div');
  categories.className = 'settings-page__costs-categories';
  categories.hidden = true;
  body.append(categories);

  const apifyBar = document.createElement('div');
  apifyBar.className = 'settings-page__costs-apify';
  apifyBar.hidden = true;
  body.append(apifyBar);

  const loadStatus = document.createElement('p');
  loadStatus.className = 'settings-page__load-status';
  loadStatus.setAttribute('aria-live', 'polite');
  loadStatus.textContent = 'Loading costs…';
  body.append(loadStatus);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'settings-page__costs-table-wrap';
  tableWrap.hidden = true;

  const table = document.createElement('table');
  table.className = 'settings-page__table settings-page__table--costs';
  table.setAttribute('aria-labelledby', 'settings-costs-heading');

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['On', 'Service', 'Category', 'Cadence', '$ / week', 'Measured', 'Notes']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement('tbody');
  table.append(tbody);
  tableWrap.append(table);
  body.append(tableWrap);

  const actions = document.createElement('div');
  actions.className = 'settings-page__costs-actions';
  actions.hidden = true;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'settings-page__secondary-cancel';
  addBtn.textContent = '+ Line item';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save costs';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  actions.append(addBtn, saveBtn, msg);
  body.append(actions);

  const note = document.createElement('p');
  note.className = 'settings-page__note';
  note.hidden = true;
  body.append(note);

  const firstEvents = root.querySelector('.settings-page__events-sources-block, .settings-page__events-block');
  if (firstEvents) root.insertBefore(block, firstEvents);
  else root.append(block);

  /** @type {{ currency: string, items: object[] }} */
  let state = { currency: 'USD', items: [] };

  /**
   * @param {object} data
   */
  function renderKpi(data) {
    const summary = data.summary || {};
    const currency = data.currency || 'USD';
    kpi.replaceChildren();

    const cards = [
      {
        label: 'This week',
        value: formatCostUsd(summary.effectiveWeeklyUsd, currency),
        hint: 'Budget + measured',
        tone: 'primary',
      },
      {
        label: 'Budgeted / wk',
        value: formatCostUsd(summary.budgetedWeeklyUsd, currency),
        hint: 'Active line items',
        tone: '',
      },
      {
        label: 'Measured / wk',
        value: formatCostUsd(summary.measuredWeeklyUsd, currency),
        hint: 'Apify last 7 days',
        tone: 'amber',
      },
      {
        label: 'Projected / mo',
        value: formatCostUsd(summary.projectedMonthlyUsd, currency),
        hint: 'Week × 4.33',
        tone: '',
      },
    ];

    for (const card of cards) {
      const el = document.createElement('div');
      el.className = `settings-page__costs-kpi-card${card.tone ? ` settings-page__costs-kpi-card--${card.tone}` : ''}`;
      const lab = document.createElement('span');
      lab.className = 'settings-page__costs-kpi-label';
      lab.textContent = card.label;
      const val = document.createElement('span');
      val.className = 'settings-page__costs-kpi-value';
      val.textContent = card.value;
      const hint = document.createElement('span');
      hint.className = 'settings-page__costs-kpi-hint';
      hint.textContent = card.hint;
      el.append(lab, val, hint);
      kpi.append(el);
    }
  }

  /**
   * @param {object} data
   */
  function renderCategories(data) {
    const byCategory = data.summary?.byCategory || {};
    const entries = Object.entries(byCategory).sort((a, b) => Number(b[1]) - Number(a[1]));
    categories.replaceChildren();
    if (!entries.length) {
      categories.hidden = true;
      return;
    }
    categories.hidden = false;
    const total = entries.reduce((s, [, v]) => s + Number(v), 0) || 1;
    const title = document.createElement('p');
    title.className = 'settings-page__costs-section-label';
    title.textContent = 'By category (this week)';
    categories.append(title);
    for (const [name, amount] of entries) {
      const row = document.createElement('div');
      row.className = 'settings-page__costs-cat-row';
      const lab = document.createElement('span');
      lab.className = 'settings-page__costs-cat-name';
      lab.textContent = name;
      const barWrap = document.createElement('div');
      barWrap.className = 'settings-page__costs-cat-bar';
      const fill = document.createElement('div');
      fill.className = 'settings-page__costs-cat-fill';
      fill.style.width = `${Math.max(2, Math.round((Number(amount) / total) * 100))}%`;
      barWrap.append(fill);
      const amt = document.createElement('span');
      amt.className = 'settings-page__costs-cat-amt';
      amt.textContent = formatCostUsd(amount, data.currency);
      row.append(lab, barWrap, amt);
      categories.append(row);
    }
  }

  /**
   * @param {object} data
   */
  function renderApifyMeter(data) {
    const month = data.measured?.facebook?.month;
    apifyBar.replaceChildren();
    if (!month) {
      apifyBar.hidden = true;
      return;
    }
    apifyBar.hidden = false;
    const used = Number(month.totalUsd) || 0;
    const credits = Number(month.monthlyCreditsUsd) || 5;
    const remaining =
      month.remainingCreditsUsd != null ? Number(month.remainingCreditsUsd) : Math.max(0, credits - used);
    const pct = credits > 0 ? Math.min(100, Math.round((used / credits) * 100)) : 0;

    const title = document.createElement('p');
    title.className = 'settings-page__costs-section-label';
    title.textContent = `Apify credits · ${month.month || 'this month'}`;
    apifyBar.append(title);

    const meter = document.createElement('div');
    meter.className = 'settings-page__costs-meter';
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(credits));
    meter.setAttribute('aria-valuenow', String(used));
    const fill = document.createElement('div');
    fill.className = 'settings-page__costs-meter-fill';
    if (pct >= 90) fill.classList.add('settings-page__costs-meter-fill--hot');
    else if (pct >= 70) fill.classList.add('settings-page__costs-meter-fill--warn');
    fill.style.width = `${pct}%`;
    meter.append(fill);
    apifyBar.append(meter);

    const caption = document.createElement('p');
    caption.className = 'settings-page__costs-meter-caption';
    const week = data.measured?.facebook?.week;
    const weekBit =
      week && Number(week.totalUsd) > 0
        ? ` · last 7 days ${formatCostUsd(week.totalUsd, data.currency)} (${week.runCount || 0} runs)`
        : '';
    caption.textContent = `${formatCostUsd(used, data.currency)} of ${formatCostUsd(
      credits,
      data.currency,
    )} used · ${formatCostUsd(remaining, data.currency)} left${weekBit}`;
    apifyBar.append(caption);
  }

  function readRowsFromDom() {
    /** @type {object[]} */
    const items = [];
    for (const tr of tbody.querySelectorAll('tr')) {
      const id = String(tr.dataset.itemId || '').trim();
      if (!id) continue;
      const activeEl = tr.querySelector('input[data-field="active"]');
      const labelEl = tr.querySelector('[data-field="label"]');
      const categoryEl = tr.querySelector('[data-field="category"]');
      const cadenceEl = tr.querySelector('[data-field="cadence"]');
      const weeklyEl = tr.querySelector('input[data-field="weeklyUsd"]');
      const notesEl = tr.querySelector('[data-field="notes"]');
      items.push({
        id,
        active: activeEl instanceof HTMLInputElement ? activeEl.checked : true,
        label:
          labelEl instanceof HTMLInputElement
            ? labelEl.value
            : String(labelEl?.textContent || id).trim(),
        category:
          categoryEl instanceof HTMLInputElement
            ? categoryEl.value
            : String(categoryEl?.textContent || 'Other').trim(),
        cadence:
          cadenceEl instanceof HTMLSelectElement
            ? cadenceEl.value
            : String(tr.dataset.cadence || 'usage'),
        weeklyUsd: weeklyEl instanceof HTMLInputElement ? weeklyEl.value : 0,
        notes:
          notesEl instanceof HTMLInputElement
            ? notesEl.value
            : String(notesEl?.textContent || '').trim(),
        measuredSource: tr.dataset.measuredSource || null,
        monthlyBudgetUsd: tr.dataset.monthlyBudgetUsd
          ? Number(tr.dataset.monthlyBudgetUsd)
          : null,
      });
    }
    return items;
  }

  /**
   * @param {object[]} items
   * @param {string} currency
   */
  function populateRows(items, currency) {
    tbody.replaceChildren();
    for (const item of items) {
      const tr = document.createElement('tr');
      tr.dataset.itemId = item.id;
      tr.dataset.cadence = item.cadence || 'usage';
      if (item.measuredSource) tr.dataset.measuredSource = item.measuredSource;
      if (item.monthlyBudgetUsd != null) {
        tr.dataset.monthlyBudgetUsd = String(item.monthlyBudgetUsd);
      }
      if (item.active === false) tr.classList.add('settings-page__costs-row--off');

      const tdOn = document.createElement('td');
      tdOn.className = 'settings-page__costs-on';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.field = 'active';
      check.checked = item.active !== false;
      check.title = 'Include in weekly totals';
      check.addEventListener('change', () => {
        tr.classList.toggle('settings-page__costs-row--off', !check.checked);
      });
      tdOn.append(check);

      const tdService = document.createElement('td');
      tdService.className = 'settings-page__type-label';
      const isCustom = String(item.id || '').startsWith('custom-');
      if (isCustom) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'settings-page__costs-input settings-page__costs-input--label';
        input.dataset.field = 'label';
        input.value = item.label || '';
        input.placeholder = 'Service name';
        tdService.append(input);
      } else {
        const span = document.createElement('span');
        span.dataset.field = 'label';
        span.textContent = item.label || item.id;
        tdService.append(span);
      }

      const tdCat = document.createElement('td');
      if (isCustom) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'settings-page__costs-input';
        input.dataset.field = 'category';
        input.value = item.category || 'Other';
        tdCat.append(input);
      } else {
        const span = document.createElement('span');
        span.dataset.field = 'category';
        span.textContent = item.category || 'Other';
        tdCat.append(span);
      }

      const tdCadence = document.createElement('td');
      tdCadence.className = 'settings-page__costs-cadence';
      if (isCustom) {
        const sel = document.createElement('select');
        sel.className = 'settings-page__costs-select';
        sel.dataset.field = 'cadence';
        for (const [id, lab] of Object.entries(COST_CADENCE_LABELS)) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = lab;
          if (id === (item.cadence || 'usage')) opt.selected = true;
          sel.append(opt);
        }
        tdCadence.append(sel);
      } else {
        tdCadence.textContent = COST_CADENCE_LABELS[item.cadence] || item.cadence || '—';
      }

      const tdWeek = document.createElement('td');
      tdWeek.className = 'settings-page__costs-weekly';
      const weekInput = document.createElement('input');
      weekInput.type = 'number';
      weekInput.min = '0';
      weekInput.step = '0.01';
      weekInput.className = 'settings-page__costs-input settings-page__costs-input--money';
      weekInput.dataset.field = 'weeklyUsd';
      weekInput.value = String(Number(item.weeklyUsd) || 0);
      weekInput.setAttribute('aria-label', `${item.label || item.id} dollars per week`);
      tdWeek.append(weekInput);

      const tdMeasured = document.createElement('td');
      tdMeasured.className = 'settings-page__value settings-page__costs-measured';
      if (item.measuredWeeklyUsd != null && Number.isFinite(Number(item.measuredWeeklyUsd))) {
        tdMeasured.textContent = formatCostUsd(item.measuredWeeklyUsd, currency);
        tdMeasured.title = item.measuredMonthlyUsd != null
          ? `Month to date: ${formatCostUsd(item.measuredMonthlyUsd, currency)}`
          : '';
        if (Number(item.measuredWeeklyUsd) > 0) {
          tdMeasured.classList.add('settings-page__costs-measured--live');
        }
      } else {
        tdMeasured.textContent = '—';
        tdMeasured.classList.add('settings-page__costs-measured--na');
      }

      const tdNotes = document.createElement('td');
      tdNotes.className = 'settings-page__costs-notes';
      const notesInput = document.createElement('input');
      notesInput.type = 'text';
      notesInput.className = 'settings-page__costs-input settings-page__costs-input--notes';
      notesInput.dataset.field = 'notes';
      notesInput.value = item.notes || '';
      notesInput.placeholder = 'Notes';
      tdNotes.append(notesInput);

      tr.append(tdOn, tdService, tdCat, tdCadence, tdWeek, tdMeasured, tdNotes);
      tbody.append(tr);
    }
  }

  /**
   * @param {object} data
   */
  function applyPayload(data) {
    state = {
      currency: data.currency || 'USD',
      items: Array.isArray(data.items) ? data.items : [],
    };
    renderKpi(data);
    renderCategories(data);
    renderApifyMeter(data);
    populateRows(state.items, state.currency);
    tableWrap.hidden = false;
    actions.hidden = false;
    loadStatus.hidden = true;
    loadStatus.textContent = '';
    note.hidden = false;
    const when = data.updatedAt
      ? new Date(data.updatedAt).toLocaleString()
      : 'defaults (not saved yet)';
    note.textContent = `Costs ledger · last saved ${when} · edit $/week and Save`;
  }

  function reload() {
    loadStatus.hidden = false;
    loadStatus.className = 'settings-page__load-status';
    loadStatus.textContent = 'Loading costs…';
    fetch('/api/dashboard-costs', { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
        applyPayload(data);
      })
      .catch((e) => {
        loadStatus.className = 'settings-page__err';
        loadStatus.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      });
  }

  addBtn.addEventListener('click', () => {
    const id = `custom-${Date.now().toString(36)}`;
    state.items = [
      ...readRowsFromDom(),
      {
        id,
        label: '',
        category: 'Other',
        cadence: 'fixed_weekly',
        weeklyUsd: 0,
        notes: '',
        active: true,
        measuredWeeklyUsd: null,
      },
    ];
    populateRows(state.items, state.currency);
    const last = tbody.querySelector('tr:last-child input[data-field="label"]');
    if (last instanceof HTMLInputElement) last.focus();
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.classList.remove('settings-page__rain-msg--err');
    msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/dashboard-costs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currency: state.currency,
          items: readRowsFromDom(),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      applyPayload(data);
      msg.textContent = 'Saved.';
      setTimeout(() => {
        if (msg.textContent === 'Saved.') msg.hidden = true;
      }, 1800);
    } catch (e) {
      msg.classList.add('settings-page__rain-msg--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    } finally {
      saveBtn.disabled = false;
    }
  });

  reload();
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
 * Site-column links for a Gmail intake row (App Password preferred; OAuth optional).
 * @param {string} email
 * @returns {HTMLTableCellElement}
 */
function buildGmailConnectCell(email) {
  const td = document.createElement('td');
  td.className = 'settings-page__live settings-page__live--gmail';

  const wrap = document.createElement('div');
  wrap.className = 'settings-page__gmail-row-links';

  const appPw = document.createElement('a');
  appPw.href =
    `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(email)}`
    + `&continue=${encodeURIComponent('https://myaccount.google.com/apppasswords')}`;
  appPw.target = '_blank';
  appPw.rel = 'noopener noreferrer';
  appPw.textContent = 'App Password';
  appPw.title =
    `Create a Google App Password while signed in as ${email}, then set GMAIL_INTAKE_APP_PASSWORD_* in .env`;

  const oauth = document.createElement('a');
  oauth.href = `/api/events-finder-gmail/oauth/start?email=${encodeURIComponent(email)}`;
  oauth.textContent = 'OAuth';
  oauth.title = `OAuth connect ${email} (Gmail API)`;

  wrap.append(appPw, oauth);
  td.append(wrap);
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
 * Modal to edit taste, where/when filters, and Facebook scrape settings.
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

  const header = document.createElement('div');
  header.className = 'settings-page__modal-header';

  const title = document.createElement('h3');
  title.id = 'settings-events-criteria-title';
  title.className = 'settings-page__modal-title';
  title.textContent = 'Events criteria (ingestion)';

  const hint = document.createElement('p');
  hint.className = 'settings-page__modal-hint';
  hint.textContent =
    'Controls what gets scraped into the catalog: keyword lists and Facebook discovery. This is separate from the Events sidebar Filters, which only sort/hide events already in the database.';

  header.append(title, hint);

  const body = document.createElement('div');
  body.className = 'settings-page__modal-scroll';

  /** @type {{ city?: string | null, place?: string | null, zip?: string | null } | null} */
  let geoState = null;
  /** @type {Array<{ url: string, name: string, avgEventsPerMonth: number | null, avgComputedAt?: string | null }>} */
  let pinnedHosts = [];
  /** @type {object | null} */
  let facebookBilling = null;

  const tasteHeading = document.createElement('h4');
  tasteHeading.className = 'settings-page__modal-subheading';
  tasteHeading.textContent = '1. Taste keywords (catalog ranking)';

  const lookLabelRow = document.createElement('div');
  lookLabelRow.className = 'settings-page__modal-label-row';
  const lookLabel = document.createElement('label');
  lookLabel.className = 'settings-page__modal-field-label';
  lookLabel.htmlFor = 'settings-events-criteria-look';
  lookLabel.textContent = 'Look for (whitelist)';
  const lookCount = document.createElement('span');
  lookCount.className = 'settings-page__modal-count';
  lookCount.textContent = '';
  lookLabelRow.append(lookLabel, lookCount);

  const lookHint = document.createElement('p');
  lookHint.className = 'settings-page__modal-field-hint';
  lookHint.textContent =
    'One idea per line. Ranks and keeps events already in the catalog (all sources). Does not buy Facebook Apify searches — edit those under Facebook discovery below.';

  const lookArea = document.createElement('textarea');
  lookArea.id = 'settings-events-criteria-look';
  lookArea.className = 'settings-page__modal-textarea settings-page__modal-textarea--look';
  lookArea.rows = 10;
  lookArea.spellcheck = true;
  lookArea.placeholder = 'Loading…';

  const skipLabelRow = document.createElement('div');
  skipLabelRow.className = 'settings-page__modal-label-row';
  const skipLabel = document.createElement('label');
  skipLabel.className = 'settings-page__modal-field-label';
  skipLabel.htmlFor = 'settings-events-criteria-skip';
  skipLabel.textContent = 'Grey list';
  const skipCount = document.createElement('span');
  skipCount.className = 'settings-page__modal-count';
  skipCount.textContent = '';
  skipLabelRow.append(skipLabel, skipCount);

  const skipHint = document.createElement('p');
  skipHint.className = 'settings-page__modal-field-hint';
  skipHint.textContent =
    'Hide matching catalog events only when no Look for (whitelist) line also matches. Feed-only — does not change what Apify scrapes or what you pay.';

  const skipArea = document.createElement('textarea');
  skipArea.id = 'settings-events-criteria-skip';
  skipArea.className = 'settings-page__modal-textarea';
  skipArea.rows = 5;
  skipArea.spellcheck = true;
  skipArea.placeholder = 'Loading…';

  const blackLabelRow = document.createElement('div');
  blackLabelRow.className = 'settings-page__modal-label-row';
  const blackLabel = document.createElement('label');
  blackLabel.className = 'settings-page__modal-field-label';
  blackLabel.htmlFor = 'settings-events-criteria-blacklist';
  blackLabel.textContent = 'Black list';
  const blackCount = document.createElement('span');
  blackCount.className = 'settings-page__modal-count';
  blackCount.textContent = '';
  blackLabelRow.append(blackLabel, blackCount);

  const blackHint = document.createElement('p');
  blackHint.className = 'settings-page__modal-field-hint';
  blackHint.textContent =
    'Always hide matching catalog events, even if a Look for (whitelist) line also matches. Feed-only.';

  const blackArea = document.createElement('textarea');
  blackArea.id = 'settings-events-criteria-blacklist';
  blackArea.className = 'settings-page__modal-textarea';
  blackArea.rows = 5;
  blackArea.spellcheck = true;
  blackArea.placeholder = 'Loading…';

  const ingestHeading = document.createElement('h4');
  ingestHeading.className = 'settings-page__modal-subheading';
  ingestHeading.textContent = '2. Ingestion window';

  const ingestHint = document.createElement('p');
  ingestHint.className = 'settings-page__modal-field-hint';
  ingestHint.textContent =
    'Scrape ahead limits bulk discovery (Gmail, Facebook, Multiverse) and rolls the Events sidebar date picks. Telegram intake is not gated — far-future invites are saved when you send them.';

  const weeksLabel = document.createElement('label');
  weeksLabel.className = 'settings-page__modal-field-label';
  weeksLabel.htmlFor = 'settings-events-criteria-weeks';
  weeksLabel.textContent = 'Scrape ahead';

  const weeksSelect = document.createElement('select');
  weeksSelect.id = 'settings-events-criteria-weeks';
  weeksSelect.className = 'settings-page__modal-input settings-page__modal-input--select';

  /**
   * @param {number} [selected]
   */
  function renderWeeksOptions(selected = 4) {
    weeksSelect.replaceChildren();
    for (const w of [1, 2, 3, 4, 5]) {
      const opt = document.createElement('option');
      opt.value = String(w);
      const days = w * 7;
      opt.textContent = `Rolling ${w} week${w === 1 ? '' : 's'} (~${days} days)`;
      weeksSelect.append(opt);
    }
    weeksSelect.value = String(selected);
  }
  renderWeeksOptions(4);

  const weeksLiveHint = document.createElement('p');
  weeksLiveHint.className = 'settings-page__modal-field-hint';
  weeksLiveHint.id = 'settings-events-criteria-weeks-hint';

  /**
   * @param {number} [weeks]
   * @param {{ futureDays?: number } | null} [ingestWindow]
   */
  function updateWeeksLiveHint(weeks, ingestWindow = null) {
    const w = Number(weeks) || Number(weeksSelect.value) || 4;
    const days = ingestWindow?.futureDays || w * 7;
    weeksLiveHint.textContent = `Keeps events from ~2 days ago through ~${days} days ahead (rolling ${w} week${w === 1 ? '' : 's'} from today).`;
  }
  updateWeeksLiveHint(4);
  weeksSelect.addEventListener('change', () => {
    updateWeeksLiveHint(Number(weeksSelect.value));
  });

  const earliestEnable = document.createElement('label');
  earliestEnable.className = 'settings-page__modal-check';
  const earliestCheck = document.createElement('input');
  earliestCheck.type = 'checkbox';
  earliestCheck.id = 'settings-events-criteria-earliest-on';
  const earliestEnableText = document.createElement('span');
  earliestEnableText.textContent = 'Require earliest start time (optional)';
  earliestEnable.append(earliestCheck, earliestEnableText);

  const earliestHint = document.createElement('p');
  earliestHint.className = 'settings-page__modal-field-hint';
  earliestHint.textContent =
    'When enabled, drop ingested events that start before this local time. Independent of the sidebar Filters earliest time.';

  const timeInput = document.createElement('input');
  timeInput.id = 'settings-events-criteria-earliest';
  timeInput.className = 'settings-page__modal-input settings-page__modal-input--time';
  timeInput.type = 'time';
  timeInput.step = '60';
  timeInput.value = '11:00';
  timeInput.disabled = true;

  earliestCheck.addEventListener('change', () => {
    timeInput.disabled = !earliestCheck.checked;
  });

  const scrapeDetails = document.createElement('details');
  scrapeDetails.className = 'settings-page__modal-details';
  scrapeDetails.open = true;

  const scrapeSummary = document.createElement('summary');
  scrapeSummary.className = 'settings-page__modal-details-summary';
  scrapeSummary.textContent = '3. Facebook discovery (Apify) — paid';

  const scrapeBody = document.createElement('div');
  scrapeBody.className = 'settings-page__modal-details-body';

  const scrapeHint = document.createElement('p');
  scrapeHint.className = 'settings-page__modal-field-hint';
  scrapeHint.textContent =
    'Gmail invites are free and separate. Paid Apify discovery = keyword searches below + pinned hosts. Taste keywords above only rank the catalog.';

  const billingRow = document.createElement('p');
  billingRow.className = 'settings-page__modal-billing';
  billingRow.textContent = 'Billing month: …';

  /** @type {string[]} */
  let searchQueries = [];

  const fbSearchLabelRow = document.createElement('div');
  fbSearchLabelRow.className = 'settings-page__modal-label-row';
  const fbSearchLabel = document.createElement('p');
  fbSearchLabel.className = 'settings-page__modal-field-label';
  fbSearchLabel.textContent = 'Facebook keyword searches (paid)';
  const fbSearchCount = document.createElement('span');
  fbSearchCount.className = 'settings-page__modal-count';
  fbSearchCount.textContent = '';
  fbSearchLabelRow.append(fbSearchLabel, fbSearchCount);

  const fbSearchHint = document.createElement('p');
  fbSearchHint.className = 'settings-page__modal-field-hint';
  fbSearchHint.textContent =
    'Paid Apify keyword searches. Include a city in the query when you want one; otherwise the dashboard city is appended. Max search queries below caps how many run.';

  const fbSearchToolbar = document.createElement('div');
  fbSearchToolbar.className = 'settings-page__modal-pinned-toolbar';
  const addSearchBtn = document.createElement('button');
  addSearchBtn.type = 'button';
  addSearchBtn.className = 'settings-page__secondary-cancel';
  addSearchBtn.textContent = 'Add query';
  const seedSearchBtn = document.createElement('button');
  seedSearchBtn.type = 'button';
  seedSearchBtn.className = 'settings-page__secondary-cancel';
  seedSearchBtn.textContent = 'Seed from Look for';
  seedSearchBtn.title = 'Copy the first N Look for lines into this list (does not change Look for)';
  fbSearchToolbar.append(addSearchBtn, seedSearchBtn);

  const fbSearchList = document.createElement('div');
  fbSearchList.className = 'settings-page__modal-fb-searches';

  const budgetRow = document.createElement('div');
  budgetRow.className = 'settings-page__modal-budget-row';

  function makeNumField(id, labelText, hintText, min, max, value) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-page__modal-budget-field';
    const lab = document.createElement('label');
    lab.className = 'settings-page__modal-field-label';
    lab.htmlFor = id;
    lab.textContent = labelText;
    const hintEl = document.createElement('p');
    hintEl.className = 'settings-page__modal-field-hint';
    hintEl.textContent = hintText;
    const input = document.createElement('input');
    input.id = id;
    input.className = 'settings-page__modal-input';
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(value);
    wrap.append(lab, hintEl, input);
    return { wrap, input };
  }

  const maxQueries = makeNumField(
    'settings-events-scrape-max-queries',
    'Max search queries',
    'Run at most this many queries from the list above (1–24).',
    1,
    24,
    6,
  );
  const maxPer = makeNumField(
    'settings-events-scrape-max-per',
    'Max events / query',
    'Apify bills per result (1–200).',
    1,
    200,
    30,
  );
  const cacheHours = makeNumField(
    'settings-events-scrape-cache-hours',
    'Cache hours',
    'Reuse results while fresh (1–168).',
    1,
    168,
    6,
  );
  budgetRow.append(maxQueries.wrap, maxPer.wrap, cacheHours.wrap);

  const pinnedLabelRow = document.createElement('div');
  pinnedLabelRow.className = 'settings-page__modal-label-row';
  const pinnedLabel = document.createElement('p');
  pinnedLabel.className = 'settings-page__modal-field-label';
  pinnedLabel.textContent = 'Pinned Facebook hosts';
  const pinnedCount = document.createElement('span');
  pinnedCount.className = 'settings-page__modal-count';
  pinnedCount.textContent = '';
  pinnedLabelRow.append(pinnedLabel, pinnedCount);

  const pinnedHint = document.createElement('p');
  pinnedHint.className = 'settings-page__modal-field-hint';
  pinnedHint.textContent =
    'Groups/pages always scraped. Avg/mo is read-only: events seen on that host over the last 6 months ÷ 6 (via Apify, including past hosted events). Updates after Facebook scrapes.';

  const pinnedToolbar = document.createElement('div');
  pinnedToolbar.className = 'settings-page__modal-pinned-toolbar';

  const bulkAddBtn = document.createElement('button');
  bulkAddBtn.type = 'button';
  bulkAddBtn.className = 'settings-page__secondary-cancel';
  bulkAddBtn.textContent = 'Bulk add';

  const bulkDeleteBtn = document.createElement('button');
  bulkDeleteBtn.type = 'button';
  bulkDeleteBtn.className = 'settings-page__secondary-cancel';
  bulkDeleteBtn.textContent = 'Delete selected';

  const addRowBtn = document.createElement('button');
  addRowBtn.type = 'button';
  addRowBtn.className = 'settings-page__secondary-cancel';
  addRowBtn.textContent = 'Add row';

  pinnedToolbar.append(addRowBtn, bulkAddBtn, bulkDeleteBtn);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'settings-page__modal-pinned-wrap';

  const table = document.createElement('table');
  table.className = 'settings-page__modal-pinned-table';
  table.innerHTML =
    '<thead><tr>'
    + '<th scope="col" class="settings-page__modal-pinned-check"><input type="checkbox" id="settings-pinned-select-all" title="Select all" aria-label="Select all hosts"></th>'
    + '<th scope="col">Name</th>'
    + '<th scope="col">URL</th>'
    + '<th scope="col" class="settings-page__modal-pinned-avg" title="Events in last 6 months ÷ 6">Avg/mo</th>'
    + '</tr></thead>';
  const tbody = document.createElement('tbody');
  table.append(tbody);
  tableWrap.append(table);

  const selectAll = table.querySelector('#settings-pinned-select-all');

  const bulkAddPanel = document.createElement('div');
  bulkAddPanel.className = 'settings-page__modal-bulk-add';
  bulkAddPanel.hidden = true;
  const bulkAddHint = document.createElement('p');
  bulkAddHint.className = 'settings-page__modal-field-hint';
  bulkAddHint.textContent =
    'One host per line: URL, or Name | URL. Blank lines and # comments ignored.';
  const bulkAddArea = document.createElement('textarea');
  bulkAddArea.className = 'settings-page__modal-textarea settings-page__modal-textarea--pinned';
  bulkAddArea.rows = 6;
  bulkAddArea.placeholder =
    'SFBay AcroYoga | https://www.facebook.com/groups/sfbayacro/\ngroups/noisebridge';
  const bulkAddActions = document.createElement('div');
  bulkAddActions.className = 'settings-page__modal-pinned-toolbar';
  const bulkAddConfirm = document.createElement('button');
  bulkAddConfirm.type = 'button';
  bulkAddConfirm.className = 'settings-page__rain-save';
  bulkAddConfirm.textContent = 'Add lines';
  const bulkAddCancel = document.createElement('button');
  bulkAddCancel.type = 'button';
  bulkAddCancel.className = 'settings-page__secondary-cancel';
  bulkAddCancel.textContent = 'Close';
  bulkAddActions.append(bulkAddConfirm, bulkAddCancel);
  bulkAddPanel.append(bulkAddHint, bulkAddArea, bulkAddActions);

  scrapeBody.append(
    scrapeHint,
    billingRow,
    fbSearchLabelRow,
    fbSearchHint,
    fbSearchToolbar,
    fbSearchList,
    budgetRow,
    pinnedLabelRow,
    pinnedHint,
    pinnedToolbar,
    tableWrap,
    bulkAddPanel,
  );
  scrapeDetails.append(scrapeSummary, scrapeBody);

  body.append(
    tasteHeading,
    lookLabelRow,
    lookHint,
    lookArea,
    skipLabelRow,
    skipHint,
    skipArea,
    blackLabelRow,
    blackHint,
    blackArea,
    ingestHeading,
    ingestHint,
    weeksLabel,
    weeksSelect,
    weeksLiveHint,
    earliestEnable,
    earliestHint,
    timeInput,
    scrapeDetails,
  );

  const footer = document.createElement('div');
  footer.className = 'settings-page__modal-footer';

  const msg = document.createElement('p');
  msg.className = 'settings-page__rain-msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'settings-page__modal-actions settings-page__modal-actions--footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-page__secondary-cancel';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-page__rain-save';
  saveBtn.textContent = 'Save';

  actions.append(cancelBtn, saveBtn);
  footer.append(msg, actions);

  modal.append(header, body, footer);
  backdrop.append(modal);
  document.body.append(backdrop);

  /**
   * @param {string} block
   * @returns {string[]}
   */
  function nonEmptyLines(block) {
    return String(block || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * @param {HTMLElement} el
   * @param {number} n
   * @param {string} unit
   */
  function setCount(el, n, unit) {
    el.textContent = n ? `${n} ${unit}${n === 1 ? '' : 's'}` : '';
  }

  function readPinnedFromTable() {
    /** @type {Array<{ url: string, name: string, avgEventsPerMonth: number | null, avgComputedAt?: string | null }>} */
    const rows = [];
    const priorByUrl = new Map(
      pinnedHosts.map((h) => [String(h.url || '').trim().toLowerCase(), h]),
    );
    for (const tr of tbody.querySelectorAll('tr')) {
      const nameInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="name"]'));
      const urlInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="url"]'));
      const url = String(urlInput?.value || '').trim();
      if (!url) continue;
      const prior = priorByUrl.get(url.toLowerCase());
      rows.push({
        name: String(nameInput?.value || '').trim() || 'Facebook host',
        url,
        avgEventsPerMonth: prior?.avgEventsPerMonth ?? null,
        avgComputedAt: prior?.avgComputedAt ?? null,
      });
    }
    pinnedHosts = rows;
    return rows;
  }

  function renderPinnedTable() {
    tbody.replaceChildren();
    for (const host of pinnedHosts) {
      const tr = document.createElement('tr');
      const tdCheck = document.createElement('td');
      tdCheck.className = 'settings-page__modal-pinned-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'settings-page__modal-pinned-row-check';
      cb.setAttribute('aria-label', `Select ${host.name || host.url}`);
      tdCheck.append(cb);

      const tdName = document.createElement('td');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'settings-page__modal-pinned-input';
      nameInput.dataset.field = 'name';
      nameInput.value = host.name || '';
      nameInput.placeholder = 'Group name';
      tdName.append(nameInput);

      const tdUrl = document.createElement('td');
      const urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.className = 'settings-page__modal-pinned-input settings-page__modal-pinned-input--url';
      urlInput.dataset.field = 'url';
      urlInput.value = host.url || '';
      urlInput.placeholder = 'https://www.facebook.com/groups/…';
      tdUrl.append(urlInput);

      const tdAvg = document.createElement('td');
      tdAvg.className = 'settings-page__modal-pinned-avg';
      const avgEl = document.createElement('span');
      avgEl.className = 'settings-page__modal-pinned-avg-value';
      avgEl.dataset.field = 'avg';
      if (host.avgEventsPerMonth == null || host.avgEventsPerMonth === '') {
        avgEl.textContent = '—';
        avgEl.title = 'Computed after the next Facebook scrape from the last 6 months of events on this host';
      } else {
        avgEl.textContent = String(host.avgEventsPerMonth);
        avgEl.title = host.avgComputedAt
          ? `Last 6 months ÷ 6 (updated ${new Date(host.avgComputedAt).toLocaleDateString()})`
          : 'Last 6 months ÷ 6 (from Apify host pages)';
      }
      tdAvg.append(avgEl);

      tr.append(tdCheck, tdName, tdUrl, tdAvg);
      tbody.append(tr);
    }
    if (selectAll instanceof HTMLInputElement) selectAll.checked = false;
    setCount(pinnedCount, pinnedHosts.length, 'host');
    updateScrapeSummary();
  }

  function renderBilling() {
    if (!facebookBilling || typeof facebookBilling !== 'object') {
      billingRow.textContent = 'Billing month: no runs logged yet.';
      return;
    }
    const month = facebookBilling.month || 'this month';
    const total = Number(facebookBilling.totalUsd) || 0;
    const credits = Number(facebookBilling.monthlyCreditsUsd) || 5;
    const remaining = Number(facebookBilling.remainingCreditsUsd);
    const runs = Number(facebookBilling.runCount) || 0;
    const est = Number(facebookBilling.estimatedRunCount) || 0;
    const remLabel = Number.isFinite(remaining)
      ? ` · $${remaining.toFixed(2)} of $${credits.toFixed(0)} credits left`
      : '';
    const estLabel = est ? ` (${est} estimated)` : '';
    billingRow.textContent =
      `${month}: $${total.toFixed(2)} across ${runs} run${runs === 1 ? '' : 's'}${estLabel}${remLabel}`;
  }

  function updateScrapeSummary() {
    const q = Math.min(
      Math.max(Number(maxQueries.input.value) || 6, 1),
      24,
      Math.max(searchQueries.filter(Boolean).length, 1),
    );
    const per = Number(maxPer.input.value) || 30;
    const hrs = Number(cacheHours.input.value) || 6;
    const pins = pinnedHosts.length;
    scrapeSummary.textContent = `3. Facebook discovery (Apify) — ${q} searches × ${per} events, ${hrs}h cache${
      pins ? `, ${pins} pinned` : ''
    }`;
  }

  function updateTasteCounts() {
    setCount(lookCount, nonEmptyLines(lookArea.value).length, 'line');
    setCount(skipCount, nonEmptyLines(skipArea.value).length, 'line');
    setCount(blackCount, nonEmptyLines(blackArea.value).length, 'line');
  }

  function placeShort() {
    const place =
      (geoState && (geoState.city || geoState.place)) ||
      'San Francisco';
    return String(place).split(',')[0].trim() || 'San Francisco';
  }

  /**
   * @param {string} line
   */
  function resolveFbQuery(line) {
    const s = String(line || '').trim();
    if (!s) return '';
    const lower = s.toLowerCase();
    if (
      lower.includes('san francisco') ||
      lower.includes('oakland') ||
      lower.includes('berkeley') ||
      lower.includes('emeryville') ||
      lower.includes('bay area')
    ) {
      return s;
    }
    return `${s} ${placeShort()}`;
  }

  function readSearchQueriesFromUi() {
    searchQueries = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')]
      .map((el) => (el instanceof HTMLInputElement ? el.value.trim() : ''))
      .filter(Boolean)
      .slice(0, 24);
    return searchQueries;
  }

  function renderFbSearchList() {
    fbSearchList.replaceChildren();
    const n = Math.min(Math.max(Number(maxQueries.input.value) || 6, 1), 24);
    const rows = searchQueries.length ? [...searchQueries] : [''];
    rows.forEach((query, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'settings-page__modal-fb-search-item';
      if (index >= n) wrap.classList.add('settings-page__modal-fb-search-item--capped');

      const row = document.createElement('div');
      row.className = 'settings-page__modal-fb-search-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'settings-page__modal-pinned-input';
      input.dataset.field = 'fb-query';
      input.value = query;
      input.placeholder = 'e.g. hackathon Oakland';
      input.addEventListener('input', () => refreshFbSearchMeta());

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'settings-page__secondary-cancel';
      upBtn.textContent = '↑';
      upBtn.title = 'Move up';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => {
        const cur = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')].map((el) =>
          el instanceof HTMLInputElement ? el.value : '',
        );
        if (index <= 0) return;
        [cur[index - 1], cur[index]] = [cur[index], cur[index - 1]];
        searchQueries = cur;
        renderFbSearchList();
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'settings-page__secondary-cancel';
      downBtn.textContent = '↓';
      downBtn.title = 'Move down';
      downBtn.disabled = index >= rows.length - 1;
      downBtn.addEventListener('click', () => {
        const cur = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')].map((el) =>
          el instanceof HTMLInputElement ? el.value : '',
        );
        if (index >= cur.length - 1) return;
        [cur[index + 1], cur[index]] = [cur[index], cur[index + 1]];
        searchQueries = cur;
        renderFbSearchList();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'settings-page__secondary-cancel';
      delBtn.textContent = '×';
      delBtn.title = 'Remove';
      delBtn.addEventListener('click', () => {
        const cur = [...fbSearchList.querySelectorAll('[data-field="fb-query"]')].map((el) =>
          el instanceof HTMLInputElement ? el.value : '',
        );
        cur.splice(index, 1);
        searchQueries = cur.map((s) => String(s || '').trim()).filter(Boolean);
        renderFbSearchList();
      });

      row.append(input, upBtn, downBtn, delBtn);
      wrap.append(row);

      const resolved = resolveFbQuery(query);
      if (query.trim() && resolved !== query.trim()) {
        const note = document.createElement('p');
        note.className = 'settings-page__modal-fb-search-note';
        note.textContent = `→ ${resolved}`;
        wrap.append(note);
      } else if (index >= n && query.trim()) {
        const note = document.createElement('p');
        note.className = 'settings-page__modal-fb-search-note';
        note.textContent = 'Over max — not run until raised or moved up';
        wrap.append(note);
      }

      fbSearchList.append(wrap);
    });
    refreshFbSearchMeta();
  }

  function refreshFbSearchMeta() {
    readSearchQueriesFromUi();
    const n = Math.min(Math.max(Number(maxQueries.input.value) || 6, 1), 24);
    const active = Math.min(searchQueries.length, n);
    fbSearchCount.textContent = searchQueries.length
      ? active < searchQueries.length
        ? `${active} of ${searchQueries.length} run`
        : `${searchQueries.length} quer${searchQueries.length === 1 ? 'y' : 'ies'}`
      : '';
    updateScrapeSummary();
    updateTasteCounts();

    // Refresh capped styling + place notes without full re-render when typing.
    const items = [...fbSearchList.querySelectorAll('.settings-page__modal-fb-search-item')];
    items.forEach((item, index) => {
      item.classList.toggle('settings-page__modal-fb-search-item--capped', index >= n);
      const input = item.querySelector('[data-field="fb-query"]');
      const value = input instanceof HTMLInputElement ? input.value.trim() : '';
      let note = item.querySelector('.settings-page__modal-fb-search-note');
      const resolved = resolveFbQuery(value);
      let noteText = '';
      if (value && resolved !== value) noteText = `→ ${resolved}`;
      else if (index >= n && value) noteText = 'Over max — not run until raised or moved up';
      if (noteText) {
        if (!note) {
          note = document.createElement('p');
          note.className = 'settings-page__modal-fb-search-note';
          item.append(note);
        }
        note.textContent = noteText;
      } else if (note) {
        note.remove();
      }
    });
  }

  /**
   * @param {{
   *   city?: string | null,
   *   place?: string | null,
   *   zip?: string | null,
   * } | null | undefined} geo
   */
  function renderGeo(geo) {
    geoState = geo && typeof geo === 'object' ? geo : null;
  }

  /**
   * @param {string} block
   */
  function parseBulkHosts(block) {
    /** @type {Array<{ url: string, name: string, avgEventsPerMonth: number | null }>} */
    const out = [];
    for (const line of String(block || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        const first = parts[0];
        if (/facebook\.com|groups\//i.test(last)) {
          out.push({ name: parts.slice(0, -1).join(' | '), url: last, avgEventsPerMonth: null });
        } else if (/facebook\.com|groups\//i.test(first)) {
          out.push({ name: parts.slice(1).join(' | '), url: first, avgEventsPerMonth: null });
        } else {
          out.push({ name: parts.slice(0, -1).join(' | '), url: last, avgEventsPerMonth: null });
        }
      } else {
        out.push({ name: '', url: trimmed, avgEventsPerMonth: null });
      }
    }
    return out;
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

  lookArea.addEventListener('input', updateTasteCounts);
  skipArea.addEventListener('input', updateTasteCounts);
  blackArea.addEventListener('input', updateTasteCounts);
  maxQueries.input.addEventListener('input', () => {
    renderFbSearchList();
  });
  maxPer.input.addEventListener('input', updateScrapeSummary);
  cacheHours.input.addEventListener('input', updateScrapeSummary);

  addSearchBtn.addEventListener('click', () => {
    readSearchQueriesFromUi();
    if (searchQueries.length >= 12) return;
    searchQueries = [...searchQueries, ''];
    renderFbSearchList();
    const last = fbSearchList.querySelector('.settings-page__modal-fb-search-row:last-child [data-field="fb-query"]');
    if (last instanceof HTMLInputElement) last.focus();
  });

  seedSearchBtn.addEventListener('click', () => {
    const n = Math.min(Math.max(Number(maxQueries.input.value) || 6, 1), 24);
    const seeded = nonEmptyLines(lookArea.value).slice(0, n);
    if (!seeded.length) return;
    searchQueries = seeded;
    renderFbSearchList();
  });

  addRowBtn.addEventListener('click', () => {
    readPinnedFromTable();
    pinnedHosts.push({ name: '', url: '', avgEventsPerMonth: null });
    renderPinnedTable();
    const last = tbody.querySelector('tr:last-child [data-field="url"]');
    if (last instanceof HTMLInputElement) last.focus();
  });

  bulkAddBtn.addEventListener('click', () => {
    bulkAddPanel.hidden = !bulkAddPanel.hidden;
    if (!bulkAddPanel.hidden) bulkAddArea.focus();
  });
  bulkAddCancel.addEventListener('click', () => {
    bulkAddPanel.hidden = true;
  });
  bulkAddConfirm.addEventListener('click', () => {
    readPinnedFromTable();
    const added = parseBulkHosts(bulkAddArea.value);
    if (!added.length) return;
    const seen = new Set(
      pinnedHosts.map((h) => String(h.url || '').trim().toLowerCase()).filter(Boolean),
    );
    for (const host of added) {
      const key = String(host.url || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pinnedHosts.push(host);
    }
    renderPinnedTable();
    bulkAddArea.value = '';
    bulkAddPanel.hidden = true;
  });

  bulkDeleteBtn.addEventListener('click', () => {
    const next = [];
    const priorByUrl = new Map(
      pinnedHosts.map((h) => [String(h.url || '').trim().toLowerCase(), h]),
    );
    for (const tr of tbody.querySelectorAll('tr')) {
      const cb = tr.querySelector('.settings-page__modal-pinned-row-check');
      if (cb instanceof HTMLInputElement && cb.checked) continue;
      const nameInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="name"]'));
      const urlInput = /** @type {HTMLInputElement | null} */ (tr.querySelector('[data-field="url"]'));
      const url = String(urlInput?.value || '').trim();
      if (!url && !String(nameInput?.value || '').trim()) continue;
      const prior = priorByUrl.get(url.toLowerCase());
      next.push({
        name: String(nameInput?.value || '').trim() || 'Facebook host',
        url,
        avgEventsPerMonth: prior?.avgEventsPerMonth ?? null,
        avgComputedAt: prior?.avgComputedAt ?? null,
      });
    }
    pinnedHosts = next;
    renderPinnedTable();
  });

  if (selectAll instanceof HTMLInputElement) {
    selectAll.addEventListener('change', () => {
      for (const cb of tbody.querySelectorAll('.settings-page__modal-pinned-row-check')) {
        if (cb instanceof HTMLInputElement) cb.checked = selectAll.checked;
      }
    });
  }

  const filterControls = [
    lookArea,
    skipArea,
    blackArea,
    weeksSelect,
    earliestCheck,
    timeInput,
    maxQueries.input,
    maxPer.input,
    cacheHours.input,
    addSearchBtn,
    seedSearchBtn,
    addRowBtn,
    bulkAddBtn,
    bulkDeleteBtn,
  ];
  for (const el of filterControls) el.disabled = true;
  saveBtn.disabled = true;
  msg.hidden = false;
  msg.textContent = 'Loading…';

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
      blackArea.value = typeof data.blacklist === 'string' ? data.blacklist : '';
      blackArea.placeholder = 'One idea per line…';
      renderGeo(data.geo);
      facebookBilling = data.facebookBilling || null;
      renderBilling();

      const scrape = data.scrape && typeof data.scrape === 'object' ? data.scrape : {};
      maxQueries.input.value = String(scrape.maxQueries ?? 6);
      maxPer.input.value = String(scrape.maxEventsPerQuery ?? 30);
      cacheHours.input.value = String(scrape.cacheHours ?? 6);
      weeksSelect.value = String(scrape.windowWeeks ?? 4);
      renderWeeksOptions(Number(scrape.windowWeeks) || 4);
      updateWeeksLiveHint(
        Number(scrape.windowWeeks) || 4,
        data.ingestWindow && typeof data.ingestWindow === 'object' ? data.ingestWindow : null,
      );
      const ingestEarliest = normalizeLocalTime(scrape.earliestLocalTime);
      if (ingestEarliest) {
        earliestCheck.checked = true;
        timeInput.disabled = false;
        timeInput.value = ingestEarliest;
      } else {
        earliestCheck.checked = false;
        timeInput.disabled = true;
        timeInput.value = '11:00';
      }
      pinnedHosts = Array.isArray(scrape.pinnedHosts)
        ? scrape.pinnedHosts.map((h) => ({
            url: String(h?.url || ''),
            name: String(h?.name || ''),
            avgEventsPerMonth:
              h?.avgEventsPerMonth == null || h?.avgEventsPerMonth === ''
                ? null
                : Number(h.avgEventsPerMonth),
            avgComputedAt: h?.avgComputedAt ? String(h.avgComputedAt) : null,
          }))
        : typeof scrape.pinnedHosts === 'string'
          ? parseBulkHosts(scrape.pinnedHosts)
          : [];
      searchQueries = Array.isArray(scrape.searchQueries)
        ? scrape.searchQueries.map((s) => String(s || '').trim()).filter(Boolean)
        : typeof scrape.searchQueries === 'string'
          ? nonEmptyLines(scrape.searchQueries)
          : [];
      renderPinnedTable();
      renderFbSearchList();

      for (const el of filterControls) el.disabled = false;
      timeInput.disabled = !earliestCheck.checked;
      saveBtn.disabled = false;
      msg.hidden = true;
      msg.textContent = '';
      updateTasteCounts();
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
      const earliestRaw = earliestCheck.checked ? String(timeInput.value || '').trim() : '';
      const earliest = normalizeLocalTime(earliestRaw);
      if (earliestRaw && !earliest) {
        throw new Error('Earliest time must look like 11:00.');
      }
      const q = Number(maxQueries.input.value);
      const per = Number(maxPer.input.value);
      const hrs = Number(cacheHours.input.value);
      const weeks = Number(weeksSelect.value);
      if (!Number.isFinite(q) || q < 1 || q > 24) {
        throw new Error('Max search queries must be 1–24.');
      }
      if (!Number.isFinite(per) || per < 1 || per > 200) {
        throw new Error('Max events per query must be 1–200.');
      }
      if (!Number.isFinite(hrs) || hrs < 1 || hrs > 168) {
        throw new Error('Cache hours must be 1–168.');
      }
      if (![1, 2, 3, 4, 5].includes(weeks)) {
        throw new Error('Scrape ahead must be 1–5 weeks.');
      }
      const hosts = readPinnedFromTable();
      const queries = readSearchQueriesFromUi();
      const r = await fetch('/api/events-finder-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lookFor: lookArea.value,
          skip: skipArea.value,
          blacklist: blackArea.value,
          scrape: {
            maxQueries: q,
            maxEventsPerQuery: per,
            cacheHours: hrs,
            windowWeeks: weeks,
            earliestLocalTime: earliest || null,
            searchQueries: queries,
            pinnedHosts: hosts,
          },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      updateWeeksLiveHint(
        Number(data.scrape?.windowWeeks) || weeks,
        data.ingestWindow && typeof data.ingestWindow === 'object' ? data.ingestWindow : null,
      );
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
 * Prompt + POST a new Events source bookmark.
 * @returns {Promise<boolean>} true if a source was added
 */
async function openAddEventSourceDialog() {
  const label = window.prompt('Source name (e.g. Noisebridge)');
  if (label == null) return false;
  const trimmedLabel = String(label).trim();
  if (!trimmedLabel) {
    window.alert('Name is required.');
    return false;
  }
  const url = window.prompt('Source URL (https://…)');
  if (url == null) return false;
  const trimmedUrl = String(url).trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    window.alert('URL must start with http:// or https://');
    return false;
  }
  try {
    const r = await fetch('/api/events-finder-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: trimmedLabel, url: trimmedUrl }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    return true;
  } catch (e) {
    window.alert(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
    return false;
  }
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
  criteriaBtn.textContent = 'Edit criteria';
  criteriaBtn.title =
    'Ingestion settings: keywords, scrape window, and Facebook discovery (not browse filters)';
  criteriaBtn.addEventListener('click', () => openEventsFilterCriteriaModal());
  toolbar.append(criteriaBtn);

  const addSourceBtn = document.createElement('button');
  addSourceBtn.type = 'button';
  addSourceBtn.className = 'settings-page__rain-save';
  addSourceBtn.textContent = '+ Event source';
  addSourceBtn.title = 'Add a site to Personal bookmarks → Events (shows up in this list)';
  addSourceBtn.addEventListener('click', () => {
    void openAddEventSourceDialog().then((added) => {
      if (added) reloadSources();
    });
  });
  toolbar.append(addSourceBtn);
  body.append(toolbar);

  const intro = document.createElement('p');
  intro.className = 'settings-page__intro';
  intro.textContent =
    'From Personal bookmarks → Events. Each site has its own ingest strategy, development status, and known coverage gaps. Use Edit criteria for taste keywords, scrape window, Facebook keyword searches, and pinned hosts. Browse ZIP/dates live in the Events sidebar Filters. Gmail intake rows link App Password or OAuth in the Site column.';
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
  for (const label of [
    'Source',
    'Strategy',
    'Dev status',
    'Status',
    'Output',
    'Missing / gaps',
    'Ingestion test',
    'Site',
  ]) {
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
   *   gmailEmail?: string | null,
   *   strategyLabel?: string,
   *   strategyDetail?: string,
   *   strategy?: string,
   *   devStatus?: string,
   *   devStatusKind?: string,
   *   missingEvents?: string,
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

      const tdDev = document.createElement('td');
      tdDev.className = 'settings-page__source-dev-status';
      const kind = String(src.devStatusKind || 'unspecified').toLowerCase();
      tdDev.classList.add(`settings-page__dev-status--${kind}`);
      tdDev.textContent = src.devStatus || '—';

      const tdStatus = document.createElement('td');
      tdStatus.className = 'settings-page__value settings-page__value--loading settings-page__source-status';
      tdStatus.textContent = 'Loading…';

      const tdOut = document.createElement('td');
      tdOut.className = 'settings-page__value settings-page__value--loading settings-page__source-output';
      tdOut.textContent = '…';

      const tdMissing = document.createElement('td');
      tdMissing.className = 'settings-page__source-missing';
      tdMissing.textContent = src.missingEvents || '—';

      const tdIngest = document.createElement('td');
      tdIngest.className =
        'settings-page__value settings-page__value--loading settings-page__source-ingest';
      tdIngest.textContent = '…';

      const tdLive = src.gmailEmail
        ? buildGmailConnectCell(src.gmailEmail)
        : buildLiveFeedCell(src.url);

      tr.append(tdName, tdStrat, tdDev, tdStatus, tdOut, tdMissing, tdIngest, tdLive);
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
      loadStatus.textContent = 'Checking sources…';
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
      const cacheBit =
        data.cached && Number(data.cacheAgeMs) > 0
          ? ` · cached ${Math.round(Number(data.cacheAgeMs) / 1000)}s ago`
          : '';
      note.textContent = `Events sources snapshot: ${when}${cacheBit}`;
    })
    .catch((e) => {
      loadStatus.className = 'settings-page__err';
      loadStatus.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    });

  function reloadSources() {
    loadStatus.hidden = false;
    loadStatus.className = 'settings-page__load-status';
    loadStatus.textContent = 'Reloading Events sources…';
    note.hidden = true;
    tbody.replaceChildren();
    rowById.clear();
    fetch('/api/events-finder-status?manifest=1', { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false || !Array.isArray(data.sources)) {
          throw new Error(data.error || `HTTP ${r.status}`);
        }
        populateRows(data.sources);
        loadStatus.textContent = 'Checking sources…';
        return fetch('/api/events-finder-status?fresh=1', { cache: 'no-store' });
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
        const when = data.checkedAt
          ? new Date(data.checkedAt).toLocaleString()
          : new Date().toLocaleString();
        note.textContent = `Events sources snapshot: ${when}`;
      })
      .catch((e) => {
        loadStatus.className = 'settings-page__err';
        loadStatus.textContent =
          e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      });
  }
}

/**
 * @param {HTMLElement | null} mount
 */
export async function mountSettingsPage(mount) {
  if (!mount) return;

  const { tbodyByGroup, status, meta } = buildSettingsShell(mount, WINDOW_HOURS);
  buildSecondaryWatchBlock(mount);
  buildEventsFinderSourcesBlock(mount);
  buildCostsBlock(mount);
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
