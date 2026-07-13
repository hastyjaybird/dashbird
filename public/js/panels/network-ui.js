/**
 * Network CRM UI — contact list + detail editor.
 * @param {HTMLElement} root
 */

import { beginWaitCursor, endWaitCursor } from '../lib/wait-cursor.js';
import { formatContactLastContact } from '../lib/network-last-contact.js';

const METHOD_LABELS = {
  phone: 'Phone',
  email: 'Email',
  signal: 'Signal',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
  other: 'Other',
};

const DEFAULT_METHODS = Object.keys(METHOD_LABELS);

/** Friendly local display for ISO timestamps (enriched / created / updated). */
function formatNetworkTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * @param {HTMLElement} root
 */
export function mountNetworkUi(root) {
  if (!root) return;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'network-crm';

  const tabs = document.createElement('div');
  tabs.className = 'network-crm__tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Network views');

  const peopleTab = document.createElement('button');
  peopleTab.type = 'button';
  peopleTab.className = 'network-crm__tab network-crm__tab--active';
  peopleTab.setAttribute('role', 'tab');
  peopleTab.setAttribute('aria-selected', 'true');
  peopleTab.id = 'network-tab-people';
  peopleTab.textContent = 'People';

  const companiesTab = document.createElement('button');
  companiesTab.type = 'button';
  companiesTab.className = 'network-crm__tab';
  companiesTab.setAttribute('role', 'tab');
  companiesTab.setAttribute('aria-selected', 'false');
  companiesTab.id = 'network-tab-companies';
  companiesTab.textContent = 'Companies';

  const groupsTab = document.createElement('button');
  groupsTab.type = 'button';
  groupsTab.className = 'network-crm__tab';
  groupsTab.setAttribute('role', 'tab');
  groupsTab.setAttribute('aria-selected', 'false');
  groupsTab.id = 'network-tab-groups';
  groupsTab.textContent = 'Groups';

  tabs.append(peopleTab, companiesTab, groupsTab);

  const toolbar = document.createElement('div');
  toolbar.className = 'network-crm__toolbar';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'network-crm__search';
  search.placeholder = 'Search people…';
  search.autocomplete = 'off';

  const peopleActions = document.createElement('div');
  peopleActions.className = 'network-crm__toolbar-actions';
  peopleActions.dataset.view = 'people';

  const companyActions = document.createElement('div');
  companyActions.className = 'network-crm__toolbar-actions';
  companyActions.dataset.view = 'companies';
  companyActions.hidden = true;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'network-crm__btn';
  addBtn.textContent = 'Add person';

  const addCompanyBtn = document.createElement('button');
  addCompanyBtn.type = 'button';
  addCompanyBtn.className = 'network-crm__btn';
  addCompanyBtn.textContent = 'Add company';

  const bulkBtn = document.createElement('button');
  bulkBtn.type = 'button';
  bulkBtn.className = 'network-crm__btn';
  bulkBtn.textContent = 'Bulk add';

  const peopleDefaultActions = document.createElement('div');
  peopleDefaultActions.className = 'network-crm__toolbar-actions';
  peopleDefaultActions.dataset.mode = 'default';
  peopleDefaultActions.append(addBtn, bulkBtn);

  const peopleSelectionActions = document.createElement('div');
  peopleSelectionActions.className = 'network-crm__toolbar-actions';
  peopleSelectionActions.dataset.mode = 'selection';
  peopleSelectionActions.hidden = true;

  const startGroupSelBtn = document.createElement('button');
  startGroupSelBtn.type = 'button';
  startGroupSelBtn.className = 'network-crm__btn network-crm__btn--primary';
  startGroupSelBtn.textContent = 'Start group';

  const addToGroupBtn = document.createElement('button');
  addToGroupBtn.type = 'button';
  addToGroupBtn.className = 'network-crm__btn';
  addToGroupBtn.textContent = 'Add to group';

  const mergeBtn = document.createElement('button');
  mergeBtn.type = 'button';
  mergeBtn.className = 'network-crm__btn';
  mergeBtn.textContent = 'Merge';

  const deleteSelBtn = document.createElement('button');
  deleteSelBtn.type = 'button';
  deleteSelBtn.className = 'network-crm__btn network-crm__btn--danger';
  deleteSelBtn.textContent = 'Delete';

  const enhanceSelBtn = document.createElement('button');
  enhanceSelBtn.type = 'button';
  enhanceSelBtn.className = 'network-crm__btn';
  enhanceSelBtn.textContent = 'Enhance';

  peopleSelectionActions.append(
    enhanceSelBtn,
    addToGroupBtn,
    startGroupSelBtn,
    mergeBtn,
    deleteSelBtn,
  );

  peopleActions.append(peopleDefaultActions, peopleSelectionActions);
  companyActions.append(addCompanyBtn);
  toolbar.append(search, peopleActions, companyActions);

  const peopleFilterBar = document.createElement('div');
  peopleFilterBar.className = 'network-crm__filters';
  peopleFilterBar.setAttribute('aria-label', 'Filter people');

  /**
   * @param {string} label
   * @param {string} name
   * @param {(string | { value: string, label: string })[]} options
   */
  function makeFilterSelect(label, name, options) {
    const wrapEl = document.createElement('label');
    wrapEl.className = 'network-crm__filter';
    const span = document.createElement('span');
    span.textContent = label;
    const sel = document.createElement('select');
    sel.className = 'network-crm__input network-crm__filter-select';
    sel.name = name;
    sel.setAttribute('aria-label', label);
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All';
    sel.append(all);
    for (const opt of options) {
      const el = document.createElement('option');
      if (typeof opt === 'string') {
        el.value = opt;
        el.textContent = opt;
      } else {
        el.value = opt.value;
        el.textContent = opt.label;
      }
      sel.append(el);
    }
    wrapEl.append(span, sel);
    return { wrapEl, sel };
  }

  const kindFilter = makeFilterSelect('Kind', 'filter-kind', [
    { value: 'friend', label: 'Friend' },
    { value: 'organizer', label: 'Organizer' },
    { value: 'business', label: 'Business' },
  ]);
  const relationshipFilter = makeFilterSelect('Relationship', 'filter-relationship', [
    'Lead',
    'Cultivating',
    'Collaborator',
    'Family',
    'Acquaintance',
    'Paused',
    'Former',
  ]);
  const statusFilter = makeFilterSelect('Status', 'filter-status', [
    'Hot',
    'Warm',
    'Cold',
  ]);
  peopleFilterBar.append(kindFilter.wrapEl, relationshipFilter.wrapEl, statusFilter.wrapEl);

  const bulkPanel = document.createElement('div');
  bulkPanel.className = 'network-crm__bulk';
  bulkPanel.hidden = true;
  bulkPanel.innerHTML = `
    <label class="network-crm__field network-crm__field--full">
      <span>Names (one per line)</span>
      <textarea class="network-crm__input network-crm__bulk-text" rows="6" placeholder="Sam Rivera&#10;Alex Chen&#10;Jordan Lee"></textarea>
    </label>
    <div class="network-crm__checks">
      <label class="network-crm__check"><input type="checkbox" name="bulk-friend" checked> Friend</label>
      <label class="network-crm__check"><input type="checkbox" name="bulk-organizer"> Organizer</label>
      <label class="network-crm__check"><input type="checkbox" name="bulk-business"> Business</label>
    </div>
    <div class="network-crm__bulk-actions">
      <button type="button" class="network-crm__btn network-crm__btn--primary" data-bulk-submit>Add all</button>
      <button type="button" class="network-crm__btn" data-bulk-cancel>Cancel</button>
    </div>
  `;

  const layout = document.createElement('div');
  layout.className = 'network-crm__layout';

  const list = document.createElement('ul');
  list.className = 'network-crm__list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'People');
  list.setAttribute('aria-labelledby', 'network-tab-people');

  const detail = document.createElement('div');
  detail.className = 'network-crm__detail';
  detail.innerHTML = '<p class="muted">Select a person</p>';

  const status = document.createElement('p');
  status.className = 'network-crm__status muted';
  status.hidden = true;

  layout.append(list, detail);
  const mainPane = document.createElement('div');
  mainPane.className = 'network-crm__main';
  mainPane.append(toolbar, peopleFilterBar, bulkPanel, layout, status);

  const groupsPane = document.createElement('div');
  groupsPane.className = 'network-crm__groups-pane';
  groupsPane.hidden = true;

  wrap.append(tabs, mainPane, groupsPane);

  const voiceBar = document.createElement('div');
  voiceBar.className = 'network-crm__voice-bar';
  voiceBar.hidden = true;
  voiceBar.innerHTML = `
    <span class="network-crm__voice-bar-dot" aria-hidden="true"></span>
    <span class="network-crm__voice-bar-label">Recording…</span>
    <button type="button" class="network-crm__btn network-crm__btn--primary" data-voice-stop>Stop &amp; enrich</button>
  `;
  wrap.append(voiceBar);
  root.append(wrap);

  /** @type {object[]} */
  let contacts = [];
  /** @type {object[]} */
  let organizations = [];
  /** @type {string[]} */
  let methodOptions = DEFAULT_METHODS;
  /** @type {string | null} */
  let selectedId = null;
  /** @type {'people' | 'companies' | 'groups'} */
  let view = 'people';
  /** @type {boolean} */
  let groupsUiMounted = false;
  /** @type {string | null} */
  let selectedOrgId = null;
  /** @type {Set<string>} */
  const selectedContactIds = new Set();
  /** @type {Set<string>} */
  const selectedOrgIds = new Set();
  let query = '';
  /** @type {{ kind: string, relationship: string, status: string }} */
  let peopleFilters = { kind: '', relationship: '', status: '' };
  /** Session flag: org detail "More attributes" panel open */
  let orgAttrsExpanded = false;
  /** Session flag: contact detail "More attributes" panel open */
  let contactAttrsExpanded = false;
  /** Bumps when detail pane is remounted; cancels stale in-flight saves */
  let detailGeneration = 0;
  const MAX_UNDO = 25;
  /** @type {Map<string, object[]>} */
  const contactUndoStacks = new Map();
  /** @type {Map<string, object[]>} */
  const orgUndoStacks = new Map();

  /**
   * @param {unknown} a
   * @param {unknown} b
   */
  function sameJson(a, b) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * PUT body snapshot from a loaded contact (for undo restore).
   * @param {object} c
   */
  function contactToPutBody(c) {
    return {
      displayName: c.displayName || '',
      nickname: c.nickname || '',
      title: c.title || '',
      org: c.org || '',
      kinds: Array.isArray(c.kinds) && c.kinds.length ? [...c.kinds] : ['friend'],
      location: c.location || '',
      region: c.region || '',
      relationshipStatus: c.relationshipStatus || '',
      aliases: Array.isArray(c.aliases) ? [...c.aliases] : [],
      department: c.department || '',
      rating: c.rating || '',
      nextStep: c.nextStep || '',
      bio: c.bio || '',
      howWeMet: c.howWeMet || '',
      networkCircles: c.networkCircles || '',
      notes: c.notes || '',
      alignedActivities: Array.isArray(c.alignedActivities) ? [...c.alignedActivities] : [],
      preferredContactMethods: Array.isArray(c.preferredContactMethods)
        ? [...c.preferredContactMethods]
        : [],
      lastContactAt: c.lastContactAt || null,
      lastContactPrecision: c.lastContactPrecision || null,
      channels: {
        email: c.channels?.email || null,
        phone: c.channels?.phone || null,
        sms: c.channels?.sms || null,
        signal: c.channels?.signal || null,
        whatsapp: c.channels?.whatsapp || null,
        linkedin: c.channels?.linkedin || null,
        other: c.channels?.other || null,
        urls: Array.isArray(c.channels?.urls) ? [...c.channels.urls] : [],
      },
    };
  }

  /**
   * @param {object} o
   */
  function orgToPutBody(o) {
    return {
      name: o.name || '',
      type: o.type || '',
      industry: o.industry || '',
      website: o.website || null,
      description: o.description || '',
      lifecycleStatus: o.lifecycleStatus || '',
      region: o.region || '',
      location: o.location || '',
      phone: o.phone || '',
      ownership: o.ownership || '',
      accountSource: o.accountSource || '',
      rating: o.rating || '',
      annualRevenue: o.annualRevenue || '',
      employeeCount: o.employeeCount || '',
      fiscalYearEnd: o.fiscalYearEnd || '',
      competitiveNotes: o.competitiveNotes || '',
      email: o.email || '',
      linkedin: o.linkedin || null,
      socialUrls: Array.isArray(o.socialUrls) ? [...o.socialUrls] : [],
      locale: o.locale || '',
      primaryContactId: o.primaryContactId || null,
      partnerRelationships: o.partnerRelationships || '',
      nextStep: o.nextStep || '',
      summary: o.summary || '',
      aliases: Array.isArray(o.aliases) ? [...o.aliases] : [],
      urls: Array.isArray(o.urls) ? [...o.urls] : [],
    };
  }

  function syncTabs() {
    const onPeople = view === 'people';
    const onCompanies = view === 'companies';
    const onGroups = view === 'groups';
    peopleTab.classList.toggle('network-crm__tab--active', onPeople);
    companiesTab.classList.toggle('network-crm__tab--active', onCompanies);
    groupsTab.classList.toggle('network-crm__tab--active', onGroups);
    peopleTab.setAttribute('aria-selected', onPeople ? 'true' : 'false');
    companiesTab.setAttribute('aria-selected', onCompanies ? 'true' : 'false');
    groupsTab.setAttribute('aria-selected', onGroups ? 'true' : 'false');
    search.placeholder = onPeople ? 'Search people…' : onCompanies ? 'Search companies…' : 'Search groups…';
    peopleActions.hidden = !onPeople;
    companyActions.hidden = !onCompanies;
    peopleFilterBar.hidden = !onPeople;
    mainPane.hidden = onGroups;
    groupsPane.hidden = !onGroups;
    if (!onPeople) bulkPanel.hidden = true;
    syncSelectionActions();
  }

  function syncSelectionActions() {
    const n = selectedContactIds.size;
    const selecting = n > 0 && view === 'people';
    peopleDefaultActions.hidden = selecting;
    peopleSelectionActions.hidden = !selecting;
    const count = n ? ` (${n})` : '';
    startGroupSelBtn.textContent = `Start group${count}`;
    addToGroupBtn.textContent = `Add to group${count}`;
    mergeBtn.textContent = n >= 2 ? `Merge (${n})` : 'Merge';
    mergeBtn.disabled = n < 2;
    deleteSelBtn.textContent = `Delete${count}`;
    enhanceSelBtn.textContent = `Enhance${count}`;
  }

  /**
   * @param {'people' | 'companies' | 'groups'} next
   * @param {{ selectOrgId?: string | null, selectGroupId?: string | null }} [opts]
   */
  async function setView(next, opts = {}) {
    view = next;
    syncTabs();
    if (next === 'groups') {
      list.setAttribute('aria-label', 'Groups');
      list.setAttribute('aria-labelledby', 'network-tab-groups');
      await openGroupsUi({ selectGroupId: opts.selectGroupId || null });
      return;
    }
    if (groupsUiMounted) {
      groupsPane.replaceChildren();
      groupsUiMounted = false;
    }
    list.setAttribute('aria-label', next === 'people' ? 'People' : 'Companies');
    list.setAttribute('aria-labelledby', next === 'people' ? 'network-tab-people' : 'network-tab-companies');
    if (next === 'companies') {
      await loadOrganizations();
      selectedOrgId = opts.selectOrgId ?? selectedOrgId ?? organizations[0]?.id ?? null;
      renderList();
      if (selectedOrgId) openOrganization(selectedOrgId);
      else detail.innerHTML = '<p class="muted">No companies yet — add one, or set an Organization on a person and save.</p>';
      return;
    }
    renderList();
    if (selectedId) selectContact(selectedId);
    else detail.innerHTML = '<p class="muted">Select a person</p>';
  }

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg || '';
    status.classList.toggle('network-crm__status--err', Boolean(isErr));
  }

  function kindsLabel(c) {
    const kinds = Array.isArray(c.kinds) ? c.kinds : [];
    return kinds.length ? kinds.join(' + ') : 'friend';
  }

  function filtered() {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (peopleFilters.kind) {
        const kinds = Array.isArray(c.kinds) ? c.kinds.map((k) => String(k).toLowerCase()) : [];
        if (!kinds.includes(peopleFilters.kind.toLowerCase())) return false;
      }
      if (peopleFilters.relationship) {
        if (String(c.relationshipStatus || '') !== peopleFilters.relationship) return false;
      }
      if (peopleFilters.status) {
        if (String(c.rating || '') !== peopleFilters.status) return false;
      }
      if (!q) return true;
      const hay = [
        c.displayName,
        c.nickname,
        ...(c.aliases || []),
        ...(c.kinds || []),
        ...(c.alignedActivities || []),
        ...(c.preferredContactMethods || []),
        c.summary,
        c.howWeMet,
        c.networkCircles,
        c.org,
        c.title,
        c.department,
        c.bio,
        c.notes,
        c.relationshipStatus,
        c.rating,
        c.location,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function filteredOrgs() {
    const q = query.trim().toLowerCase();
    if (!q) return organizations;
    return organizations.filter((o) => {
      const hay = [o.name, ...(o.aliases || []), o.summary, o.description, o.location, o.website]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function orgName(idOrName) {
    if (!idOrName) return '';
    const byId = organizations.find((o) => o.id === idOrName);
    if (byId) return byId.name;
    return String(idOrName);
  }

  function avatarEl(contact, className) {
    const box = document.createElement('div');
    box.className = className;
    if (contact.avatarUrl) {
      const img = document.createElement('img');
      img.src = `${contact.avatarUrl}${contact.avatarUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(contact.updatedAt || '')}`;
      img.alt = '';
      img.width = 48;
      img.height = 48;
      box.append(img);
    } else {
      const initials = String(contact.displayName || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0] || '')
        .join('')
        .toUpperCase();
      box.textContent = initials || '?';
    }
    return box;
  }

  function logoEl(org, className) {
    const box = document.createElement('div');
    box.className = className;
    if (org.logoUrl) {
      const img = document.createElement('img');
      img.src = `${org.logoUrl}${org.logoUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(org.updatedAt || '')}`;
      img.alt = '';
      img.width = 48;
      img.height = 48;
      box.append(img);
    } else {
      const initials = String(org.name || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0] || '')
        .join('')
        .toUpperCase();
      box.textContent = initials || '?';
    }
    return box;
  }

  /**
   * Image-candidate picker in a pop-out dialog. Skips broken previews.
   * People photos use the morning path (Search further, no keyword box).
   * When `querySearch` is true (logos), a top text box drives image search.
   * @param {{
   *   candidatesUrl: string,
   *   applyUrl: string,
   *   buttonLabel?: string,
   *   emptyLabel?: string,
   *   dialogTitle?: string,
   *   queryPlaceholder?: string,
   *   querySearch?: boolean,
   *   defaultQuery?: string | (() => string),
   *   uploadUrl?: string,
   *   onApplied: (entity: object) => void,
   * }} opts
   */
  function mountImageCandidatePicker(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'network-crm__img-pick';

    const findBtn = document.createElement('button');
    findBtn.type = 'button';
    findBtn.className = 'network-crm__btn network-crm__btn--tiny';
    findBtn.textContent = opts.buttonLabel || 'Find other photos';

    const querySearch = Boolean(opts.querySearch);
    const uploadUrl = String(opts.uploadUrl || '').trim();

    /** @type {number} */
    let nextOffset = 0;
    /** @type {boolean} */
    let hasMore = false;
    /** @type {string} */
    let activeQuery = '';
    /** @type {Set<string>} */
    const shownUrls = new Set();
    /** @type {HTMLElement | null} */
    let backdrop = null;

    function closeDialog() {
      if (backdrop) {
        backdrop.remove();
        backdrop = null;
      }
      document.removeEventListener('keydown', onKeydown);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') closeDialog();
    }

    function resolveDefaultQuery() {
      if (typeof opts.defaultQuery === 'function') return String(opts.defaultQuery() || '').trim();
      return String(opts.defaultQuery || '').trim();
    }

    /**
     * @param {HTMLElement} grid
     * @param {{ url?: string, thumbUrl?: string | null }[]} candidates
     * @param {{ append?: boolean }} [mode]
     */
    function renderCandidates(grid, candidates, mode = {}) {
      if (!mode.append) {
        grid.replaceChildren();
        shownUrls.clear();
      }
      let added = 0;
      for (const cand of candidates) {
        const url = String(cand?.url || '').trim();
        if (!url || shownUrls.has(url)) continue;
        shownUrls.add(url);
        const thumb = String(cand?.thumbUrl || url).trim();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'network-crm__img-pick-item';
        btn.title = 'Use this image';
        btn.hidden = true;
        const img = document.createElement('img');
        img.alt = '';
        // Eager: items start hidden; lazy often never fires for hidden imgs.
        img.loading = 'eager';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        let triedFull = thumb === url;
        img.addEventListener('error', () => {
          if (!triedFull && url) {
            triedFull = true;
            img.src = url;
            return;
          }
          btn.remove();
          shownUrls.delete(url);
          if (!grid.querySelector('.network-crm__img-pick-item')) {
            const empty = document.createElement('p');
            empty.className = 'muted network-crm__img-pick-hint';
            empty.dataset.empty = '1';
            empty.textContent = opts.emptyLabel || 'No previewable images found';
            grid.append(empty);
          }
        });
        img.addEventListener('load', () => {
          grid.querySelector('[data-empty="1"]')?.remove();
          btn.hidden = false;
          const statusEl = backdrop?.querySelector('.network-crm__img-pick-status');
          if (statusEl) {
            const visible = grid.querySelectorAll('.network-crm__img-pick-item:not([hidden])').length;
            statusEl.textContent = visible ? `Pick one · ${visible} shown` : 'Waiting for previews…';
          }
        });
        img.src = thumb;
        btn.append(img);
        btn.addEventListener('click', async () => {
          if (btn.hidden || btn.disabled) return;
          btn.disabled = true;
          findBtn.disabled = true;
          showStatus('Saving image…');
          try {
            const ar = await fetch(opts.applyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url }),
            });
            const aj = await ar.json();
            if (!aj.ok) throw new Error(aj.error || 'apply_failed');
            closeDialog();
            showStatus('Image updated');
            opts.onApplied(aj.contact || aj.organization);
          } catch (err) {
            showStatus(String(err?.message || err), true);
            btn.disabled = false;
            findBtn.disabled = false;
          }
        });
        grid.append(btn);
        added += 1;
      }
      return added;
    }

    /**
     * @param {{ reset?: boolean }} [fetchOpts]
     */
    async function loadCandidates(fetchOpts = {}) {
      if (!backdrop) return;
      const grid = backdrop.querySelector('.network-crm__img-pick-grid');
      const furtherBtn = backdrop.querySelector('.network-crm__img-pick-further');
      const statusEl = backdrop.querySelector('.network-crm__img-pick-status');
      const queryInput = backdrop.querySelector('.network-crm__img-pick-query');
      const searchBtn = backdrop.querySelector('.network-crm__img-pick-search');
      if (!grid || !furtherBtn || !statusEl) return;

      const query = querySearch ? String(queryInput?.value || '').trim().slice(0, 160) : '';
      if (querySearch && !query) {
        showStatus('Enter text to search', true);
        queryInput?.focus();
        return;
      }

      const reset = Boolean(fetchOpts.reset);
      if (reset) {
        nextOffset = 0;
        hasMore = false;
        activeQuery = query;
        shownUrls.clear();
        grid.replaceChildren();
      }

      furtherBtn.disabled = true;
      if (searchBtn) searchBtn.disabled = true;
      if (queryInput) queryInput.disabled = true;
      findBtn.disabled = true;
      const loading = document.createElement('p');
      loading.className = 'muted network-crm__img-pick-hint';
      loading.dataset.loading = '1';
      loading.textContent = reset
        ? query
          ? `Searching “${query}”…`
          : 'Looking up images…'
        : 'Searching further…';
      grid.append(loading);
      statusEl.textContent = reset ? 'Searching…' : 'Loading next results…';
      showStatus(reset ? 'Finding images…' : 'Searching further…');

      try {
        const r = await fetch(opts.candidatesUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: nextOffset,
            limit: 5,
            ...(query ? { query } : {}),
          }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'candidates_failed');
        grid.querySelector('[data-loading="1"]')?.remove();

        const candidates = Array.isArray(j.candidates) ? j.candidates : [];
        nextOffset = Number(j.nextOffset) >= 0 ? Number(j.nextOffset) : nextOffset + candidates.length;
        hasMore = Boolean(j.hasMore);
        activeQuery = query;

        const added = renderCandidates(grid, candidates, { append: !reset });
        if (!grid.querySelector('.network-crm__img-pick-item') && !candidates.length) {
          const empty = document.createElement('p');
          empty.className = 'muted network-crm__img-pick-hint';
          empty.dataset.empty = '1';
          empty.textContent = opts.emptyLabel || 'No images found';
          grid.replaceChildren(empty);
          statusEl.textContent = 'No images found';
          showStatus('No images found', true);
        } else {
          const visible = grid.querySelectorAll('.network-crm__img-pick-item:not([hidden])').length;
          const pending = grid.querySelectorAll('.network-crm__img-pick-item[hidden]').length;
          statusEl.textContent = visible
            ? `Pick one · ${visible} shown`
            : pending
              ? 'Waiting for previews…'
              : 'No previewable images';
          showStatus(added ? `Loaded ${added} image${added === 1 ? '' : 's'}` : 'No new images');
        }
        furtherBtn.hidden = !hasMore;
        furtherBtn.disabled = !hasMore;
      } catch (err) {
        grid.querySelector('[data-loading="1"]')?.remove();
        if (!grid.querySelector('.network-crm__img-pick-item')) {
          const empty = document.createElement('p');
          empty.className = 'muted network-crm__img-pick-hint';
          empty.textContent = 'Search failed';
          grid.replaceChildren(empty);
        }
        statusEl.textContent = 'Search failed';
        showStatus(String(err?.message || err), true);
        furtherBtn.hidden = !hasMore;
        furtherBtn.disabled = !hasMore;
      } finally {
        findBtn.disabled = false;
        if (searchBtn) searchBtn.disabled = false;
        if (queryInput) queryInput.disabled = false;
      }
    }

    function openDialog() {
      closeDialog();
      activeQuery = '';
      backdrop = document.createElement('div');
      backdrop.className = 'network-crm__img-pick-backdrop';
      backdrop.setAttribute('role', 'presentation');

      const dialog = document.createElement('div');
      dialog.className = 'network-crm__img-pick-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', opts.dialogTitle || 'Pick an image');

      const header = document.createElement('div');
      header.className = 'network-crm__img-pick-dialog-header';
      const title = document.createElement('h3');
      title.className = 'network-crm__img-pick-dialog-title';
      title.textContent = opts.dialogTitle || 'Pick an image';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => closeDialog());
      header.append(title, closeBtn);

      const hint = document.createElement('p');
      hint.className = 'network-crm__img-pick-hint muted';
      hint.textContent = 'Pick one with a working preview — broken previews are skipped';

      const statusEl = document.createElement('p');
      statusEl.className = 'network-crm__img-pick-status muted';

      const grid = document.createElement('div');
      grid.className = 'network-crm__img-pick-grid';

      const actions = document.createElement('div');
      actions.className = 'network-crm__img-pick-dialog-actions';

      if (querySearch) {
        const queryInput = document.createElement('input');
        queryInput.type = 'search';
        queryInput.className = 'network-crm__img-pick-query';
        queryInput.placeholder = opts.queryPlaceholder || 'Type to search for logos…';
        queryInput.autocomplete = 'off';
        queryInput.spellcheck = true;
        queryInput.setAttribute('aria-label', 'Search logos');
        queryInput.value = resolveDefaultQuery();
        const searchBtn = document.createElement('button');
        searchBtn.type = 'button';
        searchBtn.className =
          'network-crm__btn network-crm__btn--primary network-crm__btn--tiny network-crm__img-pick-search';
        searchBtn.textContent = 'Search';
        searchBtn.addEventListener('click', () => {
          void loadCandidates({ reset: true });
        });
        queryInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void loadCandidates({ reset: true });
          }
        });
        actions.append(queryInput, searchBtn);
      }

      const furtherBtn = document.createElement('button');
      furtherBtn.type = 'button';
      furtherBtn.className = 'network-crm__btn network-crm__img-pick-further';
      furtherBtn.textContent = 'Search further';
      furtherBtn.hidden = true;
      furtherBtn.addEventListener('click', () => {
        void loadCandidates({ reset: false });
      });
      actions.append(furtherBtn);

      if (uploadUrl) {
        const uploadBtn = document.createElement('button');
        uploadBtn.type = 'button';
        uploadBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__img-pick-upload';
        uploadBtn.textContent = 'Upload';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.hidden = true;
        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          uploadBtn.disabled = true;
          findBtn.disabled = true;
          showStatus('Uploading…');
          try {
            const dataUrl = await readFileAsDataUrl(file);
            const r = await fetch(uploadUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'upload_failed');
            closeDialog();
            showStatus('Image updated');
            opts.onApplied(j.contact || j.organization);
          } catch (err) {
            showStatus(String(err?.message || err), true);
            uploadBtn.disabled = false;
            findBtn.disabled = false;
          } finally {
            fileInput.value = '';
          }
        });
        actions.append(uploadBtn, fileInput);
      }

      dialog.append(header, hint, statusEl, grid, actions);
      backdrop.append(dialog);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeDialog();
      });
      document.body.append(backdrop);
      document.addEventListener('keydown', onKeydown);

      if (querySearch) {
        const queryInput = backdrop.querySelector('.network-crm__img-pick-query');
        queryInput?.focus();
        if (queryInput?.value.trim()) void loadCandidates({ reset: true });
        else queryInput?.select();
      } else {
        void loadCandidates({ reset: true });
      }
    }

    findBtn.addEventListener('click', () => openDialog());
    wrap.append(findBtn);
    return wrap;
  }

  function renderList() {
    list.replaceChildren();
    if (view === 'companies') {
      renderOrgList();
      return;
    }
    const items = filtered();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'network-crm__empty muted';
      empty.textContent = contacts.length ? 'No matches' : 'No people yet';
      list.append(empty);
      return;
    }
    for (const c of items) {
      const li = document.createElement('li');
      li.className = 'network-crm__row';
      li.classList.toggle('network-crm__row--active', c.id === selectedId);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', c.id === selectedId ? 'true' : 'false');
      li.tabIndex = 0;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'network-crm__select';
      check.checked = selectedContactIds.has(c.id);
      check.title = 'Select';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) selectedContactIds.add(c.id);
        else selectedContactIds.delete(c.id);
        syncSelectionActions();
      });

      const av = avatarEl(c, 'network-crm__avatar');
      const meta = document.createElement('div');
      meta.className = 'network-crm__row-meta';
      const name = document.createElement('div');
      name.className = 'network-crm__row-name';
      const nameText = document.createElement('span');
      nameText.textContent = c.displayName || 'Untitled';
      name.append(nameText);
      if (c.nickname) {
        const nick = document.createElement('span');
        nick.className = 'network-crm__row-nick muted';
        nick.textContent = c.nickname;
        name.append(document.createTextNode(' '), nick);
      }
      const sub = document.createElement('div');
      sub.className = 'network-crm__row-sub muted';
      const bits = [kindsLabel(c), c.networkCircles].filter(Boolean);
      sub.textContent = bits.join(' · ');
      meta.append(name, sub);
      li.append(check, av, meta);
      li.addEventListener('click', () => selectContact(c.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectContact(c.id);
        }
      });
      list.append(li);
    }
  }

  function renderOrgList() {
    const items = filteredOrgs();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'network-crm__empty muted';
      empty.textContent = organizations.length ? 'No matches' : 'No companies yet';
      list.append(empty);
      return;
    }
    for (const o of items) {
      const li = document.createElement('li');
      li.className = 'network-crm__row';
      li.classList.toggle('network-crm__row--active', o.id === selectedOrgId);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', o.id === selectedOrgId ? 'true' : 'false');
      li.tabIndex = 0;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'network-crm__select';
      check.checked = selectedOrgIds.has(o.id);
      check.title = 'Select';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) selectedOrgIds.add(o.id);
        else selectedOrgIds.delete(o.id);
      });

      const icon = logoEl(o, 'network-crm__avatar');
      const meta = document.createElement('div');
      meta.className = 'network-crm__row-meta';
      const name = document.createElement('div');
      name.className = 'network-crm__row-name';
      name.textContent = o.name || 'Untitled company';
      const sub = document.createElement('div');
      sub.className = 'network-crm__row-sub muted';
      sub.textContent = [o.industry || o.type, o.location, o.website].filter(Boolean).join(' · ');
      meta.append(name, sub);
      li.append(check, icon, meta);
      li.addEventListener('click', () => openOrganization(o.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openOrganization(o.id);
        }
      });
      list.append(li);
    }
  }

  /**
   * @param {string} id
   */
  function selectContact(id) {
    selectedId = id;
    renderList();
    const c = contacts.find((x) => x.id === id);
    if (!c) {
      detail.innerHTML = '<p class="muted">Person not found</p>';
      return;
    }
    renderDetail(c);
  }

  /**
   * @param {string} title
   * @param {HTMLElement[]} children
   */
  function section(title, children) {
    const sec = document.createElement('fieldset');
    sec.className = 'network-crm__section';
    const legend = document.createElement('legend');
    legend.textContent = title;
    sec.append(legend, ...children);
    return sec;
  }

  /**
   * @param {object} c
   */
  function renderDetail(c) {
    // Don't let an in-progress voice note apply to a different contact.
    if (voiceSession.contactId && voiceSession.contactId !== c.id) {
      hideVoiceBar();
    }
    const gen = ++detailGeneration;
    /** @type {object} */
    let current = c;
    detail.replaceChildren();

    const head = document.createElement('div');
    head.className = 'network-crm__detail-head';

    const avWrap = document.createElement('div');
    avWrap.className = 'network-crm__avatar-wrap';

    const avFrame = document.createElement('div');
    avFrame.className = 'network-crm__avatar-frame';
    avFrame.append(avatarEl(current, 'network-crm__avatar network-crm__avatar--lg'));
    if (current.avatarUrl) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'network-crm__avatar-clear';
      clearBtn.title = 'Remove photo';
      clearBtn.setAttribute('aria-label', 'Remove photo');
      clearBtn.textContent = '×';
      clearBtn.addEventListener('click', async () => {
        showStatus('Removing photo…');
        try {
          const r = await fetch(`/api/network/contacts/${encodeURIComponent(current.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarUrl: null }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'remove_failed');
          const idx = contacts.findIndex((x) => x.id === j.contact.id);
          if (idx >= 0) contacts[idx] = j.contact;
          showStatus('Photo removed');
          renderList();
          renderDetail(j.contact);
        } catch (err) {
          showStatus(String(err?.message || err), true);
        }
      });
      avFrame.append(clearBtn);
    }
    avWrap.append(avFrame);

    const pickWrap = mountImageCandidatePicker({
      candidatesUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar-candidates`,
      applyUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar-from-url`,
      uploadUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar`,
      buttonLabel: 'Find other photos',
      dialogTitle: 'Pick a photo',
      emptyLabel: 'No photos found — try Enrich or Upload',
      onApplied: (entity) => {
        const idx = contacts.findIndex((x) => x.id === entity.id);
        if (idx >= 0) contacts[idx] = entity;
        renderList();
        renderDetail(entity);
      },
    });
    avWrap.append(pickWrap);
    head.append(avWrap);

    const titles = document.createElement('div');
    const h = document.createElement('h3');
    h.className = 'network-crm__detail-name';
    h.textContent = current.displayName || 'Untitled';
    if (current.nickname) {
      const nick = document.createElement('span');
      nick.className = 'network-crm__detail-nick muted';
      nick.textContent = current.nickname;
      h.append(document.createTextNode(' '), nick);
    }
    if (!current.avatarUrl) {
      const hint = document.createElement('p');
      hint.className = 'muted network-crm__aliases';
      hint.textContent = 'No photo yet — find photos, Upload, or Enrich';
      titles.append(h, hint);
    } else {
      titles.append(h);
    }
    head.append(titles);

    const form = document.createElement('form');
    form.className = 'network-crm__form';
    form.setAttribute('aria-label', 'Edit contact');

    /**
     * @param {string} label
     * @param {string} name
     * @param {string} value
     * @param {{ type?: string, rows?: number, options?: string[], readonly?: boolean }} [opts]
     */
    function field(label, name, value, opts = {}) {
      const wrapEl = document.createElement('label');
      wrapEl.className = 'network-crm__field';
      if (opts.rows) wrapEl.classList.add('network-crm__field--full');
      const span = document.createElement('span');
      span.textContent = label;
      let input;
      if (opts.options) {
        input = document.createElement('select');
        input.className = 'network-crm__input';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        input.append(blank);
        for (const opt of opts.options) {
          const el = document.createElement('option');
          el.value = opt;
          el.textContent = opt;
          if (String(value || '') === opt) el.selected = true;
          input.append(el);
        }
      } else if (opts.rows) {
        input = document.createElement('textarea');
        input.rows = opts.rows;
        input.value = value || '';
        input.className = 'network-crm__input';
      } else {
        input = document.createElement('input');
        input.type = opts.type || 'text';
        input.value = value || '';
        input.className = 'network-crm__input';
        if (opts.readonly) {
          input.readOnly = true;
          input.classList.add('network-crm__input--readonly');
        }
      }
      input.name = name;
      input.required = false;
      wrapEl.append(span, input);
      return wrapEl;
    }

    const kindsBox = document.createElement('div');
    kindsBox.className = 'network-crm__checks';
    const kindsLabelEl = document.createElement('span');
    kindsLabelEl.className = 'network-crm__checks-label';
    kindsLabelEl.textContent = 'Kinds';
    kindsBox.append(kindsLabelEl);
    const kinds = new Set(c.kinds || ['friend']);
    for (const k of ['friend', 'organizer', 'business']) {
      const lab = document.createElement('label');
      lab.className = 'network-crm__check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `kind-${k}`;
      cb.value = k;
      cb.checked = kinds.has(k);
      lab.append(cb, document.createTextNode(` ${k[0].toUpperCase()}${k.slice(1)}`));
      kindsBox.append(lab);
    }

    const preferred = new Set(c.preferredContactMethods || []);

    /** @type {Record<string, HTMLElement>} */
    const channelFieldsByMethod = {
      phone: field('Phone', 'phone', c.channels?.phone || ''),
      email: field('Email', 'email', c.channels?.email || '', { type: 'email' }),
      signal: field('Signal', 'signal', c.channels?.signal || ''),
      whatsapp: field('WhatsApp', 'whatsapp', c.channels?.whatsapp || ''),
      linkedin: field('LinkedIn', 'linkedin', c.channels?.linkedin || '', { type: 'url' }),
      other: field('Other', 'other', c.channels?.other || ''),
    };

    /**
     * Wrap a Signal/WhatsApp field with a "Same as phone" checkbox that copies
     * a filled phone (or other messaging) number into this blank field.
     * @param {'signal' | 'whatsapp'} targetName
     */
    function attachSameAsPhone(targetName) {
      const fieldEl = channelFieldsByMethod[targetName];
      if (!fieldEl) return;
      const stack = document.createElement('div');
      stack.className = 'network-crm__field-stack';
      fieldEl.replaceWith(stack);
      stack.append(fieldEl);
      channelFieldsByMethod[targetName] = stack;

      const same = document.createElement('label');
      same.className = 'network-crm__check network-crm__same-as-phone';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `same-phone-${targetName}`;
      same.append(cb, document.createTextNode(' Same as phone'));
      cb.addEventListener('change', () => {
        if (!cb.checked) return;
        const target = /** @type {HTMLInputElement | null} */ (fieldEl.querySelector(`[name="${targetName}"]`));
        if (!target) return;
        if (String(target.value || '').trim()) {
          // Already filled — leave it; uncheck so the box matches state.
          cb.checked = false;
          return;
        }
        const phone = String(form.querySelector('[name="phone"]')?.value || '').trim();
        const otherName = targetName === 'signal' ? 'whatsapp' : 'signal';
        const other = String(form.querySelector(`[name="${otherName}"]`)?.value || '').trim();
        const num = phone || other;
        if (!num) {
          cb.checked = false;
          showStatus('Fill phone first', true);
          return;
        }
        target.value = num;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
      stack.append(same);
    }
    attachSameAsPhone('signal');
    attachSameAsPhone('whatsapp');
    const contactUrls = [
      ...new Set([...(c.channels?.urls || []), ...(c.enrichment?.sources || [])].filter(Boolean)),
    ];
    const urlsField = field(
      'URLs (enrichment sources — one per line)',
      'urls',
      contactUrls.join('\n'),
      { rows: 3 },
    );

    const methodsBox = document.createElement('div');
    methodsBox.className = 'network-crm__checks network-crm__checks--wrap';

    /** @type {Map<string, HTMLInputElement>} */
    const prefChecks = new Map();

    function syncChannelFieldVisibility() {
      for (const [method, el] of Object.entries(channelFieldsByMethod)) {
        el.hidden = !prefChecks.get(method)?.checked;
      }
    }

    for (const m of methodOptions) {
      const lab = document.createElement('label');
      lab.className = 'network-crm__check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = `pref-${m}`;
      cb.value = m;
      cb.checked = preferred.has(m);
      prefChecks.set(m, cb);
      if (channelFieldsByMethod[m]) {
        cb.addEventListener('change', syncChannelFieldVisibility);
      }
      lab.append(cb, document.createTextNode(` ${METHOD_LABELS[m] || m}`));
      methodsBox.append(lab);
    }
    syncChannelFieldVisibility();

    const moreChannels = section('Preferred contact methods', [
      methodsBox,
      ...Object.values(channelFieldsByMethod),
    ]);

    const orgField = field('Organization', 'org', c.org || '');
    if (c.orgId) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'network-crm__link-btn';
      link.textContent = 'Open company page →';
      link.addEventListener('click', () => openOrganization(c.orgId));
      orgField.append(link);
    }

    const attrsPanel = document.createElement('div');
    attrsPanel.className = 'network-crm__attrs-panel';
    attrsPanel.hidden = !contactAttrsExpanded;
    attrsPanel.append(
      orgField,
      field('Role', 'title', c.title),
      field('Department', 'department', c.department || ''),
      field('Aliases (comma-separated)', 'aliases', (c.aliases || []).join(', ')),
      urlsField,
      field('Private Notes', 'notes', c.notes || '', { rows: 3 }),
    );

    const enrichMeta = document.createElement('p');
    enrichMeta.className = 'network-crm__meta muted';
    const conf =
      typeof c.enrichment?.confidence === 'number'
        ? ` · confidence ${Math.round(c.enrichment.confidence * 100)}%`
        : '';
    const enriched = c.enrichment?.enrichedAt
      ? `Enriched ${formatNetworkTimestamp(c.enrichment.enrichedAt)}${conf}`
      : 'Not enriched yet';
    const created = c.createdAt ? ` · created ${formatNetworkTimestamp(c.createdAt)}` : '';
    const updated = c.updatedAt ? ` · updated ${formatNetworkTimestamp(c.updatedAt)}` : '';
    enrichMeta.textContent = `${enriched} · source: ${c.source || '—'}${created}${updated}`;
    attrsPanel.append(enrichMeta);

    const toggleAttrs = document.createElement('button');
    toggleAttrs.type = 'button';
    toggleAttrs.className = 'network-crm__btn network-crm__btn--attrs';
    toggleAttrs.textContent = contactAttrsExpanded ? 'Fewer attributes' : 'More attributes';
    toggleAttrs.setAttribute('aria-expanded', contactAttrsExpanded ? 'true' : 'false');
    toggleAttrs.addEventListener('click', () => {
      contactAttrsExpanded = !contactAttrsExpanded;
      attrsPanel.hidden = !contactAttrsExpanded;
      toggleAttrs.textContent = contactAttrsExpanded ? 'Fewer attributes' : 'More attributes';
      toggleAttrs.setAttribute('aria-expanded', contactAttrsExpanded ? 'true' : 'false');
    });

    const lastContactField = field(
      'Last contact',
      'lastContactAt',
      formatContactLastContact(c),
    );
    const lastContactInput = lastContactField.querySelector('input');
    if (lastContactInput) {
      lastContactInput.placeholder = 'e.g. yesterday, 4/5/26, last month';
    }
    if (c.lastContactChannel) {
      const hint = document.createElement('p');
      hint.className = 'network-crm__field-hint muted';
      hint.textContent = `via ${c.lastContactChannel}`;
      lastContactField.append(hint);
    }

    form.append(
      field('Name', 'displayName', c.displayName),
      field('Nickname', 'nickname', c.nickname || ''),
      field('Scene', 'networkCircles', c.networkCircles || ''),
      field('Location', 'location', c.location),
      field('Relationship', 'relationshipStatus', c.relationshipStatus || '', {
        options: [
          'Lead',
          'Cultivating',
          'Collaborator',
          'Family',
          'Acquaintance',
          'Paused',
          'Former',
        ],
      }),
      field('Status', 'rating', c.rating || '', {
        options: ['Hot', 'Warm', 'Cold'],
      }),
      lastContactField,
      kindsBox,
      moreChannels,
      field('Bio', 'bio', c.bio || '', { rows: 3 }),
      field('How we met', 'howWeMet', c.howWeMet || '', { rows: 3 }),
      field(
        'Aligned activities (one per line — things you’d do or work on together)',
        'alignedActivities',
        (c.alignedActivities || []).join('\n'),
        { rows: 4 },
      ),
      field('Next step', 'nextStep', c.nextStep || '', { rows: 2 }),
      toggleAttrs,
      attrsPanel,
    );

    const actions = document.createElement('div');
    actions.className = 'network-crm__actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'network-crm__btn network-crm__btn--primary';
    saveBtn.textContent = 'Save';

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'network-crm__btn';
    undoBtn.textContent = 'Undo';
    undoBtn.disabled = true;
    undoBtn.title = 'Undo last save (Ctrl+Z outside a field uses this too)';

    const enrichBtn = document.createElement('button');
    enrichBtn.type = 'button';
    enrichBtn.className = 'network-crm__btn';
    enrichBtn.textContent = 'Enrich';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'network-crm__btn network-crm__btn--danger';
    delBtn.textContent = 'Delete';

    actions.append(saveBtn, undoBtn, enrichBtn, delBtn);
    form.append(actions);

    /** @type {object[]} */
    let undoStack = contactUndoStacks.get(current.id);
    if (!undoStack) {
      undoStack = [];
      contactUndoStacks.set(current.id, undoStack);
    }

    function syncUndoBtn() {
      undoBtn.disabled = undoStack.length === 0;
      undoBtn.textContent = undoStack.length > 1 ? `Undo (${undoStack.length})` : 'Undo';
    }
    syncUndoBtn();

    function buildContactBody() {
      const fd = new FormData(form);
      const splitCsv = (v) =>
        String(v || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      const kindsSel = ['friend', 'organizer', 'business'].filter((k) => form.querySelector(`[name="kind-${k}"]`)?.checked);
      const prefs = methodOptions.filter((m) => form.querySelector(`[name="pref-${m}"]`)?.checked);
      return {
        displayName: String(fd.get('displayName') || '').trim(),
        nickname: String(fd.get('nickname') || '').trim(),
        title: String(fd.get('title') || '').trim(),
        org: String(fd.get('org') || '').trim(),
        kinds: kindsSel.length ? kindsSel : ['friend'],
        location: String(fd.get('location') || '').trim(),
        relationshipStatus: String(fd.get('relationshipStatus') || '').trim(),
        aliases: splitCsv(fd.get('aliases')),
        department: String(fd.get('department') || '').trim(),
        rating: String(fd.get('rating') || '').trim(),
        nextStep: String(fd.get('nextStep') || '').trim(),
        bio: String(fd.get('bio') || '').trim(),
        howWeMet: String(fd.get('howWeMet') || '').trim(),
        networkCircles: String(fd.get('networkCircles') || '').trim(),
        notes: String(fd.get('notes') || '').trim(),
        alignedActivities: String(fd.get('alignedActivities') || '')
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
        preferredContactMethods: prefs,
        lastContactAt: String(fd.get('lastContactAt') || '').trim(),
        channels: {
          email: String(fd.get('email') ?? current.channels?.email ?? '').trim() || null,
          phone: String(fd.get('phone') ?? current.channels?.phone ?? '').trim() || null,
          sms: current.channels?.sms || null,
          signal: String(fd.get('signal') ?? current.channels?.signal ?? '').trim() || null,
          whatsapp: String(fd.get('whatsapp') ?? current.channels?.whatsapp ?? '').trim() || null,
          linkedin: String(fd.get('linkedin') ?? current.channels?.linkedin ?? '').trim() || null,
          other: String(fd.get('other') ?? current.channels?.other ?? '').trim() || null,
          urls: String(fd.get('urls') ?? (current.channels?.urls || []).join('\n') ?? '')
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      };
    }

    let saveInFlight = false;
    let dirtyWhileSaving = false;

    /**
     * @param {{ remount?: boolean, fromUndo?: boolean, bodyOverride?: object }} [opts]
     */
    async function persistContact(opts = {}) {
      if (gen !== detailGeneration) return;
      if (saveInFlight) {
        dirtyWhileSaving = true;
        return;
      }
      saveInFlight = true;
      showStatus(opts.fromUndo ? 'Undoing…' : 'Saving…');
      try {
        do {
          dirtyWhileSaving = false;
          const priorId = current.id;
          const priorBody = contactToPutBody(current);
          const body = opts.bodyOverride || buildContactBody();
          // Only consume bodyOverride once (follow-up dirty saves use the form).
          opts = { ...opts, bodyOverride: undefined };
          const r = await fetch(`/api/network/contacts/${encodeURIComponent(priorId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'save_failed');
          if (gen !== detailGeneration) return;

          const saved = j.contact;
          const mergedAway = saved.id !== priorId;
          contacts = contacts.filter((x) => x.id !== priorId || x.id === saved.id);
          const idx = contacts.findIndex((x) => x.id === saved.id);
          if (idx >= 0) contacts[idx] = saved;
          else contacts.push(saved);
          selectedId = saved.id;

          if (!opts.fromUndo && !sameJson(priorBody, contactToPutBody(saved))) {
            undoStack.push(priorBody);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            syncUndoBtn();
          }
          if (mergedAway && priorId !== saved.id) {
            contactUndoStacks.set(saved.id, undoStack);
            contactUndoStacks.delete(priorId);
          }

          current = saved;

          // Org ensure/create only matters when the org name changed.
          if (String(body.org || '') !== String(priorBody.org || '')) {
            await loadOrganizations();
            if (gen !== detailGeneration) return;
          }

          if (mergedAway || opts.remount || opts.fromUndo) {
            showStatus(opts.fromUndo ? 'Undone' : mergedAway ? 'Saved (merged duplicate)' : 'Saved');
            renderList();
            renderDetail(saved);
            return;
          }

          h.replaceChildren();
          h.append(document.createTextNode(saved.displayName || 'Untitled'));
          if (saved.nickname) {
            const nick = document.createElement('span');
            nick.className = 'network-crm__detail-nick muted';
            nick.textContent = saved.nickname;
            h.append(document.createTextNode(' '), nick);
          }
          const confSaved =
            typeof saved.enrichment?.confidence === 'number'
              ? ` · confidence ${Math.round(saved.enrichment.confidence * 100)}%`
              : '';
          const enrichedSaved = saved.enrichment?.enrichedAt
            ? `Enriched ${formatNetworkTimestamp(saved.enrichment.enrichedAt)}${confSaved}`
            : 'Not enriched yet';
          const createdSaved = saved.createdAt
            ? ` · created ${formatNetworkTimestamp(saved.createdAt)}`
            : '';
          const updatedSaved = saved.updatedAt
            ? ` · updated ${formatNetworkTimestamp(saved.updatedAt)}`
            : '';
          enrichMeta.textContent = `${enrichedSaved} · source: ${saved.source || '—'}${createdSaved}${updatedSaved}`;
          showStatus('Saved');

          // Sidebar only shows name / nick / kinds / circles — skip full rebuild for notes etc.
          const listLabelChanged =
            String(saved.displayName || '') !== String(priorBody.displayName || '')
            || String(saved.nickname || '') !== String(priorBody.nickname || '')
            || !sameJson(saved.kinds || [], priorBody.kinds || [])
            || String(saved.networkCircles || '') !== String(priorBody.networkCircles || '');
          if (listLabelChanged) renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
      }
    }

    async function undoContact() {
      if (!undoStack.length) return;
      const snap = undoStack.pop();
      syncUndoBtn();
      await persistContact({ fromUndo: true, bodyOverride: snap, remount: true });
    }

    form.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return;
      const t = /** @type {HTMLElement} */ (e.target);
      const tag = t?.tagName || '';
      // Inside fields: keep browser native undo for typing.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!undoStack.length) return;
      e.preventDefault();
      void undoContact();
    });

    undoBtn.addEventListener('click', () => {
      void undoContact();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await persistContact();
    });

    enrichBtn.addEventListener('click', () => {
      const enrichErr = (j) => {
        const err = String(j?.error || 'enrich_failed');
        if (err === 'enrich_timeout' || err.includes('TimeoutError') || err.includes('aborted')) {
          return 'Enrich timed out — try again, or add a LinkedIn / website URL first';
        }
        if (err.includes('openrouter_http_402')) {
          return 'OpenRouter needs credits (or a free model). Check API key / billing.';
        }
        if (err.includes('openrouter_http_429')) {
          return 'OpenRouter is rate-limited — try again in a minute';
        }
        if (err === 'openrouter_not_configured') return 'OpenRouter API key not configured';
        if (err === 'no_shared_emails') {
          return 'No shared emails found — add their email or connect Gmail in Settings';
        }
        if (err === 'no_email_or_name') return 'Add a name or email first';
        if (err === 'gmail_search_failed') return j.detail || 'Gmail search failed — check Gmail connection';
        if (err === 'unsupported_file_type') return 'Unsupported file type — try txt, html, vcard, or an image';
        return err;
      };

      const contactId = current.id;
      const card = buildContactBody();

      /**
       * @param {string} path
       * @param {object} body
       * @param {string} okMsg
       * @param {number} [timeoutMs]
       */
      async function postEnrich(path, body, okMsg, timeoutMs = 95_000) {
        const save = await fetch(`/api/network/contacts/${encodeURIComponent(contactId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(card),
        });
        const saved = await save.json();
        if (!saved.ok) throw new Error(saved.error || 'save_failed');
        const enrichId = saved.contact?.id || contactId;
        if (saved.contact) {
          const idx = contacts.findIndex((x) => x.id === contactId || x.id === saved.contact.id);
          if (idx >= 0) contacts[idx] = saved.contact;
          else contacts.push(saved.contact);
          selectedId = enrichId;
        }
        const enrichPath = path.includes(encodeURIComponent(contactId))
          ? path.replace(encodeURIComponent(contactId), encodeURIComponent(enrichId))
          : path;
        let r;
        try {
          r = await fetch(enrichPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          const name = String(e?.name || '');
          if (name === 'TimeoutError' || name === 'AbortError') {
            throw new Error(enrichErr({ error: 'enrich_timeout' }));
          }
          throw e;
        }
        const j = await r.json();
        if (!j.ok) throw new Error(enrichErr(j));
        applyEnrichedContact(j.contact, okMsg);
        return j;
      }

      openEnrichOptionsDialog({
        title: 'Enrich',
        modes: ['web', 'file', 'email', 'voice'],
        onWeb: async () => {
          await postEnrich(
            `/api/network/contacts/${encodeURIComponent(contactId)}/enrich`,
            { card },
            'Enriched from web',
          );
        },
        onFile: async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          await postEnrich(
            `/api/network/contacts/${encodeURIComponent(contactId)}/enrich-from-file`,
            {
              card,
              dataUrl,
              filename: file.name,
              mimeType: file.type || undefined,
            },
            'Enriched from file',
          );
        },
        onEmail: async () => {
          const j = await postEnrich(
            `/api/network/contacts/${encodeURIComponent(contactId)}/enrich-from-email`,
            { card },
            'Enriched from email',
          );
          const n = Number(j.emailCount) || 0;
          if (n) showStatus(`Enriched from ${n} email${n === 1 ? '' : 's'}`);
        },
        onVoiceStart: async () => {
          await startVoiceEnrichOnScreen({
            contactId,
            card,
            onVoice: async (dataUrl, mimeType) => {
              await postEnrich(
                `/api/network/contacts/${encodeURIComponent(contactId)}/enrich-from-voice`,
                { card, dataUrl, mimeType },
                'Enriched from voice',
              );
            },
          });
        },
      });
    });

    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete ${current.displayName || 'this person'}?`)) return;
      try {
        const r = await fetch(`/api/network/contacts/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'delete_failed');
        contacts = contacts.filter((x) => x.id !== current.id);
        contactUndoStacks.delete(current.id);
        selectedId = contacts[0]?.id || null;
        showStatus('Deleted');
        renderList();
        if (selectedId) selectContact(selectedId);
        else detail.innerHTML = '<p class="muted">Select a person</p>';
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    });

    detail.append(head, form);
  }

  /**
   * Close the enrich picker and run work on the Network screen.
   * @param {string} pendingMsg
   * @param {() => Promise<void>} work
   */
  function runEnrichInBackground(pendingMsg, work) {
    showStatus(pendingMsg);
    beginWaitCursor();
    void (async () => {
      try {
        await work();
      } catch (err) {
        showStatus(String(err?.message || err), true);
      } finally {
        endWaitCursor();
      }
    })();
  }

  /**
   * Apply an enriched contact if still on People; always refresh the list row.
   * @param {object} contact
   * @param {string} [okMsg]
   */
  function applyEnrichedContact(contact, okMsg) {
    if (!contact?.id) return;
    const idx = contacts.findIndex((x) => x.id === contact.id);
    if (idx >= 0) contacts[idx] = contact;
    else contacts.push(contact);
    renderList();
    if (view === 'people' && selectedId === contact.id) {
      selectContact(contact.id);
    }
    if (okMsg) showStatus(okMsg);
  }

  /**
   * @param {object} organization
   * @param {string} [okMsg]
   */
  function applyEnrichedOrganization(organization, okMsg) {
    if (!organization?.id) return;
    const idx = organizations.findIndex((x) => x.id === organization.id);
    if (idx >= 0) organizations[idx] = organization;
    else organizations.push(organization);
    renderList();
    if (view === 'companies' && selectedOrgId === organization.id) {
      openOrganization(organization.id);
    }
    if (okMsg) showStatus(okMsg);
  }

  /** @type {{
   *   recorder: MediaRecorder | null,
   *   stream: MediaStream | null,
   *   chunks: Blob[],
   *   contactId: string | null,
   *   card: object | null,
   *   onVoice: ((dataUrl: string, mimeType: string) => Promise<void>) | null,
   * }} */
  const voiceSession = {
    recorder: null,
    stream: null,
    chunks: [],
    contactId: null,
    card: null,
    onVoice: null,
  };

  function stopVoiceSessionMic() {
    if (voiceSession.recorder && voiceSession.recorder.state !== 'inactive') {
      try {
        voiceSession.recorder.stop();
      } catch {
        // ignore
      }
    }
    voiceSession.recorder = null;
    if (voiceSession.stream) {
      for (const t of voiceSession.stream.getTracks()) t.stop();
      voiceSession.stream = null;
    }
  }

  function hideVoiceBar() {
    stopVoiceSessionMic();
    voiceBar.hidden = true;
    voiceSession.contactId = null;
    voiceSession.card = null;
    voiceSession.onVoice = null;
    voiceSession.chunks = [];
  }

  /**
   * Start mic on the Network screen (dialog already closed).
   * @param {{
   *   contactId: string,
   *   card: object,
   *   onVoice: (dataUrl: string, mimeType: string) => Promise<void>,
   * }} args
   */
  async function startVoiceEnrichOnScreen(args) {
    hideVoiceBar();
    voiceSession.contactId = args.contactId;
    voiceSession.card = args.card;
    voiceSession.onVoice = args.onVoice;
    voiceSession.chunks = [];
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone not available in this browser');
    }
    voiceSession.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
    voiceSession.recorder = mimeType
      ? new MediaRecorder(voiceSession.stream, { mimeType })
      : new MediaRecorder(voiceSession.stream);
    voiceSession.recorder.addEventListener('dataavailable', (e) => {
      if (e.data?.size) voiceSession.chunks.push(e.data);
    });
    voiceSession.recorder.start();
    const label = voiceBar.querySelector('.network-crm__voice-bar-label');
    if (label) label.textContent = 'Recording… talk freely, then Stop & enrich';
    voiceBar.hidden = false;
    showStatus('Recording voice note…');
  }

  voiceBar.querySelector('[data-voice-stop]')?.addEventListener('click', () => {
    const recorder = voiceSession.recorder;
    const onVoice = voiceSession.onVoice;
    if (!recorder || !onVoice) return;
    const stopBtn = /** @type {HTMLButtonElement | null} */ (voiceBar.querySelector('[data-voice-stop]'));
    if (stopBtn) stopBtn.disabled = true;
    const mimeType = recorder.mimeType || 'audio/webm';
    const chunks = voiceSession.chunks;
    runEnrichInBackground('Transcribing and enriching…', async () => {
      try {
        const blob = await new Promise((resolve, reject) => {
          recorder.addEventListener('stop', () => {
            resolve(new Blob(chunks, { type: mimeType }));
          });
          recorder.addEventListener('error', () => reject(new Error('record_failed')));
          try {
            recorder.stop();
          } catch (e) {
            reject(e);
          }
        });
        stopVoiceSessionMic();
        voiceBar.hidden = true;
        if (!blob.size) throw new Error('No audio captured');
        const dataUrl = await readFileAsDataUrl(blob);
        await onVoice(dataUrl, mimeType);
      } finally {
        hideVoiceBar();
        if (stopBtn) stopBtn.disabled = false;
      }
    });
  });

  /**
   * Enrich options dialog: from web / file / email / voice.
   * Choosing an option closes immediately and continues on the Network screen.
   * @param {{
   *   title?: string,
   *   modes?: Array<'web' | 'file' | 'email' | 'voice'>,
   *   onWeb: () => Promise<void>,
   *   onFile: (file: File) => Promise<void>,
   *   onEmail: () => Promise<void>,
   *   onVoiceStart?: () => Promise<void>,
   * }} opts
   */
  function openEnrichOptionsDialog(opts) {
    const modes = new Set(opts.modes || ['web', 'file', 'email', 'voice']);
    const backdrop = document.createElement('div');
    backdrop.className = 'network-crm__img-pick-backdrop network-crm__enrich-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'network-crm__img-pick-dialog network-crm__enrich-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.title || 'Enrich');

    const header = document.createElement('div');
    header.className = 'network-crm__img-pick-dialog-header';
    const title = document.createElement('h3');
    title.className = 'network-crm__img-pick-dialog-title';
    title.textContent = opts.title || 'Enrich';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
    closeBtn.textContent = 'Close';
    header.append(title, closeBtn);

    const hint = document.createElement('p');
    hint.className = 'network-crm__img-pick-hint muted';
    hint.textContent = 'Choose a source — work continues on the Network screen.';

    const listEl = document.createElement('div');
    listEl.className = 'network-crm__enrich-options';

    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    /**
     * @param {string} label
     * @param {string} desc
     * @param {() => void | Promise<void>} onClick
     * @param {{ iconHtml?: string, className?: string }} [extra]
     */
    function addOption(label, desc, onClick, extra = {}) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `network-crm__enrich-option${extra.className ? ` ${extra.className}` : ''}`;
      if (extra.iconHtml) {
        const icon = document.createElement('span');
        icon.className = 'network-crm__enrich-option-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = extra.iconHtml;
        btn.append(icon);
      }
      const textWrap = document.createElement('span');
      textWrap.className = 'network-crm__enrich-option-text';
      const strong = document.createElement('strong');
      strong.textContent = label;
      const p = document.createElement('span');
      p.className = 'muted';
      p.textContent = desc;
      textWrap.append(strong, p);
      btn.append(textWrap);
      btn.addEventListener('click', () => {
        void Promise.resolve(onClick());
      });
      listEl.append(btn);
      return btn;
    }

    if (modes.has('web')) {
      addOption('From web', 'Search public pages and fill empty fields', () => {
        close();
        runEnrichInBackground('Enriching from web (up to ~90s)…', () => opts.onWeb());
      });
    }

    if (modes.has('file')) {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept =
        '.txt,.md,.csv,.json,.html,.htm,.vcf,.vcard,text/*,image/*,.png,.jpg,.jpeg,.webp,.gif';
      fileInput.hidden = true;
      addOption('From file', 'Upload a resume, bio, notes, or screenshot', () => {
        fileInput.click();
      });
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        close();
        runEnrichInBackground(`Reading ${file.name}…`, () => opts.onFile(file));
      });
      dialog.append(fileInput);
    }

    if (modes.has('email')) {
      addOption('From email', 'Look up emails you’ve been on together', () => {
        close();
        runEnrichInBackground('Searching shared emails…', () => opts.onEmail());
      });
    }

    if (modes.has('voice')) {
      const playIcon =
        '<svg class="network-crm__enrich-play" viewBox="0 0 24 24" width="22" height="22" focusable="false">' +
        '<circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.18"/>' +
        '<path d="M9.5 7.5v9l8-4.5-8-4.5z" fill="currentColor"/>' +
        '</svg>';
      addOption(
        'From voice',
        'Press to record — we transcribe and file the facts',
        async () => {
          close();
          try {
            if (typeof opts.onVoiceStart === 'function') {
              await opts.onVoiceStart();
            }
          } catch (err) {
            hideVoiceBar();
            showStatus(String(err?.message || err), true);
          }
        },
        { iconHtml: playIcon, className: 'network-crm__enrich-option--voice' },
      );
    }

    closeBtn.addEventListener('click', () => close());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    dialog.append(header, hint, listEl);
    backdrop.append(dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
  }

  /**
   * @param {File} file
   */
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read_failed'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * @param {string} id
   */
  function openOrganization(id) {
    if (groupsUiMounted) {
      groupsPane.replaceChildren();
      groupsUiMounted = false;
    }
    view = 'companies';
    selectedOrgId = id;
    syncTabs();
    list.setAttribute('aria-label', 'Companies');
    list.setAttribute('aria-labelledby', 'network-tab-companies');
    renderList();
    const o = organizations.find((x) => x.id === id);
    if (!o) {
      detail.innerHTML = '<p class="muted">Company not found</p>';
      return;
    }
    renderOrgDetail(o);
  }

  /**
   * @param {object} o
   */
  function renderOrgDetail(o) {
    const gen = ++detailGeneration;
    /** @type {object} */
    let current = o;
    detail.replaceChildren();
    const head = document.createElement('div');
    head.className = 'network-crm__detail-head';

    const logoWrap = document.createElement('div');
    logoWrap.className = 'network-crm__avatar-wrap';
    if (current.logoUrl) {
      const logo = document.createElement('div');
      logo.className = 'network-crm__avatar network-crm__avatar--lg';
      const img = document.createElement('img');
      img.src = `${current.logoUrl}${current.logoUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(current.updatedAt || '')}`;
      img.alt = '';
      logo.append(img);
      logoWrap.append(logo);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'network-crm__avatar network-crm__avatar--lg';
      const initials = String(current.name || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0] || '')
        .join('')
        .toUpperCase();
      placeholder.textContent = initials || '?';
      logoWrap.append(placeholder);
    }
    const logoPick = mountImageCandidatePicker({
      candidatesUrl: `/api/network/organizations/${encodeURIComponent(current.id)}/logo-candidates`,
      applyUrl: `/api/network/organizations/${encodeURIComponent(current.id)}/logo-from-url`,
      buttonLabel: 'Find other logos',
      dialogTitle: 'Pick a logo',
      emptyLabel: 'No logos found — try a different search',
      querySearch: true,
      queryPlaceholder: 'Type a company or brand name…',
      defaultQuery: () => {
        const live = detail.querySelector('.network-crm__form [name="name"]');
        const name = String(live?.value || current.name || '').trim();
        return name ? `${name} logo` : '';
      },
      onApplied: (entity) => {
        const idx = organizations.findIndex((x) => x.id === entity.id);
        if (idx >= 0) organizations[idx] = entity;
        renderList();
        renderOrgDetail(entity);
      },
    });
    logoWrap.append(logoPick);
    head.append(logoWrap);

    const h = document.createElement('h3');
    h.className = 'network-crm__detail-name';
    h.textContent = current.name || 'Untitled company';
    head.append(h);

    const form = document.createElement('form');
    form.className = 'network-crm__form';

    /**
     * @param {string} label
     * @param {string} name
     * @param {string} value
     * @param {{ rows?: number, type?: string, options?: string[], readonly?: boolean }} [opts]
     */
    function field(label, name, value, opts = {}) {
      const wrapEl = document.createElement('label');
      wrapEl.className = 'network-crm__field';
      if (opts.rows) wrapEl.classList.add('network-crm__field--full');
      const span = document.createElement('span');
      span.textContent = label;
      let input;
      if (opts.options) {
        input = document.createElement('select');
        input.className = 'network-crm__input';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        input.append(blank);
        for (const opt of opts.options) {
          const el = document.createElement('option');
          el.value = opt;
          el.textContent = opt;
          if (String(value || '') === opt) el.selected = true;
          input.append(el);
        }
      } else if (opts.rows) {
        input = document.createElement('textarea');
        input.rows = opts.rows;
        input.value = value || '';
        input.className = 'network-crm__input';
      } else {
        input = document.createElement('input');
        input.type = opts.type || 'text';
        input.value = value || '';
        input.className = 'network-crm__input';
        if (opts.readonly) {
          input.readOnly = true;
          input.classList.add('network-crm__input--readonly');
        }
      }
      input.name = name;
      input.required = false;
      wrapEl.append(span, input);
      return wrapEl;
    }

    const linkedPeople = contacts.filter(
      (c) => c.orgId === o.id || (c.org || '').toLowerCase() === (o.name || '').toLowerCase(),
    );
    const linkedNameKeys = new Set(
      linkedPeople.flatMap((c) =>
        [c.displayName, c.nickname, ...(c.aliases || [])]
          .filter(Boolean)
          .map((n) => String(n).toLowerCase()),
      ),
    );
    const suggested = (Array.isArray(o.suggestedPeople) ? o.suggestedPeople : []).filter(
      (p) => p && p.status !== 'dismissed' && p.status !== 'added' && !linkedNameKeys.has(String(p.name || '').toLowerCase()),
    );

    const peopleBox = document.createElement('div');
    peopleBox.className = 'network-crm__people-panel';

    const peopleHead = document.createElement('div');
    peopleHead.className = 'network-crm__people-panel-head';
    const peopleTitle = document.createElement('h4');
    peopleTitle.className = 'network-crm__people-panel-title';
    peopleTitle.textContent = 'People';
    const addPersonBtn = document.createElement('button');
    addPersonBtn.type = 'button';
    addPersonBtn.className = 'network-crm__btn network-crm__btn--tiny';
    addPersonBtn.textContent = 'Add person';
    peopleHead.append(peopleTitle, addPersonBtn);
    peopleBox.append(peopleHead);

    /**
     * @param {object} nextOrg
     */
    async function persistSuggested(nextOrg) {
      const r = await fetch(`/api/network/organizations/${encodeURIComponent(o.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedPeople: nextOrg.suggestedPeople }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save_failed');
      const idx = organizations.findIndex((x) => x.id === o.id);
      if (idx >= 0) organizations[idx] = j.organization;
      return j.organization;
    }

    /**
     * @param {string} suggestionId
     * @param {(p: object) => object | null} mapFn
     */
    async function patchSuggestion(suggestionId, mapFn) {
      const list = Array.isArray(o.suggestedPeople) ? o.suggestedPeople.map((p) => ({ ...p })) : [];
      const idx = list.findIndex((p) => p.id === suggestionId);
      if (idx < 0) return o;
      const next = mapFn(list[idx]);
      if (next == null) list.splice(idx, 1);
      else list[idx] = next;
      return persistSuggested({ ...o, suggestedPeople: list });
    }

    function personRow({ name, sub, actions }) {
      const row = document.createElement('div');
      row.className = 'network-crm__person-row';
      const meta = document.createElement('div');
      meta.className = 'network-crm__person-meta';
      const nameEl = document.createElement('div');
      nameEl.className = 'network-crm__person-name';
      nameEl.textContent = name || 'Untitled';
      meta.append(nameEl);
      if (sub) {
        const subEl = document.createElement('div');
        subEl.className = 'network-crm__person-sub muted';
        subEl.textContent = sub;
        meta.append(subEl);
      }
      const acts = document.createElement('div');
      acts.className = 'network-crm__person-actions';
      for (const a of actions) acts.append(a);
      row.append(meta, acts);
      return row;
    }

    function tinyBtn(label, onClick, primary = false) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `network-crm__btn network-crm__btn--tiny${primary ? ' network-crm__btn--primary' : ''}`;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    }

    const inNetwork = document.createElement('div');
    inNetwork.className = 'network-crm__people-block';
    const inNetworkLabel = document.createElement('div');
    inNetworkLabel.className = 'network-crm__checks-label';
    inNetworkLabel.textContent = 'In your network';
    inNetwork.append(inNetworkLabel);
    if (!linkedPeople.length) {
      const empty = document.createElement('p');
      empty.className = 'muted network-crm__people-empty';
      empty.textContent = 'No linked people yet.';
      inNetwork.append(empty);
    } else {
      for (const p of linkedPeople) {
        const openBtn = tinyBtn('Open', () => {
          selectedId = p.id;
          void setView('people');
        });
        const renameBtn = tinyBtn('Rename', async () => {
          const next = prompt('Name', p.displayName || '');
          if (!next?.trim() || next.trim() === p.displayName) return;
          showStatus('Renaming…');
          try {
            const r = await fetch(`/api/network/contacts/${encodeURIComponent(p.id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ displayName: next.trim() }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'rename_failed');
            const idx = contacts.findIndex((x) => x.id === p.id);
            if (idx >= 0) contacts[idx] = j.contact;
            showStatus('Renamed');
            renderOrgDetail(o);
          } catch (err) {
            showStatus(String(err?.message || err), true);
          }
        });
        const unlinkBtn = tinyBtn('Unlink', async () => {
          if (!confirm(`Unlink ${p.displayName} from ${o.name}?`)) return;
          showStatus('Unlinking…');
          try {
            const r = await fetch(`/api/network/contacts/${encodeURIComponent(p.id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ org: '', orgId: null }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'unlink_failed');
            const idx = contacts.findIndex((x) => x.id === p.id);
            if (idx >= 0) contacts[idx] = j.contact;
            showStatus('Unlinked');
            renderOrgDetail(organizations.find((x) => x.id === o.id) || o);
          } catch (err) {
            showStatus(String(err?.message || err), true);
          }
        });
        inNetwork.append(
          personRow({
            name: p.nickname ? `${p.displayName} (${p.nickname})` : p.displayName,
            sub: [p.title, 'in network'].filter(Boolean).join(' · '),
            actions: [openBtn, renameBtn, unlinkBtn],
          }),
        );
      }
    }
    peopleBox.append(inNetwork);

    const foundBlock = document.createElement('div');
    foundBlock.className = 'network-crm__people-block';
    const foundLabel = document.createElement('div');
    foundLabel.className = 'network-crm__checks-label';
    foundLabel.textContent = 'Found during enrichment';
    foundBlock.append(foundLabel);
    if (!suggested.length) {
      const empty = document.createElement('p');
      empty.className = 'muted network-crm__people-empty';
      empty.textContent = o.enrichment?.enrichedAt
        ? 'No new people pending — enrich again or add someone manually.'
        : 'Run Enrich from web to find people associated with this company.';
      foundBlock.append(empty);
    } else {
      for (const s of suggested) {
        const existingMatch = contacts.find(
          (c) =>
            String(c.displayName || '').toLowerCase() === String(s.name || '').toLowerCase() ||
            (c.aliases || []).some((a) => String(a).toLowerCase() === String(s.name || '').toLowerCase()),
        );
        const actions = [];
        if (existingMatch) {
          actions.push(
            tinyBtn(
              'Link',
              async () => {
                showStatus('Linking…');
                try {
                  const r = await fetch(`/api/network/contacts/${encodeURIComponent(existingMatch.id)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ org: o.name, orgId: o.id, title: s.title || existingMatch.title || '' }),
                  });
                  const j = await r.json();
                  if (!j.ok) throw new Error(j.error || 'link_failed');
                  const cidx = contacts.findIndex((x) => x.id === existingMatch.id);
                  if (cidx >= 0) contacts[cidx] = j.contact;
                  const orgNext = await patchSuggestion(s.id, (p) => ({ ...p, status: 'added' }));
                  showStatus('Linked');
                  renderOrgDetail(orgNext);
                } catch (err) {
                  showStatus(String(err?.message || err), true);
                }
              },
              true,
            ),
          );
        } else {
          actions.push(
            tinyBtn(
              'Add',
              async () => {
                showStatus('Adding…');
                try {
                  const body = {
                    displayName: s.name,
                    org: o.name,
                    orgId: o.id,
                    title: s.title || '',
                    kinds: ['business'],
                    channels: {},
                  };
                  if (s.linkedin) body.channels.linkedin = s.linkedin;
                  const r = await fetch('/api/network/contacts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  });
                  const j = await r.json();
                  if (!j.ok) throw new Error(j.error || 'create_failed');
                  contacts.unshift(j.contact);
                  const orgNext = await patchSuggestion(s.id, (p) => ({ ...p, status: 'added' }));
                  showStatus('Added to network');
                  renderOrgDetail(orgNext);
                } catch (err) {
                  showStatus(String(err?.message || err), true);
                }
              },
              true,
            ),
          );
        }
        actions.push(
          tinyBtn('Rename', async () => {
            const next = prompt('Name', s.name || '');
            if (!next?.trim() || next.trim() === s.name) return;
            showStatus('Renaming…');
            try {
              const orgNext = await patchSuggestion(s.id, (p) => ({ ...p, name: next.trim() }));
              showStatus('Renamed');
              renderOrgDetail(orgNext);
            } catch (err) {
              showStatus(String(err?.message || err), true);
            }
          }),
          tinyBtn('Dismiss', async () => {
            showStatus('Dismissing…');
            try {
              const orgNext = await patchSuggestion(s.id, (p) => ({ ...p, status: 'dismissed' }));
              showStatus('Dismissed');
              renderOrgDetail(orgNext);
            } catch (err) {
              showStatus(String(err?.message || err), true);
            }
          }),
        );
        foundBlock.append(
          personRow({
            name: s.name,
            sub: [s.title, existingMatch ? 'already in network' : 'new'].filter(Boolean).join(' · '),
            actions,
          }),
        );
      }
    }
    peopleBox.append(foundBlock);

    addPersonBtn.addEventListener('click', async () => {
      const displayName = prompt('Person name?');
      if (!displayName?.trim()) return;
      const title = prompt('Title (optional)') || '';
      showStatus('Adding…');
      try {
        const r = await fetch('/api/network/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: displayName.trim(),
            org: o.name,
            orgId: o.id,
            title: title.trim(),
            kinds: ['business'],
          }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'create_failed');
        contacts.unshift(j.contact);
        showStatus('Added');
        renderOrgDetail(o);
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    });

    const primaryContactSelect = document.createElement('label');
    primaryContactSelect.className = 'network-crm__field';
    const primarySpan = document.createElement('span');
    primarySpan.textContent = 'Primary contact';
    const primaryInput = document.createElement('select');
    primaryInput.name = 'primaryContactId';
    primaryInput.className = 'network-crm__input';
    const primaryBlank = document.createElement('option');
    primaryBlank.value = '';
    primaryBlank.textContent = '—';
    primaryInput.append(primaryBlank);
    for (const p of linkedPeople) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.displayName || p.id;
      if (o.primaryContactId === p.id) opt.selected = true;
      primaryInput.append(opt);
    }
    primaryContactSelect.append(primarySpan, primaryInput);

    const attrsPanel = document.createElement('div');
    attrsPanel.className = 'network-crm__attrs-panel';
    attrsPanel.hidden = !orgAttrsExpanded;
    attrsPanel.append(
      field('Ownership', 'ownership', o.ownership || ''),
      field('Account source', 'accountSource', o.accountSource || ''),
      field('Rating', 'rating', o.rating || '', { options: ['Hot', 'Warm', 'Cold'] }),
      field('Annual revenue', 'annualRevenue', o.annualRevenue || ''),
      field('Employees', 'employeeCount', o.employeeCount || ''),
      field('Fiscal year end', 'fiscalYearEnd', o.fiscalYearEnd || ''),
      field('Competitive notes', 'competitiveNotes', o.competitiveNotes || '', { rows: 3 }),
      field('Email', 'email', o.email || '', { type: 'email' }),
      field('LinkedIn', 'linkedin', o.linkedin || '', { type: 'url' }),
      field('Social URLs (one per line)', 'socialUrls', (o.socialUrls || []).join('\n'), { rows: 2 }),
      field('Preferred language', 'locale', o.locale || ''),
      primaryContactSelect,
      field('Partner / channel relationships', 'partnerRelationships', o.partnerRelationships || '', { rows: 2 }),
      field('Next step', 'nextStep', o.nextStep || '', { rows: 2 }),
      field('Summary (freeform words for LLM search)', 'summary', o.summary || '', { rows: 2 }),
      field('Aliases (comma-separated)', 'aliases', (o.aliases || []).join(', ')),
      field('URLs (one per line)', 'urls', (o.urls || []).join('\n'), { rows: 2 }),
      field('Account ID', 'accountIdDisplay', o.id || '', { readonly: true }),
    );
    const enrichMeta = document.createElement('p');
    enrichMeta.className = 'network-crm__meta muted';
    const conf =
      typeof o.enrichment?.confidence === 'number'
        ? ` · confidence ${Math.round(o.enrichment.confidence * 100)}%`
        : '';
    enrichMeta.textContent = o.enrichment?.enrichedAt
      ? `Enriched ${formatNetworkTimestamp(o.enrichment.enrichedAt)}${conf}`
      : 'Not enriched yet';
    attrsPanel.append(enrichMeta);

    const toggleAttrs = document.createElement('button');
    toggleAttrs.type = 'button';
    toggleAttrs.className = 'network-crm__btn network-crm__btn--attrs';
    toggleAttrs.textContent = orgAttrsExpanded ? 'Fewer attributes' : 'More attributes';
    toggleAttrs.setAttribute('aria-expanded', orgAttrsExpanded ? 'true' : 'false');
    toggleAttrs.addEventListener('click', () => {
      orgAttrsExpanded = !orgAttrsExpanded;
      attrsPanel.hidden = !orgAttrsExpanded;
      toggleAttrs.textContent = orgAttrsExpanded ? 'Fewer attributes' : 'More attributes';
      toggleAttrs.setAttribute('aria-expanded', orgAttrsExpanded ? 'true' : 'false');
    });

    form.append(
      field('Name', 'name', o.name),
      field('Type', 'type', o.type || '', {
        options: ['Prospect', 'Customer', 'Partner', 'Competitor', 'Other'],
      }),
      field('Industry', 'industry', o.industry || ''),
      field('Website', 'website', o.website || '', { type: 'url' }),
      field('Description', 'description', o.description || '', { rows: 4 }),
      field('Lifecycle stage', 'lifecycleStatus', o.lifecycleStatus || '', {
        options: ['Prospect', 'Qualified', 'Customer', 'Churned'],
      }),
      field('Location (city / HQ)', 'location', o.location || ''),
      field('Phone', 'phone', o.phone || '', { type: 'tel' }),
      toggleAttrs,
      attrsPanel,
    );

    const actions = document.createElement('div');
    actions.className = 'network-crm__actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'network-crm__btn network-crm__btn--primary';
    saveBtn.textContent = 'Save';
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'network-crm__btn';
    undoBtn.textContent = 'Undo';
    undoBtn.disabled = true;
    undoBtn.title = 'Undo last save (Ctrl+Z outside a field uses this too)';
    const enrichBtn = document.createElement('button');
    enrichBtn.type = 'button';
    enrichBtn.className = 'network-crm__btn';
    enrichBtn.textContent = 'Enrich';
    actions.append(saveBtn, undoBtn, enrichBtn);
    form.append(actions, peopleBox);

    /** @type {object[]} */
    let undoStack = orgUndoStacks.get(current.id);
    if (!undoStack) {
      undoStack = [];
      orgUndoStacks.set(current.id, undoStack);
    }
    function syncUndoBtn() {
      undoBtn.disabled = undoStack.length === 0;
      undoBtn.textContent = undoStack.length > 1 ? `Undo (${undoStack.length})` : 'Undo';
    }
    syncUndoBtn();

    function buildOrgBody() {
      const fd = new FormData(form);
      const splitLines = (key) =>
        String(fd.get(key) || '')
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);
      return {
        name: String(fd.get('name') || '').trim(),
        type: String(fd.get('type') || '').trim(),
        industry: String(fd.get('industry') || '').trim(),
        website: String(fd.get('website') || '').trim() || null,
        description: String(fd.get('description') || '').trim(),
        lifecycleStatus: String(fd.get('lifecycleStatus') || '').trim(),
        location: String(fd.get('location') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        ownership: String(fd.get('ownership') || '').trim(),
        accountSource: String(fd.get('accountSource') || '').trim(),
        rating: String(fd.get('rating') || '').trim(),
        annualRevenue: String(fd.get('annualRevenue') || '').trim(),
        employeeCount: String(fd.get('employeeCount') || '').trim(),
        fiscalYearEnd: String(fd.get('fiscalYearEnd') || '').trim(),
        competitiveNotes: String(fd.get('competitiveNotes') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        linkedin: String(fd.get('linkedin') || '').trim() || null,
        socialUrls: splitLines('socialUrls'),
        locale: String(fd.get('locale') || '').trim(),
        primaryContactId: String(fd.get('primaryContactId') || '').trim() || null,
        partnerRelationships: String(fd.get('partnerRelationships') || '').trim(),
        nextStep: String(fd.get('nextStep') || '').trim(),
        summary: String(fd.get('summary') || '').trim(),
        aliases: String(fd.get('aliases') || '')
          .split(/[,;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        urls: splitLines('urls'),
      };
    }

    let saveInFlight = false;
    let dirtyWhileSaving = false;

    /**
     * @param {{ fromUndo?: boolean, bodyOverride?: object, remount?: boolean }} [opts]
     */
    async function persistOrg(opts = {}) {
      if (gen !== detailGeneration) return;
      if (saveInFlight) {
        dirtyWhileSaving = true;
        return;
      }
      saveInFlight = true;
      showStatus(opts.fromUndo ? 'Undoing…' : 'Saving…');
      try {
        do {
          dirtyWhileSaving = false;
          const priorId = current.id;
          const priorBody = orgToPutBody(current);
          const body = opts.bodyOverride || buildOrgBody();
          opts = { ...opts, bodyOverride: undefined };
          const r = await fetch(`/api/network/organizations/${encodeURIComponent(priorId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'save_failed');
          if (gen !== detailGeneration) return;

          const saved = j.organization;
          const mergedAway = saved.id !== priorId;
          organizations = organizations.filter((x) => x.id !== priorId || x.id === saved.id);
          const idx = organizations.findIndex((x) => x.id === saved.id);
          if (idx >= 0) organizations[idx] = saved;
          else organizations.push(saved);
          selectedOrgId = saved.id;

          if (!opts.fromUndo && !sameJson(priorBody, orgToPutBody(saved))) {
            undoStack.push(priorBody);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            syncUndoBtn();
          }
          if (mergedAway && priorId !== saved.id) {
            orgUndoStacks.set(saved.id, undoStack);
            orgUndoStacks.delete(priorId);
          }

          current = saved;

          if (mergedAway || opts.fromUndo || opts.remount) {
            showStatus(opts.fromUndo ? 'Undone' : mergedAway ? 'Saved (merged duplicate)' : 'Saved');
            renderList();
            renderOrgDetail(saved);
            return;
          }

          h.textContent = saved.name || 'Untitled company';
          showStatus('Saved');

          const listLabelChanged =
            String(saved.name || '') !== String(priorBody.name || '')
            || String(saved.industry || '') !== String(priorBody.industry || '')
            || String(saved.type || '') !== String(priorBody.type || '')
            || String(saved.location || '') !== String(priorBody.location || '')
            || String(saved.website || '') !== String(priorBody.website || '');
          if (listLabelChanged) renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
      }
    }

    async function undoOrg() {
      if (!undoStack.length) return;
      const snap = undoStack.pop();
      syncUndoBtn();
      await persistOrg({ fromUndo: true, bodyOverride: snap, remount: true });
    }

    form.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return;
      const t = /** @type {HTMLElement} */ (e.target);
      const tag = t?.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!undoStack.length) return;
      e.preventDefault();
      void undoOrg();
    });

    undoBtn.addEventListener('click', () => {
      void undoOrg();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await persistOrg();
    });

    enrichBtn.addEventListener('click', () => {
      const orgId = current.id;
      const card = buildOrgBody();
      openEnrichOptionsDialog({
        title: 'Enrich company',
        modes: ['web'],
        onWeb: async () => {
          const save = await fetch(`/api/network/organizations/${encodeURIComponent(orgId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
          });
          const saved = await save.json();
          if (!saved.ok) throw new Error(saved.error || 'save_failed');
          if (saved.organization) {
            const idx = organizations.findIndex((x) => x.id === orgId || x.id === saved.organization.id);
            if (idx >= 0) organizations[idx] = saved.organization;
          }
          let r;
          try {
            r = await fetch(`/api/network/organizations/${encodeURIComponent(orgId)}/enrich`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ card }),
              signal: AbortSignal.timeout(95_000),
            });
          } catch (e) {
            const name = String(e?.name || '');
            if (name === 'TimeoutError' || name === 'AbortError') {
              throw new Error('Enrich timed out — try again, or add a website URL first');
            }
            throw e;
          }
          const j = await r.json();
          if (!j.ok) {
            if (j.error === 'enrich_timeout') {
              throw new Error('Enrich timed out — try again, or add a website URL first');
            }
            throw new Error(j.error || 'enrich_failed');
          }
          const found = Array.isArray(j.organization?.suggestedPeople)
            ? j.organization.suggestedPeople.filter((p) => p.status === 'pending').length
            : 0;
          applyEnrichedOrganization(
            j.organization,
            found ? `Enriched · ${found} people found` : 'Enriched from web',
          );
        },
        onFile: async () => {},
        onEmail: async () => {},
      });
    });

    detail.append(head, form);
  }

  async function loadOrganizations() {
    try {
      const r = await fetch('/api/network/organizations');
      const j = await r.json();
      if (j.ok) organizations = Array.isArray(j.organizations) ? j.organizations : [];
    } catch {
      // keep previous
    }
  }

  peopleTab.addEventListener('click', () => {
    void setView('people');
  });
  companiesTab.addEventListener('click', () => {
    void setView('companies');
  });
  groupsTab.addEventListener('click', () => {
    void setView('groups');
  });

  /**
   * @param {{ selectGroupId?: string | null }} [opts]
   */
  async function openGroupsUi(opts = {}) {
    const { mountNetworkGroupsUi } = await import('./network-groups-ui.js');
    groupsUiMounted = true;
    mountNetworkGroupsUi(groupsPane, {
      contacts,
      getContacts: () => contacts,
      selectGroupId: opts.selectGroupId || null,
      embedded: true,
      onClose: () => {
        void setView('people');
      },
      onOpenContact: (id) => {
        selectedId = id;
        void setView('people');
      },
      onContactsChanged: async () => {
        const keepId = selectedId;
        const prevView = view;
        showStatus('Loading…');
        try {
          const [cr, or] = await Promise.all([
            fetch('/api/network/contacts'),
            fetch('/api/network/organizations'),
          ]);
          const j = await cr.json();
          const oj = await or.json();
          if (!j.ok) throw new Error(j.error || 'load_failed');
          contacts = Array.isArray(j.contacts) ? j.contacts : [];
          if (oj.ok) organizations = Array.isArray(oj.organizations) ? oj.organizations : [];
          if (Array.isArray(j.preferredContactMethods) && j.preferredContactMethods.length) {
            methodOptions = j.preferredContactMethods;
          }
          showStatus('');
          if (keepId && contacts.some((c) => c.id === keepId)) selectedId = keepId;
          else if (prevView !== 'groups') selectedId = contacts[0]?.id || null;
          if (prevView === 'people') {
            renderList();
            if (selectedId) selectContact(selectedId);
          }
        } catch (err) {
          showStatus(String(err?.message || err), true);
        }
      },
    });
  }

  startGroupSelBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    const name = prompt(`Group name for ${ids.length} people?`) || '';
    if (!name.trim()) {
      showStatus('Cancelled');
      return;
    }
    showStatus('Creating group…');
    try {
      const r = await fetch('/api/network/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), memberIds: ids }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      selectedContactIds.clear();
      syncSelectionActions();
      renderList();
      showStatus(`Started ${j.group?.name || 'group'}`);
      await setView('groups', { selectGroupId: j.group?.id || null });
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  addToGroupBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    showStatus('Loading groups…');
    try {
      const r = await fetch('/api/network/groups');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'groups_failed');
      const groups = Array.isArray(j.groups) ? j.groups : [];
      if (!groups.length) {
        showStatus('No groups yet — open the Groups tab first', true);
        return;
      }
      const labels = groups.map((g, i) => `${i + 1}. ${g.name || 'Untitled'} (${(g.memberIds || []).length})`).join('\n');
      const pick = prompt(`Add ${ids.length} contact(s) to which group?\n${labels}\n\nEnter number:`);
      const idx = Number(pick) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= groups.length) {
        showStatus('Cancelled');
        return;
      }
      const group = groups[idx];
      const ar = await fetch(`/api/network/groups/${encodeURIComponent(group.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: ids }),
      });
      const aj = await ar.json();
      if (!aj.ok) throw new Error(aj.error || 'add_failed');
      selectedContactIds.clear();
      syncSelectionActions();
      renderList();
      showStatus(`Added to ${group.name || 'group'}`);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  mergeBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (ids.length < 2) return;
    const names = ids
      .map((id) => contacts.find((c) => c.id === id)?.displayName || id)
      .join(', ');
    if (!confirm(`Merge ${ids.length} contacts into one?\n\n${names}`)) return;
    showStatus('Merging…');
    try {
      const r = await fetch('/api/network/contacts/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'merge_failed');
      selectedContactIds.clear();
      syncSelectionActions();
      await load();
      if (j.contact?.id) {
        selectedId = j.contact.id;
        selectContact(selectedId);
      }
      showStatus(`Merged into ${j.contact?.displayName || 'one contact'}`);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  deleteSelBtn.addEventListener('click', async () => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    const names = ids
      .map((id) => contacts.find((c) => c.id === id)?.displayName || 'contact')
      .slice(0, 8)
      .join(', ');
    const more = ids.length > 8 ? ` (+${ids.length - 8} more)` : '';
    if (!confirm(`Delete ${ids.length} contact(s)?\n\n${names}${more}`)) return;
    showStatus('Deleting…');
    try {
      const r = await fetch('/api/network/contacts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'delete_failed');
      const drop = new Set(ids);
      contacts = contacts.filter((c) => !drop.has(c.id));
      for (const id of ids) contactUndoStacks.delete(id);
      if (selectedId && drop.has(selectedId)) selectedId = contacts[0]?.id || null;
      selectedContactIds.clear();
      syncSelectionActions();
      showStatus(`Deleted ${j.deleted || ids.length}`);
      renderList();
      if (selectedId) selectContact(selectedId);
      else detail.innerHTML = '<p class="muted">Select a person</p>';
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  enhanceSelBtn.addEventListener('click', async (ev) => {
    const ids = [...selectedContactIds];
    if (!ids.length) return;
    enhanceSelBtn.disabled = true;
    beginWaitCursor(ev);
    let ok = 0;
    let fail = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const name = contacts.find((c) => c.id === id)?.displayName || id;
        showStatus(`Enhancing ${i + 1}/${ids.length}: ${name}…`);
        try {
          const r = await fetch(`/api/network/contacts/${encodeURIComponent(id)}/enrich`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(95_000),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'enrich_failed');
          const idx = contacts.findIndex((x) => x.id === id);
          if (idx >= 0) contacts[idx] = j.contact;
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      selectedContactIds.clear();
      syncSelectionActions();
      renderList();
      if (selectedId) {
        const cur = contacts.find((c) => c.id === selectedId);
        if (cur) renderDetail(cur);
      }
      showStatus(
        fail ? `Enhanced ${ok}, failed ${fail}` : `Enhanced ${ok}`,
        Boolean(fail && !ok),
      );
    } finally {
      endWaitCursor();
      enhanceSelBtn.disabled = false;
    }
  });

  addBtn.addEventListener('click', async () => {
    const displayName = prompt('Person name?');
    if (!displayName?.trim()) return;
    showStatus('Creating…');
    try {
      const r = await fetch('/api/network/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim(), kinds: ['friend'] }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      contacts.unshift(j.contact);
      selectedId = j.contact.id;
      showStatus('Created');
      renderList();
      selectContact(selectedId);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  addCompanyBtn.addEventListener('click', async () => {
    const name = prompt('Company name?');
    if (!name?.trim()) return;
    showStatus('Creating…');
    try {
      const r = await fetch('/api/network/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      organizations.unshift(j.organization);
      selectedOrgId = j.organization.id;
      showStatus('Created');
      renderList();
      openOrganization(selectedOrgId);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  bulkBtn.addEventListener('click', () => {
    bulkPanel.hidden = !bulkPanel.hidden;
  });
  bulkPanel.querySelector('[data-bulk-cancel]')?.addEventListener('click', () => {
    bulkPanel.hidden = true;
  });
  bulkPanel.querySelector('[data-bulk-submit]')?.addEventListener('click', async () => {
    const text = bulkPanel.querySelector('.network-crm__bulk-text')?.value || '';
    const kinds = [];
    if (bulkPanel.querySelector('[name="bulk-friend"]')?.checked) kinds.push('friend');
    if (bulkPanel.querySelector('[name="bulk-organizer"]')?.checked) kinds.push('organizer');
    if (bulkPanel.querySelector('[name="bulk-business"]')?.checked) kinds.push('business');
    showStatus('Bulk adding…');
    try {
      const r = await fetch('/api/network/contacts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: text, kinds: kinds.length ? kinds : ['friend'] }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'bulk_failed');
      const created = Array.isArray(j.created) ? j.created : [];
      contacts = [...created, ...contacts];
      showStatus(`Added ${created.length}${j.skipped ? ` (skipped ${j.skipped} existing)` : ''}`);
      bulkPanel.hidden = true;
      const ta = bulkPanel.querySelector('.network-crm__bulk-text');
      if (ta) ta.value = '';
      if (created[0]) {
        selectedId = created[0].id;
        renderList();
        selectContact(selectedId);
      } else {
        renderList();
      }
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });

  function syncPeopleFiltersFromUi() {
    peopleFilters = {
      kind: kindFilter.sel.value || '',
      relationship: relationshipFilter.sel.value || '',
      status: statusFilter.sel.value || '',
    };
    renderList();
  }
  kindFilter.sel.addEventListener('change', syncPeopleFiltersFromUi);
  relationshipFilter.sel.addEventListener('change', syncPeopleFiltersFromUi);
  statusFilter.sel.addEventListener('change', syncPeopleFiltersFromUi);

  async function load() {
    showStatus('Loading…');
    try {
      const [cr, or] = await Promise.all([
        fetch('/api/network/contacts'),
        fetch('/api/network/organizations'),
      ]);
      const j = await cr.json();
      const oj = await or.json();
      if (!j.ok) throw new Error(j.error || 'load_failed');
      contacts = Array.isArray(j.contacts) ? j.contacts : [];
      if (oj.ok) organizations = Array.isArray(oj.organizations) ? oj.organizations : [];
      if (Array.isArray(j.preferredContactMethods) && j.preferredContactMethods.length) {
        methodOptions = j.preferredContactMethods;
      }
      showStatus('');
      selectedId = contacts[0]?.id || null;
      syncTabs();
      renderList();
      if (selectedId) selectContact(selectedId);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  }

  load();
}
