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

  tabs.append(peopleTab, companiesTab);

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

  const groupsBtn = document.createElement('button');
  groupsBtn.type = 'button';
  groupsBtn.className = 'network-crm__btn network-crm__btn--primary';
  groupsBtn.textContent = 'Start a group';

  const addToGroupBtn = document.createElement('button');
  addToGroupBtn.type = 'button';
  addToGroupBtn.className = 'network-crm__btn';
  addToGroupBtn.textContent = 'Add to group';
  addToGroupBtn.hidden = true;

  peopleActions.append(addBtn, bulkBtn, groupsBtn, addToGroupBtn);
  companyActions.append(addCompanyBtn);
  toolbar.append(search, peopleActions, companyActions);

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
      <label class="network-crm__check"><input type="checkbox" name="bulk-business"> Business</label>
      <label class="network-crm__check"><input type="checkbox" name="bulk-community"> Community</label>
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
  mainPane.append(tabs, toolbar, bulkPanel, layout, status);

  const groupsPane = document.createElement('div');
  groupsPane.className = 'network-crm__groups-pane';
  groupsPane.hidden = true;

  wrap.append(mainPane, groupsPane);
  root.append(wrap);

  /** @type {object[]} */
  let contacts = [];
  /** @type {object[]} */
  let organizations = [];
  /** @type {string[]} */
  let methodOptions = DEFAULT_METHODS;
  /** @type {string | null} */
  let selectedId = null;
  /** @type {'people' | 'companies'} */
  let view = 'people';
  /** @type {string | null} */
  let selectedOrgId = null;
  /** @type {Set<string>} */
  const selectedContactIds = new Set();
  let query = '';
  /** Session flag: org detail "Show attributes" panel open */
  let orgAttrsExpanded = false;
  /** Session flag: contact detail "Show attributes" panel open */
  let contactAttrsExpanded = false;
  /** Bumps when detail pane is remounted; cancels stale autosaves */
  let detailGeneration = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let detailAutosaveTimer = null;
  const AUTOSAVE_MS = 700;
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
    peopleTab.classList.toggle('network-crm__tab--active', onPeople);
    companiesTab.classList.toggle('network-crm__tab--active', !onPeople);
    peopleTab.setAttribute('aria-selected', onPeople ? 'true' : 'false');
    companiesTab.setAttribute('aria-selected', onPeople ? 'false' : 'true');
    search.placeholder = onPeople ? 'Search people…' : 'Search companies…';
    peopleActions.hidden = !onPeople;
    companyActions.hidden = onPeople;
    if (!onPeople) bulkPanel.hidden = true;
    syncAddToGroupBtn();
  }

  function syncAddToGroupBtn() {
    const n = selectedContactIds.size;
    addToGroupBtn.hidden = n === 0 || view !== 'people';
    addToGroupBtn.textContent = n ? `Add to group (${n})` : 'Add to group';
  }

  /**
   * @param {'people' | 'companies'} next
   * @param {{ selectOrgId?: string | null }} [opts]
   */
  async function setView(next, opts = {}) {
    view = next;
    syncTabs();
    list.setAttribute('aria-label', next === 'people' ? 'People' : 'Companies');
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
    if (!q) return contacts;
    return contacts.filter((c) => {
      const hay = [
        c.displayName,
        ...(c.aliases || []),
        ...(c.kinds || []),
        ...(c.alignedActivities || []),
        ...(c.preferredContactMethods || []),
        c.summary,
        c.howWeMet,
        c.networkCircles,
        c.org,
        c.title,
        c.bio,
        c.notes,
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

  /**
   * Image-candidate picker in a pop-out dialog. Skips broken previews; supports Search further.
   * @param {{
   *   candidatesUrl: string,
   *   applyUrl: string,
   *   buttonLabel?: string,
   *   emptyLabel?: string,
   *   dialogTitle?: string,
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

    /** @type {number} */
    let nextOffset = 0;
    /** @type {boolean} */
    let hasMore = false;
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
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        let triedFull = thumb === url;
        img.addEventListener('error', () => {
          if (!triedFull && url) {
            triedFull = true;
            img.src = url;
            return;
          }
          // No usable preview — discard; do not offer "Preview unavailable".
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
        });
        img.src = thumb;
        btn.append(img);
        btn.addEventListener('click', async () => {
          if (btn.hidden) return;
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
      if (!grid || !furtherBtn || !statusEl) return;

      const reset = Boolean(fetchOpts.reset);
      if (reset) {
        nextOffset = 0;
        hasMore = false;
        shownUrls.clear();
        grid.replaceChildren();
      }

      furtherBtn.disabled = true;
      findBtn.disabled = true;
      const loading = document.createElement('p');
      loading.className = 'muted network-crm__img-pick-hint';
      loading.dataset.loading = '1';
      loading.textContent = reset ? 'Looking up images…' : 'Searching further…';
      grid.append(loading);
      statusEl.textContent = reset ? 'Searching…' : 'Loading next results…';
      showStatus(reset ? 'Finding images…' : 'Searching further…');

      try {
        const r = await fetch(opts.candidatesUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offset: nextOffset, limit: 5 }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'candidates_failed');
        grid.querySelector('[data-loading="1"]')?.remove();

        const candidates = Array.isArray(j.candidates) ? j.candidates : [];
        nextOffset = Number(j.nextOffset) >= 0 ? Number(j.nextOffset) : nextOffset + candidates.length;
        hasMore = Boolean(j.hasMore);

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
      }
    }

    function openDialog() {
      closeDialog();
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
      const furtherBtn = document.createElement('button');
      furtherBtn.type = 'button';
      furtherBtn.className = 'network-crm__btn network-crm__img-pick-further';
      furtherBtn.textContent = 'Search further';
      furtherBtn.hidden = true;
      furtherBtn.addEventListener('click', () => {
        void loadCandidates({ reset: false });
      });
      actions.append(furtherBtn);

      dialog.append(header, hint, statusEl, grid, actions);
      backdrop.append(dialog);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeDialog();
      });
      document.body.append(backdrop);
      document.addEventListener('keydown', onKeydown);
      void loadCandidates({ reset: true });
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
      check.title = 'Select for group';
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) selectedContactIds.add(c.id);
        else selectedContactIds.delete(c.id);
        syncAddToGroupBtn();
      });

      const av = avatarEl(c, 'network-crm__avatar');
      const meta = document.createElement('div');
      meta.className = 'network-crm__row-meta';
      const name = document.createElement('div');
      name.className = 'network-crm__row-name';
      name.textContent = c.displayName || 'Untitled';
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
      li.tabIndex = 0;
      const meta = document.createElement('div');
      meta.className = 'network-crm__row-meta';
      const name = document.createElement('div');
      name.className = 'network-crm__row-name';
      name.textContent = o.name || 'Untitled company';
      const sub = document.createElement('div');
      sub.className = 'network-crm__row-sub muted';
      sub.textContent = [o.location, o.website].filter(Boolean).join(' · ');
      meta.append(name, sub);
      li.append(meta);
      li.addEventListener('click', () => openOrganization(o.id));
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
    if (detailAutosaveTimer) {
      clearTimeout(detailAutosaveTimer);
      detailAutosaveTimer = null;
    }
    const gen = ++detailGeneration;
    /** @type {object} */
    let current = c;
    detail.replaceChildren();

    const head = document.createElement('div');
    head.className = 'network-crm__detail-head';

    const avWrap = document.createElement('div');
    avWrap.className = 'network-crm__avatar-wrap';
    avWrap.append(avatarEl(current, 'network-crm__avatar network-crm__avatar--lg'));

    const changePhoto = document.createElement('button');
    changePhoto.type = 'button';
    changePhoto.className = 'network-crm__btn network-crm__btn--tiny';
    changePhoto.textContent = 'Change photo';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    changePhoto.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      showStatus('Uploading photo…');
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const r = await fetch(`/api/network/contacts/${encodeURIComponent(current.id)}/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'avatar_failed');
        const idx = contacts.findIndex((x) => x.id === current.id);
        if (idx >= 0) contacts[idx] = j.contact;
        showStatus('Photo updated');
        renderList();
        renderDetail(j.contact);
      } catch (err) {
        showStatus(String(err?.message || err), true);
      } finally {
        fileInput.value = '';
      }
    });
    avWrap.append(changePhoto, fileInput);
    const pickWrap = mountImageCandidatePicker({
      candidatesUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar-candidates`,
      applyUrl: `/api/network/contacts/${encodeURIComponent(current.id)}/avatar-from-url`,
      buttonLabel: 'Find other photos',
      dialogTitle: 'Pick a photo',
      emptyLabel: 'No photos found — try Enrich or upload',
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
    if (!current.avatarUrl) {
      const hint = document.createElement('p');
      hint.className = 'muted network-crm__aliases';
      hint.textContent = 'No photo yet — change photo, find other photos, or Enrich';
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
    for (const k of ['friend', 'business', 'community']) {
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
    };
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
    const methodsLabel = document.createElement('span');
    methodsLabel.className = 'network-crm__checks-label';
    methodsLabel.textContent = 'Preferred contact methods';
    methodsBox.append(methodsLabel);

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

    const moreChannels = section('Contact methods', [
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
      field('Aliases (comma-separated)', 'aliases', (c.aliases || []).join(', ')),
      field('Department', 'department', c.department || ''),
      urlsField,
      field('Private Notes', 'notes', c.notes || '', { rows: 3 }),
    );

    const enrichMeta = document.createElement('p');
    enrichMeta.className = 'network-crm__meta muted';
    const conf =
      typeof c.enrichment?.confidence === 'number'
        ? ` · confidence ${Math.round(c.enrichment.confidence * 100)}%`
        : '';
    const enriched = c.enrichment?.enrichedAt ? `Enriched ${c.enrichment.enrichedAt}${conf}` : 'Not enriched yet';
    const created = c.createdAt ? ` · created ${c.createdAt}` : '';
    const updated = c.updatedAt ? ` · updated ${c.updatedAt}` : '';
    enrichMeta.textContent = `${enriched} · source: ${c.source || '—'}${created}${updated}`;
    attrsPanel.append(enrichMeta);

    const toggleAttrs = document.createElement('button');
    toggleAttrs.type = 'button';
    toggleAttrs.className = 'network-crm__btn network-crm__btn--attrs';
    toggleAttrs.textContent = contactAttrsExpanded ? 'Hide attributes' : 'Show attributes';
    toggleAttrs.setAttribute('aria-expanded', contactAttrsExpanded ? 'true' : 'false');
    toggleAttrs.addEventListener('click', () => {
      contactAttrsExpanded = !contactAttrsExpanded;
      attrsPanel.hidden = !contactAttrsExpanded;
      toggleAttrs.textContent = contactAttrsExpanded ? 'Hide attributes' : 'Show attributes';
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
      field('Role', 'title', c.title),
      field('Location', 'location', c.location),
      kindsBox,
      field('Rating', 'rating', c.rating || '', {
        options: ['Ride or Die', 'Hot', 'Warm', 'Cold'],
      }),
      field('Relationship status', 'relationshipStatus', c.relationshipStatus || '', {
        options: ['Active', 'Dormant', 'Former'],
      }),
      lastContactField,
      moreChannels,
      field('Community', 'networkCircles', c.networkCircles || '', { rows: 2 }),
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
    undoBtn.title = 'Undo last autosave (Ctrl+Z outside a field uses this too)';

    const enrichBtn = document.createElement('button');
    enrichBtn.type = 'button';
    enrichBtn.className = 'network-crm__btn';
    enrichBtn.textContent = 'Enrich from web';

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
      const kindsSel = ['friend', 'business', 'community'].filter((k) => form.querySelector(`[name="kind-${k}"]`)?.checked);
      const prefs = methodOptions.filter((m) => form.querySelector(`[name="pref-${m}"]`)?.checked);
      return {
        displayName: String(fd.get('displayName') || '').trim(),
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

          await loadOrganizations();
          if (gen !== detailGeneration) return;

          if (mergedAway || opts.remount || opts.fromUndo) {
            showStatus(opts.fromUndo ? 'Undone' : mergedAway ? 'Saved (merged duplicate)' : 'Saved');
            renderList();
            renderDetail(saved);
            return;
          }

          h.textContent = saved.displayName || 'Untitled';
          const confSaved =
            typeof saved.enrichment?.confidence === 'number'
              ? ` · confidence ${Math.round(saved.enrichment.confidence * 100)}%`
              : '';
          const enrichedSaved = saved.enrichment?.enrichedAt
            ? `Enriched ${saved.enrichment.enrichedAt}${confSaved}`
            : 'Not enriched yet';
          const createdSaved = saved.createdAt ? ` · created ${saved.createdAt}` : '';
          const updatedSaved = saved.updatedAt ? ` · updated ${saved.updatedAt}` : '';
          enrichMeta.textContent = `${enrichedSaved} · source: ${saved.source || '—'}${createdSaved}${updatedSaved}`;
          showStatus('Saved');
          renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
      }
    }

    async function undoContact() {
      if (!undoStack.length) return;
      if (detailAutosaveTimer) {
        clearTimeout(detailAutosaveTimer);
        detailAutosaveTimer = null;
      }
      const snap = undoStack.pop();
      syncUndoBtn();
      await persistContact({ fromUndo: true, bodyOverride: snap, remount: true });
    }

    function scheduleContactAutosave() {
      if (detailAutosaveTimer) clearTimeout(detailAutosaveTimer);
      detailAutosaveTimer = setTimeout(() => {
        detailAutosaveTimer = null;
        if (gen !== detailGeneration) return;
        void persistContact();
      }, AUTOSAVE_MS);
    }

    form.addEventListener('input', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t?.closest?.('[readonly], .network-crm__input--readonly')) return;
      scheduleContactAutosave();
    });
    form.addEventListener('change', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t?.closest?.('[readonly], .network-crm__input--readonly')) return;
      scheduleContactAutosave();
    });

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
      if (detailAutosaveTimer) {
        clearTimeout(detailAutosaveTimer);
        detailAutosaveTimer = null;
      }
      await persistContact();
    });

    enrichBtn.addEventListener('click', async (ev) => {
      enrichBtn.disabled = true;
      beginWaitCursor(ev);
      showStatus('Enriching from web…');
      try {
        const r = await fetch(`/api/network/contacts/${encodeURIComponent(current.id)}/enrich`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'enrich_failed');
        const idx = contacts.findIndex((x) => x.id === current.id);
        if (idx >= 0) contacts[idx] = j.contact;
        showStatus('Enriched');
        renderList();
        renderDetail(j.contact);
      } catch (err) {
        showStatus(String(err?.message || err), true);
      } finally {
        endWaitCursor();
        enrichBtn.disabled = false;
      }
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
    view = 'companies';
    selectedOrgId = id;
    syncTabs();
    list.setAttribute('aria-label', 'Companies');
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
    if (detailAutosaveTimer) {
      clearTimeout(detailAutosaveTimer);
      detailAutosaveTimer = null;
    }
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
      emptyLabel: 'No logos found — try Enrich',
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
        [c.displayName, ...(c.aliases || [])]
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
            name: p.displayName,
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
      ? `Enriched ${o.enrichment.enrichedAt}${conf}`
      : 'Not enriched yet';
    attrsPanel.append(enrichMeta);

    const toggleAttrs = document.createElement('button');
    toggleAttrs.type = 'button';
    toggleAttrs.className = 'network-crm__btn network-crm__btn--attrs';
    toggleAttrs.textContent = orgAttrsExpanded ? 'Hide attributes' : 'Show attributes';
    toggleAttrs.setAttribute('aria-expanded', orgAttrsExpanded ? 'true' : 'false');
    toggleAttrs.addEventListener('click', () => {
      orgAttrsExpanded = !orgAttrsExpanded;
      attrsPanel.hidden = !orgAttrsExpanded;
      toggleAttrs.textContent = orgAttrsExpanded ? 'Hide attributes' : 'Show attributes';
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
    undoBtn.title = 'Undo last autosave (Ctrl+Z outside a field uses this too)';
    const enrichBtn = document.createElement('button');
    enrichBtn.type = 'button';
    enrichBtn.className = 'network-crm__btn';
    enrichBtn.textContent = 'Enrich from web';
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
          renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
      }
    }

    async function undoOrg() {
      if (!undoStack.length) return;
      if (detailAutosaveTimer) {
        clearTimeout(detailAutosaveTimer);
        detailAutosaveTimer = null;
      }
      const snap = undoStack.pop();
      syncUndoBtn();
      await persistOrg({ fromUndo: true, bodyOverride: snap, remount: true });
    }

    function scheduleOrgAutosave() {
      if (detailAutosaveTimer) clearTimeout(detailAutosaveTimer);
      detailAutosaveTimer = setTimeout(() => {
        detailAutosaveTimer = null;
        if (gen !== detailGeneration) return;
        void persistOrg();
      }, AUTOSAVE_MS);
    }

    form.addEventListener('input', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t?.closest?.('[readonly], .network-crm__input--readonly')) return;
      scheduleOrgAutosave();
    });
    form.addEventListener('change', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t?.closest?.('[readonly], .network-crm__input--readonly')) return;
      scheduleOrgAutosave();
    });

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
      if (detailAutosaveTimer) {
        clearTimeout(detailAutosaveTimer);
        detailAutosaveTimer = null;
      }
      await persistOrg();
    });

    enrichBtn.addEventListener('click', async (ev) => {
      enrichBtn.disabled = true;
      beginWaitCursor(ev);
      showStatus('Enriching organization…');
      try {
        const r = await fetch(`/api/network/organizations/${encodeURIComponent(current.id)}/enrich`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'enrich_failed');
        const idx = organizations.findIndex((x) => x.id === current.id);
        if (idx >= 0) organizations[idx] = j.organization;
        const found = Array.isArray(j.organization?.suggestedPeople)
          ? j.organization.suggestedPeople.filter((p) => p.status === 'pending').length
          : 0;
        showStatus(found ? `Enriched · ${found} people found` : 'Enriched');
        renderList();
        renderOrgDetail(j.organization);
      } catch (err) {
        showStatus(String(err?.message || err), true);
      } finally {
        endWaitCursor();
        enrichBtn.disabled = false;
      }
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

  groupsBtn.addEventListener('click', async () => {
    mainPane.hidden = true;
    groupsPane.hidden = false;
    const { mountNetworkGroupsUi } = await import('./network-groups-ui.js');
    mountNetworkGroupsUi(groupsPane, {
      contacts,
      getContacts: () => contacts,
      onClose: () => {
        groupsPane.hidden = true;
        groupsPane.replaceChildren();
        mainPane.hidden = false;
        load();
      },
      onOpenContact: (id) => {
        groupsPane.hidden = true;
        groupsPane.replaceChildren();
        mainPane.hidden = false;
        selectedId = id;
        void setView('people');
      },
      onContactsChanged: async () => {
        await load();
      },
    });
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
        showStatus('No groups yet — open Start a group first', true);
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
      syncAddToGroupBtn();
      renderList();
      showStatus(`Added to ${group.name || 'group'}`);
    } catch (err) {
      showStatus(String(err?.message || err), true);
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
    if (bulkPanel.querySelector('[name="bulk-business"]')?.checked) kinds.push('business');
    if (bulkPanel.querySelector('[name="bulk-community"]')?.checked) kinds.push('community');
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
