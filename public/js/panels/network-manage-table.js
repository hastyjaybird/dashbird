/**
 * Manage contacts — spreadsheet table with column filters, cell selection,
 * context menu, drag-fill (corner handle), and double-click bulk fill.
 *
 * Filter UX mirrors Google Sheets: funnel icon on each header → sort,
 * filter-by-condition, filter-by-values (checkboxes), OK/Cancel.
 *
 * Double-click a selected fillable column → type or pick a value → Enter fills
 * all selected cells. Toolbar Undo restores the previous values.
 */

const STORAGE_KEY = 'dashbird-network-manage-columns-v1';

/** Columns that must not be bulk-copied via drag-fill / clear / fill-down. */
const NO_FILL_KEYS = new Set(['displayName', 'id', 'createdAt', 'updatedAt', 'orgId', 'avatarUrl']);

/** Known pick-list values for columns that use a fixed vocabulary. */
const FILL_OPTIONS = {
  kinds: ['friend', 'organizer', 'business'],
  rating: ['Fan', 'Hot', 'Warm', 'Cold'],
  sensitivity: ['Down', 'Situational', 'Proper'],
  relationshipStatus: [
    'Lead',
    'Cultivating',
    'Collaborator',
    'Family',
    'Acquaintance',
    'Paused',
    'Former',
  ],
};

const KIND_VALUES = new Set(['friend', 'organizer', 'business']);

const BLANK_LABEL = '(Blanks)';

/** @type {{ id: string, label: string, needsValue?: boolean, needsTwo?: boolean }[]} */
const FILTER_OPS = [
  { id: 'none', label: 'None' },
  { id: 'empty', label: 'Is empty' },
  { id: 'not_empty', label: 'Is not empty' },
  { id: 'text_contains', label: 'Text contains', needsValue: true },
  { id: 'text_not_contains', label: 'Text does not contain', needsValue: true },
  { id: 'text_eq', label: 'Text is exactly', needsValue: true },
  { id: 'text_ne', label: 'Text is not', needsValue: true },
  { id: 'text_starts', label: 'Text starts with', needsValue: true },
  { id: 'text_ends', label: 'Text ends with', needsValue: true },
];

/**
 * @param {unknown} v
 */
function listJoin(v, sep = ', ') {
  return Array.isArray(v) && v.length ? v.join(sep) : '';
}

/**
 * @param {string} v
 * @param {string | RegExp} [sep]
 */
function listSplit(v, sep = /[,+|/]+/) {
  return String(v || '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Multi-value columns (filterSplit / list fields) support Replace vs Append fills.
 * @param {{ key: string, filterSplit?: boolean | RegExp } | null | undefined} col
 */
function isAppendableColumn(col) {
  return Boolean(col?.filterSplit);
}

/**
 * @param {{ key: string, filterSplit?: boolean | RegExp }} col
 */
function listSepForCol(col) {
  if (col.filterSplit instanceof RegExp) return col.filterSplit;
  return /[,;|/]+/;
}

/**
 * @param {{ key: string, filterSplit?: boolean | RegExp }} col
 */
function listJoinSepForCol(col) {
  if (col.key === 'alignedActivities' || col.key === 'ch_urls') return '\n';
  if (col.filterSplit instanceof RegExp && col.filterSplit.source.includes('\\n')) return '\n';
  return ', ';
}

/**
 * Normalize one list token for dedupe / storage conventions.
 * @param {{ key: string }} col
 * @param {string} part
 */
function normalizeListPart(col, part) {
  const raw = String(part || '').trim();
  if (!raw) return null;
  if (col.key === 'kinds') {
    const k = raw.toLowerCase();
    return KIND_VALUES.has(k) ? k : null;
  }
  if (col.key === 'preferredContactMethods') {
    return raw.toLowerCase().replace(/\s+/g, '_');
  }
  return raw;
}

/**
 * Merge existing cell text with incoming fill text (append mode).
 * @param {{ key: string, filterSplit?: boolean | RegExp }} col
 * @param {string} existingRaw
 * @param {string} addRaw
 */
function mergeAppendValue(col, existingRaw, addRaw) {
  const sep = listSepForCol(col);
  const joinWith = listJoinSepForCol(col);
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const part of [...listSplit(existingRaw, sep), ...listSplit(addRaw, sep)]) {
    const normalized = normalizeListPart(col, part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.join(joinWith);
}

/**
 * @param {string} key
 * @param {string} label
 * @param {{ default?: boolean, get?: (c: object) => string, set?: (c: object, v: string) => object, filterSplit?: boolean | RegExp }} [opts]
 */
function strCol(key, label, opts = {}) {
  /** @type {{ key: string, label: string, default?: boolean, get: (c: object) => string, set?: (c: object, v: string) => object, filterSplit?: boolean | RegExp }} */
  const col = {
    key,
    label,
    default: opts.default !== false,
    get: opts.get || ((c) => String(c[key] ?? '')),
  };
  if (Object.prototype.hasOwnProperty.call(opts, 'set')) {
    if (opts.set) col.set = opts.set;
  } else {
    col.set = (_c, v) => ({ [key]: v });
  }
  if (opts.filterSplit) col.filterSplit = opts.filterSplit;
  return col;
}

/**
 * @param {string} channelKey
 * @param {string} label
 * @param {{ default?: boolean }} [opts]
 */
function channelCol(channelKey, label, opts = {}) {
  /** @type {{ key: string, label: string, default?: boolean, get: (c: object) => string, set: (c: object, v: string) => object, filterSplit?: boolean | RegExp }} */
  const col = {
    key: `ch_${channelKey}`,
    label,
    default: opts.default === true,
    get: (c) => {
      if (channelKey === 'urls') return listJoin(c.channels?.urls, '\n');
      return String(c.channels?.[channelKey] ?? '');
    },
    set: (_c, v) => {
      if (channelKey === 'urls') {
        return { channels: { urls: listSplit(v, /\n+/) } };
      }
      return { channels: { [channelKey]: v } };
    },
  };
  if (channelKey === 'urls') col.filterSplit = /\n+/;
  return col;
}

/** @type {{ key: string, label: string, default?: boolean, get: (c: object) => string, set?: (c: object, v: string) => object, filterSplit?: boolean | RegExp }[]} */
const COLUMNS = [
  strCol('displayName', 'Name', { default: true }),
  strCol('nickname', 'Nickname', { default: true }),
  strCol('memoryJog', 'Memory jog', { default: true }),
  {
    key: 'aliases',
    label: 'Aliases',
    default: false,
    get: (c) => listJoin(c.aliases),
    set: (_c, v) => ({ aliases: listSplit(v) }),
    filterSplit: true,
  },
  {
    key: 'kinds',
    label: 'Type',
    default: true,
    get: (c) => (Array.isArray(c.kinds) && c.kinds.length ? c.kinds.join(', ') : 'friend'),
    set: (_c, v) => ({
      kinds: listSplit(v)
        .map((s) => s.toLowerCase())
        .filter((k) => k === 'friend' || k === 'organizer' || k === 'business'),
    }),
    filterSplit: true,
  },
  strCol('networkCircles', 'Scene', { default: true, filterSplit: true }),
  strCol('location', 'Location', { default: true }),
  strCol('region', 'Region', { default: false }),
  strCol('rating', 'Status', { default: true }),
  {
    key: 'sensitivity',
    label: 'Sensitivity',
    default: true,
    get: (c) => c.sensitivity || '',
    set: (_c, v) => ({ sensitivity: v }),
  },
  {
    key: 'relationshipStatus',
    label: 'Relationship',
    default: false,
    get: (c) => c.relationshipStatus || '',
    set: (_c, v) => ({ relationshipStatus: v }),
  },
  strCol('nextStep', 'Next step', { default: true }),
  strCol('lastContactAt', 'Last contact', { default: true }),
  strCol('lastContactChannel', 'Last contact via', { default: false }),
  strCol('lastContactPrecision', 'Last contact precision', {
    default: false,
    set: (_c, v) => ({ lastContactPrecision: v }),
  }),
  strCol('org', 'Organization', { default: true }),
  strCol('title', 'Role', { default: false }),
  strCol('department', 'Department', { default: false }),
  strCol('bio', 'Bio', { default: false }),
  strCol('summary', 'Summary', { default: false }),
  strCol('notes', 'Notes', { default: false }),
  strCol('howWeMet', 'How we met', { default: false }),
  {
    key: 'alignedActivities',
    label: 'Aligned activities',
    default: false,
    get: (c) => listJoin(c.alignedActivities, '\n'),
    set: (_c, v) => ({ alignedActivities: listSplit(v, /\n+/) }),
    filterSplit: /\n+/,
  },
  {
    key: 'preferredContactMethods',
    label: 'Preferred methods',
    default: false,
    get: (c) => listJoin(c.preferredContactMethods),
    set: (_c, v) => ({
      preferredContactMethods: listSplit(v)
        .map((s) => s.toLowerCase().replace(/\s+/g, '_'))
        .filter(Boolean),
    }),
    filterSplit: true,
  },
  channelCol('email', 'Email'),
  channelCol('phone', 'Phone'),
  channelCol('sms', 'SMS'),
  channelCol('signal', 'Signal'),
  channelCol('whatsapp', 'WhatsApp'),
  channelCol('linkedin', 'LinkedIn'),
  channelCol('other', 'Other contact'),
  channelCol('urls', 'URLs'),
  strCol('avatarUrl', 'Avatar URL', {
    default: false,
    set: (_c, v) => ({ avatarUrl: v || null }),
  }),
  strCol('source', 'Source', { default: false }),
  strCol('createdAt', 'Created', { default: false, set: undefined }),
  strCol('updatedAt', 'Updated', { default: false, set: undefined }),
  strCol('id', 'ID', { default: false, set: undefined }),
  strCol('orgId', 'Org ID', { default: false, set: undefined }),
  {
    key: 'enrichmentSources',
    label: 'Enrichment sources',
    default: false,
    get: (c) => listJoin(c.enrichment?.sources, '\n'),
    filterSplit: /\n+/,
  },
  {
    key: 'enrichmentSummary',
    label: 'Enrichment summary',
    default: false,
    get: (c) => String(c.enrichment?.rawSummary ?? ''),
  },
  {
    key: 'enrichmentConfidence',
    label: 'Enrichment confidence',
    default: false,
    get: (c) =>
      typeof c.enrichment?.confidence === 'number'
        ? String(Math.round(c.enrichment.confidence * 100))
        : '',
  },
  {
    key: 'enrichedAt',
    label: 'Enriched at',
    default: false,
    get: (c) => String(c.enrichment?.enrichedAt ?? ''),
  },
];

function loadVisibleKeys() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const known = new Set(COLUMNS.map((c) => c.key));
        const keys = parsed.map(String).filter((k) => known.has(k));
        if (keys.length) return keys;
      }
    }
  } catch {
    /* ignore */
  }
  return COLUMNS.filter((c) => c.default !== false).map((c) => c.key);
}

