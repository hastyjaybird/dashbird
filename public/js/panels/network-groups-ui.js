import { beginWaitCursor, endWaitCursor } from '../lib/wait-cursor.js';

/**
 * Network groups management screen.
 * @param {HTMLElement} root
 * @param {{
 *   contacts: object[],
 *   getContacts?: () => object[],
 *   selectGroupId?: string | null,
 *   embedded?: boolean,
 *   onClose: () => void,
 *   onOpenContact?: (id: string) => void,
 *   onContactsChanged?: () => Promise<void> | void,
 * }} opts
 */
export function mountNetworkGroupsUi(root, opts) {
  const { onClose, onOpenContact } = opts;
  const embedded = Boolean(opts.embedded);
  /** @type {object[]} */
  let contacts = Array.isArray(opts.contacts) ? opts.contacts : [];
  const getContacts =
    typeof opts.getContacts === 'function' ? opts.getContacts : () => opts.contacts;

  async function pullLatestContacts() {
    await opts.onContactsChanged?.();
    const next = getContacts();
    if (Array.isArray(next)) contacts = next;
  }

  /** @type {object[]} */
  let groups = [];
  /** @type {string | null} */
  let selectedId = null;

  root.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'network-groups';
  if (embedded) wrap.classList.add('network-groups--embedded');

  const head = document.createElement('div');
  head.className = 'network-crm__toolbar';
  const title = document.createElement('h3');
  title.className = 'network-groups__title';
  title.textContent = 'Groups';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'network-crm__btn network-crm__btn--primary';
  addBtn.textContent = 'Add group';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'network-crm__btn';
  backBtn.textContent = embedded ? 'Back' : '← Contacts';
  backBtn.addEventListener('click', onClose);
  head.append(backBtn, title, addBtn);

  const layout = document.createElement('div');
  layout.className = 'network-crm__layout';
  const list = document.createElement('ul');
  list.className = 'network-crm__list';
  const detail = document.createElement('div');
  detail.className = 'network-crm__detail';
  detail.innerHTML = '<p class="muted">Select a group</p>';
  layout.append(list, detail);

  const status = document.createElement('p');
  status.className = 'network-crm__status muted';
  status.hidden = true;

  wrap.append(head, layout, status);
  root.append(wrap);

  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg || '';
    status.classList.toggle('network-crm__status--err', Boolean(isErr));
  }

  function contactName(id) {
    const c = contacts.find((x) => x.id === id);
    if (!c) return id;
    if (c.nickname) return `${c.displayName || id} (${c.nickname})`;
    return c.displayName || id;
  }

  function contactById(id) {
    return contacts.find((x) => x.id === id) || null;
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
      const initials = String(contact?.displayName || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0] || '')
        .join('')
        .toUpperCase();
      box.textContent = initials || '?';
    }
    return box;
  }

  function renderList() {
    list.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement('li');
      empty.className = 'network-crm__empty muted';
      empty.textContent = 'No groups yet — add one to start';
      list.append(empty);
      return;
    }
    for (const g of groups) {
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
      sub.textContent = `${n} member${n === 1 ? '' : 's'} · ${memberNamesPreview(g)}`;
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

  let detailGeneration = 0;

  /**
   * @param {string} id
   */
  function selectGroup(id) {
    selectedId = id;
    renderList();
    const g = groups.find((x) => x.id === id);
    if (!g) {
      detail.innerHTML = '<p class="muted">Group not found</p>';
      return;
    }
    renderDetail(g);
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
      wrapEl.append(span, input);
      return wrapEl;
    }

    form.append(
      field('Name', 'name', current.name),
      field('Description', 'description', current.description || '', { rows: 3 }),
    );

    const membersBox = document.createElement('div');
    membersBox.className = 'network-crm__people network-groups__members-panel';
    const membersTitle = document.createElement('div');
    membersTitle.className = 'network-crm__checks-label';
    membersTitle.textContent = 'Members';
    membersBox.append(membersTitle);

    const memberList = document.createElement('div');
    memberList.className = 'network-groups__member-list';
    const memberIds = [...(g.memberIds || [])];
    if (!memberIds.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No members yet — add people below.';
      memberList.append(p);
    } else {
      for (const id of memberIds) {
        const person = contactById(id);
        const row = document.createElement('div');
        row.className = 'network-groups__member';
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
          showStatus('Removing…');
          try {
            const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/members`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contactIds: [id] }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'remove_failed');
            upsertGroup(j.group);
            showStatus('Removed');
            selectGroup(g.id);
          } catch (err) {
            showStatus(String(err?.message || err), true);
          }
        });
        row.append(link, rm);
        memberList.append(row);
      }
    }
    membersBox.append(memberList);

    const addPanel = document.createElement('div');
    addPanel.className = 'network-groups__add-panel';
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
    const memberSet = new Set(memberIds);

    function renderAddCandidates() {
      addList.replaceChildren();
      const q = addSearch.value.trim().toLowerCase();
      const candidates = contacts
        .filter((c) => !memberSet.has(c.id))
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
        empty.textContent = q ? 'No matching people' : 'Everyone is already in this group';
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
            upsertGroup(j.group);
            showStatus('Added');
            selectGroup(g.id);
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
    renderAddCandidates();
    addPanel.append(addLabel, addSearch, addList);
    membersBox.append(addPanel);

    const ingest = document.createElement('div');
    ingest.className = 'network-crm__bulk';
    ingest.innerHTML = `
      <label class="network-crm__field network-crm__field--full">
        <span>Ingest people (one name per line — creates cards + adds to group)</span>
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
            showStatus('Adding…');
            try {
              const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactIds: [s.contactId] }),
              });
              const j = await r.json();
              if (!j.ok) throw new Error(j.error || 'add_failed');
              upsertGroup(j.group);
              showStatus('Added');
              selectGroup(g.id);
            } catch (err) {
              showStatus(String(err?.message || err), true);
            }
          });
          row.append(add);
        }
        suggestBox.append(row);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'network-crm__actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'network-crm__btn network-crm__btn--primary';
    saveBtn.textContent = 'Save';
    const analyzeBtn = document.createElement('button');
    analyzeBtn.type = 'button';
    analyzeBtn.className = 'network-crm__btn';
    analyzeBtn.textContent = 'Analyze commonalities';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'network-crm__btn network-crm__btn--danger';
    delBtn.textContent = 'Delete group';
    actions.append(saveBtn, analyzeBtn, delBtn);

    form.append(membersBox, ingest, commonBox, suggestBox, actions);

    let saveInFlight = false;
    let dirtyWhileSaving = false;

    async function persistGroup() {
      if (gen !== detailGeneration) return;
      if (saveInFlight) {
        dirtyWhileSaving = true;
        return;
      }
      saveInFlight = true;
      showStatus('Saving…');
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
      } catch (err) {
        if (gen === detailGeneration) showStatus(String(err?.message || err), true);
      } finally {
        saveInFlight = false;
      }
    }

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

    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete group ${g.name || ''}?`)) return;
      try {
        const r = await fetch(`/api/network/groups/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'delete_failed');
        groups = groups.filter((x) => x.id !== g.id);
        selectedId = groups[0]?.id || null;
        showStatus('Deleted');
        renderList();
        if (selectedId) selectGroup(selectedId);
        else detail.innerHTML = '<p class="muted">Select a group</p>';
      } catch (err) {
        showStatus(String(err?.message || err), true);
      }
    });

    detail.append(form);
  }

  function upsertGroup(g) {
    const idx = groups.findIndex((x) => x.id === g.id);
    if (idx >= 0) groups[idx] = g;
    else groups.unshift(g);
    renderList();
  }

  addBtn.addEventListener('click', async () => {
    const name = prompt('Group name?') || '';
    showStatus('Creating…');
    try {
      const r = await fetch('/api/network/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create_failed');
      groups.unshift(j.group);
      selectedId = j.group.id;
      showStatus('Created');
      renderList();
      selectGroup(selectedId);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  });

  async function load() {
    showStatus('Loading groups…');
    try {
      const r = await fetch('/api/network/groups');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load_failed');
      groups = Array.isArray(j.groups) ? j.groups : [];
      showStatus('');
      const prefer = opts.selectGroupId && groups.some((g) => g.id === opts.selectGroupId)
        ? opts.selectGroupId
        : null;
      selectedId = prefer || groups[0]?.id || null;
      renderList();
      if (selectedId) selectGroup(selectedId);
    } catch (err) {
      showStatus(String(err?.message || err), true);
    }
  }

  load();
}
