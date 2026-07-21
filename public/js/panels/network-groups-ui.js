import {
  createGroupKindIconEl,
  groupKind,
  groupKindLabel,
  groupSectionLabel,
  isSceneGroup,
} from '../lib/network-group-kind.js?v=scene-ux-1';
import { NETWORK_LABELS } from '../lib/network-labels.js';
import {
  findExactDisplayNameMatch,
  openExactNameConflictDialog,
  openNamesListDialog,
} from '../lib/network-add-contacts-dialog.js?v=group-kind-9';
import {
  fetchHowWeMetSuggestion,
  howWeMetStatusBit,
} from '../lib/network-how-we-met-suggest.js?v=how-we-met-1';
import { compareContactSearchNameRank } from '../lib/network-contact-search.js';
import { addSceneToken, removeSceneToken } from '../lib/network-scene-tokens.js';

/**
 * Network groups management screen.
 * @param {HTMLElement} root
 * @param {{
 *   contacts: object[],
 *   getContacts?: () => object[],
 *   getFilteredContacts?: () => object[],
 *   isContactsLoading?: () => boolean,
 *   groups?: object[],
 *   selectGroupId?: string | null,
 *   embedded?: boolean,
 *   onClose?: () => void,
 *   onOpenContact?: (id: string) => void,
 *   onGroupFocus?: () => void,
 *   onContactsChanged?: () => Promise<void> | void,
 *   onToolbarSync?: () => void,
 * }} opts
 * @returns {{
 *   focus: (opts?: { selectGroupId?: string | null, refresh?: boolean }) => Promise<void>,
 *   setQuery: (q: string) => void,
 *   createGroup: () => Promise<void>,
 *   saveSelected: () => Promise<void>,
 *   deleteSelected: () => Promise<void>,
 *   canEditSelected: () => boolean,
 *   destroy: () => void,
 * }}
 */
