import { contactActions } from '../lib/contact-deep-links.js';
import { formatContactBirthday } from '../lib/network-birthday.js';
import {
  CONTACT_REGION_IN_BAY,
  CONTACT_REGION_OUT,
  contactRegionAttribute,
} from '../lib/network-contact-region.js';
import {
  pushMobileNav,
  mobileNavBack,
  isMobileNavApplying,
} from '../lib/mobile-history.js';

const RELATIONSHIP_STATUSES = [
  'Lead',
  'Acquaintance',
  'Cultivating',
  'Inner Circle',
  'Collaborator',
  'Meta',
  'Family',
  'Paused',
  'Former',
];

const RATINGS = ['Fan', 'Hot', 'Warm', 'Cold'];

const REGION_FILTER_OPTIONS = [CONTACT_REGION_IN_BAY, CONTACT_REGION_OUT];

/** Default mobile people filters on first load (cleared filters = All). */
const DEFAULT_MOBILE_PEOPLE_FILTERS = {
  kinds: ['friend', 'organizer'],
  hasTasks: [],
  relationships: ['Cultivating', 'Meta', 'Inner Circle', 'Collaborator', 'Family'],
  statuses: ['Fan', 'Hot', 'Warm'],
  regions: [CONTACT_REGION_IN_BAY],
  hidePaused: true,
  hideFormer: true,
};

const METHOD_LABELS = {
  phone: 'Phone',
  office_phone: 'Office phone',
  email: 'Email',
  signal: 'Signal',
  whatsapp: 'WhatsApp',
  messenger: 'FB Messenger',
  linkedin: 'LinkedIn',
  other: 'Other',
};

const DEFAULT_METHODS = Object.keys(METHOD_LABELS);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asFilterList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))];
  }
  const s = String(value || '').trim();
  return s ? [s] : [];
}

/**
 * @param {object} c
 * @returns {string}
 */
function contactName(c) {
  return String(c?.displayName || '').trim() || 'Unnamed';
}

/**
 * @param {object} c
 * @returns {string}
 */
function contactSub(c) {
  const nick = String(c?.nickname || '').trim();
  const org = String(c?.organizationName || c?.org || '').trim();
  return [nick, org].filter(Boolean).join(' · ');
}

/**
 * @param {string} label
 * @param {string} name
 * @param {string} value
 * @param {{ type?: string, rows?: number, options?: string[], placeholder?: string, maxLength?: number }} [opts]
 */
function field(label, name, value, opts = {}) {
  const wrap = document.createElement('label');
  wrap.className = 'mobile-network__field';
  const span = document.createElement('span');
  span.className = 'mobile-network__field-label';
  span.textContent = label;
  wrap.append(span);

  if (Array.isArray(opts.options)) {
    const sel = document.createElement('select');
    sel.name = name;
    sel.className = 'mobile-network__input';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '—';
    sel.append(blank);
    for (const opt of opts.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (String(value || '') === opt) o.selected = true;
      sel.append(o);
    }
    wrap.append(sel);
    return wrap;
  }

  if (opts.rows && opts.rows > 1) {
    const ta = document.createElement('textarea');
    ta.name = name;
    ta.className = 'mobile-network__input';
    ta.rows = opts.rows;
    ta.value = value || '';
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    if (opts.maxLength) ta.maxLength = opts.maxLength;
    wrap.append(ta);
    return wrap;
  }

  const input = document.createElement('input');
  input.type = opts.type || 'text';
  input.name = name;
  input.className = 'mobile-network__input';
  input.value = value || '';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.maxLength) input.maxLength = opts.maxLength;
  wrap.append(input);
  return wrap;
}

/**
 * Mobile contacts: list + editable detail (subset of CRM fields) + tap-to-open actions.
 * @param {HTMLElement | null} root
 */