/**
 * @param {string} raw
 */
function valueKey(raw) {
  const s = String(raw ?? '');
  return s === '' ? BLANK_LABEL : s;
}

/**
 * Filter-by-values keys for a cell. Multi-value columns (e.g. Scene) split
 * comma-separated cells into separate checkbox options.
 * @param {{ filterSplit?: boolean | RegExp }} col
 * @param {string} cell
 * @returns {string[]}
 */
function filterKeysForCell(col, cell) {
  if (!col?.filterSplit) return [valueKey(cell)];
  const sep = col.filterSplit === true ? /[,;|/]+/ : col.filterSplit;
  const parts = listSplit(cell, sep);
  if (!parts.length) return [BLANK_LABEL];
  return parts;
}

/**
 * @param {string} cell
 * @param {{ op: string, value: string, value2?: string }} condition
 */
function matchesCondition(cell, condition) {
  const op = condition?.op || 'none';
  if (op === 'none') return true;
  const text = String(cell ?? '');
  const needle = String(condition.value ?? '');
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  switch (op) {
    case 'empty':
      return text.trim() === '';
    case 'not_empty':
      return text.trim() !== '';
    case 'text_contains':
      return n ? lower.includes(n) : true;
    case 'text_not_contains':
      return n ? !lower.includes(n) : true;
    case 'text_eq':
      return lower === n;
    case 'text_ne':
      return lower !== n;
    case 'text_starts':
      return n ? lower.startsWith(n) : true;
    case 'text_ends':
      return n ? lower.endsWith(n) : true;
    default:
      return true;
  }
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   getContacts: () => object[],
 *   getSelectedIds: () => Set<string>,
 *   setSelectedIds: (ids: Set<string>) => void,
 *   onSelectContact: (id: string) => void,
 *   onContactsUpdated: (contacts: object[]) => void,
 *   showStatus: (msg: string, isErr?: boolean) => void,
 * }} opts
 */
