/**
 * Shared dev request form — desktop sticky + mobile sheet.
 */

const MOBILE_TAB_KEY = 'dashbirdMobileTab';
const LS_PAGE_KEY = 'dashbirdPage';

/** @typedef {{ id: string, label: string }} DevArea */
/** @typedef {{ id: number, label: string, short: string }} DevPriority */
/** @typedef {{ desktop: DevArea[], mobile: DevArea[] }} DevAreasMap */
/** @typedef {{ dataUrl: string, filename: string }} PendingAttachment */

/** @type {DevAreasMap | null} */
let metaCache = null;

/**
 * @returns {Promise<{ areas: DevAreasMap, priorities: DevPriority[] }>}
 */
export async function loadDevRequestMeta() {
  if (metaCache) return { areas: metaCache, priorities: defaultPriorities() };
  const r = await fetch('/api/dev-requests/meta');
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || 'Failed to load dev request meta');
  metaCache = data.areas;
  return { areas: data.areas, priorities: data.priorities || defaultPriorities() };
}

/** @returns {DevPriority[]} */
function defaultPriorities() {
  return [
    { id: 1, label: 'High', short: 'high' },
    { id: 2, label: 'Med', short: 'med' },
    { id: 3, label: 'Low', short: 'low' },
  ];
}

/**
 * @param {'desktop' | 'mobile'} platform
 * @returns {string}
 */
export function detectDevRequestArea(platform) {
  if (platform === 'mobile') {
    try {
      const t = localStorage.getItem(MOBILE_TAB_KEY);
      if (t === 'notes' || t === 'network' || t === 'events' || t === 'groups' || t === 'tasks' || t === 'gmail') return t;
    } catch {
      /* ignore */
    }
    return 'notes';
  }
  try {
    const p = localStorage.getItem(LS_PAGE_KEY);
    if (p === 'settings') return 'settings';
    if (p === 'network' || p === 'nrm') return 'network';
  } catch {
    /* ignore */
  }
  return 'events';
}

/**
 * @param {{
 *   platform: 'desktop' | 'mobile',
 *   onSubmit?: (result: { ok?: boolean, error?: string }) => void,
 *   compact?: boolean,
 * }} opts
 */