export function mountNetworkContactsMobile(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-network');

  const toolbar = document.createElement('div');
  toolbar.className = 'mobile-network__toolbar';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'mobile-network__search';
  search.placeholder = 'Search contacts';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search contacts');

  /**
   * Multi-select filter control (checkbox dropdown). Empty selection = All.
   * @param {string} label
   * @param {string} name
   * @param {(string | { value: string, label: string })[]} options
   */
  function makeFilterMultiSelect(label, name, options) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'mobile-network__filter mobile-network__filter--multi';
    const span = document.createElement('span');
    span.textContent = label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-network__filter-select mobile-network__filter-multi-btn';
    btn.name = name;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'mobile-network__filter-multi-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label);
    menu.setAttribute('aria-multiselectable', 'true');
    /** @type {any} */
    (menu)._filterBtn = btn;

    /** @type {{ value: string, label: string }[]} */
    let optionList = [];
    /** @type {Set<string>} */
    let selected = new Set();
    /** @type {(() => void) | null} */
    let changeHandler = null;

    function summarize() {
      if (!selected.size) return 'All';
      const labels = optionList.filter((o) => selected.has(o.value)).map((o) => o.label);
      if (labels.length === 1) return labels[0];
      if (labels.length === 2) return `${labels[0]}, ${labels[1]}`;
      return `${labels[0]} +${labels.length - 1}`;
    }

    function syncBtn() {
      btn.textContent = summarize();
      wrapEl.classList.toggle('mobile-network__filter--active', selected.size > 0);
    }

    function paintMenu() {
      menu.replaceChildren();
      const actions = document.createElement('div');
      actions.className = 'mobile-network__filter-multi-actions';
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'mobile-network__filter-multi-link';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        if (!selected.size) return;
        selected.clear();
        paintMenu();
        syncBtn();
        changeHandler?.();
      });
      actions.append(clearBtn);
      menu.append(actions);
      for (const opt of optionList) {
        const lab = document.createElement('label');
        lab.className = 'mobile-network__filter-multi-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt.value;
        cb.checked = selected.has(opt.value);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(opt.value);
          else selected.delete(opt.value);
          syncBtn();
          changeHandler?.();
        });
        lab.append(cb, document.createTextNode(` ${opt.label}`));
        menu.append(lab);
      }
    }

    /**
     * @param {(string | { value: string, label: string })[]} opts
     */
    function setOptions(opts) {
      optionList = (opts || []).map((opt) =>
        typeof opt === 'string' ? { value: opt, label: opt } : { value: opt.value, label: opt.label },
      );
      const valid = new Set(optionList.map((o) => o.value));
      selected = new Set([...selected].filter((v) => valid.has(v)));
      paintMenu();
      syncBtn();
    }

    function getSelected() {
      return optionList.filter((o) => selected.has(o.value)).map((o) => o.value);
    }

    /**
     * @param {unknown} values
     */
    function setSelected(values) {
      const valid = new Set(optionList.map((o) => o.value));
      selected = new Set(asFilterList(values).filter((v) => valid.has(v)));
      paintMenu();
      syncBtn();
    }

    /**
     * @param {() => void} fn
     */
    function onChange(fn) {
      changeHandler = fn;
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = menu.hidden;
      closeOpenFilterMenu();
      if (opening) {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        openFilterMenu = menu;
      }
    });

    setOptions(options);
    wrapEl.append(span, btn, menu);
    return { wrapEl, getSelected, setSelected, setOptions, onChange };
  }

  /**
   * @param {string} label
   * @param {string} name
   * @param {boolean} checked
   */
  function makeDefaultFilterCheck(label, name, checked) {
    const lab = document.createElement('label');
    lab.className = 'mobile-network__filter-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = name;
    cb.checked = checked;
    cb.setAttribute('aria-label', label);
    lab.append(cb, document.createTextNode(` ${label}`));
    return { lab, cb };
  }

  const filterBar = document.createElement('div');
  filterBar.className = 'mobile-network__filters';
  filterBar.setAttribute('aria-label', 'Filter people');

  /** @type {HTMLElement | null} */
  let openFilterMenu = null;

  function closeOpenFilterMenu() {
    if (!openFilterMenu) return;
    openFilterMenu.hidden = true;
    const ownerBtn = /** @type {HTMLElement | undefined} */ (openFilterMenu._filterBtn);
    if (ownerBtn) ownerBtn.setAttribute('aria-expanded', 'false');
    openFilterMenu = null;
  }

  const hasTaskFilter = makeFilterMultiSelect('Has task', 'filter-has-task', [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ]);
  const relationshipFilter = makeFilterMultiSelect(
    'Relationship',
    'filter-relationship',
    RELATIONSHIP_STATUSES,
  );
  const statusFilter = makeFilterMultiSelect('Status', 'filter-status', RATINGS);
  const regionFilter = makeFilterMultiSelect('Region', 'filter-region', REGION_FILTER_OPTIONS);
  const kindFilter = makeFilterMultiSelect('Type', 'filter-kind', [
    { value: 'friend', label: 'Friend' },
    { value: 'organizer', label: 'Organizer' },
    { value: 'business', label: 'Business' },
    { value: 'family', label: 'Family' },
  ]);
  const hidePausedFilter = makeDefaultFilterCheck('Hide Paused', 'filter-hide-paused', true);
  const hideFormerFilter = makeDefaultFilterCheck('Hide Former', 'filter-hide-former', true);
  const defaultFilters = document.createElement('div');
  defaultFilters.className = 'mobile-network__filter mobile-network__filter--default';
  defaultFilters.setAttribute('aria-label', 'Default filters');
  const defaultLabel = document.createElement('span');
  defaultLabel.textContent = 'Default';
  const defaultRows = document.createElement('div');
  defaultRows.className = 'mobile-network__filter-default-stack';
  defaultRows.append(hidePausedFilter.lab, hideFormerFilter.lab);
  defaultFilters.append(defaultLabel, defaultRows);

  filterBar.append(
    kindFilter.wrapEl,
    relationshipFilter.wrapEl,
    statusFilter.wrapEl,
    regionFilter.wrapEl,
    hasTaskFilter.wrapEl,
    defaultFilters,
  );
  toolbar.append(search, filterBar);

  const selectionBar = document.createElement('div');
  selectionBar.className = 'mobile-network__selection-bar';
  selectionBar.hidden = true;
  const selectionCount = document.createElement('span');
  selectionCount.className = 'mobile-network__selection-count';
  const addToGroupBtn = document.createElement('button');
  addToGroupBtn.type = 'button';
  addToGroupBtn.className = 'mobile-network__selection-btn mobile-network__selection-btn--primary';
  addToGroupBtn.textContent = 'Add to group';
  const clearSelectionBtn = document.createElement('button');
  clearSelectionBtn.type = 'button';
  clearSelectionBtn.className = 'mobile-network__selection-btn';
  clearSelectionBtn.textContent = 'Clear';
  selectionBar.append(selectionCount, addToGroupBtn, clearSelectionBtn);

  const listPane = document.createElement('div');
  listPane.className = 'mobile-network__list-pane';
  const list = document.createElement('ul');
  list.className = 'mobile-network__list';
  listPane.append(list);

  const detailPane = document.createElement('div');
  detailPane.className = 'mobile-network__detail-pane';
  detailPane.hidden = true;

  const status = document.createElement('p');
  status.className = 'mobile-network__status';
  status.textContent = 'Loading…';

  root.append(toolbar, selectionBar, status, listPane, detailPane);

  /** @type {object[]} */
  let contacts = [];
  /** @type {string[]} */
  let methodOptions = DEFAULT_METHODS.slice();
  /** @type {string[]} */
  let relationshipOptions = RELATIONSHIP_STATUSES.slice();
  /** @type {string | null} */
  let selectedId = null;
  /** @type {Set<string>} */
  const selectedContactIds = new Set();
  let dirty = false;

  let peopleFilters = { ...DEFAULT_MOBILE_PEOPLE_FILTERS };

  function syncPeopleFiltersFromUi() {
    peopleFilters = {
      kinds: kindFilter.getSelected(),
      hasTasks: hasTaskFilter.getSelected(),
      relationships: relationshipFilter.getSelected(),
      statuses: statusFilter.getSelected(),
      regions: regionFilter.getSelected(),
      hidePaused: hidePausedFilter.cb.checked,
      hideFormer: hideFormerFilter.cb.checked,
    };
  }

  function applyDefaultPeopleFiltersToUi() {
    peopleFilters = { ...DEFAULT_MOBILE_PEOPLE_FILTERS };
    kindFilter.setSelected(peopleFilters.kinds);
    hasTaskFilter.setSelected(peopleFilters.hasTasks);
    relationshipFilter.setSelected(peopleFilters.relationships);
    statusFilter.setSelected(peopleFilters.statuses);
    regionFilter.setSelected(peopleFilters.regions);
    hidePausedFilter.cb.checked = peopleFilters.hidePaused !== false;
    hideFormerFilter.cb.checked = peopleFilters.hideFormer !== false;
  }

  /**
   * @param {object[]} listIn
   * @returns {object[]}
   */
  function filteredByPeopleFilters(listIn = contacts) {
    return listIn.filter((c) => {
      if (peopleFilters.kinds.length) {
        const kinds = Array.isArray(c.kinds) ? c.kinds.map((k) => String(k).toLowerCase()) : [];
        const want = peopleFilters.kinds.map((k) => k.toLowerCase());
        if (!want.some((k) => kinds.includes(k))) return false;
      }
      if (peopleFilters.hasTasks.length === 1) {
        const hasOpen = Array.isArray(c.tasks)
          ? c.tasks.some((t) => t && !t.done && String(t.text || '').trim())
          : Boolean(String(c.nextStep || '').trim());
        if (peopleFilters.hasTasks[0] === 'yes' && !hasOpen) return false;
        if (peopleFilters.hasTasks[0] === 'no' && hasOpen) return false;
      }
      if (peopleFilters.relationships.length) {
        if (!peopleFilters.relationships.includes(String(c.relationshipStatus || ''))) return false;
      } else {
        const rel = String(c.relationshipStatus || '');
        if (peopleFilters.hidePaused && rel === 'Paused') return false;
        if (peopleFilters.hideFormer && rel === 'Former') return false;
      }
      if (peopleFilters.statuses.length) {
        if (!peopleFilters.statuses.includes(String(c.rating || ''))) return false;
      }
      if (peopleFilters.regions.length) {
        const region = contactRegionAttribute(c);
        if (!peopleFilters.regions.includes(region)) return false;
      }
      return true;
    });
  }

  /**
   * @param {string} q
   * @returns {object[]}
   */
  function filtered(q) {
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const base = filteredByPeopleFilters();
    if (!needle) return base;
    return base.filter((c) => {
      const ch = c.channels || {};
      const hay = [
        c.displayName,
        c.nickname,
        c.firstName,
        c.lastName,
        c.memoryJog,
        c.org,
        c.location,
        c.bio,
        ch.email,
        ch.phone,
        ch.whatsapp,
        ch.signal,
        ch.messenger,
        ch.linkedin,
        ch.other,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  function showList() {
    selectedId = null;
    dirty = false;
    detailPane.hidden = true;
    detailPane.replaceChildren();
    listPane.hidden = false;
    toolbar.hidden = false;
    syncSelectionUi();
  }

  function syncSelectionUi() {
    const n = selectedContactIds.size;
    selectionBar.hidden = n === 0 || !detailPane.hidden;
    if (n === 0) return;
    selectionCount.textContent = n === 1 ? '1 selected' : `${n} selected`;
    addToGroupBtn.textContent = n === 1 ? 'Add to group' : `Add to group (${n})`;
  }

  /**
   * Mobile-friendly group picker (replaces desktop prompt()).
   * @param {object[]} groups
   * @param {number} contactCount
   * @returns {Promise<object | null>}
   */
  function openGroupPickerDialog(groups, contactCount) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'mobile-network__sheet-backdrop';
      backdrop.setAttribute('role', 'presentation');

      const sheet = document.createElement('div');
      sheet.className = 'mobile-network__sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', 'Add to group');

      const header = document.createElement('div');
      header.className = 'mobile-network__sheet-head';
      const title = document.createElement('h3');
      title.className = 'mobile-network__sheet-title';
      title.textContent =
        contactCount === 1 ? 'Add 1 contact to group' : `Add ${contactCount} contacts to group`;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mobile-network__sheet-close';
      closeBtn.textContent = 'Cancel';
      header.append(title, closeBtn);

      const listEl = document.createElement('ul');
      listEl.className = 'mobile-network__sheet-list';

      let settled = false;
      /** @param {object | null} group */
      function finish(group) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        resolve(group);
      }

      /** @param {KeyboardEvent} e */
      function onKey(e) {
        if (e.key === 'Escape') finish(null);
      }

      for (const g of groups) {
        const kind = g.kind === 'event' ? 'Event' : 'Community';
        const typeBit = g.kind === 'event' && g.eventType ? ` · ${g.eventType}` : '';
        const memberCount = Array.isArray(g.memberIds) ? g.memberIds.length : 0;
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mobile-network__sheet-option';
        const name = document.createElement('span');
        name.className = 'mobile-network__sheet-option-name';
        name.textContent = g.name || 'Untitled';
        const meta = document.createElement('span');
        meta.className = 'mobile-network__sheet-option-meta';
        meta.textContent = `[${kind}${typeBit}] · ${memberCount} member${memberCount === 1 ? '' : 's'}`;
        btn.append(name, meta);
        btn.addEventListener('click', () => finish(g));
        li.append(btn);
        listEl.append(li);
      }

      closeBtn.addEventListener('click', () => finish(null));
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) finish(null);
      });

      sheet.append(header, listEl);
      backdrop.append(sheet);
      document.body.append(backdrop);
      document.addEventListener('keydown', onKey);
      closeBtn.focus();
    });
  }

  /**
   * @param {HTMLFormElement} form
   * @param {object} current
   */
  function buildBody(form, current) {
    const fd = new FormData(form);
    const kindsSel = ['friend', 'organizer', 'business', 'family'].filter(
      (k) => form.querySelector(`[name="kind-${k}"]`)?.checked,
    );
    const prefs = methodOptions.filter((m) => form.querySelector(`[name="pref-${m}"]`)?.checked);

    /** @type {{ id: string, text: string, done: boolean }[]} */
    let tasks = [];
    const tasksEl = form.querySelector('[data-tasks-field]');
    if (tasksEl && typeof /** @type {any} */ (tasksEl).getTasks === 'function') {
      tasks = /** @type {any} */ (tasksEl).getTasks();
    } else if (Array.isArray(current.tasks)) {
      tasks = current.tasks;
    }

    return {
      displayName: String(fd.get('displayName') || '').trim(),
      nickname: String(fd.get('nickname') || '').trim(),
      memoryJog: String(fd.get('memoryJog') || '').trim().slice(0, 80),
      org: String(fd.get('org') || '').trim(),
      kinds: kindsSel.length ? kindsSel : ['friend'],
      location: String(fd.get('location') || '').trim(),
      relationshipStatus: String(fd.get('relationshipStatus') || '').trim(),
      rating: String(fd.get('rating') || '').trim(),
      tasks,
      bio: String(fd.get('bio') || '').trim(),
      alignedActivities: String(fd.get('alignedActivities') || '')
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean),
      preferredContactMethods: prefs,
      birthday: String(fd.get('birthday') || '').trim(),
      channels: {
        email: String(fd.get('email') ?? current.channels?.email ?? '').trim() || null,
        phone: String(fd.get('phone') ?? current.channels?.phone ?? '').trim() || null,
        officePhone:
          String(fd.get('officePhone') ?? current.channels?.officePhone ?? '').trim() || null,
        sms: current.channels?.sms || null,
        signal: String(fd.get('signal') ?? current.channels?.signal ?? '').trim() || null,
        whatsapp: String(fd.get('whatsapp') ?? current.channels?.whatsapp ?? '').trim() || null,
        telegram: current.channels?.telegram || null,
        messenger:
          String(fd.get('messenger') ?? current.channels?.messenger ?? '').trim() || null,
        linkedin: String(fd.get('linkedin') ?? current.channels?.linkedin ?? '').trim() || null,
        other: String(fd.get('other') ?? current.channels?.other ?? '').trim() || null,
        urls: Array.isArray(current.channels?.urls) ? [...current.channels.urls] : [],
      },
    };
  }

  /**
   * @param {object} c
   * @param {{ fromHistory?: boolean }} [opts]
   */
  function showDetail(c, opts = {}) {
    selectedId = c.id;
    dirty = false;
    listPane.hidden = true;
    toolbar.hidden = true;
    selectionBar.hidden = true;
    detailPane.hidden = false;
    detailPane.replaceChildren();

    if (!opts.fromHistory && !isMobileNavApplying()) {
      pushMobileNav({ tab: 'network', pane: 'contact', contactId: String(c.id) });
    }

    /** @type {object} */
    let current = c;

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-network__back';
    back.textContent = '← Contacts';
    back.addEventListener('click', () => {
      if (dirty && !confirm('Discard unsaved changes?')) return;
      mobileNavBack();
    });

    const head = document.createElement('div');
    head.className = 'mobile-network__detail-head';
    const avatar = document.createElement('div');
    avatar.className = 'mobile-network__avatar mobile-network__avatar--lg';
    const avatarUrl = String(current.avatarUrl || '').trim();
    if (avatarUrl) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      avatar.append(img);
    } else {
      avatar.textContent = contactName(current).slice(0, 1).toUpperCase();
    }
    const titles = document.createElement('div');
    titles.className = 'mobile-network__detail-titles';
    const nameEl = document.createElement('h2');
    nameEl.className = 'mobile-network__detail-name';
    nameEl.textContent = contactName(current);
    const sub = document.createElement('p');
    sub.className = 'mobile-network__detail-sub';
    const subText = contactSub(current);
    if (subText) sub.textContent = subText;
    else sub.hidden = true;
    titles.append(nameEl, sub);
    head.append(avatar, titles);

    const form = document.createElement('form');
    form.className = 'mobile-network__form';
    form.addEventListener('input', () => {
      dirty = true;
    });
    form.addEventListener('change', () => {
      dirty = true;
    });

    const preferred = new Set(current.preferredContactMethods || []);
    /** @type {Record<string, HTMLElement>} */
    const channelFields = {
      phone: field('Phone', 'phone', current.channels?.phone || ''),
      office_phone: field('Office phone', 'officePhone', current.channels?.officePhone || ''),
      email: field('Email', 'email', current.channels?.email || '', { type: 'email' }),
      signal: field('Signal', 'signal', current.channels?.signal || ''),
      whatsapp: field('WhatsApp', 'whatsapp', current.channels?.whatsapp || ''),
      messenger: field('FB Messenger', 'messenger', current.channels?.messenger || '', {
        placeholder: 'm.me/username or Facebook URL',
      }),
      linkedin: field('LinkedIn', 'linkedin', current.channels?.linkedin || '', { type: 'url' }),
      other: field('Other', 'other', current.channels?.other || ''),
    };

    const methodsBox = document.createElement('div');
    methodsBox.className = 'mobile-network__checks';
    /** @type {Map<string, HTMLInputElement>} */
    const prefChecks = new Map();
    function syncChannelVisibility() {
      for (const [method, el] of Object.entries(channelFields)) {
        el.hidden = !prefChecks.get(method)?.checked;
      }
    }
    for (const m of methodOptions) {
      const lab = document.createElement('label');
      lab.className = 'mobile-network__check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `pref-${m}`;
      cb.value = m;
      cb.checked = preferred.has(m);
      prefChecks.set(m, cb);
      cb.addEventListener('change', syncChannelVisibility);
      lab.append(cb, document.createTextNode(` ${METHOD_LABELS[m] || m}`));
      methodsBox.append(lab);
    }
    syncChannelVisibility();

    const sectionPref = document.createElement('div');
    sectionPref.className = 'mobile-network__section';

    const prefHead = document.createElement('div');
    prefHead.className = 'mobile-network__section-head';
    const prefTitle = document.createElement('h3');
    prefTitle.className = 'mobile-network__section-title';
    prefTitle.textContent = 'Preferred contact methods';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'mobile-network__section-edit';
    editBtn.textContent = 'Edit';
    prefHead.append(prefTitle, editBtn);

    const linksBox = document.createElement('div');
    linksBox.className = 'mobile-network__pref-links';
    const linksEmpty = document.createElement('p');
    linksEmpty.className = 'mobile-network__empty';
    linksEmpty.textContent = 'No preferred methods yet — tap Edit to add.';

    const editBox = document.createElement('div');
    editBox.className = 'mobile-network__pref-edit';
    editBox.hidden = true;
    editBox.append(methodsBox, ...Object.values(channelFields));

    /**
     * @param {object} contact
     * @returns {import('../lib/contact-deep-links.js').ContactAction[]}
     */
    function preferredOpenActions(contact) {
      const pref = new Set(
        (Array.isArray(contact?.preferredContactMethods)
          ? contact.preferredContactMethods
          : []
        ).map((m) => String(m)),
      );
      if (!pref.size) return [];
      return contactActions(contact).filter((a) => {
        if (!a.href) return false;
        if (a.id === 'sms') return pref.has('phone');
        if (a.id === 'office_phone') return pref.has('office_phone');
        return pref.has(a.id);
      });
    }

    /**
     * @param {object} contact
     */
    function paintPreferredLinks(contact) {
      linksBox.replaceChildren();
      const items = preferredOpenActions(contact);
      if (!items.length) {
        linksBox.append(linksEmpty);
        return;
      }
      for (const a of items) {
        const link = document.createElement('a');
        link.className = 'mobile-network__action';
        link.href = a.href;
        if (/^https?:/i.test(a.href)) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        link.textContent = a.label;
        linksBox.append(link);
      }
    }

    let editingPrefs = false;
    function setPrefEditMode(on) {
      editingPrefs = on;
      editBtn.textContent = on ? 'Done' : 'Edit';
      editBox.hidden = !on;
      linksBox.hidden = on;
      if (!on) {
        paintPreferredLinks({ ...current, ...buildBody(form, current) });
      }
    }
    editBtn.addEventListener('click', () => {
      setPrefEditMode(!editingPrefs);
    });

    paintPreferredLinks(current);
    sectionPref.append(prefHead, linksBox, editBox);

    const kindsBox = document.createElement('div');
    kindsBox.className = 'mobile-network__checks';
    const kindsLabel = document.createElement('span');
    kindsLabel.className = 'mobile-network__field-label';
    kindsLabel.textContent = 'Type';
    kindsBox.append(kindsLabel);
    const kinds = new Set(current.kinds || ['friend']);
    for (const k of ['friend', 'organizer', 'business', 'family']) {
      const lab = document.createElement('label');
      lab.className = 'mobile-network__check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `kind-${k}`;
      cb.value = k;
      cb.checked = kinds.has(k);
      lab.append(cb, document.createTextNode(` ${k[0].toUpperCase()}${k.slice(1)}`));
      kindsBox.append(lab);
    }

    /** @type {{ id: string, text: string, done: boolean }[]} */
    let draftTasks = Array.isArray(current.tasks)
      ? current.tasks
          .map((t) => ({
            id: String(t.id || `task_${Math.random().toString(36).slice(2, 10)}`),
            text: String(t.text || '').trim(),
            done: Boolean(t.done),
          }))
          .filter((t) => t.text)
      : [];

    const tasksWrap = document.createElement('div');
    tasksWrap.className = 'mobile-network__field mobile-network__tasks';
    tasksWrap.dataset.tasksField = '1';
    const tasksLabel = document.createElement('span');
    tasksLabel.className = 'mobile-network__field-label';
    tasksLabel.textContent = 'Tasks';
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'mobile-network__input';
    addInput.placeholder = 'Add a task…';
    addInput.autocomplete = 'off';
    const taskList = document.createElement('ul');
    taskList.className = 'mobile-network__tasks-list';

    function renderTasks() {
      taskList.replaceChildren();
      for (const task of draftTasks) {
        const li = document.createElement('li');
        li.className = 'mobile-network__tasks-item';
        if (task.done) li.classList.add('mobile-network__tasks-item--done');
        const row = document.createElement('label');
        row.className = 'mobile-network__tasks-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = task.done;
        cb.addEventListener('change', () => {
          task.done = cb.checked;
          li.classList.toggle('mobile-network__tasks-item--done', task.done);
          dirty = true;
        });
        const text = document.createElement('span');
        text.textContent = task.text;
        row.append(cb, text);
        li.append(row);
        taskList.append(li);
      }
    }
    addInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = String(addInput.value || '').trim();
      if (!text) return;
      draftTasks.push({
        id: `task_${Math.random().toString(36).slice(2, 10)}`,
        text,
        done: false,
      });
      addInput.value = '';
      dirty = true;
      renderTasks();
    });
    /** @type {any} */ (tasksWrap).getTasks = () =>
      draftTasks.map((t) => ({ id: t.id, text: t.text, done: t.done }));
    tasksWrap.append(tasksLabel, addInput, taskList);
    renderTasks();

    form.append(
      sectionPref,
      field('Name', 'displayName', current.displayName || ''),
      field('Nickname', 'nickname', current.nickname || ''),
      field('Memory jog', 'memoryJog', current.memoryJog || '', {
        placeholder: '1–2 words to remember who',
        maxLength: 80,
      }),
      field('Location', 'location', current.location || ''),
      field('Birthday', 'birthday', formatContactBirthday(current), {
        placeholder: 'e.g. March 15',
      }),
      field('Company', 'org', current.org || ''),
      field('Relationship', 'relationshipStatus', current.relationshipStatus || '', {
        options: relationshipOptions,
      }),
      field('Status', 'rating', current.rating || '', { options: RATINGS }),
      kindsBox,
      tasksWrap,
      field('Bio', 'bio', current.bio || '', { rows: 3 }),
      field('Interests', 'alignedActivities', (current.alignedActivities || []).join('\n'), {
        rows: 3,
        placeholder: 'One per line',
      }),
    );

    const saveRow = document.createElement('div');
    saveRow.className = 'mobile-network__save-row';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'mobile-network__save';
    saveBtn.textContent = 'Save';
    const saveStatus = document.createElement('p');
    saveStatus.className = 'mobile-network__save-status';
    saveStatus.hidden = true;
    saveRow.append(saveBtn, saveStatus);
    form.append(saveRow);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      saveStatus.hidden = false;
      saveStatus.textContent = 'Saving…';
      saveStatus.classList.remove('mobile-network__save-status--err');
      try {
        const body = buildBody(form, current);
        const r = await fetch(`/api/network/contacts/${encodeURIComponent(current.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) {
          throw new Error(data.error || `HTTP ${r.status}`);
        }
        current = data.contact || { ...current, ...body };
        const idx = contacts.findIndex((x) => x.id === current.id);
        if (idx >= 0) contacts[idx] = current;
        dirty = false;
        nameEl.textContent = contactName(current);
        const nextSub = contactSub(current);
        if (nextSub) {
          sub.hidden = false;
          sub.textContent = nextSub;
        } else {
          sub.hidden = true;
        }
        paintPreferredLinks(current);
        setPrefEditMode(false);
        saveStatus.textContent = 'Saved';
        setTimeout(() => {
          if (saveStatus.textContent === 'Saved') saveStatus.hidden = true;
        }, 1500);
      } catch (err) {
        saveStatus.textContent = `Save failed: ${err?.message || err}`;
        saveStatus.classList.add('mobile-network__save-status--err');
      } finally {
        saveBtn.disabled = false;
      }
    });

    detailPane.append(back, head, form);
  }

  function renderList() {
    list.replaceChildren();
    const items = filtered(search.value);
    status.hidden = true;
    if (!items.length) {
      status.hidden = false;
      status.textContent = contacts.length ? 'No matches.' : 'No contacts yet.';
      return;
    }
    for (const c of items) {
      const li = document.createElement('li');
      li.className = 'mobile-network__row';
      li.classList.toggle('mobile-network__row--selected', selectedContactIds.has(c.id));

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'mobile-network__row-select';
      check.checked = selectedContactIds.has(c.id);
      check.setAttribute('aria-label', `Select ${contactName(c)}`);
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) selectedContactIds.add(c.id);
        else selectedContactIds.delete(c.id);
        li.classList.toggle('mobile-network__row--selected', check.checked);
        syncSelectionUi();
      });

      const avatar = document.createElement('div');
      avatar.className = 'mobile-network__avatar';
      const avatarUrl = String(c.avatarUrl || '').trim();
      if (avatarUrl) {
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        avatar.append(img);
      } else {
        avatar.textContent = contactName(c).slice(0, 1).toUpperCase();
      }
      const body = document.createElement('div');
      body.className = 'mobile-network__row-body';
      const name = document.createElement('div');
      name.className = 'mobile-network__row-name';
      name.textContent = contactName(c);
      const subEl = document.createElement('div');
      subEl.className = 'mobile-network__row-sub';
      const subText = contactSub(c);
      if (subText) subEl.textContent = subText;
      else subEl.hidden = true;
      body.append(name, subEl);
      li.append(check, avatar, body);
      li.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('.mobile-network__row-select')) return;
        showDetail(c);
      });
      list.append(li);
    }
    syncSelectionUi();
  }

  search.addEventListener('input', () => {
    if (!detailPane.hidden) return;
    renderList();
  });

  function onFilterChange() {
    syncPeopleFiltersFromUi();
    if (!detailPane.hidden) return;
    renderList();
  }
  kindFilter.onChange(onFilterChange);
  hasTaskFilter.onChange(onFilterChange);
  relationshipFilter.onChange(onFilterChange);
  statusFilter.onChange(onFilterChange);
  regionFilter.onChange(onFilterChange);
  hidePausedFilter.cb.addEventListener('change', onFilterChange);
  hideFormerFilter.cb.addEventListener('change', onFilterChange);
  document.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Element && e.target.closest('.mobile-network__filter--multi')) return;
    closeOpenFilterMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOpenFilterMenu();
  });

  clearSelectionBtn.addEventListener('click', () => {
    selectedContactIds.clear();
    renderList();
  });

  addToGroupBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    status.hidden = false;
    status.textContent = 'Loading groups…';
    try {
      const r = await fetch('/api/network/groups');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'groups_failed');
      const groups = Array.isArray(j.groups) ? j.groups : [];
      if (!groups.length) {
        status.textContent = 'No groups yet — create one from the Groups tab first.';
        return;
      }
      status.hidden = true;
      const group = await openGroupPickerDialog(groups, ids.length);
      if (!group) return;
      status.hidden = false;
      status.textContent = 'Adding to group…';
      const ar = await fetch(`/api/network/groups/${encodeURIComponent(group.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: ids }),
      });
      const aj = await ar.json();
      if (!aj.ok) throw new Error(aj.error || 'add_failed');
      selectedContactIds.clear();
      syncSelectionUi();
      if (group.kind !== 'event') {
        try {
          const cr = await fetch('/api/network/contacts', { cache: 'no-store' });
          const cj = await cr.json();
          if (cr.ok && cj.ok !== false && Array.isArray(cj.contacts)) {
            contacts = cj.contacts.slice();
            contacts.sort((a, b) =>
              contactName(a).localeCompare(contactName(b), undefined, { sensitivity: 'base' }),
            );
          }
        } catch {
          /* keep existing contacts */
        }
      }
      renderList();
      status.textContent = `Added to ${group.name || 'group'}`;
      setTimeout(() => {
        if (status.textContent.startsWith('Added to')) status.hidden = true;
      }, 2000);
    } catch (err) {
      status.textContent = String(err?.message || err);
    }
  });

  async function load() {
    try {
      const r = await fetch('/api/network/contacts', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      contacts = Array.isArray(data.contacts) ? data.contacts.slice() : [];
      if (Array.isArray(data.preferredContactMethods) && data.preferredContactMethods.length) {
        methodOptions = data.preferredContactMethods;
      }
      if (Array.isArray(data.relationshipStatuses) && data.relationshipStatuses.length) {
        relationshipOptions = data.relationshipStatuses;
        relationshipFilter.setOptions(relationshipOptions);
      }
      contacts.sort((a, b) =>
        contactName(a).localeCompare(contactName(b), undefined, { sensitivity: 'base' }),
      );
      renderList();
      const navState = history.state;
      if (
        navState?.dashbirdMobile &&
        navState.tab === 'network' &&
        navState.pane === 'contact' &&
        navState.contactId
      ) {
        document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: navState }));
      }
    } catch (e) {
      status.hidden = false;
      status.textContent = `Could not load contacts: ${e?.message || e}`;
    }
  }

  applyDefaultPeopleFiltersToUi();
  void load();

  document.addEventListener('dashbird:mobile-nav', (e) => {
    const s = e.detail;
    if (!s || s.tab !== 'network') return;
    if (s.pane === 'list') {
      showList();
      renderList();
      return;
    }
    if (s.pane === 'contact' && s.contactId) {
      const c = contacts.find((x) => String(x.id) === String(s.contactId));
      if (c) showDetail(c, { fromHistory: true });
      else {
        showList();
        renderList();
      }
    }
  });
}
