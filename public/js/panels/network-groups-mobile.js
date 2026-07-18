import {
  pushMobileNav,
  mobileNavBack,
  isMobileNavApplying,
} from '../lib/mobile-history.js';
import { compareContactSearchNameRank } from '../lib/network-contact-search.js';
import {
  createGroupKindIconEl,
  groupKind,
  groupKindLabel,
  groupSectionLabel,
  isSceneGroup,
} from '../lib/network-group-kind.js?v=scene-ux-1';
import { NETWORK_LABELS } from '../lib/network-labels.js';

/**
 * @param {string} label
 * @param {string} name
 * @param {string} value
 * @param {{ type?: string, rows?: number, placeholder?: string, hidden?: boolean }} [opts]
 * @returns {HTMLLabelElement}
 */
function field(label, name, value, opts = {}) {
  const wrap = document.createElement('label');
  wrap.className = 'mobile-network__field';
  if (opts.hidden) wrap.hidden = true;
  const span = document.createElement('span');
  span.className = 'mobile-network__field-label';
  span.textContent = label;
  wrap.append(span);

  if (opts.rows && opts.rows > 1) {
    const ta = document.createElement('textarea');
    ta.name = name;
    ta.className = 'mobile-network__input';
    ta.rows = opts.rows;
    ta.value = value || '';
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    wrap.append(ta);
    return wrap;
  }

  const input = document.createElement('input');
  input.type = opts.type || 'text';
  input.name = name;
  input.className = 'mobile-network__input';
  input.value = value || '';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  wrap.append(input);
  return wrap;
}

/**
 * @param {object} c
 * @returns {string}
 */
function contactName(c) {
  return String(c?.displayName || '').trim() || 'Unnamed';
}

/**
 * @param {object} g
 * @returns {string}
 */
function groupName(g) {
  return String(g?.name || '').trim() || 'Untitled group';
}

/**
 * @param {object} g
 * @returns {number}
 */
function memberCount(g) {
  return Array.isArray(g?.memberIds) ? g.memberIds.length : 0;
}

/**
 * Mobile-friendly discard prompt (replaces window.confirm).
 * @returns {Promise<boolean>} true when the user chooses to discard
 */
function openDiscardSheet() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'mobile-network__sheet-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const sheet = document.createElement('div');
    sheet.className = 'mobile-network__sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Discard changes');

    const header = document.createElement('div');
    header.className = 'mobile-network__sheet-head';
    const title = document.createElement('h3');
    title.className = 'mobile-network__sheet-title';
    title.textContent = 'Discard unsaved changes?';
    header.append(title);

    const actions = document.createElement('div');
    actions.className = 'mobile-groups__sheet-actions';

    const keepBtn = document.createElement('button');
    keepBtn.type = 'button';
    keepBtn.className = 'mobile-network__selection-btn';
    keepBtn.textContent = 'Keep editing';

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'mobile-network__selection-btn mobile-network__selection-btn--primary';
    discardBtn.textContent = 'Discard';

    let settled = false;
    /** @param {boolean} discard */
    function finish(discard) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(discard);
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key === 'Escape') finish(false);
    }

    keepBtn.addEventListener('click', () => finish(false));
    discardBtn.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
    });

    actions.append(keepBtn, discardBtn);
    sheet.append(header, actions);
    backdrop.append(sheet);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    keepBtn.focus();
  });
}

/**
 * Mobile Network Groups: list → edit → members → contact deep links.
 * @param {HTMLElement | null} root
 */
