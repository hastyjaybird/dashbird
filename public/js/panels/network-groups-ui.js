import { beginWaitCursor, endWaitCursor } from '../lib/wait-cursor.js';
import { openGroupKindDialog } from '../lib/network-group-kind-dialog.js?v=group-kind-9';
import {
  findExactDisplayNameMatch,
  openExactNameConflictDialog,
  openNamesListDialog,
} from '../lib/network-add-contacts-dialog.js?v=group-kind-9';

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
  const { onOpenContact } = opts;
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

  function groupKind(g) {
    return g?.kind === 'event' ? 'event' : 'community';
  }

  function groupKindLabel(g) {
    return groupKind(g) === 'event' ? 'Event' : 'Community';
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

  function groupIconEl(g) {
    const box = document.createElement('div');
    box.className = 'network-crm__avatar';
    const initials = String(g.name || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] || '')
      .join('')
      .toUpperCase();
    box.textContent = initials || '?';
    return box;
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
      const kindBit =
        groupKind(g) === 'event' && g.eventType
          ? `Event · ${g.eventType}`
          : groupKindLabel(g);
      sub.textContent = `${kindBit} · ${n} member${n === 1 ? '' : 's'} · ${memberNamesPreview(g)}`;
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
      empty.textContent = 'No groups yet — add a community or event group';
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
    appendGroupSection('Communities', communities);
    appendGroupSection('Events', events);
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
    note.textContent = 'People who are not members of any community or event group.';

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
      const filtered = people.filter((c) => {
        if (!q) return true;
        const hay = [c.displayName, c.nickname, ...(c.aliases || []), c.org, c.networkCircles]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
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
        row.append(avatarEl(c));
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'network-crm__link-btn';
        link.textContent = c.nickname
          ? `${c.displayName || 'Untitled'} (${c.nickname})`
          : c.displayName || 'Untitled';
        link.addEventListener('click', () => onOpenContact?.(c.id));

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
    detail.replaceChildren();

    const form = document.createElement('form');
    form.className = 'network-crm__form';

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
      if (opts.placeholder) input.placeholder = opts.placeholder;
      wrapEl.append(span, input);
      return wrapEl;
    }

    const kindField = document.createElement('label');
    kindField.className = 'network-crm__field';
    const kindSpan = document.createElement('span');
    kindSpan.textContent = 'Kind';
    const kindSelect = document.createElement('select');
    kindSelect.name = 'kind';
    kindSelect.className = 'network-crm__input';
    for (const opt of [
      { value: 'community', label: 'Community (updates Scene on people)' },
      { value: 'event', label: 'Event (friends grouping only)' },
    ]) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (groupKind(current) === opt.value) o.selected = true;
      kindSelect.append(o);
    }
    kindField.append(kindSpan, kindSelect);

    const eventTypeField = field('Event type', 'eventType', current.eventType || '', {
      placeholder: 'e.g. dinner, festival, house party',
      hidden: groupKind(current) !== 'event',
    });

    const kindNote = document.createElement('p');
    kindNote.className = 'muted network-groups__kind-note';
    function syncKindUi() {
      const isEvent = kindSelect.value === 'event';
      eventTypeField.hidden = !isEvent;
      kindNote.textContent = isEvent
        ? 'Event groups are just friend lists for a specific occasion — they do not change Scene (or any other) attributes on people.'
        : 'Community membership syncs each person’s Scene tag to match this group name.';
    }
    kindSelect.addEventListener('change', syncKindUi);
    syncKindUi();

    const topActions = document.createElement('div');
    topActions.className = 'network-crm__actions network-groups__top-actions';
    const analyzeBtn = document.createElement('button');
    analyzeBtn.type = 'button';
    analyzeBtn.className = 'network-crm__btn';
    analyzeBtn.textContent = 'Analyze commonalities';
    topActions.append(analyzeBtn);

    form.append(
      field('Name', 'name', current.name),
      kindField,
      eventTypeField,
      field('Description', 'description', current.description || '', { rows: 3 }),
      kindNote,
      topActions,
    );

    const peopleCols = document.createElement('div');
    peopleCols.className = 'network-groups__people-cols';

    const membersBox = document.createElement('div');
    membersBox.className = 'network-groups__col network-groups__members-panel';
    const membersTitle = document.createElement('div');
    membersTitle.className = 'network-crm__checks-label';
    membersTitle.textContent = 'Members';
    membersBox.append(membersTitle);

    const memberList = document.createElement('div');
    memberList.className = 'network-groups__member-list';
    /** @type {string[]} */
    let memberIds = [...(g.memberIds || [])];
    const memberSet = new Set(memberIds);

    /**
     * @param {string} id
     */
    function appendMemberRow(id) {
      const person = contactById(id);
      const row = document.createElement('div');
      row.className = 'network-groups__member';
      row.dataset.memberId = id;
      row.append(avatarEl(person));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'network-crm__link-btn';
      link.textContent = contactName(id);
      link.addEventListener('click', () => onOpenContact?.(id));
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'network-crm__btn network-crm__btn--tiny';
      rm.textContent = 'Remove';
      rm.addEventListener('click', async () => {
        rm.disabled = true;
        showStatus('Removing…');
        try {
          const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/members`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactIds: [id] }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'remove_failed');
          applyMembership(j.group);
          if (groupKind(current) === 'community') await pullLatestContacts();
          showStatus('Removed');
        } catch (err) {
          showStatus(String(err?.message || err), true);
          rm.disabled = false;
        }
      });
      row.append(link, rm);
      memberList.append(row);
    }

    function paintMemberList() {
      memberList.replaceChildren();
      if (!memberIds.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'No members yet — add people on the right.';
        memberList.append(p);
        return;
      }
      const first = memberIds.slice(0, MEMBER_PAINT_CHUNK);
      for (const id of first) appendMemberRow(id);
      if (memberIds.length > MEMBER_PAINT_CHUNK) {
        const rest = memberIds.slice(MEMBER_PAINT_CHUNK);
        requestAnimationFrame(() => {
          if (gen !== detailGeneration) return;
          for (const id of rest) appendMemberRow(id);
        });
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
    }

    paintMemberList();
    membersBox.append(memberList);

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
        row.append(avatarEl(c));
        const name = document.createElement('span');
        name.className = 'network-groups__member-name';
        name.append(document.createTextNode(c.displayName || 'Untitled'));
        if (c.nickname) {
          const nick = document.createElement('span');
          nick.className = 'muted';
          nick.textContent = ` ${c.nickname}`;
          name.append(nick);
        }
        const addPersonBtn = document.createElement('button');
        addPersonBtn.type = 'button';
        addPersonBtn.className = 'network-crm__btn network-crm__btn--tiny';
        addPersonBtn.textContent = 'Add';
        addPersonBtn.addEventListener('click', async () => {
          addPersonBtn.disabled = true;
          showStatus(`Adding ${c.displayName || 'person'}…`);
          try {
            const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contactIds: [c.id] }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'add_failed');
            applyMembership(j.group);
            if (groupKind(current) === 'community') await pullLatestContacts();
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
          const cr = await fetch('/api/network/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              displayName: name,
              kinds: ['friend'],
              source: 'manual',
            }),
          });
          const cj = await cr.json();
          if (!cj.ok || !cj.contact?.id) {
            throw new Error(cj.error || `create_failed:${name}`);
          }
          createdIds.push(String(cj.contact.id));
        }

        if (createdIds.length) {
          showStatus(`Adding ${createdIds.length} to group…`);
          const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactIds: createdIds }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'add_failed');
          applyMembership(j.group);
          await pullLatestContacts();
        }

        if (gen !== detailGeneration) return;
        const bits = [];
        if (createdIds.length) bits.push(`${createdIds.length} added`);
        if (skipped) bits.push(`${skipped} skipped`);
        if (cancelled) bits.push('stopped early');
        showStatus(bits.length ? bits.join(' · ') : 'Nothing to add');
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        if (gen === detailGeneration) addNewContactsBtn.disabled = false;
      }
    });

    addPanel.append(addLabel, addSearch, addNewContactsBtn, addList);
    peopleCols.append(membersBox, addPanel);
    // Defer candidate list so the group form + members paint first.
    requestAnimationFrame(() => {
      if (gen !== detailGeneration) return;
      renderAddCandidates();
    });

    const toolsBox = document.createElement('div');
    toolsBox.className = 'network-groups__tools';

    const ingest = document.createElement('div');
    ingest.className = 'network-crm__bulk network-groups__tools-ingest';
    const ingestHint =
      groupKind(g) === 'community'
        ? 'Ingest people (one name per line — creates cards, adds to group, and sets Scene)'
        : 'Ingest people (one name per line — creates cards + adds to this event group; does not set Scene)';
    ingest.innerHTML = `
      <label class="network-crm__field network-crm__field--full">
        <span>${ingestHint}</span>
        <textarea class="network-crm__input" data-ingest rows="4" placeholder="Alex Chen&#10;Jordan Lee"></textarea>
      </label>
    `;
    const ingestBtn = document.createElement('button');
    ingestBtn.type = 'button';
    ingestBtn.className = 'network-crm__btn network-crm__btn--primary';
    ingestBtn.textContent = 'Ingest into group';
    ingestBtn.addEventListener('click', async () => {
      const text = ingest.querySelector('[data-ingest]')?.value || '';
      showStatus('Ingesting…');
      try {
        const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: text }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'ingest_failed');
        upsertGroup(j.group);
        await pullLatestContacts();
        showStatus(`Ingested ${j.created?.length || 0} new, linked ${j.linked?.length || 0}`);
        const ta = ingest.querySelector('[data-ingest]');
        if (ta) ta.value = '';
        selectGroup(g.id);
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    });
    ingest.append(ingestBtn);

    const commonBox = document.createElement('div');
    commonBox.className = 'network-groups__analysis';
    const commonTitle = document.createElement('div');
    commonTitle.className = 'network-crm__checks-label';
    commonTitle.textContent = 'Commonalities (auto when >2 members)';
    commonBox.append(commonTitle);
    const commons = Array.isArray(g.commonalities) ? g.commonalities : [];
    if (!commons.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent =
        (g.memberIds || []).length > 2
          ? 'No analysis yet — run Analyze.'
          : 'Add more than 2 people to unlock commonality ranking.';
      commonBox.append(p);
    } else {
      const ol = document.createElement('ol');
      ol.className = 'network-groups__ranked';
      for (const c of commons) {
        const li = document.createElement('li');
        li.textContent = `${c.label} (${Math.round((c.score || 0) * 100)}%) — ${c.evidence || ''}`;
        ol.append(li);
      }
      commonBox.append(ol);
    }

    const suggestBox = document.createElement('div');
    suggestBox.className = 'network-groups__analysis';
    const suggestTitle = document.createElement('div');
    suggestTitle.className = 'network-crm__checks-label';
    suggestTitle.textContent = 'Suggested people (by commonality)';
    suggestBox.append(suggestTitle);
    const suggestions = Array.isArray(g.suggestions) ? g.suggestions : [];
    if (!suggestions.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No suggestions yet.';
      suggestBox.append(p);
    } else {
      for (const s of suggestions) {
        const row = document.createElement('div');
        row.className = 'network-groups__member';
        const label = document.createElement('span');
        label.textContent = `${s.displayName || contactName(s.contactId)} (${Math.round((s.score || 0) * 100)}%) — ${s.reason || ''}`;
        row.append(label);
        if (s.contactId) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'network-crm__btn network-crm__btn--tiny';
          add.textContent = 'Add';
          add.addEventListener('click', async () => {
            add.disabled = true;
            showStatus('Adding…');
            try {
              const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactIds: [s.contactId] }),
              });
              const j = await r.json();
              if (!j.ok) throw new Error(j.error || 'add_failed');
              applyMembership(j.group);
              if (groupKind(current) === 'community') await pullLatestContacts();
              showStatus('Added');
            } catch (err) {
              showStatus(String(err?.message || err), true);
              add.disabled = false;
            }
          });
          row.append(add);
        }
        suggestBox.append(row);
      }
    }

    toolsBox.append(ingest, commonBox, suggestBox);
    form.append(peopleCols, toolsBox);

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
          const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: String(fd.get('name') || '').trim(),
              description: String(fd.get('description') || '').trim(),
              kind: String(fd.get('kind') || 'community').trim(),
              eventType: String(fd.get('eventType') || '').trim(),
            }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'save_failed');
          if (gen !== detailGeneration) return;
          upsertGroup(j.group);
          current = j.group;
          showStatus('Saved');
          renderList();
        } while (dirtyWhileSaving && gen === detailGeneration);

        // Refresh contacts only when community Scene tags may have changed.
        if (gen === detailGeneration) {
          const nextKind = groupKind(current);
          const nextName = String(current.name || '');
          const members = Array.isArray(current.memberIds) ? current.memberIds : [];
          const sceneMayChange =
            members.length > 0
            && (prevKind !== nextKind
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
      if (!confirm(`Delete group ${g.name || ''}?`)) return;
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

    analyzeBtn.addEventListener('click', async (ev) => {
      analyzeBtn.disabled = true;
      beginWaitCursor(ev);
      showStatus('Analyzing…');
      try {
        const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || j.reason || 'analyze_failed');
        if (j.group) upsertGroup(j.group);
        showStatus(j.skipped ? 'Need more than 2 members' : 'Analysis updated');
        selectGroup(g.id);
      } catch (err) {
        showStatus(String(err?.message || err), true);
      } finally {
        endWaitCursor();
        analyzeBtn.disabled = false;
      }
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
    const kind = await openGroupKindDialog({ title: 'Group kind' });
    if (kind == null) {
      showStatus('Cancelled');
      return;
    }
    showStatus('Creating…');
    try {
      const r = await fetch('/api/network/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', kind, eventType: '' }),
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
    return Boolean(detailActions && selectedId && selectedId !== UNGROUPED_ID);
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
