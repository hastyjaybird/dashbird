import { collectSceneOptions, joinSceneTokens } from '../lib/network-scenes.js';
import { formatContactBirthday } from '../lib/network-birthday.js';
import { NETWORK_LABELS } from '../lib/network-labels.js';

/**
 * Manage contacts — spreadsheet table with column filters, cell selection,
 * context menu, and drag-fill (corner handle / Fill…).
 *
 * Filter UX mirrors Google Sheets: funnel icon on each header → sort,
 * filter-by-condition, filter-by-values (checkboxes), OK/Cancel.
 *
 * Double-click (or Enter/F2) an editable cell to change its value. Pick-list
 * columns open a dropdown (or multi-select). Drag column headers to reorder;
 * which columns are shown (and their order) persist in localStorage across
 * browser sessions. Ctrl/Cmd+C/V copies and pastes within the same column.
 * Right-click → Open details / Fill… (or drag the corner handle) for bulk fill.
 * Toolbar Undo restores the previous values.
 */

const STORAGE_KEY = 'dashbird-network-manage-columns-v3';
/** Manage column filters + sort — localStorage so they survive browser restarts. */
const FILTER_SORT_KEY = 'dashbird-network-manage-filters-v1';

/** Preferred adjacent order for the birthday / status attribute cluster. */
const ATTR_CLUSTER_KEYS = [
  'memoryJog',
  'location',
  'birthday',
  'relationshipStatus',
  'rating',
  'sensitivity',
];

/**
 * Keep the attribute cluster consecutive in the requested order.
 * @param {string[]} keys
 */
function applyAttrClusterOrder(keys) {
  const want = ATTR_CLUSTER_KEYS.filter((k) => keys.includes(k));
  if (want.length < 2) return keys;
  const first = Math.min(...want.map((k) => keys.indexOf(k)));
  const rest = keys.filter((k) => !ATTR_CLUSTER_KEYS.includes(k));
  rest.splice(Math.min(first, rest.length), 0, ...want);
  return rest;
}

/** Columns that must not be bulk-copied via drag-fill / clear / fill-down. */
const NO_FILL_KEYS = new Set(['displayName', 'id', 'createdAt', 'updatedAt', 'orgId', 'avatarUrl']);

/** Known pick-list values for columns that use a fixed vocabulary. */
const FILL_OPTIONS = {
  kinds: ['friend', 'organizer', 'business', 'family'],
  hasKids: ['Yes', 'No'],
  hasTask: ['Yes', 'No'],
  rating: ['Fan', 'Hot', 'Warm', 'Cold'],
  sensitivity: ['Down', 'Situational', 'Proper'],
  relationshipStatus: [
    'Lead',
    'Acquaintance',
    'Cultivating',
    'Inner Circle',
    'Collaborator',
    'Meta',
    'Family',
    'Paused',
    'Former',
  ],
  preferredContactMethods: ['phone', 'office_phone', 'email', 'signal', 'whatsapp', 'messenger', 'linkedin', 'other'],
};

/**
 * Resolve pick-list presets, preferring live options from the parent (API-backed).
 * @param {{ key: string } | null | undefined} col
 * @param {object} opts
 * @param {object[]} [contacts]
 */
function resolveFillOptions(col, opts, contacts = []) {
  if (!col) return null;
  if (col.key === 'networkCircles') {
    const sceneOpts = collectSceneOptions(contacts);
    return sceneOpts.length ? sceneOpts : [];
  }
  if (col.key === 'relationshipStatus' && typeof opts.getRelationshipStatuses === 'function') {
    const live = opts.getRelationshipStatuses();
    if (Array.isArray(live) && live.length) return live;
  }
  if (col.key === 'preferredContactMethods' && typeof opts.getPreferredContactMethods === 'function') {
    const live = opts.getPreferredContactMethods();
    if (Array.isArray(live) && live.length) return live;
  }
  const fixed = FILL_OPTIONS[col.key];
  return Array.isArray(fixed) && fixed.length ? fixed : null;
}

/** Yes/No columns that store blank for No. */
const YES_NO_KEYS = new Set(['hasKids', 'hasTask']);

/** Pick-list columns that allow choosing more than one value. */
const MULTI_SELECT_KEYS = new Set(['kinds', 'preferredContactMethods', 'networkCircles']);

const KIND_VALUES = new Set(['friend', 'organizer', 'business', 'family']);

/**
 * @param {string} colKey
 * @param {string} value
 */
function pickOptionLabel(colKey, value) {
  if (colKey === 'kinds') {
    return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
  }
  if (colKey === 'preferredContactMethods') {
    return String(value || '')
      .split('_')
      .filter(Boolean)
      .map((p) => `${p[0].toUpperCase()}${p.slice(1)}`)
      .join(' ');
  }
  return value;
}

/**
 * @param {{ key: string } | null | undefined} col
 * @param {object} [liveOpts]
 * @param {object[]} [contacts]
 */
function pickOptionsForCol(col, liveOpts = {}, contacts = []) {
  return resolveFillOptions(col, liveOpts, contacts);
}

/**
 * @param {{ key: string } | null | undefined} col
 * @param {object} [liveOpts]
 */
function isPickListCol(col, liveOpts = {}) {
  if (!col) return false;
  if (col.key === 'networkCircles') return true;
  return Boolean(resolveFillOptions(col, liveOpts)?.length);
}

/**
 * @param {{ key: string } | null | undefined} col
 */
function isMultiSelectCol(col) {
  return Boolean(col && MULTI_SELECT_KEYS.has(col.key));
}

const BLANK_LABEL = '(Blanks)';

/** @type {{ id: string, label: string, needsValue?: boolean }[]} */
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
  strCol('location', 'Location', { default: true }),
  {
    key: 'birthday',
    label: 'Birthday',
    default: true,
    get: (c) => formatContactBirthday(c),
    set: (_c, v) => ({ birthday: String(v || '').trim() }),
  },
  {
    key: 'relationshipStatus',
    label: 'Relationship',
    default: true,
    get: (c) => c.relationshipStatus || '',
    set: (_c, v) => ({ relationshipStatus: v }),
  },
  strCol('rating', 'Status', { default: true }),
  {
    key: 'sensitivity',
    label: 'Sensitivity',
    default: true,
    get: (c) => c.sensitivity || '',
    set: (_c, v) => ({ sensitivity: v }),
  },
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
        .filter((k) => k === 'friend' || k === 'organizer' || k === 'business' || k === 'family'),
    }),
    filterSplit: true,
  },
  {
    key: 'hasKids',
    label: 'Have kids',
    default: true,
    get: (c) => (c.hasKids ? 'Yes' : ''),
    set: (_c, v) => {
      const s = String(v || '').trim().toLowerCase();
      if (!s || s === 'no' || s === 'false' || s === '0' || s === 'n') return { hasKids: false };
      if (s === 'yes' || s === 'true' || s === '1' || s === 'y' || s === 'kids') return { hasKids: true };
      return { hasKids: Boolean(s) };
    },
  },
  strCol('networkCircles', 'Scene', { default: true, filterSplit: true }),
  strCol('address', 'Address', { default: false }),
  {
    key: 'hasTask',
    label: 'Has task',
    default: true,
    get: (c) => {
      const open = Array.isArray(c.tasks)
        ? c.tasks.some((t) => t && !t.done && String(t.text || '').trim())
        : Boolean(String(c.nextStep || '').trim());
      return open ? 'Yes' : '';
    },
    set: (c, v) => {
      const s = String(v || '').trim().toLowerCase();
      const want =
        s === 'yes' || s === 'true' || s === '1' || s === 'y' || s === 'task' || s === 'tasks';
      const existing = Array.isArray(c.tasks)
        ? c.tasks.map((t) => ({
            id: String(t?.id || ''),
            text: String(t?.text || '').trim(),
            done: Boolean(t?.done),
          })).filter((t) => t.text)
        : String(c.nextStep || '')
            .split(/\n+|;/)
            .map((text) => text.trim())
            .filter(Boolean)
            .map((text, i) => ({ id: `task_${i + 1}`, text, done: false }));
      if (want) {
        if (existing.some((t) => !t.done)) return { tasks: existing };
        return {
          tasks: [
            ...existing,
            {
              id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              text: 'Follow up',
              done: false,
            },
          ],
        };
      }
      return { tasks: existing.map((t) => ({ ...t, done: true })) };
    },
  },
  strCol('lastContactAt', 'Last contact', { default: true }),
  strCol('lastContactChannel', 'Last contact via', { default: false }),
  strCol('lastContactPrecision', 'Last contact precision', {
    default: false,
    set: (_c, v) => ({ lastContactPrecision: v }),
  }),
  strCol('org', 'Organization', { default: true }),
  strCol('title', 'Role', { default: false }),
  strCol('department', 'Department', { default: false }),
  {
    key: 'alignedActivities',
    label: NETWORK_LABELS.activities,
    default: false,
    get: (c) => listJoin(c.alignedActivities, '\n'),
    set: (_c, v) => ({ alignedActivities: listSplit(v, /\n+/) }),
    filterSplit: /\n+/,
  },
  strCol('bio', 'Bio', { default: false }),
  strCol('summary', 'Summary', { default: false }),
  strCol('notes', 'Notes', { default: false }),
  strCol('howWeMet', 'How we met', { default: false }),
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
  channelCol('officePhone', 'Office phone'),
  channelCol('sms', 'SMS'),
  channelCol('signal', 'Signal'),
  channelCol('whatsapp', 'WhatsApp'),
  channelCol('messenger', 'FB Messenger'),
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
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate older column prefs once into v3 (Name only — no first/last cols).
      raw =
        localStorage.getItem('dashbird-network-manage-columns-v2')
        || localStorage.getItem('dashbird-network-manage-columns-v1');
    }
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const known = new Set(COLUMNS.map((c) => c.key));
        let keys = parsed
          .map(String)
          .filter((k) => k !== 'firstName' && k !== 'lastName' && known.has(k));
        if (!keys.includes('displayName')) keys = ['displayName', ...keys];
        // Ensure new defaults join existing layouts.
        for (const k of ['birthday', 'relationshipStatus']) {
          if (!keys.includes(k) && COLUMNS.some((c) => c.key === k && c.default !== false)) {
            keys.push(k);
          }
        }
        keys = applyAttrClusterOrder(keys);
        if (keys.length) {
          persistVisibleKeys(keys);
          return keys;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return applyAttrClusterOrder(COLUMNS.filter((c) => c.default !== false).map((c) => c.key));
}