export function buildDevRequestForm(opts) {
  const platform = opts.platform;
  /** @type {PendingAttachment[]} */
  let attachments = [];
  let submitting = false;

  const form = document.createElement('form');
  form.className = 'dev-request-form';
  form.noValidate = true;

  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'dev-request-form__textarea';
  bodyInput.placeholder = 'What should change? Steps to reproduce, expected behavior…';
  bodyInput.rows = opts.compact ? 4 : 5;
  bodyInput.required = true;

  const row1 = document.createElement('div');
  row1.className = 'dev-request-form__row';

  const prioritySelect = document.createElement('select');
  prioritySelect.className = 'dev-request-form__select';
  prioritySelect.title = 'Priority';

  const areaSelect = document.createElement('select');
  areaSelect.className = 'dev-request-form__select dev-request-form__select--area';
  areaSelect.title = 'Area';

  row1.append(prioritySelect, areaSelect);

  const attachZone = document.createElement('div');
  attachZone.className = 'dev-request-form__attach';
  attachZone.tabIndex = 0;

  const attachLabel = document.createElement('span');
  attachLabel.className = 'dev-request-form__attach-label';
  attachLabel.textContent = 'Paste or drop screenshot';

  const attachPreview = document.createElement('div');
  attachPreview.className = 'dev-request-form__attach-preview';
  attachPreview.hidden = true;

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.accept = 'image/*';
  attachInput.hidden = true;

  attachZone.append(attachLabel, attachPreview, attachInput);

  const footer = document.createElement('div');
  footer.className = 'dev-request-form__footer dev-request-form__footer--stacked';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'dev-request-form__view';
  viewBtn.textContent = 'View requests';
  viewBtn.addEventListener('click', () => {
    void import('./dev-request-view.js').then(({ openDevRequestsViewer }) => openDevRequestsViewer());
  });

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'dev-request-form__submit';
  submitBtn.textContent = 'Submit request';

  footer.append(viewBtn, submitBtn);
  form.append(bodyInput, row1, attachZone, footer);

  /** @type {DevAreasMap} */
  let areas = { desktop: [], mobile: [] };

  function syncSubmitState() {
    submitBtn.disabled = submitting || !bodyInput.value.trim();
    submitBtn.textContent = submitting ? 'Submitting…' : 'Submit request';
  }

  /**
   * Derive a short title from the change-request text (first non-empty line).
   * @param {string} text
   * @returns {string}
   */
  function deriveTitle(text) {
    const firstLine = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || '';
    if (firstLine.length <= 160) return firstLine;
    return `${firstLine.slice(0, 157).trimEnd()}…`;
  }

  function renderPreview() {
    attachPreview.replaceChildren();
    if (!attachments.length) {
      attachPreview.hidden = true;
      attachLabel.textContent = 'Paste or drop screenshot';
      return;
    }
    attachPreview.hidden = false;
    attachLabel.textContent = `${attachments.length} screenshot${attachments.length > 1 ? 's' : ''} attached`;
    for (const att of attachments) {
      const wrap = document.createElement('div');
      wrap.className = 'dev-request-form__thumb';
      const img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = att.filename;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'dev-request-form__thumb-remove';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.addEventListener('click', (e) => {
        e.preventDefault();
        attachments = attachments.filter((a) => a !== att);
        renderPreview();
      });
      wrap.append(img, rm);
      attachPreview.append(wrap);
    }
  }

  /**
   * @param {File} file
   */
  async function addFile(file) {
    if (!file || !String(file.type || '').startsWith('image/')) return;
    if (attachments.length >= 4) return;
    const dataUrl = await readFileAsDataUrl(file);
    attachments.push({ dataUrl, filename: file.name || 'screenshot.png' });
    renderPreview();
  }

  /**
   * @param {File} file
   * @returns {Promise<string>}
   */
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  function populateAreas() {
    areaSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Pick one (optional)';
    placeholder.selected = true;
    areaSelect.append(placeholder);
    const list = areas[platform] || [];
    for (const a of list) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.label;
      areaSelect.append(opt);
    }
    areaSelect.value = '';
  }

  /** @param {DevPriority[]} priorities */
  function populatePriorities(priorities) {
    prioritySelect.replaceChildren();
    for (const p of priorities) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.label;
      if (p.id === 2) opt.selected = true;
      prioritySelect.append(opt);
    }
  }

  bodyInput.addEventListener('input', syncSubmitState);

  attachZone.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', () => {
    const file = attachInput.files?.[0];
    attachInput.value = '';
    if (file) void addFile(file);
  });
  attachZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    attachZone.classList.add('dev-request-form__attach--hover');
  });
  attachZone.addEventListener('dragleave', () => {
    attachZone.classList.remove('dev-request-form__attach--hover');
  });
  attachZone.addEventListener('drop', (e) => {
    e.preventDefault();
    attachZone.classList.remove('dev-request-form__attach--hover');
    const file = e.dataTransfer?.files?.[0];
    if (file) void addFile(file);
  });
  attachZone.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) void addFile(file);
        break;
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const changeText = bodyInput.value.trim();
    if (submitting || !changeText) return;
    submitting = true;
    syncSubmitState();
    try {
      const payload = {
        title: deriveTitle(changeText),
        body: changeText,
        platform,
        area: areaSelect.value,
        priority: Number(prioritySelect.value) || 2,
        attachments: attachments.map((a) => ({ dataUrl: a.dataUrl, filename: a.filename })),
      };
      const r = await fetch('/api/dev-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || 'Submit failed');
      bodyInput.value = '';
      attachments = [];
      renderPreview();
      opts.onSubmit?.({ ok: true });
    } catch (err) {
      opts.onSubmit?.({ ok: false, error: String(err?.message || err) });
    } finally {
      submitting = false;
      syncSubmitState();
    }
  });

  void loadDevRequestMeta()
    .then(({ areas: loadedAreas, priorities }) => {
      areas = loadedAreas;
      populatePriorities(priorities);
      populateAreas();
      syncSubmitState();
    })
    .catch(() => {
      areas = {
        desktop: [{ id: 'events', label: 'Events' }, { id: 'network', label: 'Network' }],
        mobile: [{ id: 'events', label: 'Events' }, { id: 'network', label: 'Contacts' }],
      };
      populatePriorities(defaultPriorities());
      populateAreas();
      syncSubmitState();
    });

  syncSubmitState();
  return form;
}