export function mountNetworkGroupsMobile(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-network', 'mobile-groups');

  const toolbar = document.createElement('div');
  toolbar.className = 'mobile-network__toolbar';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'mobile-network__search';
  search.placeholder = 'Search groups';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search groups');

  const listActions = document.createElement('div');
  listActions.className = 'mobile-network__toolbar-actions';

  const addEventBtn = document.createElement('button');
  addEventBtn.type = 'button';
  addEventBtn.className = 'mobile-network__action';
  addEventBtn.textContent = NETWORK_LABELS.createEventOnly;

  listActions.append(addEventBtn);
  toolbar.append(search, listActions);

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

  root.append(toolbar, status, listPane, detailPane);

  /** @type {object[]} */
  let groups = [];
  /** @type {Map<string, object>} */
  let contactMap = new Map();
  /** @type {'list' | 'group'} */
  let view = 'list';
  /** @type {object | null} */
  let selectedGroup = null;
  /** @type {boolean} */
  let dirty = false;

  /**
   * @param {object} g
   */
  function upsertGroup(g) {
    const idx = groups.findIndex((x) => x.id === g.id);
    if (idx >= 0) groups[idx] = g;
    else groups.unshift(g);
    if (selectedGroup?.id === g.id) selectedGroup = g;
  }

  /**
   * @param {string} q
   * @returns {object[]}
   */
  function filtered(q) {
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const items = groups.slice().sort((a, b) => {
      const ka = groupKindLabel(a);
      const kb = groupKindLabel(b);
      if (ka !== kb) return ka.localeCompare(kb);
      return groupName(a).localeCompare(groupName(b), undefined, { sensitivity: 'base' });
    });
    if (!needle) return items;
    return items.filter((g) => {
      const hay = [groupName(g), groupKindLabel(g), g.description, g.eventType]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  function showList() {
    view = 'list';
    selectedGroup = null;
    dirty = false;
    detailPane.hidden = true;
    detailPane.replaceChildren();
    listPane.hidden = false;
    toolbar.hidden = false;
  }

  /**
   * @param {object} contact
   */
  function openContactDetail(contact) {
    document.dispatchEvent(
      new CustomEvent('dashbird:mobile-goto', {
        detail: { tab: 'network', pane: 'contact', contactId: String(contact.id) },
      }),
    );
  }

  /**
   * @param {object} group
   * @param {{ fromHistory?: boolean }} [opts]
   */
  function showGroup(group, opts = {}) {
    view = 'group';
    selectedGroup = group;
    dirty = false;
    listPane.hidden = true;
    toolbar.hidden = true;
    detailPane.hidden = false;
    detailPane.replaceChildren();

    if (!opts.fromHistory && !isMobileNavApplying()) {
      pushMobileNav({ tab: 'groups', pane: 'group', groupId: String(group.id) });
    }

    /** @type {object} */
    let current = group;
    const readOnly = isSceneGroup(group);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-network__back';
    back.textContent = '← Groups';
    back.addEventListener('click', async () => {
      if (dirty && !(await openDiscardSheet())) return;
      mobileNavBack();
    });

    const form = document.createElement('form');
    form.className = 'mobile-network__form';
    if (!readOnly) {
      form.addEventListener('input', () => {
        dirty = true;
      });
      form.addEventListener('change', () => {
        dirty = true;
      });
    }

    const kindNote = document.createElement('p');
    kindNote.className = 'mobile-groups__desc';
    kindNote.textContent = readOnly ? NETWORK_LABELS.sceneGroupNote : NETWORK_LABELS.eventGroupNote;

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

    if (readOnly) {
      const head = document.createElement('div');
      head.className = 'mobile-groups__scene-head';
      head.append(createGroupKindIconEl(group, 'mobile-groups__kind-icon'));
      const title = document.createElement('h2');
      title.className = 'mobile-network__detail-name';
      title.textContent = groupName(current);
      head.append(title);
      form.append(head, kindNote);
    } else {
      form.append(field('Name', 'name', current.name || ''), kindNote, saveRow);
    }

    const membersSection = document.createElement('div');
    membersSection.className = 'mobile-network__section';
    const membersHead = document.createElement('div');
    membersHead.className = 'mobile-network__section-head';
    const membersLabel = document.createElement('h3');
    membersLabel.className = 'mobile-network__section-title';
    membersLabel.textContent = 'Members';
    membersHead.append(membersLabel);
    membersSection.append(membersHead);

    const memberBulk = document.createElement('div');
    memberBulk.className = 'mobile-network__selection-bar';
    memberBulk.hidden = true;
    const memberBulkCount = document.createElement('span');
    memberBulkCount.className = 'mobile-network__selection-count';
    const bulkRemoveBtn = document.createElement('button');
    bulkRemoveBtn.type = 'button';
    bulkRemoveBtn.className = 'mobile-network__selection-btn';
    bulkRemoveBtn.textContent = 'Remove';
    const moveSelect = document.createElement('select');
    moveSelect.className = 'mobile-network__input mobile-groups__move-select';
    moveSelect.setAttribute('aria-label', 'Move selected members to group');
    const bulkMoveBtn = document.createElement('button');
    bulkMoveBtn.type = 'button';
    bulkMoveBtn.className = 'mobile-network__selection-btn mobile-network__selection-btn--primary';
    bulkMoveBtn.textContent = 'Move';
    const clearMemberSelBtn = document.createElement('button');
    clearMemberSelBtn.type = 'button';
    clearMemberSelBtn.className = 'mobile-network__selection-btn';
    clearMemberSelBtn.textContent = 'Clear';
    memberBulk.append(memberBulkCount, bulkRemoveBtn, moveSelect, bulkMoveBtn, clearMemberSelBtn);
    membersSection.append(memberBulk);
    if (readOnly) memberBulk.hidden = true;

    const memberStatus = document.createElement('p');
    memberStatus.className = 'mobile-network__save-status';
    memberStatus.hidden = true;
    membersSection.append(memberStatus);

    const members = document.createElement('ul');
    members.className = 'mobile-network__list';

    /** @type {Set<string>} */
    const memberSet = new Set(Array.isArray(current.memberIds) ? current.memberIds.map(String) : []);
    /** @type {Set<string>} */
    const selectedMemberIds = new Set();

    function fillMoveGroupOptions() {
      moveSelect.replaceChildren();
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Move to…';
      moveSelect.append(blank);
      for (const og of groups) {
        if (String(og.id) === String(current.id)) continue;
        const o = document.createElement('option');
        o.value = og.id;
        o.textContent = `${groupName(og)} (${groupKindLabel(og)})`;
        moveSelect.append(o);
      }
      moveSelect.disabled = !groups.some((og) => String(og.id) !== String(current.id));
    }

    function syncMemberBulkUi() {
      const n = selectedMemberIds.size;
      memberBulk.hidden = n === 0;
      memberBulkCount.textContent = n === 1 ? '1 selected' : `${n} selected`;
      bulkRemoveBtn.disabled = n === 0;
      bulkMoveBtn.disabled = n === 0 || !moveSelect.value;
    }

    fillMoveGroupOptions();
    moveSelect.addEventListener('change', syncMemberBulkUi);

    clearMemberSelBtn.addEventListener('click', () => {
      selectedMemberIds.clear();
      for (const cb of members.querySelectorAll('input[type="checkbox"]')) {
        if (cb instanceof HTMLInputElement) cb.checked = false;
      }
      syncMemberBulkUi();
    });

    async function refreshContactsIfCommunity(force = false) {
      if (!force && groupKind(current) !== 'community') return;
      try {
        const contactsRes = await fetch('/api/network/contacts', { cache: 'no-store' });
        const contactsData = await contactsRes.json().catch(() => ({}));
        if (contactsRes.ok && contactsData.ok !== false) {
          contactMap = new Map();
          for (const row of Array.isArray(contactsData.contacts) ? contactsData.contacts : []) {
            if (row?.id) contactMap.set(String(row.id), row);
          }
        }
      } catch {
        /* non-fatal */
      }
    }

    /**
     * @param {string[]} ids
     */
    async function removeMembers(ids) {
      if (!ids.length) return;
      showMemberStatus(`Removing ${ids.length}…`);
      const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: ids }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      for (const id of ids) selectedMemberIds.delete(String(id));
      applyMembership(data.group);
      await refreshContactsIfCommunity();
      showMemberStatus(`Removed ${ids.length}`);
      renderList();
      syncMemberBulkUi();
      setTimeout(() => {
        if (memberStatus.textContent.startsWith('Removed')) memberStatus.hidden = true;
      }, 1500);
    }

    bulkRemoveBtn.addEventListener('click', async () => {
      const ids = [...selectedMemberIds];
      if (!ids.length) return;
      bulkRemoveBtn.disabled = true;
      try {
        await removeMembers(ids);
      } catch (err) {
        showMemberStatus(`Remove failed: ${err?.message || err}`, true);
        syncMemberBulkUi();
      }
    });

    bulkMoveBtn.addEventListener('click', async () => {
      const targetId = moveSelect.value;
      const ids = [...selectedMemberIds];
      if (!targetId || !ids.length) return;
      bulkMoveBtn.disabled = true;
      showMemberStatus(`Moving ${ids.length}…`);
      try {
        const addRes = await fetch(`/api/network/groups/${encodeURIComponent(targetId)}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactIds: ids }),
        });
        const addData = await addRes.json().catch(() => ({}));
        if (!addRes.ok || addData.ok === false) throw new Error(addData.error || `HTTP ${addRes.status}`);
        upsertGroup(addData.group);

        const rmRes = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}/members`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactIds: ids }),
        });
        const rmData = await rmRes.json().catch(() => ({}));
        if (!rmRes.ok || rmData.ok === false) throw new Error(rmData.error || `HTTP ${rmRes.status}`);

        for (const id of ids) selectedMemberIds.delete(String(id));
        applyMembership(rmData.group);
        const sceneRefresh =
          groupKind(current) === 'community'
          || groupKind(addData.group) === 'community';
        if (sceneRefresh) await refreshContactsIfCommunity(true);
        moveSelect.value = '';
        showMemberStatus(`Moved ${ids.length}`);
        renderList();
        syncMemberBulkUi();
        setTimeout(() => {
          if (memberStatus.textContent.startsWith('Moved')) memberStatus.hidden = true;
        }, 1500);
      } catch (err) {
        showMemberStatus(`Move failed: ${err?.message || err}`, true);
        syncMemberBulkUi();
      }
    });

    function showMemberStatus(msg, isErr = false) {
      memberStatus.hidden = !msg;
      memberStatus.textContent = msg || '';
      memberStatus.classList.toggle('mobile-network__save-status--err', isErr);
    }

    /**
     * @param {object} group
     */
    function applyMembership(group) {
      if (!group) return;
      current = group;
      upsertGroup(current);
      memberSet.clear();
      for (const id of Array.isArray(current.memberIds) ? current.memberIds : []) {
        memberSet.add(String(id));
      }
      for (const id of [...selectedMemberIds]) {
        if (!memberSet.has(String(id))) selectedMemberIds.delete(id);
      }
      paintMembers();
      renderAddCandidates();
      syncMemberBulkUi();
    }

    /**
     * @param {object} c
     */
    function appendMemberRow(c) {
      const li = document.createElement('li');
      li.className = 'mobile-network__row mobile-groups__member-row';
      if (!readOnly) {
        const checkWrap = document.createElement('label');
        checkWrap.className = 'mobile-groups__member-check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selectedMemberIds.has(String(c.id));
        check.setAttribute('aria-label', `Select ${contactName(c)}`);
        check.addEventListener('click', (e) => e.stopPropagation());
        check.addEventListener('change', () => {
          if (check.checked) selectedMemberIds.add(String(c.id));
          else selectedMemberIds.delete(String(c.id));
          syncMemberBulkUi();
        });
        checkWrap.append(check);
        li.append(checkWrap);
      }
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
      const rowSub = document.createElement('div');
      rowSub.className = 'mobile-network__row-sub';
      const nick = String(c.nickname || '').trim();
      const org = String(c.organizationName || c.org || '').trim();
      const subText = [nick, org].filter(Boolean).join(' · ');
      if (subText) rowSub.textContent = subText;
      else rowSub.hidden = true;
      body.append(name, rowSub);
      const openContact = () => openContactDetail(c);
      avatar.addEventListener('click', openContact);
      body.addEventListener('click', openContact);
      li.append(avatar, body);
      members.append(li);
    }

    function paintMembers() {
      members.replaceChildren();
      membersSection.querySelector('.mobile-network__empty')?.remove();
      const ids = Array.isArray(current.memberIds) ? current.memberIds : [];
      if (!ids.length) {
        const empty = document.createElement('p');
        empty.className = 'mobile-network__empty';
        empty.textContent = readOnly
          ? 'No contacts with this Scene tag yet.'
          : 'No members yet — add people below.';
        membersSection.append(empty);
        return;
      }
      const sorted = ids
        .map((id) => contactMap.get(String(id)) || { id, displayName: 'Unknown contact' })
        .sort((a, b) =>
          contactName(a).localeCompare(contactName(b), undefined, { sensitivity: 'base' }),
        );
      for (const c of sorted) appendMemberRow(c);
    }

    paintMembers();
    membersSection.append(members);

    const addSection = document.createElement('div');
    addSection.className = 'mobile-network__section';
    const addHead = document.createElement('div');
    addHead.className = 'mobile-network__section-head';
    const addTitle = document.createElement('h3');
    addTitle.className = 'mobile-network__section-title';
    addTitle.textContent = 'Add people';
    addHead.append(addTitle);
    const addSearch = document.createElement('input');
    addSearch.type = 'search';
    addSearch.className = 'mobile-network__search';
    addSearch.placeholder = 'Search people to add…';
    addSearch.autocomplete = 'off';
    addSearch.setAttribute('aria-label', 'Search people to add');
    const addList = document.createElement('ul');
    addList.className = 'mobile-network__list';

    function renderAddCandidates() {
      addList.replaceChildren();
      addSection.querySelector('.mobile-network__empty')?.remove();
      const q = addSearch.value.trim().toLowerCase();
      const candidates = [...contactMap.values()]
        .filter((c) => c?.id && !memberSet.has(String(c.id)))
        .filter((c) => {
          if (!q) return true;
          const hay = [c.displayName, c.nickname, c.org, c.organizationName]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
        .sort((a, b) => compareContactSearchNameRank(a, b, q, contactName))
        .slice(0, 40);
      if (!candidates.length) {
        const empty = document.createElement('p');
        empty.className = 'mobile-network__empty';
        empty.textContent = q ? 'No matching people' : 'Everyone is already in this group';
        addSection.append(empty);
        return;
      }
      for (const c of candidates) {
        const li = document.createElement('li');
        li.className = 'mobile-network__row mobile-groups__member-row';
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
        body.append(name);
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'mobile-network__selection-btn mobile-network__selection-btn--primary';
        addBtn.textContent = 'Add';
        addBtn.addEventListener('click', async () => {
          addBtn.disabled = true;
          showMemberStatus(`Adding ${contactName(c)}…`);
          try {
            const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}/members`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contactIds: [c.id] }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
            applyMembership(data.group);
            if (groupKind(current) === 'community') {
              try {
                const contactsRes = await fetch('/api/network/contacts', { cache: 'no-store' });
                const contactsData = await contactsRes.json().catch(() => ({}));
                if (contactsRes.ok && contactsData.ok !== false) {
                  contactMap = new Map();
                  for (const row of Array.isArray(contactsData.contacts) ? contactsData.contacts : []) {
                    if (row?.id) contactMap.set(String(row.id), row);
                  }
                }
              } catch {
                /* non-fatal */
              }
            }
            showMemberStatus('Added');
            renderList();
            setTimeout(() => {
              if (memberStatus.textContent === 'Added') memberStatus.hidden = true;
            }, 1500);
          } catch (err) {
            showMemberStatus(`Add failed: ${err?.message || err}`, true);
            addBtn.disabled = false;
          }
        });
        li.append(avatar, body, addBtn);
        addList.append(li);
      }
    }

    addSearch.addEventListener('input', () => renderAddCandidates());
    addSection.append(addHead, addSearch, addList);
    if (!readOnly) renderAddCandidates();

    if (!readOnly) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        saveBtn.disabled = true;
        saveStatus.hidden = false;
        saveStatus.textContent = 'Saving…';
        saveStatus.classList.remove('mobile-network__save-status--err');
        try {
          const fd = new FormData(form);
          const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: String(fd.get('name') || '').trim(),
              kind: 'event',
            }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || data.ok === false) {
            throw new Error(data.error || `HTTP ${r.status}`);
          }
          current = data.group || current;
          upsertGroup(current);
          dirty = false;
          saveStatus.textContent = 'Saved';
          setTimeout(() => {
            if (saveStatus.textContent === 'Saved') saveStatus.hidden = true;
          }, 1500);
          renderList();
          paintMembers();
        } catch (err) {
          saveStatus.textContent = `Save failed: ${err?.message || err}`;
          saveStatus.classList.add('mobile-network__save-status--err');
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    detailPane.append(back, form, membersSection);
    if (!readOnly) detailPane.append(addSection);
  }

  function renderList() {
    list.replaceChildren();
    const items = filtered(search.value);
    status.hidden = true;
    if (!items.length) {
      status.hidden = false;
      status.textContent = groups.length ? 'No matches.' : NETWORK_LABELS.noGroupsYet;
      return;
    }

    /** @type {string | null} */
    let lastSection = null;
    for (const g of items) {
      const section = groupSectionLabel(groupKind(g));
      if (section !== lastSection) {
        lastSection = section;
        const heading = document.createElement('li');
        heading.className = 'mobile-groups__heading';
        heading.textContent = section;
        list.append(heading);
      }
      const li = document.createElement('li');
      li.className = 'mobile-network__row';
      const icon = createGroupKindIconEl(g, 'mobile-groups__kind-icon');
      const body = document.createElement('div');
      body.className = 'mobile-network__row-body';
      const name = document.createElement('div');
      name.className = 'mobile-network__row-name';
      name.textContent = groupName(g);
      const sub = document.createElement('div');
      sub.className = 'mobile-network__row-sub';
      const n = memberCount(g);
      sub.textContent = `${n} member${n === 1 ? '' : 's'}`;
      body.append(name, sub);
      li.append(icon, body);
      li.addEventListener('click', () => showGroup(g));
      list.append(li);
    }
  }

  async function createEventGroup() {
    addEventBtn.disabled = true;
    status.hidden = false;
    status.textContent = 'Creating…';
    try {
      const r = await fetch('/api/network/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', kind: 'event', eventType: '' }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      const g = data.group;
      if (!g?.id) throw new Error('create_failed');
      upsertGroup(g);
      status.hidden = true;
      showGroup(g);
      const nameInput = detailPane.querySelector('input[name="name"]');
      if (nameInput instanceof HTMLInputElement) {
        nameInput.focus();
        nameInput.select();
      }
    } catch (e) {
      status.hidden = false;
      status.textContent = `Could not create group: ${e?.message || e}`;
    } finally {
      addEventBtn.disabled = false;
    }
  }

  addEventBtn.addEventListener('click', () => {
    if (view !== 'list') return;
    void createEventGroup();
  });

  search.addEventListener('input', () => {
    if (view !== 'list') return;
    renderList();
  });

  async function load() {
    try {
      const [groupsRes, contactsRes] = await Promise.all([
        fetch('/api/network/groups', { cache: 'no-store' }),
        fetch('/api/network/contacts', { cache: 'no-store' }),
      ]);
      const groupsData = await groupsRes.json().catch(() => ({}));
      const contactsData = await contactsRes.json().catch(() => ({}));
      if (!groupsRes.ok || groupsData.ok === false) {
        throw new Error(groupsData.error || `Groups HTTP ${groupsRes.status}`);
      }
      if (!contactsRes.ok || contactsData.ok === false) {
        throw new Error(contactsData.error || `Contacts HTTP ${contactsRes.status}`);
      }
      groups = Array.isArray(groupsData.groups) ? groupsData.groups.slice() : [];
      contactMap = new Map();
      for (const c of Array.isArray(contactsData.contacts) ? contactsData.contacts : []) {
        if (c?.id) contactMap.set(String(c.id), c);
      }
      renderList();
      const navState = history.state;
      if (navState?.dashbirdMobile && navState.tab === 'groups' && navState.pane !== 'list') {
        document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: navState }));
      }
    } catch (e) {
      status.hidden = false;
      status.textContent = `Could not load groups: ${e?.message || e}`;
    }
  }

  void load();

  document.addEventListener('dashbird:mobile-nav', (e) => {
    const s = e.detail;
    if (!s || s.tab !== 'groups') return;
    if (s.pane === 'list') {
      showList();
      renderList();
      return;
    }
    if (s.pane === 'group' && s.groupId) {
      const g = groups.find((x) => String(x.id) === String(s.groupId));
      if (g) showGroup(g, { fromHistory: true });
      else {
        showList();
        renderList();
      }
      return;
    }
    if (s.pane === 'contact' && s.contactId) {
      document.dispatchEvent(
        new CustomEvent('dashbird:mobile-goto', {
          detail: { tab: 'network', pane: 'contact', contactId: String(s.contactId) },
        }),
      );
      return;
    }
  });
}