export function mountNetworkManageTable(root, opts) {
  root.replaceChildren();
  root.classList.add('network-manage');

  /** @type {string[]} */
  let visibleKeys = loadVisibleKeys();

  /** @type {Map<string, { condition: { op: string, value: string }, values: Set<string> | null }>} */
  const filters = new Map();

  /** @type {{ key: string, dir: 'asc' | 'desc' } | null} */
  let sort = null;

  /** @type {{ colKey: string, rows: Set<number>, anchor: number, focus: number } | null} */
  let cellSel = null;

  /** @type {{ colKey: string, startRow: number, endRow: number, value: string } | null} */
  let fillDrag = null;

  /** @type {{ colKey: string, startRow: number } | null} */
  let selectDrag = null;

  /** @type {{ colKey: string, label: string, entries: { id: string, value: string }[] } | null} */
  let lastBulkUndo = null;

  /** @type {object[]} */
  let viewRows = [];

  const bar = document.createElement('div');
  bar.className = 'network-manage__bar';

  const colsBtn = document.createElement('button');
  colsBtn.type = 'button';
  colsBtn.className = 'network-crm__btn network-crm__btn--tiny';
  colsBtn.textContent = 'Columns';
  colsBtn.title = 'Show or hide column picker';
  colsBtn.setAttribute('aria-expanded', 'false');
  colsBtn.setAttribute('aria-controls', 'network-manage-cols');

  const colsPanel = document.createElement('div');
  colsPanel.className = 'network-manage__cols';
  colsPanel.id = 'network-manage-cols';
  colsPanel.hidden = true;
  colsPanel.setAttribute('role', 'group');
  colsPanel.setAttribute('aria-label', 'Visible columns');

  for (const col of COLUMNS) {
    const lab = document.createElement('label');
    lab.className = 'network-manage__col-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = visibleKeys.includes(col.key);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!visibleKeys.includes(col.key)) visibleKeys = [...visibleKeys, col.key];
      } else {
        visibleKeys = visibleKeys.filter((k) => k !== col.key);
        if (!visibleKeys.length) visibleKeys = ['displayName'];
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleKeys));
      } catch {
        /* ignore */
      }
      render();
    });
    lab.append(cb, document.createTextNode(` ${col.label}`));
    colsPanel.append(lab);
  }

  function setColsPanelOpen(open) {
    colsPanel.hidden = !open;
    colsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  colsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFilterMenu();
    closeContextMenu();
    closeFillEditor();
    setColsPanelOpen(colsPanel.hidden);
  });

  const clearFiltersBtn = document.createElement('button');
  clearFiltersBtn.type = 'button';
  clearFiltersBtn.className = 'network-crm__btn network-crm__btn--tiny';
  clearFiltersBtn.textContent = 'Clear filters';
  clearFiltersBtn.hidden = true;
  clearFiltersBtn.addEventListener('click', () => {
    filters.clear();
    sort = null;
    cellSel = null;
    render();
  });

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'network-crm__btn network-crm__btn--tiny';
  undoBtn.textContent = 'Undo fill';
  undoBtn.disabled = true;
  undoBtn.title = 'Undo the last bulk fill / clear';
  undoBtn.addEventListener('click', () => {
    void undoLastBulk();
  });

  function syncUndoBtn() {
    const n = lastBulkUndo?.entries?.length || 0;
    undoBtn.disabled = n === 0;
    undoBtn.textContent = n ? `Undo fill (${n})` : 'Undo fill';
    undoBtn.title = n
      ? `Restore previous ${lastBulkUndo.label} on ${n} contact${n === 1 ? '' : 's'}`
      : 'Undo the last bulk fill / clear';
  }

  const fillHint = document.createElement('p');
  fillHint.className = 'muted network-manage__hint';
  fillHint.textContent =
    'Filter via header funnel. Click-drag or Shift/Ctrl+click to select in one column; arrows move (Shift/Ctrl ↑↓ extend/add). Double-click to fill.';

  bar.append(colsBtn, clearFiltersBtn, undoBtn, colsPanel, fillHint);

  const scroller = document.createElement('div');
  scroller.className = 'network-manage__scroll';
  const table = document.createElement('table');
  table.className = 'network-manage__table';
  scroller.append(table);
  root.append(bar, scroller);

  const filterMenu = document.createElement('div');
  filterMenu.className = 'network-manage__filter-menu';
  filterMenu.hidden = true;
  filterMenu.setAttribute('role', 'dialog');
  filterMenu.setAttribute('aria-label', 'Column filter');
  root.append(filterMenu);

  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'network-manage__ctx';
  ctxMenu.hidden = true;
  ctxMenu.setAttribute('role', 'menu');
  root.append(ctxMenu);

  const fillEditor = document.createElement('div');
  fillEditor.className = 'network-manage__fill-editor';
  fillEditor.hidden = true;
  fillEditor.setAttribute('role', 'dialog');
  fillEditor.setAttribute('aria-label', 'Fill selected cells');
  root.append(fillEditor);

  function visibleCols() {
    const order = new Map(COLUMNS.map((c, i) => [c.key, i]));
    return visibleKeys
      .map((k) => COLUMNS.find((c) => c.key === k))
      .filter(Boolean)
      .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  }

  function colByKey(key) {
    return COLUMNS.find((c) => c.key === key) || null;
  }

  function filterIsActive(key) {
    const f = filters.get(key);
    if (!f) return false;
    if (f.condition?.op && f.condition.op !== 'none') return true;
    return f.values instanceof Set;
  }

  function anyFilterOrSort() {
    if (sort) return true;
    for (const key of filters.keys()) {
      if (filterIsActive(key)) return true;
    }
    return false;
  }

  /**
   * @param {object} contact
   * @param {string} [skipKey]
   */
  function contactPassesFilters(contact, skipKey) {
    for (const [key, f] of filters) {
      if (key === skipKey) continue;
      if (!filterIsActive(key)) continue;
      const col = colByKey(key);
      if (!col) continue;
      const cell = col.get(contact);
      if (f.condition?.op && f.condition.op !== 'none' && !matchesCondition(cell, f.condition)) {
        return false;
      }
      if (f.values instanceof Set) {
        const keys = filterKeysForCell(col, cell);
        if (!keys.some((k) => f.values.has(k))) return false;
      }
    }
    return true;
  }

  function buildViewRows() {
    let rows = opts.getContacts().filter((c) => contactPassesFilters(c));
    if (sort) {
      const col = colByKey(sort.key);
      if (col) {
        const dir = sort.dir === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const av = col.get(a).toLowerCase();
          const bv = col.get(b).toLowerCase();
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
      }
    }
    viewRows = rows;
    return rows;
  }

  function contactAt(rowIdx) {
    return viewRows[rowIdx] || null;
  }

  /**
   * @returns {{
   *   colKey: string,
   *   rows: number[],
   *   lo: number,
   *   hi: number,
   *   count: number,
   *   anchor: number,
   *   focus: number,
   *   contiguous: boolean,
   * } | null}
   */
  function selectionInfo() {
    if (!cellSel?.rows?.size) return null;
    const rows = [...cellSel.rows].sort((a, b) => a - b);
    const lo = rows[0];
    const hi = rows[rows.length - 1];
    return {
      colKey: cellSel.colKey,
      rows,
      lo,
      hi,
      count: rows.length,
      anchor: cellSel.anchor,
      focus: cellSel.focus,
      contiguous: hi - lo + 1 === rows.length,
    };
  }

  /** @deprecated use selectionInfo — kept as thin alias for lo/hi callers during transition */
  function selectionBounds() {
    const info = selectionInfo();
    if (!info) return null;
    return { colKey: info.colKey, lo: info.lo, hi: info.hi };
  }

  /**
   * @param {string} colKey
   * @param {Iterable<number>} rows
   * @param {number} anchor
   * @param {number} focus
   */
  function setCellSelection(colKey, rows, anchor, focus) {
    const next = new Set();
    const max = viewRows.length - 1;
    for (const r of rows) {
      const n = Number(r);
      if (Number.isInteger(n) && n >= 0 && n <= max) next.add(n);
    }
    if (!next.size || max < 0) {
      cellSel = null;
      paintSelection();
      return;
    }
    cellSel = {
      colKey,
      rows: next,
      anchor: Math.max(0, Math.min(anchor, max)),
      focus: Math.max(0, Math.min(focus, max)),
    };
    paintSelection();
  }

  /**
   * @param {string} colKey
   * @param {number} rowIdx
   */
  function selectSingleCell(colKey, rowIdx) {
    setCellSelection(colKey, [rowIdx], rowIdx, rowIdx);
  }

  /**
   * @param {string} colKey
   * @param {number} from
   * @param {number} to
   */
  function selectRowRange(colKey, from, to) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    /** @type {number[]} */
    const rows = [];
    for (let i = lo; i <= hi; i += 1) rows.push(i);
    setCellSelection(colKey, rows, from, to);
  }

  /**
   * @param {string} colKey
   * @param {number} rowIdx
   */
  function toggleCellInSelection(colKey, rowIdx) {
    if (!cellSel || cellSel.colKey !== colKey) {
      selectSingleCell(colKey, rowIdx);
      return;
    }
    const next = new Set(cellSel.rows);
    if (next.has(rowIdx)) next.delete(rowIdx);
    else next.add(rowIdx);
    if (!next.size) {
      cellSel = null;
      paintSelection();
      return;
    }
    setCellSelection(colKey, next, rowIdx, rowIdx);
  }

  /**
   * @param {string} colKey
   * @param {number} rowIdx
   */
  function isCellSelected(colKey, rowIdx) {
    return Boolean(cellSel && cellSel.colKey === colKey && cellSel.rows.has(rowIdx));
  }

  function paintSelection() {
    const info = selectionInfo();
    table.querySelectorAll('.network-manage__cell--sel, .network-manage__cell--focus').forEach((el) => {
      el.classList.remove('network-manage__cell--sel', 'network-manage__cell--focus');
    });
    if (!info) return;
    table.querySelectorAll('.network-manage__cell').forEach((el) => {
      const r = Number(el.dataset.rowIdx);
      const k = el.dataset.colKey;
      if (k !== info.colKey) return;
      if (info.rows.includes(r)) el.classList.add('network-manage__cell--sel');
      if (r === info.focus) el.classList.add('network-manage__cell--focus');
    });
  }

  /**
   * @param {string} colKey
   * @param {number} rowIdx
   */
  function scrollCellIntoView(colKey, rowIdx) {
    const el = table.querySelector(
      `.network-manage__cell[data-col-key="${CSS.escape(colKey)}"][data-row-idx="${rowIdx}"]`,
    );
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /**
   * @param {number} delta
   * @param {{ extend?: boolean, add?: boolean }} [opts]
   */
  function moveCellFocus(delta, moveOpts = {}) {
    if (!viewRows.length) return;
    if (!cellSel) {
      const cols = visibleCols();
      if (!cols.length) return;
      selectSingleCell(cols[0].key, 0);
      scrollCellIntoView(cols[0].key, 0);
      return;
    }
    const max = viewRows.length - 1;
    const next = Math.max(0, Math.min(max, cellSel.focus + delta));
    if (moveOpts.extend) {
      selectRowRange(cellSel.colKey, cellSel.anchor, next);
    } else if (moveOpts.add) {
      const rows = new Set(cellSel.rows);
      rows.add(next);
      setCellSelection(cellSel.colKey, rows, cellSel.anchor, next);
    } else {
      selectSingleCell(cellSel.colKey, next);
    }
    if (cellSel) scrollCellIntoView(cellSel.colKey, cellSel.focus);
  }

  /**
   * Move to an adjacent visible column. Always starts a fresh single-cell
   * selection in that column (multi-select never spans columns).
   * @param {number} delta -1 left, +1 right
   */
  function moveCellColumn(delta) {
    if (!viewRows.length) return;
    const cols = visibleCols();
    if (!cols.length) return;
    const row = cellSel ? cellSel.focus : 0;
    const curIdx = cellSel ? cols.findIndex((c) => c.key === cellSel.colKey) : -1;
    const nextIdx =
      curIdx < 0
        ? delta > 0
          ? 0
          : cols.length - 1
        : Math.max(0, Math.min(cols.length - 1, curIdx + delta));
    const nextCol = cols[nextIdx];
    if (!nextCol) return;
    const max = viewRows.length - 1;
    const rowIdx = Math.max(0, Math.min(row, max));
    selectSingleCell(nextCol.key, rowIdx);
    scrollCellIntoView(nextCol.key, rowIdx);
  }

  function clearFillHighlight() {
    table.querySelectorAll('.network-manage__cell--fill').forEach((el) => {
      el.classList.remove('network-manage__cell--fill');
    });
  }

  function closeFilterMenu() {
    filterMenu.hidden = true;
    filterMenu.replaceChildren();
  }

  function closeContextMenu() {
    ctxMenu.hidden = true;
    ctxMenu.replaceChildren();
  }

  function closeFillEditor() {
    fillEditor.hidden = true;
    fillEditor.replaceChildren();
  }

  function canFillColumn(col) {
    return Boolean(col?.set) && !NO_FILL_KEYS.has(col.key);
  }

  /**
   * @param {HTMLElement} el
   * @param {number} clientX
   * @param {number} clientY
   */
  function placeFloating(el, clientX, clientY) {
    el.hidden = false;
    el.style.left = '0px';
    el.style.top = '0px';
    const rootRect = root.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = clientX - rootRect.left;
    let y = clientY - rootRect.top;
    x = Math.max(4, Math.min(x, rootRect.width - w - 4));
    y = Math.max(4, Math.min(y, rootRect.height - h - 4));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  /**
   * @param {string} contactId
   * @param {object} patch
   */
  async function patchContact(contactId, patch) {
    const r = await fetch(`/api/network/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save_failed');
    return j.contact;
  }

  async function applyFill() {
    if (!fillDrag) return;
    const { colKey, startRow, endRow, value } = fillDrag;
    fillDrag = null;
    clearFillHighlight();
    const col = colByKey(colKey);
    if (!canFillColumn(col)) return;
    const lo = Math.min(startRow, endRow);
    const hi = Math.max(startRow, endRow);
    if (hi <= lo) return;
    const targetCount = hi - lo;
    const preview = value.length > 40 ? `${value.slice(0, 37)}…` : value || '(empty)';
    const ok = window.confirm(
      `Copy ${col.label} “${preview}” onto ${targetCount} contact${targetCount === 1 ? '' : 's'} below?\n\nThis overwrites existing values.`,
    );
    if (!ok) {
      opts.showStatus('Fill cancelled');
      return;
    }
    await writeValueToRowIndexes(col, value, Array.from({ length: hi - lo }, (_, i) => lo + 1 + i));
  }

  /**
   * @param {{ key: string, label: string, set?: (c: object, v: string) => object, get?: (c: object) => string, filterSplit?: boolean | RegExp }} col
   * @param {string} value
   * @param {number} lo
   * @param {number} hi
   * @param {'replace' | 'append'} [mode]
   */
  async function writeValueToRows(col, value, lo, hi, mode = 'replace') {
    /** @type {number[]} */
    const rows = [];
    for (let i = lo; i <= hi; i += 1) rows.push(i);
    await writeValueToRowIndexes(col, value, rows, mode);
  }

  /**
   * @param {{ key: string, label: string, set?: (c: object, v: string) => object, get?: (c: object) => string, filterSplit?: boolean | RegExp }} col
   * @param {string} value
   * @param {number[]} rowIndexes
   * @param {'replace' | 'append'} [mode]
   */
  async function writeValueToRowIndexes(col, value, rowIndexes, mode = 'replace') {
    if (!col.set) return;
    const rows = [...new Set(rowIndexes.map(Number))].filter((i) => i >= 0 && i < viewRows.length).sort((a, b) => a - b);
    if (!rows.length) return;
    const fillMode = mode === 'append' && isAppendableColumn(col) ? 'append' : 'replace';
    const count = rows.length;
    const verb = fillMode === 'append' ? 'Appending' : 'Updating';
    opts.showStatus(`${verb} ${col.label} on ${count} contact${count === 1 ? '' : 's'}…`);
    /** @type {{ id: string, value: string }[]} */
    const undoEntries = [];
    /** @type {object[]} */
    const updated = [];
    try {
      for (const i of rows) {
        const c = contactAt(i);
        if (!c) continue;
        const prev = col.get(c);
        undoEntries.push({ id: c.id, value: prev });
        const nextValue =
          fillMode === 'append' ? mergeAppendValue(col, prev, value) : value;
        const patch = col.set({}, nextValue);
        if (col.key === 'kinds' && (!Array.isArray(patch.kinds) || !patch.kinds.length)) {
          patch.kinds = ['friend'];
        }
        const saved = await patchContact(c.id, patch);
        updated.push(saved);
      }
      if (updated.length) {
        lastBulkUndo = {
          colKey: col.key,
          label: col.label,
          entries: undoEntries,
        };
        syncUndoBtn();
        opts.onContactsUpdated(updated);
      }
      const done =
        fillMode === 'append'
          ? `Appended to ${col.label} on ${updated.length} contact${updated.length === 1 ? '' : 's'}`
          : `Updated ${col.label} on ${updated.length} contact${updated.length === 1 ? '' : 's'}`;
      opts.showStatus(done);
    } catch (err) {
      opts.showStatus(String(err?.message || err), true);
    }
    render();
  }

  async function undoLastBulk() {
    if (!lastBulkUndo?.entries?.length) return;
    const snapshot = lastBulkUndo;
    lastBulkUndo = null;
    syncUndoBtn();
    const col = colByKey(snapshot.colKey);
    if (!col?.set) {
      opts.showStatus('Cannot undo — column is no longer editable', true);
      return;
    }
    opts.showStatus(
      `Undoing ${snapshot.label} on ${snapshot.entries.length} contact${snapshot.entries.length === 1 ? '' : 's'}…`,
    );
    /** @type {object[]} */
    const updated = [];
    try {
      for (const entry of snapshot.entries) {
        const patch = col.set({}, entry.value);
        if (col.key === 'kinds' && (!Array.isArray(patch.kinds) || !patch.kinds.length)) {
          patch.kinds = ['friend'];
        }
        const saved = await patchContact(entry.id, patch);
        updated.push(saved);
      }
      if (updated.length) opts.onContactsUpdated(updated);
      opts.showStatus(
        `Restored ${snapshot.label} on ${updated.length} contact${updated.length === 1 ? '' : 's'}`,
      );
    } catch (err) {
      opts.showStatus(String(err?.message || err), true);
    }
    render();
  }

  /**
   * Suggestion list for the fill editor: presets first, then existing column values.
   * @param {string} colKey
   * @returns {string[]}
   */
  function fillSuggestionsForColumn(colKey) {
    const presets = FILL_OPTIONS[colKey] || [];
    const seen = new Set(presets.map((v) => v.toLowerCase()));
    const fromData = [];
    for (const { value } of uniqueValuesForColumn(colKey)) {
      if (value === BLANK_LABEL) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fromData.push(value);
    }
    return [...presets, ...fromData];
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {{ colKey: string, rowIdx: number }} target
   */
  function openFillEditor(clientX, clientY, target) {
    closeFilterMenu();
    closeContextMenu();
    setColsPanelOpen(false);

    const col = colByKey(target.colKey);
    if (!canFillColumn(col)) {
      opts.showStatus('This column cannot be bulk-filled', true);
      return;
    }

    const info = selectionInfo();
    const inSel = info && info.colKey === target.colKey && info.rows.includes(target.rowIdx);
    if (!inSel) {
      selectSingleCell(target.colKey, target.rowIdx);
    }
    const sel = selectionInfo();
    if (!sel) return;

    const count = sel.count;
    const first = contactAt(sel.rows[0]);
    const initial = first ? col.get(first) : '';
    const suggestions = fillSuggestionsForColumn(col.key);
    const hasPresets = Boolean(FILL_OPTIONS[col.key]?.length);
    const appendable = isAppendableColumn(col);
    const selectedRows = [...sel.rows];

    fillEditor.replaceChildren();

    const title = document.createElement('div');
    title.className = 'network-manage__fill-editor-title';
    title.textContent = `Fill ${col.label} · ${count} cell${count === 1 ? '' : 's'}`;

    /** @type {'replace' | 'append'} */
    let fillMode = 'replace';
    /** @type {HTMLElement | null} */
    let modeRow = null;
    if (appendable) {
      modeRow = document.createElement('div');
      modeRow.className = 'network-manage__fill-editor-modes';
      modeRow.setAttribute('role', 'radiogroup');
      modeRow.setAttribute('aria-label', 'Fill mode');

      /**
       * @param {'replace' | 'append'} mode
       * @param {string} label
       * @param {string} hint
       */
      function addMode(mode, label, hint) {
        const lab = document.createElement('label');
        lab.className = 'network-manage__fill-editor-mode';
        lab.title = hint;
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'network-manage-fill-mode';
        radio.value = mode;
        radio.checked = mode === fillMode;
        radio.addEventListener('change', () => {
          if (radio.checked) fillMode = mode;
        });
        lab.append(radio, document.createTextNode(` ${label}`));
        modeRow.append(lab);
      }

      addMode(
        'replace',
        'Replace',
        'Overwrite the whole cell (e.g. friend + business → friend)',
      );
      addMode(
        'append',
        'Append',
        'Add to existing values without removing them (e.g. business → business, friend)',
      );
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'network-manage__fill-editor-input';
    input.value = appendable ? '' : initial;
    input.placeholder = appendable
      ? fillMode === 'append'
        ? `Value(s) to add to ${col.label}`
        : `New value(s) for ${col.label}`
      : `Value for ${col.label}`;
    input.setAttribute('aria-label', `Fill value for ${col.label}`);
    const listId = `network-manage-fill-opts-${col.key}`;
    input.setAttribute('list', listId);

    const datalist = document.createElement('datalist');
    datalist.id = listId;
    for (const opt of suggestions) {
      const o = document.createElement('option');
      o.value = opt;
      datalist.append(o);
    }

    /** @type {HTMLSelectElement | null} */
    let pick = null;
    if (hasPresets || suggestions.length) {
      pick = document.createElement('select');
      pick.className = 'network-manage__fill-editor-pick';
      pick.setAttribute('aria-label', `Pick ${col.label}`);
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = hasPresets ? 'Pick a value…' : 'Existing values…';
      pick.append(placeholder);
      for (const opt of suggestions) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        pick.append(o);
      }
      if (!appendable && initial && suggestions.some((s) => s === initial)) {
        pick.value = initial;
      }
      pick.addEventListener('change', () => {
        if (pick.value) {
          input.value = pick.value;
          input.focus();
          input.select();
        }
      });
    }

    const hint = document.createElement('p');
    hint.className = 'muted network-manage__fill-editor-hint';
    function syncModeHint() {
      if (!appendable) {
        hint.hidden = true;
        return;
      }
      hint.hidden = false;
      hint.textContent =
        fillMode === 'append'
          ? 'Append keeps existing values and adds any that are missing.'
          : 'Replace overwrites the whole cell with what you enter.';
      input.placeholder =
        fillMode === 'append'
          ? `Value(s) to add to ${col.label}`
          : `New value(s) for ${col.label}`;
    }
    if (modeRow) {
      modeRow.addEventListener('change', syncModeHint);
    }
    syncModeHint();

    const actions = document.createElement('div');
    actions.className = 'network-manage__fill-editor-actions';

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__btn--primary';
    applyBtn.textContent = 'Fill';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'network-crm__btn network-crm__btn--tiny';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => closeFillEditor());

    async function commitFill() {
      const value = input.value;
      const mode = fillMode;
      closeFillEditor();
      await writeValueToRowIndexes(col, value, selectedRows, mode);
    }

    applyBtn.addEventListener('click', () => {
      void commitFill();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void commitFill();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFillEditor();
      }
    });

    actions.append(applyBtn, cancelBtn);
    fillEditor.append(title);
    if (modeRow) fillEditor.append(modeRow);
    if (pick) fillEditor.append(pick);
    fillEditor.append(input, datalist, hint, actions);

    placeFloating(fillEditor, clientX, clientY);
    requestAnimationFrame(() => {
      input.focus();
      if (!appendable) input.select();
    });
  }

  /**
   * Unique values for a column among rows matching other filters.
   * @param {string} colKey
   */
  function uniqueValuesForColumn(colKey) {
    const col = colByKey(colKey);
    if (!col) return [];
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const c of opts.getContacts()) {
      if (!contactPassesFilters(c, colKey)) continue;
      for (const key of filterKeysForCell(col, col.get(c))) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => {
        if (a[0] === BLANK_LABEL) return 1;
        if (b[0] === BLANK_LABEL) return -1;
        return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
      })
      .map(([value, count]) => ({ value, count }));
  }

  /**
   * @param {string} colKey
   * @param {DOMRect} anchorRect
   */
  function openFilterMenu(colKey, anchorRect) {
    closeContextMenu();
    closeFillEditor();
    setColsPanelOpen(false);
    const col = colByKey(colKey);
    if (!col) return;
    const existing = filters.get(colKey) || {
      condition: { op: 'none', value: '' },
      values: null,
    };
    const draftCondition = {
      op: existing.condition?.op || 'none',
      value: existing.condition?.value || '',
    };
    const unique = uniqueValuesForColumn(colKey);
    /** @type {Set<string>} */
    const draftValues = new Set(
      existing.values instanceof Set ? [...existing.values] : unique.map((u) => u.value),
    );
    let valuesSearch = '';

    filterMenu.replaceChildren();
    filterMenu.dataset.colKey = colKey;

    const title = document.createElement('div');
    title.className = 'network-manage__filter-title';
    title.textContent = col.label;

    const sortRow = document.createElement('div');
    sortRow.className = 'network-manage__filter-sort';
    const sortAsc = document.createElement('button');
    sortAsc.type = 'button';
    sortAsc.className = 'network-manage__filter-link';
    sortAsc.textContent = 'Sort A → Z';
    sortAsc.addEventListener('click', () => {
      sort = { key: colKey, dir: 'asc' };
      closeFilterMenu();
      render();
    });
    const sortDesc = document.createElement('button');
    sortDesc.type = 'button';
    sortDesc.className = 'network-manage__filter-link';
    sortDesc.textContent = 'Sort Z → A';
    sortDesc.addEventListener('click', () => {
      sort = { key: colKey, dir: 'desc' };
      closeFilterMenu();
      render();
    });
    sortRow.append(sortAsc, sortDesc);

    const condHead = document.createElement('button');
    condHead.type = 'button';
    condHead.className = 'network-manage__filter-section-toggle';
    condHead.textContent = 'Filter by condition';
    const condBody = document.createElement('div');
    condBody.className = 'network-manage__filter-section';
    const opSel = document.createElement('select');
    opSel.className = 'network-crm__input network-manage__filter-op';
    for (const op of FILTER_OPS) {
      const o = document.createElement('option');
      o.value = op.id;
      o.textContent = op.label;
      if (op.id === draftCondition.op) o.selected = true;
      opSel.append(o);
    }
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'network-crm__input network-manage__filter-value';
    valueInput.placeholder = 'Value';
    valueInput.value = draftCondition.value;
    function syncCondInputs() {
      const meta = FILTER_OPS.find((o) => o.id === opSel.value);
      valueInput.hidden = !meta?.needsValue;
      draftCondition.op = opSel.value;
      draftCondition.value = valueInput.value;
    }
    opSel.addEventListener('change', syncCondInputs);
    valueInput.addEventListener('input', () => {
      draftCondition.value = valueInput.value;
    });
    syncCondInputs();
    condBody.append(opSel, valueInput);
    let condOpen = draftCondition.op !== 'none';
    condBody.hidden = !condOpen;
    condHead.addEventListener('click', () => {
      condOpen = !condOpen;
      condBody.hidden = !condOpen;
    });

    const valsHead = document.createElement('button');
    valsHead.type = 'button';
    valsHead.className = 'network-manage__filter-section-toggle';
    valsHead.textContent = 'Filter by values';
    const valsBody = document.createElement('div');
    valsBody.className = 'network-manage__filter-section';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'network-crm__input network-manage__filter-search';
    search.placeholder = 'Search values';
    const valActions = document.createElement('div');
    valActions.className = 'network-manage__filter-val-actions';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'network-manage__filter-link';
    selectAllBtn.textContent = 'Select all';
    const clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'network-manage__filter-link';
    clearAllBtn.textContent = 'Clear';
    valActions.append(selectAllBtn, clearAllBtn);
    const list = document.createElement('div');
    list.className = 'network-manage__filter-values';

    function renderValueList() {
      list.replaceChildren();
      const q = valuesSearch.trim().toLowerCase();
      for (const { value, count } of unique) {
        if (q && !value.toLowerCase().includes(q)) continue;
        const lab = document.createElement('label');
        lab.className = 'network-manage__filter-value-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = draftValues.has(value);
        cb.addEventListener('change', () => {
          if (cb.checked) draftValues.add(value);
          else draftValues.delete(value);
        });
        const text = document.createElement('span');
        text.className = 'network-manage__filter-value-label';
        text.textContent = value;
        text.title = value;
        const cnt = document.createElement('span');
        cnt.className = 'muted network-manage__filter-value-count';
        cnt.textContent = String(count);
        lab.append(cb, text, cnt);
        list.append(lab);
      }
      if (!list.childElementCount) {
        const empty = document.createElement('p');
        empty.className = 'muted network-manage__filter-empty';
        empty.textContent = 'No values';
        list.append(empty);
      }
    }

    search.addEventListener('input', () => {
      valuesSearch = search.value;
      renderValueList();
    });
    selectAllBtn.addEventListener('click', () => {
      for (const { value } of unique) {
        if (valuesSearch.trim() && !value.toLowerCase().includes(valuesSearch.trim().toLowerCase())) {
          continue;
        }
        draftValues.add(value);
      }
      renderValueList();
    });
    clearAllBtn.addEventListener('click', () => {
      for (const { value } of unique) {
        if (valuesSearch.trim() && !value.toLowerCase().includes(valuesSearch.trim().toLowerCase())) {
          continue;
        }
        draftValues.delete(value);
      }
      renderValueList();
    });
    renderValueList();
    valsBody.append(search, valActions, list);

    const actions = document.createElement('div');
    actions.className = 'network-manage__filter-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'network-crm__btn network-crm__btn--tiny';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => closeFilterMenu());
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__btn--primary';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => {
      draftCondition.op = opSel.value;
      draftCondition.value = valueInput.value;
      const allSelected =
        unique.length > 0 && unique.every((u) => draftValues.has(u.value));
      const next = {
        condition: { ...draftCondition },
        values: allSelected ? null : new Set(draftValues),
      };
      if (next.condition.op === 'none' && next.values == null) filters.delete(colKey);
      else filters.set(colKey, next);
      cellSel = null;
      closeFilterMenu();
      render();
    });
    actions.append(cancelBtn, okBtn);

    filterMenu.append(title, sortRow, condHead, condBody, valsHead, valsBody, actions);
    const rootRect = root.getBoundingClientRect();
    placeFloating(filterMenu, anchorRect.left, anchorRect.bottom + 4);
    // Prefer aligning under the header icon
    const menuW = filterMenu.offsetWidth;
    let left = anchorRect.right - rootRect.left - menuW;
    left = Math.max(4, Math.min(left, rootRect.width - menuW - 4));
    filterMenu.style.left = `${left}px`;
    filterMenu.style.top = `${Math.max(4, anchorRect.bottom - rootRect.top + 2)}px`;
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {{ colKey: string, rowIdx: number }} target
   */
  function openContextMenu(clientX, clientY, target) {
    closeFilterMenu();
    closeFillEditor();
    setColsPanelOpen(false);
    const col = colByKey(target.colKey);
    if (!col) return;

    // If right-click is outside current selection, select that cell.
    const info = selectionInfo();
    const inSel = info && info.colKey === target.colKey && info.rows.includes(target.rowIdx);
    if (!inSel) {
      selectSingleCell(target.colKey, target.rowIdx);
    }
    const sel = selectionInfo();
    if (!sel) return;
    const count = sel.count;
    const first = contactAt(sel.rows[0]);
    const firstVal = first ? col.get(first) : '';
    const selectedRows = [...sel.rows];

    ctxMenu.replaceChildren();

    /**
     * @param {string} label
     * @param {() => void | Promise<void>} action
     * @param {{ danger?: boolean, disabled?: boolean }} [opts]
     */
    function item(label, action, itemOpts = {}) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'network-manage__ctx-item';
      if (itemOpts.danger) btn.classList.add('network-manage__ctx-item--danger');
      btn.textContent = label;
      btn.disabled = Boolean(itemOpts.disabled);
      btn.setAttribute('role', 'menuitem');
      btn.addEventListener('click', () => {
        closeContextMenu();
        void action();
      });
      ctxMenu.append(btn);
    }

    item(`Copy${count > 1 ? ` (${count})` : ''}`, async () => {
      const lines = [];
      for (const i of selectedRows) {
        const c = contactAt(i);
        lines.push(c ? col.get(c) : '');
      }
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        opts.showStatus(`Copied ${count} cell${count === 1 ? '' : 's'}`);
      } catch {
        opts.showStatus('Clipboard unavailable', true);
      }
    });

    item('Fill…', () => {
      // Defer so the context-menu click does not immediately dismiss the editor.
      queueMicrotask(() => {
        openFillEditor(clientX, clientY, { colKey: col.key, rowIdx: sel.rows[0] });
      });
    }, { disabled: !canFillColumn(col) });

    item('Clear', async () => {
      if (!canFillColumn(col)) {
        opts.showStatus('This column cannot be cleared', true);
        return;
      }
      const ok = window.confirm(`Clear ${col.label} on ${count} cell${count === 1 ? '' : 's'}?`);
      if (!ok) return;
      await writeValueToRowIndexes(col, '', selectedRows);
    }, { disabled: !canFillColumn(col) });

    item('Fill down', async () => {
      if (!canFillColumn(col) || count < 2) {
        opts.showStatus('Need 2+ editable cells in the selection', true);
        return;
      }
      const ok = window.confirm(
        `Fill “${firstVal.length > 40 ? `${firstVal.slice(0, 37)}…` : firstVal || '(empty)'}” onto ${count - 1} other selected cell${count - 1 === 1 ? '' : 's'}?`,
      );
      if (!ok) return;
      await writeValueToRowIndexes(col, firstVal, selectedRows.slice(1));
    }, { disabled: !canFillColumn(col) || count < 2 });

    item('Filter by cell value', () => {
      filters.set(col.key, {
        condition: { op: 'none', value: '' },
        values: new Set(filterKeysForCell(col, firstVal)),
      });
      cellSel = null;
      render();
    });

    item('Clear column filter', () => {
      filters.delete(col.key);
      if (sort?.key === col.key) sort = null;
      render();
    }, { disabled: !filterIsActive(col.key) && sort?.key !== col.key });

    item('Select these contacts', () => {
      const next = new Set(opts.getSelectedIds());
      for (const i of selectedRows) {
        const c = contactAt(i);
        if (c) next.add(c.id);
      }
      opts.setSelectedIds(next);
      render();
    });

    item('Open details', () => {
      if (first) opts.onSelectContact(first.id);
    }, { disabled: !first });

    item('Sort A → Z', () => {
      sort = { key: col.key, dir: 'asc' };
      render();
    });
    item('Sort Z → A', () => {
      sort = { key: col.key, dir: 'desc' };
      render();
    });

    placeFloating(ctxMenu, clientX, clientY);
  }

  function render() {
    closeFilterMenu();
    closeContextMenu();
    closeFillEditor();
    const contacts = buildViewRows();
    const selected = opts.getSelectedIds();
    const cols = visibleCols();
    clearFiltersBtn.hidden = !anyFilterOrSort();
    syncUndoBtn();
    table.replaceChildren();

    // Drop selection if it points past filtered rows.
    if (cellSel) {
      const max = contacts.length - 1;
      if (max < 0) cellSel = null;
      else {
        const rows = new Set([...cellSel.rows].filter((r) => r >= 0 && r <= max));
        if (!rows.size) cellSel = null;
        else {
          cellSel = {
            colKey: cellSel.colKey,
            rows,
            anchor: Math.max(0, Math.min(cellSel.anchor, max)),
            focus: Math.max(0, Math.min(cellSel.focus, max)),
          };
        }
      }
    }

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const thCheck = document.createElement('th');
    thCheck.className = 'network-manage__th network-manage__th--check';
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.title = 'Select all visible';
    selectAll.checked = contacts.length > 0 && contacts.every((c) => selected.has(c.id));
    selectAll.indeterminate =
      contacts.some((c) => selected.has(c.id)) && !contacts.every((c) => selected.has(c.id));
    selectAll.addEventListener('change', () => {
      const next = new Set(selected);
      if (selectAll.checked) contacts.forEach((c) => next.add(c.id));
      else contacts.forEach((c) => next.delete(c.id));
      opts.setSelectedIds(next);
      render();
    });
    thCheck.append(selectAll);
    hr.append(thCheck);

    for (const col of cols) {
      const th = document.createElement('th');
      th.className = 'network-manage__th';
      if (filterIsActive(col.key) || sort?.key === col.key) {
        th.classList.add('network-manage__th--filtered');
      }
      const head = document.createElement('div');
      head.className = 'network-manage__th-inner';
      const label = document.createElement('span');
      label.className = 'network-manage__th-label';
      label.textContent = col.label;
      if (sort?.key === col.key) {
        label.textContent = `${col.label} ${sort.dir === 'asc' ? '↑' : '↓'}`;
      }
      const filterBtn = document.createElement('button');
      filterBtn.type = 'button';
      filterBtn.className = 'network-manage__filter-btn';
      if (filterIsActive(col.key)) filterBtn.classList.add('network-manage__filter-btn--on');
      filterBtn.title = `Filter ${col.label}`;
      filterBtn.setAttribute('aria-label', `Filter ${col.label}`);
      filterBtn.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M2 3h12l-4.5 5.2V13l-3 1.5V8.2L2 3z"/></svg>';
      filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!filterMenu.hidden && filterMenu.dataset.colKey === col.key) {
          closeFilterMenu();
          return;
        }
        openFilterMenu(col.key, filterBtn.getBoundingClientRect());
      });
      head.append(label, filterBtn);
      th.append(head);
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = document.createElement('tbody');
    if (!contacts.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = cols.length + 1;
      td.className = 'muted network-manage__empty';
      td.textContent = anyFilterOrSort() ? 'No people match these filters' : 'No people match';
      tr.append(td);
      tbody.append(tr);
    } else {
      contacts.forEach((c, rowIdx) => {
        const tr = document.createElement('tr');
        tr.className = 'network-manage__row';
        tr.dataset.contactId = c.id;
        tr.dataset.rowIdx = String(rowIdx);
        tr.title = 'Double-click a fillable cell to bulk-fill · double-click Name for details · right-click for actions';
        tr.addEventListener('dblclick', (e) => {
          if (
            e.target instanceof HTMLElement &&
            e.target.closest(
              'input, .network-manage__fill-handle, .network-manage__filter-btn, .network-manage__fill-editor',
            )
          ) {
            return;
          }
          const cell = e.target instanceof HTMLElement ? e.target.closest('.network-manage__cell') : null;
          if (cell instanceof HTMLElement) {
            const colKey = cell.dataset.colKey;
            const col = colKey ? colByKey(colKey) : null;
            if (canFillColumn(col)) {
              // Handled on the cell itself.
              return;
            }
          }
          opts.onSelectContact(c.id);
        });

        const tdCheck = document.createElement('td');
        tdCheck.className = 'network-manage__td network-manage__td--check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'network-crm__select';
        cb.checked = selected.has(c.id);
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => {
          const next = new Set(opts.getSelectedIds());
          if (cb.checked) next.add(c.id);
          else next.delete(c.id);
          opts.setSelectedIds(next);
          render();
        });
        tdCheck.append(cb);
        tr.append(tdCheck);

        for (const col of cols) {
          const td = document.createElement('td');
          td.className = 'network-manage__td network-manage__cell';
          td.dataset.colKey = col.key;
          td.dataset.rowIdx = String(rowIdx);
          const val = col.get(c);
          if (col.key === 'displayName') {
            const name = document.createElement('span');
            name.className = 'network-manage__name';
            name.textContent = val || 'Untitled';
            td.append(name);
          } else {
            td.textContent = val;
            td.title = val;
          }

          const canFill = canFillColumn(col);
          if (canFill) {
            td.classList.add('network-manage__cell--fillable');
            td.title = val
              ? `${val}\nDouble-click to fill selection`
              : 'Double-click to fill selection';
            const handle = document.createElement('span');
            handle.className = 'network-manage__fill-handle';
            handle.title = `Drag to copy ${col.label} onto rows below`;
            handle.setAttribute('aria-label', `Fill ${col.label} down`);
            handle.addEventListener('mousedown', (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              selectDrag = null;
              fillDrag = {
                colKey: col.key,
                startRow: rowIdx,
                endRow: rowIdx,
                value: col.get(c),
              };
              td.classList.add('network-manage__cell--fill');
            });
            td.append(handle);
          }

          td.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target instanceof HTMLElement && e.target.closest('.network-manage__fill-handle, input')) {
              return;
            }
            e.preventDefault();
            closeFilterMenu();
            closeContextMenu();
            closeFillEditor();
            fillDrag = null;

            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl) {
              selectDrag = null;
              toggleCellInSelection(col.key, rowIdx);
              return;
            }
            if (e.shiftKey && cellSel && cellSel.colKey === col.key) {
              selectDrag = null;
              selectRowRange(col.key, cellSel.anchor, rowIdx);
              return;
            }

            // Keep a multi-cell selection when clicking inside it so double-click
            // can open the fill editor without collapsing the range.
            if (isCellSelected(col.key, rowIdx) && (selectionInfo()?.count || 0) > 1) {
              selectDrag = null;
              // Move focus to the clicked cell within the selection.
              cellSel = { ...cellSel, focus: rowIdx };
              paintSelection();
              return;
            }

            selectDrag = { colKey: col.key, startRow: rowIdx };
            selectSingleCell(col.key, rowIdx);
          });

          td.addEventListener('mouseenter', () => {
            if (fillDrag && fillDrag.colKey === col.key) {
              fillDrag.endRow = rowIdx;
              const lo = Math.min(fillDrag.startRow, fillDrag.endRow);
              const hi = Math.max(fillDrag.startRow, fillDrag.endRow);
              table.querySelectorAll('.network-manage__cell').forEach((el) => {
                const r = Number(el.dataset.rowIdx);
                const k = el.dataset.colKey;
                el.classList.toggle(
                  'network-manage__cell--fill',
                  k === fillDrag.colKey && r >= lo && r <= hi,
                );
              });
              return;
            }
            if (selectDrag && selectDrag.colKey === col.key) {
              selectRowRange(selectDrag.colKey, selectDrag.startRow, rowIdx);
            }
          });

          td.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, { colKey: col.key, rowIdx });
          });

          if (canFill) {
            td.addEventListener('dblclick', (e) => {
              e.preventDefault();
              e.stopPropagation();
              openFillEditor(e.clientX, e.clientY, { colKey: col.key, rowIdx });
            });
          }

          tr.append(td);
        }
        tbody.append(tr);
      });
    }
    table.append(tbody);
    paintSelection();
  }

  window.addEventListener('mouseup', () => {
    if (fillDrag) void applyFill();
    selectDrag = null;
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (!colsPanel.hidden && !colsPanel.contains(t) && !colsBtn.contains(t)) {
      setColsPanelOpen(false);
    }
    if (!filterMenu.hidden && !filterMenu.contains(t)) {
      const filterBtn = t instanceof Element ? t.closest('.network-manage__filter-btn') : null;
      if (!filterBtn) closeFilterMenu();
    }
    if (!ctxMenu.hidden && !ctxMenu.contains(t)) closeContextMenu();
    if (!fillEditor.hidden && !fillEditor.contains(t)) closeFillEditor();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!fillEditor.hidden) {
        closeFillEditor();
        return;
      }
      closeFilterMenu();
      closeContextMenu();
      setColsPanelOpen(false);
      if (cellSel) {
        cellSel = null;
        paintSelection();
      }
      return;
    }

    const typingTarget =
      e.target instanceof HTMLElement &&
      (e.target.closest('input, textarea, select, [contenteditable="true"]') ||
        e.target.isContentEditable);
    if (typingTarget) return;
    if (!root.isConnected) return;
    if (!cellSel && !(e.target instanceof Node && root.contains(e.target))) return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      if (e.shiftKey) moveCellFocus(delta, { extend: true });
      else if (e.ctrlKey || e.metaKey) moveCellFocus(delta, { add: true });
      else moveCellFocus(delta);
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      // Changing columns always drops multi-select — one column only.
      moveCellColumn(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  syncUndoBtn();

  return {
    render,
    destroy() {
      root.replaceChildren();
      root.classList.remove('network-manage');
    },
  };
}
