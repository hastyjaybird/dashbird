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
  isEventGroup,
  isSceneGroup,
} from '../lib/network-group-kind.js?v=scene-ux-1';
import { NETWORK_LABELS } from '../lib/network-labels.js';
import { addSceneToken, removeSceneToken } from '../lib/network-scene-tokens.js';

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
 * Fire a callback after a touch (or mouse) press is held for ~ms without moving.
 * Touch-first for mobile; mouse handlers make it usable on desktop too.
 * @param {HTMLElement} el
 * @param {() => void} onLongPress
 * @param {number} [ms]
 */
function attachLongPress(el, onLongPress, ms = 500) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let startX = 0;
  let startY = 0;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  /** @param {number} x @param {number} y */
  function start(x, y) {
    startX = x;
    startY = y;
    clear();
    timer = setTimeout(() => {
      timer = null;
      onLongPress();
    }, ms);
  }
  /** @param {number} x @param {number} y */
  function move(x, y) {
    if (!timer) return;
    if (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10) clear();
  }

  el.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (t) start(t.clientX, t.clientY);
    },
    { passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (t) move(t.clientX, t.clientY);
    },
    { passive: true },
  );
  el.addEventListener('touchend', clear);
  el.addEventListener('touchcancel', clear);
  el.addEventListener('mousedown', (e) => start(e.clientX, e.clientY));
  el.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  el.addEventListener('mouseup', clear);
  el.addEventListener('mouseleave', clear);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

/**
 * Multi-select contact picker sheet. Resolves with selected contact ids, or null.
 * @param {{ title: string, candidates: object[] }} opts
 * @returns {Promise<string[] | null>}
 */