/**
 * @param {string[]} keys
 */
function persistVisibleKeys(keys) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{
 *   filters: Map<string, { condition: { op: string, value: string }, values: Set<string> | null }>,
 *   sort: { key: string, dir: 'asc' | 'desc' } | null,
 * }}
 */
function loadFilterSortState() {
  /** @type {Map<string, { condition: { op: string, value: string }, values: Set<string> | null }>} */
  const filters = new Map();
  /** @type {{ key: string, dir: 'asc' | 'desc' } | null} */
  let sort = null;
  try {
    let raw = localStorage.getItem(FILTER_SORT_KEY);
    if (!raw) {
      // Migrate older session-only prefs into localStorage once.
      raw = sessionStorage.getItem(FILTER_SORT_KEY);
      if (raw) {
        try {
          localStorage.setItem(FILTER_SORT_KEY, raw);
          sessionStorage.removeItem(FILTER_SORT_KEY);
        } catch {
          /* keep reading from session raw */
        }
      }
    }
    if (!raw) return { filters, sort };
    const parsed = JSON.parse(raw);
    if (parsed?.sort?.key && (parsed.sort.dir === 'asc' || parsed.sort.dir === 'desc')) {
      sort = { key: String(parsed.sort.key), dir: parsed.sort.dir };
    }
    if (Array.isArray(parsed?.filters)) {
      for (const entry of parsed.filters) {
        if (!entry?.key) continue;
        const condition =
          entry.condition && typeof entry.condition === 'object'
            ? {
                op: String(entry.condition.op || 'none'),
                value: String(entry.condition.value || ''),
              }
            : { op: 'none', value: '' };
        const values = Array.isArray(entry.values) ? new Set(entry.values.map(String)) : null;
        filters.set(String(entry.key), { condition, values });
      }
    }
  } catch {
    /* ignore */
  }
  return { filters, sort };
}

/**
 * @param {Map<string, { condition: { op: string, value: string }, values: Set<string> | null }>} filters
 * @param {{ key: string, dir: 'asc' | 'desc' } | null} sort
 */