export function mountNetworkGroupsUi(root, opts) {
  const { onOpenContact, onGroupFocus } = opts;
  const embedded = Boolean(opts.embedded);
  /** @type {object[]} */
  let contacts = Array.isArray(opts.contacts) ? opts.contacts : [];
  /** @type {Map<string, object>} */
  let contactMap = new Map();
  const getContacts =
    typeof opts.getContacts === 'function' ? opts.getContacts : () => opts.contacts;
  const getFilteredContacts =
    typeof opts.getFilteredContacts === 'function' ? opts.getFilteredContacts : getContacts;
  const isContactsLoading =
    typeof opts.isContactsLoading === 'function' ? opts.isContactsLoading : () => false;

  function rebuildContactMap() {
    contactMap = new Map();
    for (const c of contacts) {
      if (c?.id) contactMap.set(c.id, c);
    }
  }
  rebuildContactMap();

  async function pullLatestContacts() {
    await opts.onContactsChanged?.();
    const next = getContacts();
    if (Array.isArray(next)) {
      contacts = next;
      rebuildContactMap();
    }
  }

  /** @type {object[]} */
  let groups = Array.isArray(opts.groups) ? opts.groups.slice() : [];
  /** @type {string | null} */
  let selectedId = null;
  /** @type {string} */
  let listQuery = '';
  /** @type {{ save: () => Promise<void>, delete: () => Promise<void> } | null} */
  let detailActions = null;
  /** @type {Set<string> | null} */
  let cachedMemberIds = null;
  /** @type {(() => void) | null} */
  let refreshOpenDetail = null;
  const UNGROUPED_ID = '__ungrouped__';
  /** Initial members to paint before yielding (rest fill in next frames). */
  const MEMBER_PAINT_CHUNK = 24;

  function notifyToolbar() {
    opts.onToolbarSync?.();
  }

  root.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'network-groups';
  if (embedded) wrap.classList.add('network-groups--embedded');

  const layout = document.createElement('div');
  layout.className = 'network-crm__layout network-groups__layout';

  const listCol = document.createElement('div');
  listCol.className = 'network-groups__list-col';
  const list = document.createElement('ul');
  list.className = 'network-crm__list';
  listCol.append(list);

  const detailCol = document.createElement('div');
  detailCol.className = 'network-groups__detail-col';
  const detail = document.createElement('div');
  detail.className = 'network-crm__detail';
  detail.innerHTML = '<p class="muted">Select a group</p>';

  const status = document.createElement('p');
  status.className = 'network-crm__status network-groups__detail-status muted';
  status.hidden = true;

  detailCol.append(detail, status);

  layout.append(listCol, detailCol);

  wrap.append(layout);
  root.append(wrap);

  /** Cap list + detail just above the browser bottom (room for rounded corners). */
  function syncColumnsToViewport() {
    if (!list.isConnected) return;
    const pagePad = 12;
    for (const el of [list, detail]) {
      const top = el.getBoundingClientRect().top;
      const avail = Math.floor(window.innerHeight - top - pagePad);
      el.style.maxHeight = `${Math.max(120, avail)}px`;
    }
  }

  const onViewportChange = () => {
    requestAnimationFrame(syncColumnsToViewport);
  };
  window.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  const scrollFitObs = new ResizeObserver(onViewportChange);
  scrollFitObs.observe(wrap);
  if (root.parentElement) scrollFitObs.observe(root.parentElement);

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg || '';
    status.classList.toggle('network-crm__status--err', Boolean(isErr));
  }

  function contactName(id) {
    const c = contactMap.get(id);
    if (!c) return id;
    if (c.nickname) return `${c.displayName || id} (${c.nickname})`;
    return c.displayName || id;
  }

  function contactById(id) {
    return contactMap.get(id) || null;
  }

  /**
   * @param {string} id
   * @param {string} [label]
   */
  function contactOpenBtn(id, label) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'network-crm__link-btn';
    link.textContent = label ?? contactName(id);
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      onOpenContact?.(id);
    });
    return link;
  }

  /**
   * @param {HTMLElement} avatar
   * @param {string} id
   */
  function wireAvatarOpenContact(avatar, id) {
    if (!id || !onOpenContact) return;
    avatar.classList.add('network-crm__avatar--open');
    avatar.tabIndex = 0;
    avatar.setAttribute('role', 'button');
    avatar.setAttribute('aria-label', `Open ${contactName(id)}`);
    avatar.title = 'Open contact';
    const open = () => onOpenContact(id);
    avatar.addEventListener('click', open);
    avatar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }

  function groupIconEl(g) {
    return createGroupKindIconEl(g);
  }

  function invalidateMemberCache() {
    cachedMemberIds = null;
  }

  /** Contact IDs that appear in at least one community or event group. */
  function memberIdSet() {
    if (cachedMemberIds) return cachedMemberIds;
    const set = new Set();
    for (const g of groups) {
      for (const id of g.memberIds || []) set.add(id);
    }
    cachedMemberIds = set;
    return set;
  }

  function ungroupedContacts() {
    const inGroup = memberIdSet();
    const pool = getFilteredContacts();
    const list = Array.isArray(pool) ? pool : contacts;
    return list
      .filter((c) => c?.id && !inGroup.has(c.id))
      .slice()
      .sort((a, b) =>
        String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
          sensitivity: 'base',
        }),
      );
  }

  /** Shared group options for “Add to…” (built once per ungrouped render). */
  function fillGroupOptions(select) {
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = groups.length ? 'Add to…' : 'No groups yet';
    select.append(blank);
    for (const g of groups) {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = `${g.name || 'Untitled'} (${groupKindLabel(g)})`;
      select.append(o);
    }
    select.disabled = !groups.length;
  }

  function memberNamesPreview(g, limit = 6) {
    const ids = Array.isArray(g.memberIds) ? g.memberIds : [];
    if (!ids.length) return 'No members';
    const names = ids.slice(0, limit).map((id) => contactName(id));
    const more = ids.length > limit ? ` +${ids.length - limit}` : '';
    return `${names.join(', ')}${more}`;
  }

  function avatarEl(contact) {
    const box = document.createElement('div');
    box.className = 'network-crm__avatar network-crm__avatar--sm';
    if (contact?.avatarUrl) {
      const img = document.createElement('img');
      img.src = `${contact.avatarUrl}${contact.avatarUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(contact.updatedAt || '')}`;
      img.alt = '';
      box.append(img);
    } else {
      const first = String(contact?.firstName || '').trim();
      const last = String(contact?.lastName || '').trim();
      const initials = first || last
        ? `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
        : String(contact?.displayName || '?')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((p, i, arr) => (i === 0 || i === arr.length - 1 ? p[0] || '' : ''))
            .join('')
            .toUpperCase()
            .slice(0, 2);
      box.textContent = initials || '?';
    }
    return box;
  }

  function appendUngroupedRow() {
    const people = ungroupedContacts();
    const li = document.createElement('li');
    li.className = 'network-crm__row network-groups__ungrouped-row';
    li.classList.toggle('network-crm__row--active', selectedId === UNGROUPED_ID);
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', selectedId === UNGROUPED_ID ? 'true' : 'false');
    li.tabIndex = 0;
    const icon = document.createElement('div');
    icon.className = 'network-crm__avatar';
    icon.textContent = '?';
    const meta = document.createElement('div');
    meta.className = 'network-crm__row-meta';
    const name = document.createElement('div');
    name.className = 'network-crm__row-name';
    name.textContent = 'Ungrouped';
    const sub = document.createElement('div');
    sub.className = 'network-crm__row-sub muted';
    const n = people.length;
    sub.textContent = `${n} person${n === 1 ? '' : 's'} not in any group`;
    meta.append(name, sub);
    li.append(icon, meta);
    li.addEventListener('click', () => selectUngrouped());
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectUngrouped();
      }
    });
    list.append(li);
  }

  function appendGroupSection(label, items) {
    if (!items.length) return;
    const heading = document.createElement('li');
    heading.className = 'network-groups__section-label muted';
    heading.textContent = label;
    heading.setAttribute('aria-hidden', 'true');
    list.append(heading);
    for (const g of items) {
      const li = document.createElement('li');
      li.className = 'network-crm__row';
      li.classList.toggle('network-crm__row--active', g.id === selectedId);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', g.id === selectedId ? 'true' : 'false');
      li.tabIndex = 0;
      const meta = document.createElement('div');
      meta.className = 'network-crm__row-meta';
      const name = document.createElement('div');
      name.className = 'network-crm__row-name';
      name.textContent = g.name || 'Untitled group';
      const sub = document.createElement('div');
      sub.className = 'network-crm__row-sub muted';
      const n = (g.memberIds || []).length;
      sub.textContent = `${groupKindLabel(g)} · ${n} member${n === 1 ? '' : 's'} · ${memberNamesPreview(g)}`;
      meta.append(name, sub);
      li.append(groupIconEl(g), meta);
      li.addEventListener('click', () => selectGroup(g.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectGroup(g.id);
        }
      });
      list.append(li);
    }
  }

  function groupMatchesQuery(g, q) {
    if (!q) return true;
    const memberPreview = (g.memberIds || [])
      .slice(0, 12)
      .map((id) => contactName(id))
      .join(' ');
    const hay = [g.name, g.description, g.eventType, groupKindLabel(g), memberPreview]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  }

  function renderList() {
    list.replaceChildren();
    const q = listQuery.trim().toLowerCase();
    if (!q) appendUngroupedRow();
    if (!groups.length) {
      const empty = document.createElement('li');
      empty.className = 'network-crm__empty muted';
      empty.textContent = NETWORK_LABELS.noGroupsYet;
      list.append(empty);
      syncColumnsToViewport();
      return;
    }
    const visible = groups.filter((g) => groupMatchesQuery(g, q));
    if (!visible.length) {
      const empty = document.createElement('li');
      empty.className = 'network-crm__empty muted';
      empty.textContent = 'No groups match your search';
      list.append(empty);
      syncColumnsToViewport();
      return;
    }
    const communities = visible.filter((g) => groupKind(g) === 'community');
    const events = visible.filter((g) => groupKind(g) === 'event');
    appendGroupSection(groupSectionLabel('community'), communities);
    appendGroupSection(groupSectionLabel('event'), events);
    syncColumnsToViewport();
  }

  let detailGeneration = 0;

  function selectUngrouped() {
    selectedId = UNGROUPED_ID;
    detailActions = null;
    refreshOpenDetail = null;
    renderList();
    renderUngroupedDetail();
    notifyToolbar();
  }

  /**
   * @param {string} id
   */
  function selectGroup(id) {
    onGroupFocus?.();
    selectedId = id;
    detailActions = null;
    refreshOpenDetail = null;
    renderList();
    const g = groups.find((x) => x.id === id);
    if (!g) {
      detail.innerHTML = '<p class="muted">Group not found</p>';
      notifyToolbar();
      return;
    }
    renderDetail(g);
    notifyToolbar();
  }

  function renderUngroupedDetail() {
    const gen = ++detailGeneration;
    detailActions = null;
    refreshOpenDetail = null;
    detail.replaceChildren();

    const wrapEl = document.createElement('div');
    wrapEl.className = 'network-groups__ungrouped';

    const headEl = document.createElement('div');
    headEl.className = 'network-crm__checks-label';
    const people = ungroupedContacts();
    headEl.textContent = `Ungrouped people (${people.length})`;
    const note = document.createElement('p');
    note.className = 'muted network-groups__kind-note';
    note.textContent = 'People who are not members of any Scene or event group.';

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'network-crm__input';
    search.placeholder = 'Search ungrouped people…';
    search.autocomplete = 'off';

    const results = document.createElement('div');
    results.className = 'network-groups__ungrouped-list';

    function renderRows() {
      if (gen !== detailGeneration) return;
      results.replaceChildren();
      const q = search.value.trim().toLowerCase();
      const filtered = people
        .filter((c) => {
          if (!q) return true;
          const hay = [c.displayName, c.nickname, ...(c.aliases || []), c.org, c.networkCircles]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
        .sort((a, b) => compareContactSearchNameRank(a, b, q));
      if (!filtered.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = isContactsLoading()
          ? 'Loading…'
          : q
            ? 'No matches'
            : 'Everyone is in at least one group';
        results.append(empty);
        return;
      }
      for (const c of filtered) {
        const row = document.createElement('div');
        row.className = 'network-groups__member';
        const avatar = avatarEl(c);
        wireAvatarOpenContact(avatar, c.id);
        row.append(avatar);
        const link = contactOpenBtn(
          c.id,
          c.nickname
            ? `${c.displayName || 'Untitled'} (${c.nickname})`
            : c.displayName || 'Untitled',
        );

        const addWrap = document.createElement('div');
        addWrap.className = 'network-groups__ungrouped-add';
        const pick = document.createElement('select');
        pick.className = 'network-crm__input network-groups__ungrouped-select';
        pick.setAttribute('aria-label', `Add ${c.displayName || 'person'} to group`);
        fillGroupOptions(pick);
        pick.addEventListener('change', async () => {
          const groupId = pick.value;
          if (!groupId) return;
          pick.disabled = true;
          showStatus(`Adding ${c.displayName || 'person'}…`);
          try {
            const r = await fetch(`/api/network/groups/${encodeURIComponent(groupId)}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contactIds: [c.id] }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'add_failed');
            upsertGroup(j.group);
            if (groupKind(j.group) === 'community') await pullLatestContacts();
            showStatus(`Added to ${j.group?.name || 'group'}`);
            if (gen === detailGeneration) renderUngroupedDetail();
            else renderList();
          } catch (err) {
            showStatus(String(err?.message || err), true);
            pick.disabled = false;
            pick.value = '';
          }
        });
        addWrap.append(pick);
        row.append(link, addWrap);
        results.append(row);
      }
    }

    search.addEventListener('input', () => renderRows());
    wrapEl.append(headEl, note, search, results);
    detail.append(wrapEl);
    renderRows();
  }

  /**
   * @param {object} g
   */
  function renderDetail(g) {
    const gen = ++detailGeneration;
    /** @type {object} */
    let current = g;
    /** Scene groups mirror contact Scene tags; event groups use memberIds APIs. */
    const isScene = isSceneGroup(g);
    detail.replaceChildren();

    const form = document.createElement('form');
    form.className = 'network-crm__form network-crm__form--groups-detail';

    function field(label, name, value, opts = {}) {
      const wrapEl = document.createElement('label');
      wrapEl.className = 'network-crm__field';
      if (opts.rows) wrapEl.classList.add('network-crm__field--full');
      if (opts.hidden) wrapEl.hidden = true;
      const span = document.createElement('span');
      span.textContent = label;
      let input;
      if (opts.rows) {
        input = document.createElement('textarea');
        input.rows = opts.rows;
        input.value = value || '';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = value || '';
      }
      input.name = name;
      input.className = 'network-crm__input';
      input.required = false;
      if (opts.readOnly) input.readOnly = true;
      if (opts.placeholder) input.placeholder = opts.placeholder;
      wrapEl.append(span, input);
      return wrapEl;
    }

    if (isScene) {
      const head = document.createElement('div');
      head.className = 'network-groups__scene-head network-groups__scene-head--edit';
      head.append(createGroupKindIconEl(g));
      const nameField = field('Scene tag', 'name', current.name, {
        placeholder: 'Scene name',
      });
      nameField.classList.add('network-groups__scene-name-field');
      head.append(nameField);
      form.append(head);
    } else {
      form.append(field('Name', 'name', current.name));
    }

    const peopleCols = document.createElement('div');
    peopleCols.className = 'network-groups__people-cols';

    const membersBox = document.createElement('div');
    membersBox.className = 'network-groups__col network-groups__members-panel';

    const memberBulk = document.createElement('div');
    memberBulk.className = 'network-groups__member-bulk';

    const bulkActions = document.createElement('div');
    bulkActions.className = 'network-crm__bulk-actions network-groups__member-bulk-actions';
    bulkActions.hidden = true;

    const bulkRemoveBtn = document.createElement('button');
    bulkRemoveBtn.type = 'button';
    bulkRemoveBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__btn--danger';
    bulkRemoveBtn.textContent = 'Remove selected';
    bulkRemoveBtn.disabled = true;

    const moveSelect = document.createElement('select');
    moveSelect.className = 'network-crm__input network-groups__move-select';
    moveSelect.setAttribute('aria-label', 'Move selected members to group');

    const bulkMoveBtn = document.createElement('button');
    bulkMoveBtn.type = 'button';
    bulkMoveBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__btn--primary';
    bulkMoveBtn.textContent = 'Move to group';
    bulkMoveBtn.disabled = true;

    bulkActions.append(bulkRemoveBtn, moveSelect, bulkMoveBtn);

    const selectAllWrap = document.createElement('label');
    selectAllWrap.className = 'network-crm__check network-groups__member-select-all';
    const selectAllCb = document.createElement('input');
    selectAllCb.type = 'checkbox';
    selectAllCb.setAttribute('aria-label', 'Select all members');
    const membersTitle = document.createElement('span');
    membersTitle.className = 'network-groups__members-count';
    selectAllWrap.append(selectAllCb, document.createTextNode(' '), membersTitle);

    memberBulk.append(bulkActions, selectAllWrap);

    const memberList = document.createElement('div');
    memberList.className = 'network-groups__member-list';
    membersBox.append(memberBulk, memberList);
    /** @type {string[]} */
    let memberIds = [...(g.memberIds || [])];
    const memberSet = new Set(memberIds);
    /** @type {Set<string>} */
    const selectedMemberIds = new Set();
    /** @type {(() => void) | null} */
    let paintInsights = null;

    function syncMembersTitle() {
      const n = memberIds.length;
      membersTitle.textContent = n ? `Members (${n})` : 'Members';
    }
    syncMembersTitle();

    function fillMoveGroupOptions() {
      moveSelect.replaceChildren();
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Move to…';
      moveSelect.append(blank);
      for (const og of groups) {
        if (og.id === g.id) continue;
        const o = document.createElement('option');
        o.value = og.id;
        o.textContent = `${og.name || 'Untitled'} (${groupKindLabel(og)})`;
        moveSelect.append(o);
      }
      moveSelect.disabled = !groups.some((og) => og.id !== g.id);
    }

    function syncMemberBulkUi() {
      const n = selectedMemberIds.size;
      const active = n > 0;
      bulkActions.hidden = !active;
      bulkActions.classList.toggle('network-groups__member-bulk-actions--active', active);
      bulkRemoveBtn.disabled = !active;
      bulkMoveBtn.disabled = !active || !moveSelect.value;
      moveSelect.disabled = !active || !groups.some((og) => og.id !== g.id);
      if (!memberIds.length) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
        selectAllCb.disabled = true;
        return;
      }
      selectAllCb.disabled = false;
      selectAllCb.checked = n > 0 && n === memberIds.length;
      selectAllCb.indeterminate = n > 0 && n < memberIds.length;
    }

    fillMoveGroupOptions();
    moveSelect.addEventListener('change', syncMemberBulkUi);

    selectAllCb.addEventListener('change', () => {
      selectedMemberIds.clear();
      if (selectAllCb.checked) {
        for (const id of memberIds) selectedMemberIds.add(id);
      }
      for (const row of memberList.querySelectorAll('[data-member-id]')) {
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb instanceof HTMLInputElement) cb.checked = selectAllCb.checked;
      }
      syncMemberBulkUi();
    });

    /**
     * @param {string} groupId
     */
    async function fetchGroupFresh(groupId) {
      const r = await fetch(`/api/network/groups/${encodeURIComponent(groupId)}`, {
        cache: 'no-store',
      });
      const j = await r.json();
      if (!j.ok || !j.group) throw new Error(j.error || 'reload_failed');
      return j.group;
    }

    /**
     * @param {string} id
     * @param {string} networkCircles
     */
    async function putContactSceneCircles(id, networkCircles) {
      const r = await fetch(`/api/network/contacts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ networkCircles }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.contact?.id) {
        contactMap.set(j.contact.id, j.contact);
        const i = contacts.findIndex((c) => c.id === j.contact.id);
        if (i >= 0) contacts[i] = j.contact;
      }
    }

    /**
     * Add contacts to a group (Scene → networkCircles; Event → members API).
     * @param {object} group
     * @param {string[]} ids
     */
    async function addIdsToGroup(group, ids) {
      if (!ids.length) return group;
      if (isSceneGroup(group)) {
        const sceneName = group.name || '';
        for (const id of ids) {
          const c = contactById(id);
          const next = addSceneToken(c?.networkCircles, sceneName);
          if (c && next === String(c.networkCircles || '')) continue;
          await putContactSceneCircles(id, next);
        }
        await pullLatestContacts();
        return fetchGroupFresh(group.id);
      }
      const r = await fetch(`/api/network/groups/${encodeURIComponent(group.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: ids }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'add_failed');
      return j.group;
    }

    /**
     * Remove contacts from a group (Scene → networkCircles; Event → members API).
     * @param {object} group
     * @param {string[]} ids
     */
    async function removeIdsFromGroup(group, ids) {
      if (!ids.length) return group;
      if (isSceneGroup(group)) {
        const sceneName = group.name || '';
        for (const id of ids) {
          const c = contactById(id);
          const next = removeSceneToken(c?.networkCircles, sceneName);
          if (c && next === String(c.networkCircles || '')) continue;
          await putContactSceneCircles(id, next);
        }
        await pullLatestContacts();
        return fetchGroupFresh(group.id);
      }
      const r = await fetch(`/api/network/groups/${encodeURIComponent(group.id)}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: ids }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'remove_failed');
      return j.group;
    }

    /**
     * @param {string[]} ids
     */
    async function removeMembers(ids) {
      if (!ids.length) return;
      showStatus(`Removing ${ids.length}…`);
      const nextGroup = await removeIdsFromGroup(current, ids);
      for (const id of ids) selectedMemberIds.delete(id);
      applyMembership(nextGroup);
      showStatus(`Removed ${ids.length}`);
      syncMemberBulkUi();
    }

    bulkRemoveBtn.addEventListener('click', async () => {
      const ids = [...selectedMemberIds];
      if (!ids.length) return;
      if (!confirm(`Remove ${ids.length} member${ids.length === 1 ? '' : 's'} from this group?`)) return;
      bulkRemoveBtn.disabled = true;
      try {
        await removeMembers(ids);
      } catch (err) {
        showStatus(String(err?.message || err), true);
        syncMemberBulkUi();
      }
    });

    bulkMoveBtn.addEventListener('click', async () => {
      const targetId = moveSelect.value;
      const ids = [...selectedMemberIds];
      if (!targetId || !ids.length) return;
      const target = groups.find((og) => og.id === targetId);
      if (!target) return;
      bulkMoveBtn.disabled = true;
      showStatus(`Moving ${ids.length}…`);
      try {
        const added = await addIdsToGroup(target, ids);
        upsertGroup(added);
        const removed = await removeIdsFromGroup(current, ids);
        for (const id of ids) selectedMemberIds.delete(id);
        applyMembership(removed);
        moveSelect.value = '';
        showStatus(`Moved ${ids.length}`);
        syncMemberBulkUi();
      } catch (err) {
        showStatus(String(err?.message || err), true);
        syncMemberBulkUi();
      }
    });

    /**
     * @param {string} id
     */
    function appendMemberRow(id) {
      const person = contactById(id);
      const row = document.createElement('div');
      row.className = 'network-groups__member';
      row.dataset.memberId = id;
      const checkWrap = document.createElement('label');
      checkWrap.className = 'network-crm__check network-groups__member-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedMemberIds.has(id);
      cb.setAttribute('aria-label', `Select ${contactName(id)}`);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedMemberIds.add(id);
        else selectedMemberIds.delete(id);
        syncMemberBulkUi();
      });
      checkWrap.append(cb);
      row.append(checkWrap);
      const avatar = avatarEl(person);
      wireAvatarOpenContact(avatar, id);
      const link = contactOpenBtn(id);
      row.append(avatar, link);
      memberList.append(row);
    }

    function paintMemberList() {
      syncMembersTitle();
      memberList.replaceChildren();
      for (const id of [...selectedMemberIds]) {
        if (!memberSet.has(id)) selectedMemberIds.delete(id);
      }
      if (!memberIds.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'No members yet.';
        memberList.append(p);
        syncMemberBulkUi();
        return;
      }
      const first = memberIds.slice(0, MEMBER_PAINT_CHUNK);
      for (const id of first) appendMemberRow(id);
      if (memberIds.length > MEMBER_PAINT_CHUNK) {
        const rest = memberIds.slice(MEMBER_PAINT_CHUNK);
        requestAnimationFrame(() => {
          if (gen !== detailGeneration) return;
          for (const id of rest) appendMemberRow(id);
          syncMemberBulkUi();
        });
      } else {
        syncMemberBulkUi();
      }
    }

    /**
     * Keep left Members list + right Add list in sync after membership API calls.
     * @param {object} group
     */
    function applyMembership(group) {
      if (!group || gen !== detailGeneration) return;
      upsertGroup(group);
      current = group;
      memberIds = [...(group.memberIds || [])];
      memberSet.clear();
      for (const id of memberIds) memberSet.add(id);
      paintMemberList();
      renderAddCandidates();
      if (paintInsights) paintInsights();
    }

    paintMemberList();

    const addPanel = document.createElement('div');
    addPanel.className = 'network-groups__col network-groups__add-panel';
    const addLabel = document.createElement('div');
    addLabel.className = 'network-crm__checks-label';
    addLabel.textContent = 'Add people from network';
    const addSearch = document.createElement('input');
    addSearch.type = 'search';
    addSearch.className = 'network-crm__input';
    addSearch.placeholder = 'Search people to add…';
    addSearch.autocomplete = 'off';
    const addList = document.createElement('div');
    addList.className = 'network-groups__add-list';

    function renderAddCandidates() {
      addList.replaceChildren();
      const q = addSearch.value.trim().toLowerCase();
      const pool = getFilteredContacts();
      const filteredPool = Array.isArray(pool) ? pool : contacts;
      const candidates = filteredPool
        .filter((c) => c?.id && !memberSet.has(c.id))
        .filter((c) => {
          if (!q) return true;
          const hay = [c.displayName, c.nickname, ...(c.aliases || []), c.org, c.networkCircles]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
        .sort((a, b) => compareContactSearchNameRank(a, b, q))
        .slice(0, 40);
      if (!candidates.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        const anyOutsideFilters =
          !isContactsLoading()
          && contacts.some((c) => c?.id && !memberSet.has(c.id));
        empty.textContent = isContactsLoading()
          ? 'Loading…'
          : q
            ? 'No matching people'
            : anyOutsideFilters
              ? 'No people match the Manage filters'
              : 'Everyone is already in this group';
        addList.append(empty);
        return;
      }
      for (const c of candidates) {
        const row = document.createElement('div');
        row.className = 'network-groups__member';
        const avatar = avatarEl(c);
        wireAvatarOpenContact(avatar, c.id);
        row.append(avatar);
        const name = contactOpenBtn(
          c.id,
          c.nickname
            ? `${c.displayName || 'Untitled'} (${c.nickname})`
            : c.displayName || 'Untitled',
        );
        name.classList.add('network-groups__member-name');
        const addPersonBtn = document.createElement('button');
        addPersonBtn.type = 'button';
        addPersonBtn.className = 'network-crm__btn network-crm__btn--tiny';
        addPersonBtn.textContent = 'Add';
        addPersonBtn.addEventListener('click', async () => {
          addPersonBtn.disabled = true;
          showStatus(`Adding ${c.displayName || 'person'}…`);
          try {
            const nextGroup = await addIdsToGroup(current, [c.id]);
            applyMembership(nextGroup);
            showStatus('Added');
          } catch (err) {
            showStatus(String(err?.message || err), true);
            addPersonBtn.disabled = false;
          }
        });
        row.append(name, addPersonBtn);
        addList.append(row);
      }
    }
    addSearch.addEventListener('input', () => renderAddCandidates());
    refreshOpenDetail = () => {
      if (gen !== detailGeneration) return;
      renderAddCandidates();
    };

    const addNewContactsBtn = document.createElement('button');
    addNewContactsBtn.type = 'button';
    addNewContactsBtn.className = 'network-crm__btn network-crm__btn--primary';
    addNewContactsBtn.textContent = 'Add new contacts';
    addNewContactsBtn.addEventListener('click', async () => {
      const names = await openNamesListDialog({
        title: 'Add new contacts',
        hint: 'One name per line. Creates a contact card for each and adds them to this group. If a name already exists, you choose New contact or Skip.',
      });
      if (!names?.length) return;

      addNewContactsBtn.disabled = true;
      showStatus(`Adding ${names.length} name(s)…`);
      /** @type {string[]} */
      const createdIds = [];
      let skipped = 0;
      let cancelled = false;
      const met = await fetchHowWeMetSuggestion();

      try {
        for (let i = 0; i < names.length; i++) {
          if (gen !== detailGeneration) return;
          const name = names[i];
          const existing = findExactDisplayNameMatch(contacts, name);
          if (existing) {
            const decision = await openExactNameConflictDialog({
              name,
              existingLabel: existing.displayName || name,
            });
            if (decision == null) {
              cancelled = true;
              break;
            }
            if (decision === 'skip') {
              skipped += 1;
              showStatus(`Skipped “${name}” (${i + 1}/${names.length})`);
              continue;
            }
          }

          showStatus(`Creating “${name}” (${i + 1}/${names.length})…`);
          const createBody = {
            displayName: name,
            kinds: ['friend'],
            source: 'manual',
          };
          if (met?.howWeMet) createBody.howWeMet = met.howWeMet;
          const cr = await fetch('/api/network/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createBody),
          });
          const cj = await cr.json();
          if (!cj.ok || !cj.contact?.id) {
            throw new Error(cj.error || `create_failed:${name}`);
          }
          createdIds.push(String(cj.contact.id));
        }

        if (createdIds.length) {
          showStatus(`Adding ${createdIds.length} to group…`);
          await pullLatestContacts();
          const nextGroup = await addIdsToGroup(current, createdIds);
          applyMembership(nextGroup);
        }

        if (gen !== detailGeneration) return;
        const bits = [];
        if (createdIds.length) bits.push(`${createdIds.length} added`);
        if (skipped) bits.push(`${skipped} skipped`);
        if (cancelled) bits.push('stopped early');
        const metBit = howWeMetStatusBit(met).replace(/^\s·\s/, '');
        if (metBit && createdIds.length) bits.push(metBit);
        showStatus(bits.length ? bits.join(' · ') : 'Nothing to add');
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        if (gen === detailGeneration) addNewContactsBtn.disabled = false;
      }
    });

    addPanel.append(addLabel, addSearch, addNewContactsBtn, addList);
    peopleCols.append(membersBox, addPanel);
    requestAnimationFrame(() => {
      if (gen !== detailGeneration) return;
      renderAddCandidates();
    });

    form.append(peopleCols);

    {
      const insights = document.createElement('div');
      insights.className = 'network-groups__insights';

      const insightsHead = document.createElement('div');
      insightsHead.className = 'network-groups__insights-head';
      const insightsTitle = document.createElement('div');
      insightsTitle.className = 'network-crm__checks-label';
      insightsTitle.textContent = 'Insights';
      const analyzeBtn = document.createElement('button');
      analyzeBtn.type = 'button';
      analyzeBtn.className = 'network-crm__btn network-crm__btn--tiny';
      analyzeBtn.textContent = 'Analyze';
      const insightsStamp = document.createElement('span');
      insightsStamp.className = 'network-groups__insights-stamp muted';
      insightsHead.append(insightsTitle, analyzeBtn, insightsStamp);

      const commonalitiesBox = document.createElement('div');
      commonalitiesBox.className = 'network-groups__insights-section';
      const commonalitiesLabel = document.createElement('div');
      commonalitiesLabel.className = 'network-groups__insights-sublabel';
      commonalitiesLabel.textContent = 'Commonalities';
      const commonalitiesList = document.createElement('div');
      commonalitiesList.className = 'network-groups__commonality-list';
      commonalitiesBox.append(commonalitiesLabel, commonalitiesList);

      const suggestionsBox = document.createElement('div');
      suggestionsBox.className = 'network-groups__insights-section';
      const suggestionsLabel = document.createElement('div');
      suggestionsLabel.className = 'network-groups__insights-sublabel';
      suggestionsLabel.textContent = 'Suggested people';
      const suggestionsList = document.createElement('div');
      suggestionsList.className = 'network-groups__suggestion-list';
      suggestionsBox.append(suggestionsLabel, suggestionsList);

      insights.append(insightsHead, commonalitiesBox, suggestionsBox);
      form.append(insights);

      /**
       * @param {string | null | undefined} iso
       */
      function formatInsightsStamp(iso) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return '';
        try {
          return `Updated ${new Date(t).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}`;
        } catch {
          return '';
        }
      }

      /**
       * @param {object} suggestion
       */
      async function addSuggestion(suggestion) {
        const contactId = suggestion?.contactId ? String(suggestion.contactId) : '';
        if (!contactId || memberSet.has(contactId)) return;
        showStatus('Adding…');
        try {
          const nextGroup = await addIdsToGroup(current, [contactId]);
          applyMembership(nextGroup);
          showStatus(`Added ${contactName(contactId)}`);
        } catch (err) {
          showStatus(String(err?.message || err), true);
        }
      }

      paintInsights = () => {
        if (gen !== detailGeneration) return;
        const commonalities = Array.isArray(current.commonalities) ? current.commonalities : [];
        const suggestions = Array.isArray(current.suggestions) ? current.suggestions : [];
        const stamp = formatInsightsStamp(current.commonalitiesUpdatedAt);
        insightsStamp.textContent = stamp;
        insightsStamp.hidden = !stamp;
        analyzeBtn.textContent = commonalities.length || suggestions.length ? 'Refresh' : 'Analyze';

        commonalitiesList.replaceChildren();
        if (!commonalities.length) {
          const empty = document.createElement('p');
          empty.className = 'muted network-groups__insights-empty';
          empty.textContent =
            memberIds.length <= 2
              ? 'Add at least 3 members, then run Analyze.'
              : 'Run Analyze to find shared traits.';
          commonalitiesList.append(empty);
        } else {
          for (const c of commonalities) {
            const row = document.createElement('div');
            row.className = 'network-groups__commonality';
            const label = document.createElement('div');
            label.className = 'network-groups__commonality-label';
            label.textContent = c.label || '';
            row.append(label);
            if (c.evidence) {
              const ev = document.createElement('div');
              ev.className = 'network-groups__commonality-evidence muted';
              ev.textContent = c.evidence;
              row.append(ev);
            }
            commonalitiesList.append(row);
          }
        }

        suggestionsList.replaceChildren();
        const visible = suggestions.filter((s) => {
          const id = s?.contactId ? String(s.contactId) : '';
          return id ? !memberSet.has(id) : Boolean(s?.displayName);
        });
        if (!visible.length) {
          const empty = document.createElement('p');
          empty.className = 'muted network-groups__insights-empty';
          empty.textContent = suggestions.length
            ? 'All suggested people are already in this group.'
            : 'Suggestions appear after Analyze.';
          suggestionsList.append(empty);
        } else {
          for (const s of visible) {
            const row = document.createElement('div');
            row.className = 'network-groups__suggestion';
            const body = document.createElement('div');
            body.className = 'network-groups__suggestion-body';
            const nameEl = document.createElement('div');
            nameEl.className = 'network-groups__suggestion-name';
            const cid = s.contactId ? String(s.contactId) : '';
            if (cid && contactMap.has(cid)) {
              nameEl.append(contactOpenBtn(cid, contactName(cid)));
            } else {
              nameEl.textContent = s.displayName || cid || 'Unknown';
            }
            body.append(nameEl);
            if (s.reason) {
              const reason = document.createElement('div');
              reason.className = 'network-groups__suggestion-reason muted';
              reason.textContent = s.reason;
              body.append(reason);
            }
            row.append(body);
            if (cid && contactMap.has(cid) && !memberSet.has(cid)) {
              const addBtn = document.createElement('button');
              addBtn.type = 'button';
              addBtn.className = 'network-crm__btn network-crm__btn--tiny';
              addBtn.textContent = 'Add';
              addBtn.addEventListener('click', () => {
                addBtn.disabled = true;
                addSuggestion(s).finally(() => {
                  if (gen === detailGeneration) paintInsights();
                });
              });
              row.append(addBtn);
            }
            suggestionsList.append(row);
          }
        }
      };

      analyzeBtn.addEventListener('click', async () => {
        if (memberIds.length <= 2) {
          showStatus('Need more than 2 members to analyze', true);
          return;
        }
        analyzeBtn.disabled = true;
        showStatus('Analyzing…');
        try {
          const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}/analyze`, {
            method: 'POST',
          });
          const j = await r.json();
          if (gen !== detailGeneration) return;
          if (!j.ok) {
            const err = j.error || 'analyze_failed';
            if (err === 'openrouter_not_configured') {
              throw new Error('OpenRouter is not configured');
            }
            throw new Error(err);
          }
          if (j.skipped) {
            showStatus('Need more than 2 members to analyze', true);
            return;
          }
          if (j.group) {
            upsertGroup(j.group);
            current = j.group;
          } else {
            current = {
              ...current,
              commonalities: j.commonalities || [],
              suggestions: j.suggestions || [],
              commonalitiesUpdatedAt: new Date().toISOString(),
            };
            upsertGroup(current);
          }
          paintInsights();
          const nC = (current.commonalities || []).length;
          const nS = (current.suggestions || []).length;
          showStatus(`Analyzed · ${nC} commonalit${nC === 1 ? 'y' : 'ies'} · ${nS} suggestion${nS === 1 ? '' : 's'}`);
        } catch (err) {
          if (gen === detailGeneration) showStatus(String(err?.message || err), true);
        } finally {
          if (gen === detailGeneration) analyzeBtn.disabled = false;
        }
      });

      paintInsights();
    }

    let saveInFlight = false;
    let dirtyWhileSaving = false;

    async function persistGroup() {
      if (gen !== detailGeneration) {
        showStatus('Detail refreshed — try Save again');
        return;
      }
      if (saveInFlight) {
        dirtyWhileSaving = true;
        showStatus('Saving…');
        return;
      }
      saveInFlight = true;
      notifyToolbar();
      showStatus('Saving…');
      const prevKind = groupKind(current);
      const prevName = String(current.name || '');
      try {
        do {
          dirtyWhileSaving = false;
          const fd = new FormData(form);
          const nextName = String(fd.get('name') || '').trim();
          if (!nextName) throw new Error(isScene ? 'Scene tag is required' : 'Name is required');
          /** @type {Record<string, string>} */
          const body = { name: nextName };
          // Scene groups only accept name (+ insights); keep kind out of the patch.
          if (!isScene) body.kind = 'event';
          const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'save_failed');
          if (gen !== detailGeneration) return;
          upsertGroup(j.group);
          current = j.group;
          showStatus(isScene ? 'Scene tag saved' : 'Saved');
          renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);

        // Refresh contacts when Scene tags may have been rewritten on members.
        if (gen === detailGeneration) {
          const nextKind = groupKind(current);
          const nextName = String(current.name || '');
          const members = Array.isArray(current.memberIds) ? current.memberIds : [];
          const sceneMayChange =
            members.length > 0
            && (prevKind !== nextKind
              || (isScene && prevName.toLowerCase() !== nextName.toLowerCase())
              || (nextKind === 'community' && prevName.toLowerCase() !== nextName.toLowerCase()));
          if (sceneMayChange) await pullLatestContacts();
        }
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
        if (gen === detailGeneration) notifyToolbar();
      }
    }

    async function deleteGroup() {
      const label = g.name || (isScene ? 'this scene' : 'this group');
      const msg = isScene
        ? `Delete scene “${label}”? This removes that Scene tag from all members.`
        : `Delete group ${label}?`;
      if (!confirm(msg)) return;
      try {
        const wasCommunity = groupKind(g) === 'community';
        const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'delete_failed');
        groups = groups.filter((x) => x.id !== g.id);
        invalidateMemberCache();
        if (wasCommunity) await pullLatestContacts();
        selectedId = groups[0]?.id || null;
        detailActions = null;
        showStatus('Deleted');
        renderList();
        if (selectedId) selectGroup(selectedId);
        else {
          detail.innerHTML = '<p class="muted">Select a group</p>';
          notifyToolbar();
        }
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    }

    detailActions = {
      save: persistGroup,
      delete: deleteGroup,
      saving: () => saveInFlight,
    };
    notifyToolbar();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await persistGroup();
    });

    detail.append(form);
  }

  function upsertGroup(g) {
    const idx = groups.findIndex((x) => x.id === g.id);
    if (idx >= 0) groups[idx] = g;
    else groups.unshift(g);
    invalidateMemberCache();
    renderList();
    if (selectedId === UNGROUPED_ID) renderUngroupedDetail();
  }

  /**
   * @param {object[]} next
   * @param {{ selectGroupId?: string | null, paintDetail?: boolean, listOnly?: boolean }} [paintOpts]
   */
  function applyGroups(next, paintOpts = {}) {
    const prevSelected =
      selectedId && selectedId !== UNGROUPED_ID
        ? groups.find((g) => g.id === selectedId)
        : null;
    groups = Array.isArray(next) ? next : [];
    invalidateMemberCache();
    const prefer =
      paintOpts.selectGroupId && groups.some((g) => g.id === paintOpts.selectGroupId)
        ? paintOpts.selectGroupId
        : null;
    const keep =
      selectedId === UNGROUPED_ID || (selectedId && groups.some((g) => g.id === selectedId))
        ? selectedId
        : null;
    selectedId = prefer || keep || groups[0]?.id || null;
    // Don't let a stale list refresh clobber a newer local membership edit.
    if (paintOpts.listOnly && prevSelected && selectedId === prevSelected.id) {
      const idx = groups.findIndex((g) => g.id === selectedId);
      if (idx >= 0) {
        const remote = groups[idx];
        const localT = Date.parse(prevSelected.updatedAt || '') || 0;
        const remoteT = Date.parse(remote.updatedAt || '') || 0;
        if (localT > remoteT) groups[idx] = prevSelected;
      }
    }
    renderList();
    if (paintOpts.paintDetail === false) {
      detailActions = null;
      detail.innerHTML = selectedId
        ? '<p class="muted">Loading…</p>'
        : '<p class="muted">Select a group</p>';
      notifyToolbar();
      return;
    }
    if (paintOpts.listOnly) {
      const nextSelected =
        selectedId && selectedId !== UNGROUPED_ID
          ? groups.find((g) => g.id === selectedId)
          : null;
      const membersChanged =
        Boolean(prevSelected)
        && Boolean(nextSelected)
        && JSON.stringify(prevSelected.memberIds || []) !== JSON.stringify(nextSelected.memberIds || []);
      if (!prefer && !membersChanged && selectedId === (prevSelected?.id || selectedId)) {
        return;
      }
    }
    if (selectedId === UNGROUPED_ID) selectUngrouped();
    else if (selectedId) selectGroup(selectedId);
    else {
      detailActions = null;
      detail.innerHTML = '<p class="muted">Select a group</p>';
      notifyToolbar();
    }
  }

  async function createGroup() {
    showStatus('Creating…');
    try {
      const r = await fetch('/api/network/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', kind: 'event', eventType: '' }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      groups.unshift(j.group);
      invalidateMemberCache();
      selectedId = j.group.id;
      showStatus('Created — fill in optional details');
      renderList();
      selectGroup(selectedId);
      const nameInput = detail.querySelector('input[name="name"]');
      if (nameInput instanceof HTMLInputElement) {
        nameInput.focus();
        nameInput.select();
      }
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  }

  function setQuery(q) {
    listQuery = String(q || '');
    renderList();
  }

  function canEditSelected() {
    if (!detailActions || !selectedId || selectedId === UNGROUPED_ID) return false;
    return groups.some((x) => x.id === selectedId);
  }

  async function saveSelected() {
    if (!detailActions?.save) return;
    await detailActions.save();
  }

  async function deleteSelected() {
    if (!detailActions?.delete) return;
    await detailActions.delete();
  }

  /**
   * @param {{ selectGroupId?: string | null }} [focusOpts]
   */
  async function fetchAndPaint(focusOpts = {}) {
    showStatus(groups.length ? '' : 'Loading groups…');
    try {
      const r = await fetch('/api/network/groups');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load_failed');
      showStatus('');
      applyGroups(Array.isArray(j.groups) ? j.groups : [], {
        selectGroupId: focusOpts.selectGroupId || null,
      });
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  }

  /**
   * Re-enter Groups without remounting: optionally refresh, or just reselect.
   * @param {{ selectGroupId?: string | null, refresh?: boolean }} [focusOpts]
   */
  async function focus(focusOpts = {}) {
    const prevCount = contacts.length;
    const next = getContacts();
    if (Array.isArray(next)) {
      contacts = next;
      rebuildContactMap();
    }
    if (focusOpts.refresh || !groups.length) {
      await fetchAndPaint(focusOpts);
      return;
    }
    const want = focusOpts.selectGroupId || null;
    if (want && want !== selectedId) {
      applyGroups(groups, { selectGroupId: want });
      return;
    }
    // Contacts finished loading after Groups painted an empty shell — refresh detail.
    if (prevCount === 0 && contacts.length > 0 && selectedId) {
      if (selectedId === UNGROUPED_ID) selectUngrouped();
      else selectGroup(selectedId);
      return;
    }
    // Pane was kept mounted while hidden — refresh lists against current Manage filters.
    if (selectedId === UNGROUPED_ID) selectUngrouped();
    else refreshOpenDetail?.();
    syncColumnsToViewport();
  }

  // Instant shell from prefetch when available; refresh in background for freshness.
  if (groups.length) {
    applyGroups(groups, {
      selectGroupId: opts.selectGroupId || null,
      paintDetail: false,
    });
    requestAnimationFrame(() => {
      if (selectedId === UNGROUPED_ID) selectUngrouped();
      else if (selectedId) selectGroup(selectedId);
    });
    // Background refresh — keep whatever the user already selected.
    void (async () => {
      try {
        const r = await fetch('/api/network/groups');
        const j = await r.json();
        if (!j.ok) return;
        applyGroups(Array.isArray(j.groups) ? j.groups : [], { listOnly: true });
      } catch {
        /* keep prefetched */
      }
    })();
  } else {
    void fetchAndPaint({ selectGroupId: opts.selectGroupId || null });
  }

  syncColumnsToViewport();

  return {
    focus,
    setQuery,
    createGroup,
    saveSelected,
    deleteSelected,
    canEditSelected,
    destroy() {
      window.removeEventListener('resize', onViewportChange);
      window.visualViewport?.removeEventListener('resize', onViewportChange);
      scrollFitObs.disconnect();
      detailActions = null;
      root.replaceChildren();
    },
  };
}