function openContactPickerSheet({ title, candidates }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'mobile-network__sheet-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const sheet = document.createElement('div');
    sheet.className = 'mobile-network__sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', title);

    const header = document.createElement('div');
    header.className = 'mobile-network__sheet-head';
    const heading = document.createElement('h3');
    heading.className = 'mobile-network__sheet-title';
    heading.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mobile-network__sheet-close';
    closeBtn.textContent = 'Cancel';
    header.append(heading, closeBtn);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'mobile-network__search';
    search.placeholder = 'Search people…';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Search people to add');

    const listEl = document.createElement('ul');
    listEl.className = 'mobile-network__sheet-list mobile-groups__picker-list';

    const footer = document.createElement('div');
    footer.className = 'mobile-groups__picker-footer';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'mobile-network__selection-btn mobile-network__selection-btn--primary';
    addBtn.textContent = 'Add';
    addBtn.disabled = true;
    footer.append(addBtn);

    /** @type {Set<string>} */
    const selected = new Set();

    function syncAddBtn() {
      const n = selected.size;
      addBtn.disabled = n === 0;
      addBtn.textContent = n === 0 ? 'Add' : `Add ${n}`;
    }

    function paint() {
      listEl.replaceChildren();
      const q = search.value.trim().toLowerCase();
      const items = candidates
        .filter((c) => {
          if (!q) return true;
          const hay = [c.displayName, c.nickname, c.org, c.organizationName]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
        .sort((a, b) => compareContactSearchNameRank(a, b, q, contactName))
        .slice(0, 60);
      if (!items.length) {
        const empty = document.createElement('li');
        empty.className = 'mobile-network__empty';
        empty.textContent = q ? 'No matching people' : 'No contacts available';
        listEl.append(empty);
        return;
      }
      for (const c of items) {
        const li = document.createElement('li');
        const lab = document.createElement('label');
        lab.className = 'mobile-network__sheet-option mobile-groups__picker-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(String(c.id));
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(String(c.id));
          else selected.delete(String(c.id));
          syncAddBtn();
        });
        const name = document.createElement('span');
        name.className = 'mobile-network__sheet-option-name';
        name.textContent = contactName(c);
        const sub = String(c.nickname || c.organizationName || c.org || '').trim();
        lab.append(cb, name);
        if (sub) {
          const meta = document.createElement('span');
          meta.className = 'mobile-network__sheet-option-meta';
          meta.textContent = sub;
          lab.append(meta);
        }
        li.append(lab);
        listEl.append(li);
      }
    }

    let settled = false;
    /** @param {string[] | null} result */
    function finish(result) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key === 'Escape') finish(null);
    }

    search.addEventListener('input', paint);
    addBtn.addEventListener('click', () => finish([...selected]));
    closeBtn.addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });

    paint();
    syncAddBtn();
    sheet.append(header, search, listEl, footer);
    backdrop.append(sheet);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    search.focus();
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
    const isScene = isSceneGroup(group);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mobile-network__back';
    back.textContent = '← Groups';
    back.addEventListener('click', () => {
      mobileNavBack();
    });

    // --- Header: kind icon + name (event names rename inline on long-press). ---
    const headerBlock = document.createElement('div');
    headerBlock.className = 'mobile-groups__header-block';

    const head = document.createElement('div');
    head.className = 'mobile-groups__scene-head';
    head.append(createGroupKindIconEl(current, 'mobile-groups__kind-icon'));

    const title = document.createElement('h2');
    title.className = 'mobile-network__detail-name mobile-groups__name-title';
    title.textContent = groupName(current);
    head.append(title);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'mobile-network__input mobile-groups__name-input';
    nameInput.setAttribute('aria-label', 'Group name');
    nameInput.hidden = true;

    const nameStatus = document.createElement('p');
    nameStatus.className = 'mobile-network__save-status';
    nameStatus.hidden = true;

    headerBlock.append(head, nameInput, nameStatus);

    /**
     * @param {string} [msg]
     * @param {boolean} [isErr]
     */
    function showNameStatus(msg, isErr = false) {
      nameStatus.hidden = !msg;
      nameStatus.textContent = msg || '';
      nameStatus.classList.toggle('mobile-network__save-status--err', isErr);
    }

    let editingName = false;
    function openNameEditor() {
      if (isScene || editingName) return;
      editingName = true;
      nameInput.value = String(current.name || '');
      title.hidden = true;
      nameInput.hidden = false;
      nameInput.focus();
      nameInput.select();
    }
    function closeNameEditor() {
      editingName = false;
      nameInput.hidden = true;
      title.hidden = false;
    }
    async function commitGroupName() {
      if (!editingName) return;
      const name = String(nameInput.value || '').trim();
      if (!name || name === String(current.name || '')) {
        closeNameEditor();
        return;
      }
      showNameStatus('Saving…');
      try {
        const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, kind: 'event' }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
        current = data.group || { ...current, name };
        upsertGroup(current);
        title.textContent = groupName(current);
        showNameStatus('');
        closeNameEditor();
        renderList();
      } catch (err) {
        showNameStatus(`Rename failed: ${err?.message || err}`, true);
      }
    }

    if (!isScene) {
      title.classList.add('mobile-groups__name-title--editable');
      title.setAttribute('role', 'button');
      title.setAttribute('tabindex', '0');
      title.title = 'Long-press to rename';
      attachLongPress(title, openNameEditor);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commitGroupName();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeNameEditor();
        }
      });
      nameInput.addEventListener('blur', () => {
        void commitGroupName();
      });
      const editHint = document.createElement('p');
      editHint.className = 'mobile-network__field-hint mobile-groups__name-hint';
      editHint.textContent = 'Long-press the name to rename.';
      headerBlock.append(editHint);
    }

    // --- Members section (multi-select + bulk copy / remove). ---
    const membersSection = document.createElement('div');
    membersSection.className = 'mobile-network__section';
    const membersHead = document.createElement('div');
    membersHead.className = 'mobile-network__section-head';
    const membersLabel = document.createElement('h3');
    membersLabel.className = 'mobile-network__section-title';
    membersLabel.textContent = 'Members';
    const addContactsBtn = document.createElement('button');
    addContactsBtn.type = 'button';
    addContactsBtn.className = 'mobile-network__action mobile-groups__add-contacts';
    addContactsBtn.textContent = 'Add contacts';
    membersHead.append(membersLabel, addContactsBtn);
    membersSection.append(membersHead);

    const memberBulk = document.createElement('div');
    memberBulk.className = 'mobile-network__selection-bar mobile-groups__member-bulk';
    memberBulk.hidden = true;
    const memberBulkCount = document.createElement('span');
    memberBulkCount.className = 'mobile-network__selection-count';
    const copySelect = document.createElement('select');
    copySelect.className = 'mobile-network__input mobile-groups__move-select';
    copySelect.setAttribute('aria-label', 'Copy selected members to group');
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'mobile-network__selection-btn mobile-network__selection-btn--primary';
    copyBtn.textContent = 'Copy';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'mobile-network__selection-btn';
    removeBtn.textContent = 'Remove from group';
    const clearMemberSelBtn = document.createElement('button');
    clearMemberSelBtn.type = 'button';
    clearMemberSelBtn.className = 'mobile-network__selection-btn';
    clearMemberSelBtn.textContent = 'Clear';
    memberBulk.append(memberBulkCount, copySelect, copyBtn, removeBtn, clearMemberSelBtn);
    membersSection.append(memberBulk);

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

    function fillCopyOptions() {
      const prev = copySelect.value;
      copySelect.replaceChildren();
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Copy to…';
      copySelect.append(blank);
      const others = groups.filter((og) => String(og.id) !== String(current.id));
      for (const og of others) {
        const o = document.createElement('option');
        o.value = og.id;
        o.textContent = `${groupName(og)} (${groupKindLabel(og)})`;
        copySelect.append(o);
      }
      copySelect.disabled = others.length === 0;
      if (prev && others.some((og) => String(og.id) === String(prev))) copySelect.value = prev;
    }

    function syncMemberBulkUi() {
      const n = selectedMemberIds.size;
      memberBulk.hidden = n === 0;
      memberBulkCount.textContent = n === 1 ? '1 selected' : `${n} selected`;
      removeBtn.disabled = n === 0;
      copyBtn.disabled = n === 0 || !copySelect.value;
    }

    fillCopyOptions();
    copySelect.addEventListener('change', syncMemberBulkUi);

    clearMemberSelBtn.addEventListener('click', () => {
      selectedMemberIds.clear();
      for (const cb of members.querySelectorAll('input[type="checkbox"]')) {
        if (cb instanceof HTMLInputElement) cb.checked = false;
      }
      syncMemberBulkUi();
    });

    /** @param {string} [msg] @param {boolean} [isErr] */
    function showMemberStatus(msg, isErr = false) {
      memberStatus.hidden = !msg;
      memberStatus.textContent = msg || '';
      memberStatus.classList.toggle('mobile-network__save-status--err', isErr);
    }

    async function refreshContacts() {
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

    async function reloadCurrentGroup() {
      try {
        const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}`, {
          cache: 'no-store',
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok !== false && d.group) applyMembership(d.group);
      } catch {
        /* non-fatal */
      }
    }

    async function reloadGroups() {
      try {
        const r = await fetch('/api/network/groups', { cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok !== false && Array.isArray(d.groups)) {
          groups = d.groups.slice();
          const updated = groups.find((x) => String(x.id) === String(current.id));
          if (updated) {
            current = updated;
            upsertGroup(current);
          }
        }
      } catch {
        /* non-fatal */
      }
    }

    /**
     * Add contacts to a Scene by editing each contact's Scene tag. Scene groups
     * mirror `networkCircles`, so the server re-syncs group membership.
     * @param {string[]} ids
     * @param {string} sceneName
     */
    async function addContactsToScene(ids, sceneName) {
      for (const id of ids) {
        const c = contactMap.get(String(id));
        const next = addSceneToken(c?.networkCircles, sceneName);
        if (c && next === String(c.networkCircles || '')) continue;
        const r = await fetch(`/api/network/contacts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkCircles: next }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      }
    }

    /**
     * @param {string[]} ids
     * @param {string} sceneName
     */
    async function removeContactsFromScene(ids, sceneName) {
      for (const id of ids) {
        const c = contactMap.get(String(id));
        const next = removeSceneToken(c?.networkCircles, sceneName);
        if (c && next === String(c.networkCircles || '')) continue;
        const r = await fetch(`/api/network/contacts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkCircles: next }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      }
    }

    /**
     * @param {object} g
     */
    function applyMembership(g) {
      if (!g) return;
      current = g;
      upsertGroup(current);
      memberSet.clear();
      for (const id of Array.isArray(current.memberIds) ? current.memberIds : []) {
        memberSet.add(String(id));
      }
      for (const id of [...selectedMemberIds]) {
        if (!memberSet.has(String(id))) selectedMemberIds.delete(id);
      }
      paintMembers();
      syncMemberBulkUi();
    }

    removeBtn.addEventListener('click', async () => {
      const ids = [...selectedMemberIds];
      if (!ids.length) return;
      removeBtn.disabled = true;
      showMemberStatus(`Removing ${ids.length}…`);
      try {
        if (isScene) {
          await removeContactsFromScene(ids, current.name || '');
          for (const id of ids) selectedMemberIds.delete(String(id));
          await refreshContacts();
          await reloadCurrentGroup();
        } else {
          const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}/members`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactIds: ids }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
          for (const id of ids) selectedMemberIds.delete(String(id));
          applyMembership(data.group);
        }
        showMemberStatus(`Removed ${ids.length}`);
        renderList();
        setTimeout(() => {
          if (memberStatus.textContent.startsWith('Removed')) memberStatus.hidden = true;
        }, 1500);
      } catch (err) {
        showMemberStatus(`Remove failed: ${err?.message || err}`, true);
      } finally {
        syncMemberBulkUi();
      }
    });

    copyBtn.addEventListener('click', async () => {
      const targetId = copySelect.value;
      const ids = [...selectedMemberIds];
      if (!targetId || !ids.length) return;
      const target = groups.find((g) => String(g.id) === String(targetId));
      if (!target) return;
      copyBtn.disabled = true;
      showMemberStatus(`Copying ${ids.length}…`);
      try {
        if (isEventGroup(target)) {
          const r = await fetch(`/api/network/groups/${encodeURIComponent(target.id)}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactIds: ids }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
          if (data.group) upsertGroup(data.group);
        } else {
          await addContactsToScene(ids, target.name || '');
          await refreshContacts();
        }
        copySelect.value = '';
        showMemberStatus(`Copied ${ids.length} to ${groupName(target)}`);
        await reloadGroups();
        fillCopyOptions();
        renderList();
        setTimeout(() => {
          if (memberStatus.textContent.startsWith('Copied')) memberStatus.hidden = true;
        }, 1800);
      } catch (err) {
        showMemberStatus(`Copy failed: ${err?.message || err}`, true);
      } finally {
        syncMemberBulkUi();
      }
    });

    addContactsBtn.addEventListener('click', async () => {
      const candidates = [...contactMap.values()].filter(
        (c) => c?.id && !memberSet.has(String(c.id)),
      );
      const picked = await openContactPickerSheet({
        title: `Add contacts to ${groupName(current)}`,
        candidates,
      });
      if (!picked || !picked.length) return;
      showMemberStatus(`Adding ${picked.length}…`);
      try {
        if (isScene) {
          await addContactsToScene(picked, current.name || '');
          await refreshContacts();
          await reloadCurrentGroup();
        } else {
          const r = await fetch(`/api/network/groups/${encodeURIComponent(current.id)}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactIds: picked }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
          applyMembership(data.group);
        }
        showMemberStatus(`Added ${picked.length}`);
        renderList();
        setTimeout(() => {
          if (memberStatus.textContent.startsWith('Added')) memberStatus.hidden = true;
        }, 1500);
      } catch (err) {
        showMemberStatus(`Add failed: ${err?.message || err}`, true);
      }
    });

    /**
     * @param {object} c
     */
    function appendMemberRow(c) {
      const li = document.createElement('li');
      li.className = 'mobile-network__row mobile-groups__member-row';
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

      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'mobile-network__avatar-wrap';
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
      avatarWrap.append(avatar);
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
      li.append(avatarWrap, body);
      members.append(li);
    }

    function paintMembers() {
      members.replaceChildren();
      membersSection.querySelector('.mobile-network__empty')?.remove();
      const ids = Array.isArray(current.memberIds) ? current.memberIds : [];
      if (!ids.length) {
        const empty = document.createElement('p');
        empty.className = 'mobile-network__empty';
        empty.textContent = isScene
          ? 'No contacts with this Scene tag yet — use Add contacts.'
          : 'No members yet — use Add contacts.';
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

    detailPane.append(back, headerBlock, membersSection);
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