function persistFilterSortState(filters, sort) {
  try {
    const payload = {
      sort,
      filters: [...filters.entries()].map(([key, f]) => ({
        key,
        condition: f.condition || { op: 'none', value: '' },
        values: f.values instanceof Set ? [...f.values] : null,
      })),
    };
    localStorage.setItem(FILTER_SORT_KEY, JSON.stringify(payload));
    try {
      sessionStorage.removeItem(FILTER_SORT_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
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
 * @param {{ op: string, value: string }} condition
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
 *   getAllContacts?: () => object[],
 *   getSelectedIds: () => Set<string>,
 *   setSelectedIds: (ids: Set<string>) => void,
 *   onSelectContact: (id: string) => void,
 *   onContactsUpdated: (contacts: object[]) => void,
 *   showStatus: (msg: string, isErr?: boolean) => void,
 *   isLoading?: () => boolean,
 *   toolbarHost?: HTMLElement | null,
 * }} opts
 */
export function mountNetworkManageTable(root, opts) {
  root.replaceChildren();
  root.classList.add('network-manage');
  const toolbarHost = opts.toolbarHost || null;

  /** Full CRM list (unfiltered) — multi-select pick lists must not shrink with filters. */
  function allContacts() {
    if (typeof opts.getAllContacts === 'function') {
      const list = opts.getAllContacts();
      if (Array.isArray(list)) return list;
    }
    return opts.getContacts();
  }

  /** @type {string[]} */
  let visibleKeys = loadVisibleKeys();

  const restoredFilterSort = loadFilterSortState();

  /** @type {Map<string, { condition: { op: string, value: string }, values: Set<string> | null }>} */
  const filters = restoredFilterSort.filters;

  /** @type {{ key: string, dir: 'asc' | 'desc' } | null} */
  let sort = restoredFilterSort.sort;

  function rememberFilterSort() {
    persistFilterSortState(filters, sort);
  }

  /** @type {{ colKey: string, rows: Set<number>, anchor: number, focus: number } | null} */
  let cellSel = null;

  /** @type {{ colKey: string, startRow: number, endRow: number, value: string } | null} */
  let fillDrag = null;

  /** @type {{ colKey: string, startRow: number } | null} */
  let selectDrag = null;

  /** @type {{ colKey: string, label: string, entries: { id: string, value: string }[] } | null} */
  let lastBulkUndo = null;

  /** @type {{ colKey: string, rowIdx: number, getValue: () => string, focus: () => void, el: HTMLElement, floating?: boolean } | null} */
  let cellEdit = null;

  /**
   * Internal cell clipboard for Ctrl+C / Ctrl+V (same-column only).
   * @type {{ colKey: string, value: string, values: string[] } | null}
   */
  let cellClipboard = null;

  /** @type {string | null} */
  let colDragKey = null;

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
      persistVisibleKeys(visibleKeys);
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

  const exportCsvBtn = document.createElement('button');
  exportCsvBtn.type = 'button';
  exportCsvBtn.className = 'network-crm__btn network-crm__btn--tiny';
  exportCsvBtn.textContent = 'Export CSV';
  exportCsvBtn.title =
    'Download a CSV of the rows matching current filters, using only checked columns';
  exportCsvBtn.addEventListener('click', () => {
    exportVisibleCsv();
  });

  function syncUndoBtn() {
    const n = lastBulkUndo?.entries?.length || 0;
    undoBtn.disabled = n === 0;
    undoBtn.textContent = n ? `Undo fill (${n})` : 'Undo fill';
    undoBtn.title = n
      ? `Restore previous ${lastBulkUndo.label} on ${n} contact${n === 1 ? '' : 's'}`
      : 'Undo the last bulk fill / clear';
  }

  const toolbar = toolbarHost || bar;
  toolbar.append(colsBtn, clearFiltersBtn, undoBtn, exportCsvBtn, colsPanel);

  const scroller = document.createElement('div');
  scroller.className = 'network-manage__scroll';
  scroller.tabIndex = -1;
  scroller.setAttribute('aria-label', 'Contacts table');
  const table = document.createElement('table');
  table.className = 'network-manage__table';
  scroller.append(table);
  if (toolbarHost) {
    root.append(scroller);
  } else {
    root.append(bar, scroller);
  }

  /** Cap the table scroller just above the browser bottom (room for rounded corners). */
  function syncScrollerToViewport() {
    if (!scroller.isConnected) return;
    const top = scroller.getBoundingClientRect().top;
    const pagePad = 12;
    const avail = Math.floor(window.innerHeight - top - pagePad);
    scroller.style.maxHeight = `${Math.max(120, avail)}px`;
  }

  const onViewportChange = () => {
    requestAnimationFrame(syncScrollerToViewport);
  };
  window.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  const scrollFitObs = new ResizeObserver(onViewportChange);
  scrollFitObs.observe(root);
  if (root.parentElement) scrollFitObs.observe(root.parentElement);

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

  const cellEditorFloat = document.createElement('div');
  cellEditorFloat.className = 'network-manage__cell-editor';
  cellEditorFloat.hidden = true;
  cellEditorFloat.setAttribute('role', 'presentation');
  // Fixed to the viewport (not inside the table) so pick lists never widen columns.
  document.body.append(cellEditorFloat);

  function closeCellEditorFloat() {
    cellEditorFloat.hidden = true;
    cellEditorFloat.replaceChildren();
    cellEditorFloat.style.minWidth = '';
    cellEditorFloat.style.width = '';
    cellEditorFloat.style.maxWidth = '';
    cellEditorFloat.style.left = '';
    cellEditorFloat.style.top = '';
  }

  /**
   * Sheets-style: fixed overlay anchored to the cell. Never mounted inside <td>.
   * @param {HTMLElement} editorEl
   * @param {HTMLElement} td
   */
  function openCellEditorFloat(editorEl, td) {
    cellEditorFloat.replaceChildren(editorEl);
    cellEditorFloat.hidden = false;
    const tdRect = td.getBoundingClientRect();
    const isMulti = editorEl.classList.contains('network-manage__cell-multi');
    const minW = Math.max(Math.ceil(tdRect.width), isMulti ? 180 : 140);
    const maxW = Math.min(isMulti ? 352 : 288, Math.floor(window.innerWidth - 16));
    cellEditorFloat.style.minWidth = `${Math.min(minW, maxW)}px`;
    cellEditorFloat.style.maxWidth = `${maxW}px`;
    cellEditorFloat.style.width = 'max-content';
    cellEditorFloat.style.maxHeight = '';
    cellEditorFloat.style.overflow = '';
    cellEditorFloat.style.left = '0px';
    cellEditorFloat.style.top = '0px';
    const w = Math.min(Math.max(cellEditorFloat.offsetWidth, minW), maxW);
    const h = cellEditorFloat.offsetHeight;
    const viewH = window.innerHeight;
    let x = tdRect.left;
    let y = tdRect.top;
    // Prefer opening down from the cell; flip up if needed.
    if (y + h > viewH - 8 && tdRect.bottom - h >= 8) {
      y = tdRect.bottom - h;
    }
    // Tall multi-select (e.g. all Scene options): pin near the top so the full list fits.
    if (isMulti && h > viewH - 16) {
      y = 8;
    } else {
      y = Math.max(8, Math.min(y, viewH - h - 8));
    }
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    cellEditorFloat.style.left = `${x}px`;
    cellEditorFloat.style.top = `${y}px`;
  }

  function visibleCols() {
    return visibleKeys.map((k) => COLUMNS.find((c) => c.key === k)).filter(Boolean);
  }

  /**
   * @param {string} fromKey
   * @param {string} toKey
   * @param {boolean} placeAfter
   */
  function reorderVisibleColumn(fromKey, toKey, placeAfter) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const from = visibleKeys.indexOf(fromKey);
    if (from < 0 || visibleKeys.indexOf(toKey) < 0) return;
    const next = visibleKeys.filter((k) => k !== fromKey);
    let insertAt = next.indexOf(toKey);
    if (insertAt < 0) return;
    if (placeAfter) insertAt += 1;
    next.splice(insertAt, 0, fromKey);
    visibleKeys = next;
    persistVisibleKeys(visibleKeys);
    render();
  }

  function clearColumnDropIndicators() {
    for (const el of table.querySelectorAll(
      '.network-manage__th--drop-before, .network-manage__th--drop-after, .network-manage__th--dragging',
    )) {
      el.classList.remove(
        'network-manage__th--drop-before',
        'network-manage__th--drop-after',
        'network-manage__th--dragging',
      );
    }
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
    if (contact?.intakeReviewed === false) return true;
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
    const effectiveSort = sort || { key: 'displayName', dir: 'asc' };
    const col = colByKey(effectiveSort.key);
    if (col) {
      const dir = effectiveSort.dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const aNew = a.intakeReviewed === false;
        const bNew = b.intakeReviewed === false;
        if (aNew !== bNew) return aNew ? -1 : 1;
        if (aNew) {
          const aAt = String(a.createdAt || '');
          const bAt = String(b.createdAt || '');
          if (aAt !== bAt) return bAt.localeCompare(aAt);
        }
        const av = col.get(a).toLowerCase();
        const bv = col.get(b).toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
          sensitivity: 'base',
        });
      });
    }
    viewRows = rows;
    return rows;
  }

  /** Escape a single CSV field (RFC 4180). */
  function csvEscape(value) {
    const s = String(value ?? '');
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  /**
   * Download CSV of currently filtered rows × checked (visible) columns only.
   */
  function exportVisibleCsv() {
    const cols = visibleCols();
    if (!cols.length) {
      opts.showStatus?.('No columns selected', true);
      return;
    }
    const rows = buildViewRows();
    const lines = [cols.map((c) => csvEscape(c.label)).join(',')];
    for (const contact of rows) {
      lines.push(cols.map((c) => csvEscape(c.get(contact))).join(','));
    }
    // BOM so Excel opens UTF-8 correctly.
    const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], {
      type: 'text/csv;charset=utf-8',
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `network-contacts-${stamp}.csv`;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    opts.showStatus?.(
      `Exported ${rows.length} contact${rows.length === 1 ? '' : 's'} (${cols.length} column${cols.length === 1 ? '' : 's'})`,
    );
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
    };
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
    // Keep keyboard focus on the grid so arrow keys move the highlight
    // even after clicking a cell while a search/filter input was focused.
    if (document.activeElement instanceof HTMLElement) {
      const ae = document.activeElement;
      if (
        ae.matches('input, textarea, select') ||
        ae.isContentEditable ||
        ae.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        // Leave inline cell editors alone; they own focus while open.
        if (!cellEdit) scroller.focus({ preventScroll: true });
      } else if (!scroller.contains(ae)) {
        scroller.focus({ preventScroll: true });
      }
    } else {
      scroller.focus({ preventScroll: true });
    }
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

  /**
   * @param {string} colKey
   * @param {number} startRow
   * @param {number} endRow
   */
  function paintFillRange(colKey, startRow, endRow) {
    const lo = Math.min(startRow, endRow);
    const hi = Math.max(startRow, endRow);
    table.querySelectorAll('.network-manage__cell').forEach((el) => {
      const r = Number(el.dataset.rowIdx);
      const k = el.dataset.colKey;
      el.classList.toggle('network-manage__cell--fill', k === colKey && r >= lo && r <= hi);
    });
  }

  /**
   * Resolve the manage-table cell under the pointer (handles nested fill-handle hits).
   * @param {number} clientX
   * @param {number} clientY
   * @param {string} colKey
   * @returns {HTMLElement | null}
   */
  function fillCellFromPoint(clientX, clientY, colKey) {
    const stack =
      typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(clientX, clientY)
        : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
    for (const el of stack) {
      if (!(el instanceof Element)) continue;
      const cell = el.closest('.network-manage__cell');
      if (cell instanceof HTMLElement && cell.dataset.colKey === colKey) return cell;
    }
    return null;
  }

  /**
   * Keep fill endRow aligned with the pointer (mouseenter alone can miss the last row).
   * @param {number} clientX
   * @param {number} clientY
   * @returns {number | null} updated endRow, or null if unchanged / unknown
   */
  function syncFillEndFromPointer(clientX, clientY) {
    if (!fillDrag) return null;
    const cell = fillCellFromPoint(clientX, clientY, fillDrag.colKey);
    if (!cell) return null;
    const row = Number(cell.dataset.rowIdx);
    if (!Number.isFinite(row)) return null;
    if (row === fillDrag.endRow) return row;
    fillDrag.endRow = row;
    paintFillRange(fillDrag.colKey, fillDrag.startRow, fillDrag.endRow);
    return row;
  }

  function closeFilterMenu() {
    filterMenu.hidden = true;
    filterMenu.style.maxHeight = '';
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

  function canEditColumn(col) {
    return Boolean(col?.set);
  }

  /** Name opens the detail pane instead of inline editing. */
  function opensDetailsOnActivate(col) {
    return col?.key === 'displayName';
  }

  /** Inline spreadsheet edit (not Name → details). */
  function canInlineEditColumn(col) {
    return canEditColumn(col) && !opensDetailsOnActivate(col);
  }

  function canFillColumn(col) {
    return Boolean(col?.set) && !NO_FILL_KEYS.has(col.key);
  }

  /**
   * Copy the current cell selection into the internal clipboard (and system clipboard).
   * Paste only works into the same column.
   */
  async function copySelectedCells() {
    const sel = selectionInfo();
    if (!sel) {
      opts.showStatus('Select a cell to copy', true);
      return;
    }
    const col = colByKey(sel.colKey);
    if (!col) return;

    const lines = [];
    for (const i of sel.rows) {
      const c = contactAt(i);
      lines.push(c ? col.get(c) : '');
    }
    const focusContact = contactAt(sel.focus);
    const pasteValue = focusContact ? col.get(focusContact) : lines[0] || '';
    cellClipboard = { colKey: sel.colKey, value: pasteValue, values: lines };

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
    } catch {
      /* internal clipboard still works */
    }
    opts.showStatus(
      sel.count === 1
        ? `Copied ${col.label}`
        : `Copied ${col.label} (${sel.count} cells)`,
    );
  }

  /**
   * Paste the internal cell clipboard into the current selection (same column only).
   */
  async function pasteIntoSelectedCells() {
    const sel = selectionInfo();
    if (!sel) {
      opts.showStatus('Select a cell to paste into', true);
      return;
    }
    if (!cellClipboard) {
      opts.showStatus('Nothing to paste — copy a cell first (Ctrl/Cmd+C)', true);
      return;
    }
    if (cellClipboard.colKey !== sel.colKey) {
      const from = colByKey(cellClipboard.colKey)?.label || cellClipboard.colKey;
      const to = colByKey(sel.colKey)?.label || sel.colKey;
      opts.showStatus(`Paste only within the same column (${from} → ${to})`, true);
      return;
    }
    const col = colByKey(sel.colKey);
    if (!canEditColumn(col)) {
      opts.showStatus('This column is read-only', true);
      return;
    }

    // Same-size multi-copy → paste 1:1 onto the selection; otherwise fill selection
    // with the focused source cell's value (typical one-cell → other-cell paste).
    const src = cellClipboard.values;
    if (src.length > 1 && src.length === sel.count) {
      await writePerRowValues(
        col,
        sel.rows.map((rowIdx, i) => ({ rowIdx, value: src[i] ?? '' })),
      );
      return;
    }
    await writeValueToRowIndexes(col, cellClipboard.value, sel.rows);
  }

  /** Clear selected cell(s) with no confirmation prompt. */
  async function clearSelectedCells() {
    const sel = selectionInfo();
    if (!sel) return;
    const col = colByKey(sel.colKey);
    if (!canEditColumn(col)) {
      opts.showStatus('This column cannot be cleared', true);
      return;
    }
    await writeValueToRowIndexes(col, '', sel.rows);
  }

  /**
   * @param {{ key: string, label: string, set?: (c: object, v: string) => object, get?: (c: object) => string, filterSplit?: boolean | RegExp }} col
   * @param {{ rowIdx: number, value: string }[]} entries
   */
  async function writePerRowValues(col, entries) {
    if (!col.set) return;
    /** @type {{ id: string, value: string }[]} */
    const undoEntries = [];
    /** @type {{ id: string, patch: object }[]} */
    const jobs = [];
    /** @type {object[]} */
    const optimistic = [];
    for (const { rowIdx, value } of entries) {
      const c = contactAt(rowIdx);
      if (!c) continue;
      undoEntries.push({ id: c.id, value: col.get(c) });
      const patch = patchForColumnValue(col, value, c);
      jobs.push({ id: c.id, patch });
      optimistic.push(mergeContactPatch(c, patch));
    }
    if (!jobs.length) return;

    opts.onContactsUpdated(optimistic);
    opts.showStatus(`Updating ${col.label} on ${jobs.length} contact${jobs.length === 1 ? '' : 's'}…`);

    try {
      const updated = await Promise.all(jobs.map((job) => patchContact(job.id, job.patch)));
      lastBulkUndo = {
        colKey: col.key,
        label: col.label,
        entries: undoEntries,
      };
      syncUndoBtn();
      opts.onContactsUpdated(updated);
      opts.showStatus(
        `Updated ${col.label} on ${updated.length} contact${updated.length === 1 ? '' : 's'}`,
      );
    } catch (err) {
      /** @type {object[]} */
      const reverted = [];
      const byId = new Map(opts.getContacts().map((c) => [c.id, c]));
      for (const entry of undoEntries) {
        const c = byId.get(entry.id);
        if (!c) continue;
        reverted.push(mergeContactPatch(c, patchForColumnValue(col, entry.value, c)));
      }
      if (reverted.length) opts.onContactsUpdated(reverted);
      opts.showStatus(String(err?.message || err), true);
    }
  }

  /**
   * @param {{ key: string, filterSplit?: boolean | RegExp } | null | undefined} col
   */
  function isMultilineCol(col) {
    if (!col) return false;
    if (
      col.key === 'notes' ||
      col.key === 'bio' ||
      col.key === 'summary' ||
      col.key === 'memoryJog' ||
      col.key === 'howWeMet' ||
      col.key === 'alignedActivities' ||
      col.key === 'ch_urls'
    ) {
      return true;
    }
    return col.filterSplit instanceof RegExp && String(col.filterSplit.source).includes('\\n');
  }

  function cancelCellEdit() {
    if (!cellEdit) return;
    cellEdit = null;
    closeCellEditorFloat();
    render();
  }

  async function commitCellEdit() {
    if (!cellEdit) return;
    const { colKey, rowIdx, getValue } = cellEdit;
    const value = getValue();
    cellEdit = null;
    closeCellEditorFloat();
    const col = colByKey(colKey);
    if (!canEditColumn(col)) {
      render();
      return;
    }
    const c = contactAt(rowIdx);
    if (c && col.get(c) === value) {
      render();
      return;
    }
    await writeValueToRowIndexes(col, value, [rowIdx]);
  }

  /**
   * Shared keyboard handling for inline editors (text / select / multi).
   * @param {KeyboardEvent} e
   * @param {{ multiline?: boolean, colKey: string, rowIdx: number }} cfg
   */
  function onCellEditorKeydown(e, cfg) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelCellEdit();
      return;
    }
    if (e.key === 'Enter' && (!cfg.multiline || !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      void commitCellEdit();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const cols = visibleCols();
      const colIdx = cols.findIndex((x) => x.key === cfg.colKey);
      void commitCellEdit().then(() => {
        const delta = e.shiftKey ? -1 : 1;
        let nextCol = colIdx + delta;
        while (nextCol >= 0 && nextCol < cols.length && !canInlineEditColumn(cols[nextCol])) {
          nextCol += delta;
        }
        if (nextCol >= 0 && nextCol < cols.length) {
          startCellEdit(cols[nextCol].key, cfg.rowIdx);
        }
      });
    }
  }

  /**
   * @param {string} colKey
   * @param {number} rowIdx
   */
  function startCellEdit(colKey, rowIdx) {
    const col = colByKey(colKey);
    if (!canInlineEditColumn(col)) {
      if (opensDetailsOnActivate(col)) {
        const c = contactAt(rowIdx);
        if (c) opts.onSelectContact(c.id);
      }
      return;
    }

    if (cellEdit) {
      if (cellEdit.colKey === colKey && cellEdit.rowIdx === rowIdx) {
        cellEdit.focus();
        return;
      }
      const prev = cellEdit;
      cellEdit = null;
      const prevCol = colByKey(prev.colKey);
      const prevVal = prev.getValue();
      const prevContact = contactAt(prev.rowIdx);
      if (prevCol && canEditColumn(prevCol) && (!prevContact || prevCol.get(prevContact) !== prevVal)) {
        void writeValueToRowIndexes(prevCol, prevVal, [prev.rowIdx]).then(() => {
          startCellEdit(colKey, rowIdx);
        });
        return;
      }
    }

    closeFilterMenu();
    closeContextMenu();
    closeFillEditor();
    selectSingleCell(colKey, rowIdx);

    const td = table.querySelector(
      `.network-manage__cell[data-col-key="${CSS.escape(colKey)}"][data-row-idx="${rowIdx}"]`,
    );
    if (!(td instanceof HTMLElement)) return;
    const c = contactAt(rowIdx);
    if (!c) return;

    const initial = col.get(c);
    // Multi-select / pick lists always use the full contact set so people/search
    // filters do not hide choices that exist outside the current view.
    const pickOpts = pickOptionsForCol(col, opts, allContacts());
    const multi = isMultiSelectCol(col);
    const pickList = isPickListCol(col, opts);

    /** @type {() => string} */
    let getValue;
    /** @type {() => void} */
    let focusEditor;
    /** @type {HTMLElement} */
    let editorEl;
    let floating = false;

    if (pickList && multi) {
      floating = true;
      const panel = document.createElement('div');
      panel.className = 'network-manage__cell-multi';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', `Edit ${col.label}`);
      panel.tabIndex = -1;

      /** @type {HTMLInputElement[]} */
      const checks = [];
      /** @type {string[]} */
      let optionList = [...(pickOpts || [])];
      const selected = new Set(
        listSplit(initial, listSepForCol(col))
          .map((p) => normalizeListPart(col, p))
          .filter(Boolean),
      );
      // kinds defaults to friend in get() when empty — keep checkboxes honest to storage.
      if (col.key === 'kinds' && !selected.size) selected.add('friend');
      // Include any current values that aren't in the known list yet.
      for (const token of selected) {
        if (!optionList.some((o) => o.toLowerCase() === token.toLowerCase())) {
          optionList.push(token);
        }
      }
      if (col.key === 'networkCircles') {
        optionList = collectSceneOptions(allContacts(), [...selected]);
      }

      const optsWrap = document.createElement('div');
      optsWrap.className = 'network-manage__cell-multi-opts';

      function rebuildChecks() {
        optsWrap.replaceChildren();
        checks.length = 0;
        for (const opt of optionList) {
          const lab = document.createElement('label');
          lab.className = 'network-manage__cell-multi-opt';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = opt;
          cb.checked = [...selected].some((s) => s.toLowerCase() === opt.toLowerCase());
          checks.push(cb);
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(opt);
            else {
              for (const s of [...selected]) {
                if (s.toLowerCase() === opt.toLowerCase()) selected.delete(s);
              }
            }
          });
          lab.append(cb, document.createTextNode(` ${pickOptionLabel(col.key, opt)}`));
          optsWrap.append(lab);
        }
      }
      rebuildChecks();
      panel.append(optsWrap);

      if (col.key === 'networkCircles') {
        const addNew = document.createElement('button');
        addNew.type = 'button';
        addNew.className = 'network-crm__btn network-crm__btn--tiny';
        addNew.textContent = 'New scene…';
        addNew.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const name = (prompt('New scene name?') || '').replace(/\s+/g, ' ').trim();
          if (!name) return;
          if (!optionList.some((o) => o.toLowerCase() === name.toLowerCase())) {
            optionList = [...optionList, name].sort((a, b) =>
              a.localeCompare(b, undefined, { sensitivity: 'base' }),
            );
          }
          selected.add(name);
          rebuildChecks();
        });
        panel.append(addNew);
      }

      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'network-crm__btn network-crm__btn--tiny network-crm__btn--primary';
      done.textContent = 'Done';
      done.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void commitCellEdit();
      });
      panel.append(done);

      getValue = () => {
        const picked = checks.filter((cb) => cb.checked).map((cb) => cb.value);
        if (col.key === 'networkCircles') return joinSceneTokens(picked);
        return listJoin(picked, listJoinSepForCol(col));
      };
      focusEditor = () => {
        const first = checks.find((cb) => cb.checked) || checks[0];
        (first || panel).focus();
      };
      editorEl = panel;

      panel.addEventListener('keydown', (e) => onCellEditorKeydown(e, { colKey, rowIdx }));
      panel.addEventListener('mousedown', (e) => e.stopPropagation());
      panel.addEventListener('click', (e) => e.stopPropagation());
      panel.addEventListener('dblclick', (e) => e.stopPropagation());

      openCellEditorFloat(panel, td);
    } else if (pickList && pickOpts) {
      floating = true;
      const panel = document.createElement('div');
      panel.className = 'network-manage__cell-pick';
      panel.setAttribute('role', 'listbox');
      panel.setAttribute('aria-label', `Edit ${col.label}`);
      panel.tabIndex = -1;

      let selectValue = initial;
      if (YES_NO_KEYS.has(col.key)) {
        selectValue = initial === 'Yes' ? 'Yes' : '';
      }

      /** @type {string} */
      let picked = selectValue;

      /**
       * @param {string} value
       * @param {string} label
       */
      function addPickOpt(value, label) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'network-manage__cell-pick-opt';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', value === picked ? 'true' : 'false');
        if (value === picked) btn.classList.add('network-manage__cell-pick-opt--active');
        btn.textContent = label;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          picked = value;
          void commitCellEdit();
        });
        panel.append(btn);
      }

      addPickOpt('', YES_NO_KEYS.has(col.key) ? 'No' : '(blank)');
      for (const opt of pickOpts) {
        if (YES_NO_KEYS.has(col.key) && opt === 'No') continue;
        addPickOpt(opt, pickOptionLabel(col.key, opt));
      }
      if (
        selectValue &&
        !YES_NO_KEYS.has(col.key) &&
        !pickOpts.some((o) => o === selectValue)
      ) {
        addPickOpt(selectValue, selectValue);
      }

      getValue = () => picked;
      focusEditor = () => {
        const active =
          panel.querySelector('.network-manage__cell-pick-opt--active') ||
          panel.querySelector('.network-manage__cell-pick-opt');
        (active instanceof HTMLElement ? active : panel).focus();
      };
      editorEl = panel;

      panel.addEventListener('keydown', (e) => onCellEditorKeydown(e, { colKey, rowIdx }));
      panel.addEventListener('mousedown', (e) => e.stopPropagation());
      panel.addEventListener('click', (e) => e.stopPropagation());
      panel.addEventListener('dblclick', (e) => e.stopPropagation());

      openCellEditorFloat(panel, td);
    } else {
      const multiline = isMultilineCol(col);
      /** @type {HTMLInputElement | HTMLTextAreaElement} */
      const input = multiline ? document.createElement('textarea') : document.createElement('input');
      if (!multiline && input instanceof HTMLInputElement) input.type = 'text';
      input.className = 'network-manage__cell-input';
      if (multiline) input.classList.add('network-manage__cell-input--multiline');
      input.value = initial;
      input.setAttribute('aria-label', `Edit ${col.label}`);

      const suggestions = fillSuggestionsForColumn(col.key);
      if (suggestions.length && !multiline) {
        const listId = `network-manage-cell-opts-${col.key}`;
        input.setAttribute('list', listId);
        const datalist = document.createElement('datalist');
        datalist.id = listId;
        for (const opt of suggestions) {
          const o = document.createElement('option');
          o.value = opt;
          datalist.append(o);
        }
        td.replaceChildren(input, datalist);
      } else {
        td.replaceChildren(input);
      }

      getValue = () => input.value;
      focusEditor = () => {
        input.focus();
        input.select();
      };
      editorEl = input;

      input.addEventListener('keydown', (e) =>
        onCellEditorKeydown(e, { multiline, colKey, rowIdx }),
      );
      input.addEventListener('blur', () => {
        window.requestAnimationFrame(() => {
          if (cellEdit?.el === input) void commitCellEdit();
        });
      });
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('dblclick', (e) => e.stopPropagation());
    }

    td.classList.add('network-manage__cell--editing');
    if (floating) td.classList.add('network-manage__cell--editing-float');
    cellEdit = { colKey, rowIdx, getValue, focus: focusEditor, el: editorEl, floating };

    window.requestAnimationFrame(() => {
      focusEditor();
    });
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
   * Local merge mirroring server updateContact so the table can refresh before PUTs finish.
   * @param {object} contact
   * @param {object} patch
   */
  function mergeContactPatch(contact, patch) {
    return {
      ...contact,
      ...(patch && typeof patch === 'object' ? patch : {}),
      id: contact.id,
      channels: {
        ...(contact.channels && typeof contact.channels === 'object' ? contact.channels : {}),
        ...(patch?.channels && typeof patch.channels === 'object' ? patch.channels : {}),
      },
      enrichment: {
        ...(contact.enrichment && typeof contact.enrichment === 'object' ? contact.enrichment : {}),
        ...(patch?.enrichment && typeof patch.enrichment === 'object' ? patch.enrichment : {}),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * @param {{ key: string, set: (c: object, v: string) => object }} col
   * @param {string} value
   */
  function patchForColumnValue(col, value, contact = {}) {
    const patch = col.set(contact, value);
    if (col.key === 'kinds' && (!Array.isArray(patch.kinds) || !patch.kinds.length)) {
      patch.kinds = ['friend'];
    }
    return patch;
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

  /** Skip one outside-click dismiss after opening the drag-fill chooser. */
  let ignoreFillEditorOutsideClick = false;

  /**
   * After a drag-fill release on a multi-value column, ask Overwrite vs Append.
   * @param {number} clientX
   * @param {number} clientY
   * @param {{
   *   col: { key: string, label: string, set?: (c: object, v: string) => object, get?: (c: object) => string, filterSplit?: boolean | RegExp },
   *   value: string,
   *   preview: string,
   *   targetCount: number,
   *   rowIndexes: number[],
   * }} pending
   */
  function openDragFillChooser(clientX, clientY, pending) {
    const { col, value, preview, targetCount, rowIndexes } = pending;
    closeFilterMenu();
    closeContextMenu();
    closeFillEditor();

    fillEditor.replaceChildren();

    const title = document.createElement('div');
    title.className = 'network-manage__fill-editor-title';
    title.textContent = `Copy ${col.label} · ${targetCount} contact${targetCount === 1 ? '' : 's'}`;

    const hint = document.createElement('p');
    hint.className = 'muted network-manage__fill-editor-hint';
    hint.textContent = `“${preview}” — overwrite existing values, or append what’s missing?`;

    const actions = document.createElement('div');
    actions.className = 'network-manage__fill-editor-actions';

    const overwriteBtn = document.createElement('button');
    overwriteBtn.type = 'button';
    overwriteBtn.className = 'btn';
    overwriteBtn.textContent = 'Overwrite';
    overwriteBtn.title = 'Replace the whole cell with the dragged value';

    const appendBtn = document.createElement('button');
    appendBtn.type = 'button';
    appendBtn.className = 'btn';
    appendBtn.textContent = 'Append';
    appendBtn.title = 'Keep existing values and add any that are missing';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn--ghost';
    cancelBtn.textContent = 'Cancel';

    /**
     * @param {'replace' | 'append'} mode
     */
    function choose(mode) {
      closeFillEditor();
      void writeValueToRowIndexes(col, value, rowIndexes, mode);
    }

    overwriteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      choose('replace');
    });
    appendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      choose('append');
    });
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFillEditor();
      opts.showStatus('Fill cancelled');
    });

    actions.append(overwriteBtn, appendBtn, cancelBtn);
    fillEditor.append(title, hint, actions);
    fillEditor.setAttribute('aria-label', `Drag fill ${col.label}`);

    // mouseup is followed by a click on the cell under the cursor; ignore that dismiss.
    ignoreFillEditorOutsideClick = true;
    placeFloating(fillEditor, clientX, clientY);
    overwriteBtn.focus();
    window.setTimeout(() => {
      ignoreFillEditorOutsideClick = false;
    }, 0);
  }

  /**
   * @param {number} [clientX]
   * @param {number} [clientY]
   */
  async function applyFill(clientX = 0, clientY = 0) {
    if (!fillDrag) return;
    const { colKey, startRow, value } = fillDrag;
    let { endRow } = fillDrag;

    // Prefer the cell under the pointer at release — mouseenter can miss the last
    // row when the cursor settles on it without a fresh enter event.
    const synced = syncFillEndFromPointer(clientX, clientY);
    if (synced != null) endRow = synced;
    else if (
      Number.isFinite(Number(fillDrag.endRow))
    ) {
      endRow = fillDrag.endRow;
    }

    const underCell = fillCellFromPoint(clientX, clientY, colKey);

    // Snapshot mouse-highlighted cells before clearing (contact ids, not raw indexes).
    const highlighted = [...table.querySelectorAll('.network-manage__cell--fill')]
      .filter((el) => el instanceof HTMLElement && el.dataset.colKey === colKey)
      .map((el) => {
        const row = Number(el.dataset.rowIdx);
        const c = contactAt(row);
        return {
          row,
          id: c?.id != null ? String(c.id) : null,
          name: c?.displayName || null,
        };
      })
      .filter((h) => Number.isFinite(h.row));


    fillDrag = null;
    clearFillHighlight();
    const col = colByKey(colKey);
    if (!canFillColumn(col)) return;
    const lo = Math.min(startRow, endRow);
    const hi = Math.max(startRow, endRow);
    if (hi <= lo) return;
    // Exclude the drag source so upward fills hit the destination row(s), not the source.
    const rowIndexes = [];
    for (let i = lo; i <= hi; i++) {
      if (i !== startRow) rowIndexes.push(i);
    }
    const rangeIds = rowIndexes.map((i) => {
      const c = contactAt(i);
      return c?.id != null ? String(c.id) : null;
    });
    const highlightTargetIds = highlighted
      .filter((h) => h.row !== startRow && h.id)
      .map((h) => h.id);
    const targetCount = rowIndexes.length;
    if (!targetCount) return;
    const preview = value.length > 40 ? `${value.slice(0, 37)}…` : value || '(empty)';


    if (isAppendableColumn(col)) {
      openDragFillChooser(clientX, clientY, {
        col,
        value,
        preview,
        targetCount,
        rowIndexes,
      });
      return;
    }

    const ok = window.confirm(
      `Copy ${col.label} “${preview}” onto ${targetCount} contact${targetCount === 1 ? '' : 's'}?\n\nThis overwrites existing values.`,
    );
    if (!ok) {
      opts.showStatus('Fill cancelled');
      return;
    }
    await writeValueToRowIndexes(col, value, rowIndexes);
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
    /** @type {{ id: string, value: string }[]} */
    const undoEntries = [];
    /** @type {{ id: string, patch: object }[]} */
    const jobs = [];
    /** @type {object[]} */
    const optimistic = [];
    for (const i of rows) {
      const c = contactAt(i);
      if (!c) continue;
      const prev = col.get(c);
      undoEntries.push({ id: c.id, value: prev });
      const nextValue = fillMode === 'append' ? mergeAppendValue(col, prev, value) : value;
      const patch = patchForColumnValue(col, nextValue, c);
      jobs.push({ id: c.id, patch });
      optimistic.push(mergeContactPatch(c, patch));
    }
    if (!jobs.length) return;


    // Show the new values in the table immediately; persist in parallel afterward.
    try {
      opts.onContactsUpdated(optimistic);
    } catch (err) {
      throw err;
    }
    opts.showStatus(`${verb} ${col.label} on ${count} contact${count === 1 ? '' : 's'}…`);

    try {
      const updated = await Promise.all(
        jobs.map(async (job) => {
          try {
            const contact = await patchContact(job.id, job.patch);
            return contact;
          } catch (err) {
            throw err;
          }
        }),
      );
      lastBulkUndo = {
        colKey: col.key,
        label: col.label,
        entries: undoEntries,
      };
      syncUndoBtn();
      opts.onContactsUpdated(updated);
      const done =
        fillMode === 'append'
          ? `Appended to ${col.label} on ${updated.length} contact${updated.length === 1 ? '' : 's'}`
          : `Updated ${col.label} on ${updated.length} contact${updated.length === 1 ? '' : 's'}`;
      opts.showStatus(done);
    } catch (err) {
      /** @type {object[]} */
      const reverted = [];
      const byId = new Map(opts.getContacts().map((c) => [c.id, c]));
      for (const entry of undoEntries) {
        const c = byId.get(entry.id);
        if (!c) continue;
        reverted.push(mergeContactPatch(c, patchForColumnValue(col, entry.value, c)));
      }
      if (reverted.length) opts.onContactsUpdated(reverted);
      opts.showStatus(String(err?.message || err), true);
    }
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
    /** @type {{ id: string, patch: object }[]} */
    const jobs = [];
    /** @type {object[]} */
    const optimistic = [];
    const byId = new Map(opts.getContacts().map((c) => [c.id, c]));
    for (const entry of snapshot.entries) {
      const c = byId.get(entry.id);
      if (!c) continue;
      const patch = patchForColumnValue(col, entry.value, c);
      jobs.push({ id: entry.id, patch });
      optimistic.push(mergeContactPatch(c, patch));
    }
    if (optimistic.length) opts.onContactsUpdated(optimistic);
    try {
      const updated = await Promise.all(jobs.map((job) => patchContact(job.id, job.patch)));
      if (updated.length) opts.onContactsUpdated(updated);
      opts.showStatus(
        `Restored ${snapshot.label} on ${updated.length} contact${updated.length === 1 ? '' : 's'}`,
      );
    } catch (err) {
      opts.showStatus(String(err?.message || err), true);
    }
  }

  /**
   * Suggestion list for the fill editor: presets first, then existing column values.
   * @param {string} colKey
   * @returns {string[]}
   */
  function fillSuggestionsForColumn(colKey) {
    const presets =
      colKey === 'networkCircles'
        ? collectSceneOptions(allContacts())
        : resolveFillOptions({ key: colKey }, opts) || [];
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
    if (cellEdit) {
      void commitCellEdit().then(() => openFillEditor(clientX, clientY, target));
      return;
    }
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
    const hasPresets = isPickListCol(col, opts) || Boolean(suggestions.length);
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
        'Overwrite',
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
          : 'Overwrite replaces the whole cell with what you enter.';
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
   * Multi-select columns always seed the full choice list (not only values
   * present in the current filtered view).
   * @param {string} colKey
   */
  function uniqueValuesForColumn(colKey) {
    const col = colByKey(colKey);
    if (!col) return [];
    /** @type {Map<string, number>} */
    const counts = new Map();
    if (isMultiSelectCol(col)) {
      const presets = resolveFillOptions(col, opts, allContacts()) || [];
      for (const p of presets) {
        if (!counts.has(p)) counts.set(p, 0);
      }
    }
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
    valsBody.className = 'network-manage__filter-section network-manage__filter-section--values';
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
    const top = Math.max(4, anchorRect.bottom - rootRect.top + 2);
    filterMenu.style.left = `${left}px`;
    filterMenu.style.top = `${top}px`;
    // Grow into leftover space under the header (down to the viewport / manage root).
    const menuTop = rootRect.top + top;
    const avail = Math.min(
      window.innerHeight - menuTop - 8,
      rootRect.bottom - menuTop - 4,
    );
    filterMenu.style.maxHeight = `${Math.max(220, avail)}px`;
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

    item('Edit cell', () => {
      queueMicrotask(() => startCellEdit(col.key, target.rowIdx));
    }, { disabled: !canInlineEditColumn(col) || count !== 1 });

    item('Open details', () => {
      const c = contactAt(target.rowIdx);
      if (c) opts.onSelectContact(c.id);
    });

    item(`Copy${count > 1 ? ` (${count})` : ''}`, async () => {
      const lines = [];
      for (const i of selectedRows) {
        const c = contactAt(i);
        lines.push(c ? col.get(c) : '');
      }
      const focusContact = contactAt(sel.focus);
      const pasteValue = focusContact ? col.get(focusContact) : firstVal;
      cellClipboard = { colKey: col.key, value: pasteValue, values: lines };
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        opts.showStatus(`Copied ${count} cell${count === 1 ? '' : 's'}`);
      } catch {
        opts.showStatus(`Copied ${count} cell${count === 1 ? '' : 's'} (internal)`);
      }
    });

    item('Paste', async () => {
      await pasteIntoSelectedCells();
    }, {
      disabled:
        !cellClipboard ||
        cellClipboard.colKey !== col.key ||
        !canEditColumn(col),
    });

    item('Fill…', () => {
      // Defer so the context-menu click does not immediately dismiss the editor.
      queueMicrotask(() => {
        openFillEditor(clientX, clientY, { colKey: col.key, rowIdx: sel.rows[0] });
      });
    }, { disabled: !canFillColumn(col) });

    item('Clear', async () => {
      if (!canEditColumn(col)) {
        opts.showStatus('This column cannot be cleared', true);
        return;
      }
      await writeValueToRowIndexes(col, '', selectedRows);
    }, { disabled: !canEditColumn(col) });

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

  /** Update row / select-all checkboxes from opts.getSelectedIds() without a full re-render. */
  function syncSelectionUi() {
    const selected = opts.getSelectedIds();
    const contacts = viewRows;
    for (const tr of table.querySelectorAll('.network-manage__row')) {
      const id = tr.dataset.contactId;
      const cb = /** @type {HTMLInputElement | null} */ (
        tr.querySelector('input.network-crm__select')
      );
      if (id && cb) cb.checked = selected.has(id);
    }
    const selectAll = /** @type {HTMLInputElement | null} */ (
      table.querySelector('thead .network-manage__th--check input[type="checkbox"]')
    );
    if (selectAll) {
      selectAll.checked =
        contacts.length > 0 && contacts.every((c) => selected.has(c.id));
      selectAll.indeterminate =
        contacts.some((c) => selected.has(c.id))
        && !contacts.every((c) => selected.has(c.id));
    }
  }

  function render() {
    rememberFilterSort();
    closeFilterMenu();
    closeContextMenu();
    closeFillEditor();
    closeCellEditorFloat();
    cellEdit = null;
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
      syncSelectionUi();
    });
    thCheck.append(selectAll);
    hr.append(thCheck);

    for (const col of cols) {
      const th = document.createElement('th');
      th.className = 'network-manage__th';
      th.draggable = true;
      th.dataset.colKey = col.key;
      th.title = `Drag to reorder · ${col.label}`;
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
      filterBtn.draggable = false;
      if (filterIsActive(col.key)) filterBtn.classList.add('network-manage__filter-btn--on');
      filterBtn.title = `Filter ${col.label}`;
      filterBtn.setAttribute('aria-label', `Filter ${col.label}`);
      filterBtn.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M2 3h12l-4.5 5.2V13l-3 1.5V8.2L2 3z"/></svg>';
      filterBtn.addEventListener('mousedown', (e) => e.stopPropagation());
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

      th.addEventListener('dragstart', (e) => {
        if (e.target instanceof HTMLElement && e.target.closest('.network-manage__filter-btn')) {
          e.preventDefault();
          return;
        }
        colDragKey = col.key;
        th.classList.add('network-manage__th--dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', col.key);
        }
        closeFilterMenu();
        closeContextMenu();
        closeFillEditor();
      });
      th.addEventListener('dragend', () => {
        colDragKey = null;
        clearColumnDropIndicators();
      });
      th.addEventListener('dragover', (e) => {
        if (!colDragKey && !e.dataTransfer?.types.includes('text/plain')) return;
        if (colDragKey === col.key) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = th.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        for (const el of table.querySelectorAll(
          '.network-manage__th--drop-before, .network-manage__th--drop-after',
        )) {
          if (el !== th) {
            el.classList.remove('network-manage__th--drop-before', 'network-manage__th--drop-after');
          }
        }
        th.classList.toggle('network-manage__th--drop-before', !after);
        th.classList.toggle('network-manage__th--drop-after', after);
      });
      th.addEventListener('dragleave', (e) => {
        if (e.relatedTarget instanceof Node && th.contains(e.relatedTarget)) return;
        th.classList.remove('network-manage__th--drop-before', 'network-manage__th--drop-after');
      });
      th.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromKey = (e.dataTransfer?.getData('text/plain') || colDragKey || '').trim();
        const rect = th.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        colDragKey = null;
        clearColumnDropIndicators();
        reorderVisibleColumn(fromKey, col.key, after);
      });

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
      const loading = typeof opts.isLoading === 'function' && opts.isLoading();
      td.textContent = loading
        ? 'Loading…'
        : anyFilterOrSort()
          ? 'No people match these filters'
          : 'No people match';
      tr.append(td);
      tbody.append(tr);
    } else {
      contacts.forEach((c, rowIdx) => {
        const tr = document.createElement('tr');
        tr.className = 'network-manage__row';
        tr.dataset.contactId = c.id;
        tr.dataset.rowIdx = String(rowIdx);

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
          syncSelectionUi();
        });
        tdCheck.append(cb);
        tr.append(tdCheck);

        for (const col of cols) {
          const td = document.createElement('td');
          td.className = 'network-manage__td network-manage__cell';
          td.dataset.colKey = col.key;
          td.dataset.rowIdx = String(rowIdx);
          const val = col.get(c);
          const editable = canInlineEditColumn(col);
          if (col.key === 'displayName') {
            const nameWrap = document.createElement('span');
            nameWrap.className = 'network-manage__name-wrap';
            const name = document.createElement('span');
            name.className = 'network-manage__name';
            name.textContent = val || 'Untitled';
            nameWrap.append(name);
            if (c.intakeReviewed === false) {
              const badge = document.createElement('span');
              badge.className = 'network-crm__new-intake network-manage__new-intake';
              badge.title = 'New from Telegram';
              badge.setAttribute('aria-label', 'New from Telegram');
              nameWrap.append(badge);
            }
            if (c.enrichment?.needsReview) {
              const badge = document.createElement('span');
              badge.className = 'network-crm__enrich-review network-manage__enrich-review';
              badge.title = 'Last enrichment needs review';
              badge.setAttribute('aria-label', 'Last enrichment needs review');
              badge.innerHTML =
                '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 2.2c.55 0 1 .45 1 1v4.1a1 1 0 1 1-2 0V4.7c0-.55.45-1 1-1zm0 8.1a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1z"/></svg>';
              nameWrap.append(badge);
            }
            td.append(nameWrap);
          } else {
            td.textContent = val;
            td.title = val;
          }

          const canFill = canFillColumn(col);
          if (editable) {
            td.classList.add('network-manage__cell--editable');
          }
          if (canFill) {
            td.classList.add('network-manage__cell--fillable');
            td.title = val
              ? `${val}\nDouble-click to edit · drag corner to fill`
              : 'Double-click to edit · drag corner to fill';
            const handle = document.createElement('span');
            handle.className = 'network-manage__fill-handle';
            handle.title = isAppendableColumn(col)
              ? `Drag to copy ${col.label} onto rows above or below (overwrite or append)`
              : `Drag to copy ${col.label} onto rows above or below`;
            handle.setAttribute('aria-label', `Fill ${col.label} onto other rows`);
            handle.addEventListener('mousedown', (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              if (cellEdit) void commitCellEdit();
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
          } else if (opensDetailsOnActivate(col)) {
            td.title = val
              ? `${val}\nDouble-click to open details`
              : 'Double-click to open details';
          } else if (editable) {
            td.title = val
              ? `${val}\nDouble-click to edit · right-click for details`
              : 'Double-click to edit · right-click for details';
          } else {
            td.title = val
              ? `${val}\nRight-click → Open details`
              : 'Right-click → Open details';
          }

          td.addEventListener('dblclick', (e) => {
            if (
              e.target instanceof HTMLElement &&
              e.target.closest(
                'input, textarea, select, .network-manage__cell-multi, .network-manage__fill-handle, .network-manage__filter-btn, .network-manage__fill-editor',
              )
            ) {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (opensDetailsOnActivate(col) || !editable) {
              opts.onSelectContact(c.id);
            } else {
              startCellEdit(col.key, rowIdx);
            }
          });

          td.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target instanceof HTMLElement && e.target.closest('.network-manage__fill-handle, input, textarea, select, .network-manage__cell-multi')) {
              return;
            }
            if (cellEdit) {
              const same = cellEdit.colKey === col.key && cellEdit.rowIdx === rowIdx;
              if (same) return;
              e.preventDefault();
              void commitCellEdit().then(() => {
                selectSingleCell(col.key, rowIdx);
              });
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

            // Keep a multi-cell selection when clicking inside it so right-click
            // Fill… can target the range without collapsing it.
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
              paintFillRange(fillDrag.colKey, fillDrag.startRow, fillDrag.endRow);
              return;
            }
            if (selectDrag && selectDrag.colKey === col.key) {
              selectRowRange(selectDrag.colKey, selectDrag.startRow, rowIdx);
            }
          });

          td.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (cellEdit) {
              void commitCellEdit().then(() => {
                openContextMenu(e.clientX, e.clientY, { colKey: col.key, rowIdx });
              });
              return;
            }
            openContextMenu(e.clientX, e.clientY, { colKey: col.key, rowIdx });
          });

          tr.append(td);
        }
        tbody.append(tr);
      });
    }
    table.append(tbody);
    paintSelection();
    syncScrollerToViewport();
  }

  window.addEventListener('mousemove', (e) => {
    if (!fillDrag) return;
    syncFillEndFromPointer(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', (e) => {
    if (fillDrag) void applyFill(e.clientX, e.clientY);
    selectDrag = null;
  });

  scroller.addEventListener(
    'scroll',
    () => {
      if (cellEdit?.floating) void commitCellEdit();
    },
    { passive: true },
  );

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (cellEdit && !cellEdit.el.contains(t) && !cellEditorFloat.contains(t)) {
      void commitCellEdit();
    }
    if (!colsPanel.hidden && !colsPanel.contains(t) && !colsBtn.contains(t)) {
      setColsPanelOpen(false);
    }
    if (!filterMenu.hidden && !filterMenu.contains(t)) {
      const filterBtn = t instanceof Element ? t.closest('.network-manage__filter-btn') : null;
      if (!filterBtn) closeFilterMenu();
    }
    if (!ctxMenu.hidden && !ctxMenu.contains(t)) closeContextMenu();
    if (!fillEditor.hidden && !fillEditor.contains(t)) {
      if (ignoreFillEditorOutsideClick) return;
      closeFillEditor();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (cellEdit) {
        cancelCellEdit();
        return;
      }
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

    const isArrow =
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight';
    const typingTarget =
      e.target instanceof HTMLElement &&
      (e.target.closest('input, textarea, select, [contenteditable="true"]') ||
        e.target.isContentEditable);
    // Spreadsheet-style: arrows move the highlighted cell even if a search
    // box still has focus. Inline cell editors keep their own caret/keys.
    if (typingTarget && !(isArrow && cellSel && !cellEdit)) return;
    if (!root.isConnected) return;
    if (!cellSel && !(e.target instanceof Node && root.contains(e.target))) return;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && cellSel) {
      const key = e.key.toLowerCase();
      if (key === 'c') {
        e.preventDefault();
        void copySelectedCells();
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        void pasteIntoSelectedCells();
        return;
      }
    }

    if ((e.key === 'Enter' || e.key === 'F2') && cellSel) {
      e.preventDefault();
      const col = colByKey(cellSel.colKey);
      const focusRow = cellSel.focus;
      if (opensDetailsOnActivate(col) || !canInlineEditColumn(col)) {
        const c = contactAt(focusRow);
        if (c) opts.onSelectContact(c.id);
      } else {
        startCellEdit(cellSel.colKey, focusRow);
      }
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && cellSel && !mod) {
      e.preventDefault();
      void clearSelectedCells();
      return;
    }

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

  syncScrollerToViewport();

  // #region agent log
  (() => {
    const payload = {
      sessionId: 'e55622',
      runId: 'post-fix',
      hypothesisId: 'F',
      location: 'network-manage-table.js:mount',
      message: 'manage column order probe',
      data: {
        buildTag: 'birthday-row-2',
        storageKey: STORAGE_KEY,
        visibleKeys: [...visibleKeys],
        clusterSlice: (() => {
          const idxs = ATTR_CLUSTER_KEYS.map((k) => visibleKeys.indexOf(k)).filter((i) => i >= 0);
          if (!idxs.length) return [];
          const a = Math.min(...idxs);
          const b = Math.max(...idxs);
          return visibleKeys.slice(a, b + 1);
        })(),
      },
      timestamp: Date.now(),
    };
    fetch('http://127.0.0.1:7876/ingest/1b066eee-66f3-47a1-b65d-c1c076370e22', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e55622' },
      body: JSON.stringify(payload),
    }).catch(() => {});
    fetch('/api/dev-agent-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  })();
  // #endregion

  return {
    render,
    syncSelectionUi,
    destroy() {
      window.removeEventListener('resize', onViewportChange);
      window.visualViewport?.removeEventListener('resize', onViewportChange);
      scrollFitObs.disconnect();
      closeCellEditorFloat();
      cellEditorFloat.remove();
      root.replaceChildren();
      root.classList.remove('network-manage');
    },
  };
}
