/**
 * Dialogs for adding new contacts to a network group from a name list.
 */

/**
 * @param {{ title?: string, hint?: string, placeholder?: string }} [opts]
 * @returns {Promise<string[] | null>}
 */
export function openNamesListDialog(opts = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'network-crm__img-pick-backdrop network-crm__enrich-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'network-crm__img-pick-dialog network-crm__enrich-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.title || 'Add new contacts');

    const header = document.createElement('div');
    header.className = 'network-crm__img-pick-dialog-header';
    const title = document.createElement('h3');
    title.className = 'network-crm__img-pick-dialog-title';
    title.textContent = opts.title || 'Add new contacts';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
    closeBtn.textContent = 'Close';
    header.append(title, closeBtn);

    const hint = document.createElement('p');
    hint.className = 'network-crm__img-pick-hint muted';
    hint.textContent =
      opts.hint || 'One name per line. Creates a contact card for each and adds them to this group.';

    const ta = document.createElement('textarea');
    ta.className = 'network-crm__input';
    ta.rows = 8;
    ta.placeholder = opts.placeholder || 'Alex Chen\nJordan Lee';
    ta.autocomplete = 'off';

    const actions = document.createElement('div');
    actions.className = 'network-crm__img-pick-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'network-crm__btn';
    cancelBtn.textContent = 'Cancel';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'network-crm__btn network-crm__btn--primary';
    submitBtn.textContent = 'Continue';
    actions.append(cancelBtn, submitBtn);

    let settled = false;
    function finish(/** @type {string[] | null} */ value) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    }

    function onKey(e) {
      if (e.key === 'Escape') finish(null);
    }

    function parseNames() {
      return String(ta.value || '')
        .split(/\n+/)
        .map((n) => n.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }

    closeBtn.addEventListener('click', () => finish(null));
    cancelBtn.addEventListener('click', () => finish(null));
    submitBtn.addEventListener('click', () => {
      const names = parseNames();
      if (!names.length) {
        ta.focus();
        return;
      }
      finish(names);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });

    dialog.append(header, hint, ta, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    ta.focus();
  });
}

/**
 * Exact-name collision: create another card, or skip this name.
 * @param {{ name: string, existingLabel?: string }} opts
 * @returns {Promise<'create' | 'skip' | null>}
 */
export function openExactNameConflictDialog(opts) {
  return new Promise((resolve) => {
    const name = String(opts.name || '').trim();
    const existingLabel = String(opts.existingLabel || name).trim() || name;

    const backdrop = document.createElement('div');
    backdrop.className = 'network-crm__img-pick-backdrop network-crm__enrich-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'network-crm__img-pick-dialog network-crm__enrich-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Name already exists');

    const header = document.createElement('div');
    header.className = 'network-crm__img-pick-dialog-header';
    const title = document.createElement('h3');
    title.className = 'network-crm__img-pick-dialog-title';
    title.textContent = 'Name already exists';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
    closeBtn.textContent = 'Close';
    header.append(title, closeBtn);

    const hint = document.createElement('p');
    hint.className = 'network-crm__img-pick-hint muted';
    hint.textContent = `“${name}” matches existing contact “${existingLabel}”. Create another card, or skip this name?`;

    const listEl = document.createElement('div');
    listEl.className = 'network-crm__enrich-options';

    let settled = false;
    function finish(/** @type {'create' | 'skip' | null} */ value) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    }

    function onKey(e) {
      if (e.key === 'Escape') finish(null);
    }

    /**
     * @param {string} label
     * @param {string} desc
     * @param {'create' | 'skip'} value
     */
    function addOption(label, desc, value) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'network-crm__enrich-option';
      const textWrap = document.createElement('span');
      textWrap.className = 'network-crm__enrich-option-text';
      const strong = document.createElement('strong');
      strong.textContent = label;
      const p = document.createElement('span');
      p.className = 'muted';
      p.textContent = desc;
      textWrap.append(strong, p);
      btn.append(textWrap);
      btn.addEventListener('click', () => finish(value));
      listEl.append(btn);
    }

    addOption('New contact', 'Create another card with this name and add it to the group', 'create');
    addOption('Skip', 'Do not create or add this name', 'skip');

    closeBtn.addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });

    dialog.append(header, hint, listEl);
    backdrop.append(dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Exact displayName match (case-insensitive).
 * @param {object[]} contacts
 * @param {string} name
 */
export function findExactDisplayNameMatch(contacts, name) {
  const needle = String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!needle) return null;
  for (const c of contacts || []) {
    const dn = String(c?.displayName || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (dn === needle) return c;
  }
  return null;
}

/**
 * @param {object} contact
 * @param {string} className
 */
function pickAvatarEl(contact, className) {
  const box = document.createElement('div');
  box.className = className;
  if (contact?.avatarUrl) {
    const img = document.createElement('img');
    img.src = `${contact.avatarUrl}${contact.avatarUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(contact.updatedAt || '')}`;
    img.alt = '';
    img.width = 48;
    img.height = 48;
    box.append(img);
    return box;
  }
  const first = String(contact?.firstName || '').trim();
  const last = String(contact?.lastName || '').trim();
  const initials =
    first || last
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
  return box;
}

/**
 * Search existing contacts to link, or create a new contact (company prefilled by caller).
 * @param {{
 *   contacts: object[],
 *   excludeIds?: Iterable<string>,
 *   title?: string,
 *   hint?: string,
 *   orgLabel?: string,
 * }} opts
 * @returns {Promise<
 *   | { action: 'link', contactId: string }
 *   | { action: 'create', displayName: string, title: string }
 *   | null
 * >}
 */
export function openPickContactDialog(opts = {}) {
  return new Promise((resolve) => {
    const exclude = new Set(
      [...(opts.excludeIds || [])].map((id) => String(id || '')).filter(Boolean),
    );
    const pool = (opts.contacts || []).filter((c) => c?.id && !exclude.has(String(c.id)));
    const orgLabel = String(opts.orgLabel || '').trim();

    const backdrop = document.createElement('div');
    backdrop.className = 'network-crm__img-pick-backdrop network-crm__enrich-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className =
      'network-crm__img-pick-dialog network-crm__enrich-dialog network-crm__pick-contact-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.title || 'Link person');

    const header = document.createElement('div');
    header.className = 'network-crm__img-pick-dialog-header';
    const title = document.createElement('h3');
    title.className = 'network-crm__img-pick-dialog-title';
    title.textContent = opts.title || 'Link person';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
    closeBtn.textContent = 'Close';
    header.append(title, closeBtn);

    const hint = document.createElement('p');
    hint.className = 'network-crm__img-pick-hint muted';
    hint.textContent =
      opts.hint ||
      (orgLabel
        ? `Search your network, or add someone new — they’ll be linked to ${orgLabel}.`
        : 'Search your network, or add someone new.');

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'network-crm__input';
    search.placeholder = 'Search contacts…';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Search contacts');

    const results = document.createElement('div');
    results.className = 'network-crm__pick-contact-list';
    results.setAttribute('role', 'listbox');
    results.setAttribute('aria-label', 'Matching contacts');

    const createWrap = document.createElement('div');
    createWrap.className = 'network-crm__pick-contact-create';
    const createLabel = document.createElement('div');
    createLabel.className = 'network-crm__checks-label';
    createLabel.textContent = 'Not in your network?';
    const nameField = document.createElement('label');
    nameField.className = 'network-crm__field';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = 'Name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'network-crm__input';
    nameInput.placeholder = 'Full name';
    nameInput.autocomplete = 'off';
    nameField.append(nameSpan, nameInput);
    const titleField = document.createElement('label');
    titleField.className = 'network-crm__field';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Title (optional)';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'network-crm__input';
    titleInput.placeholder = 'Role / title';
    titleInput.autocomplete = 'off';
    titleField.append(titleSpan, titleInput);
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'network-crm__btn network-crm__btn--primary';
    createBtn.textContent = orgLabel ? `Add contact · ${orgLabel}` : 'Add contact';
    createWrap.append(createLabel, nameField, titleField, createBtn);

    let settled = false;
    function finish(/** @type {{ action: 'link', contactId: string } | { action: 'create', displayName: string, title: string } | null} */ value) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    }

    function onKey(e) {
      if (e.key === 'Escape') finish(null);
    }

    function contactHay(c) {
      return [c.displayName, c.nickname, ...(c.aliases || []), c.org, c.title, c.networkCircles]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    }

    function renderResults() {
      results.replaceChildren();
      const q = search.value.trim().toLowerCase();
      if (q && !nameInput.value.trim()) nameInput.value = search.value.trim();
      const matches = pool
        .filter((c) => {
          if (!q) return true;
          return contactHay(c).includes(q);
        })
        .sort((a, b) =>
          String(a.displayName || '').localeCompare(String(b.displayName || ''), undefined, {
            sensitivity: 'base',
          }),
        )
        .slice(0, 40);
      if (!matches.length) {
        const empty = document.createElement('p');
        empty.className = 'muted network-crm__people-empty';
        empty.textContent = q
          ? 'No matching contacts — add them below.'
          : pool.length
            ? 'Type to filter, or pick someone below.'
            : 'No other contacts available — add someone new below.';
        results.append(empty);
        return;
      }
      for (const c of matches) {
        const row = document.createElement('div');
        row.className = 'network-crm__pick-contact-row';
        row.setAttribute('role', 'option');
        row.append(pickAvatarEl(c, 'network-crm__avatar network-crm__avatar--sm'));
        const meta = document.createElement('div');
        meta.className = 'network-crm__pick-contact-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'network-crm__pick-contact-name';
        nameEl.append(document.createTextNode(c.displayName || 'Untitled'));
        if (c.nickname) {
          const nick = document.createElement('span');
          nick.className = 'muted';
          nick.textContent = ` ${c.nickname}`;
          nameEl.append(nick);
        }
        const sub = document.createElement('div');
        sub.className = 'muted network-crm__pick-contact-sub';
        sub.textContent = [c.title, c.org].filter(Boolean).join(' · ');
        meta.append(nameEl);
        if (sub.textContent) meta.append(sub);
        const linkBtn = document.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'network-crm__btn network-crm__btn--tiny network-crm__btn--primary';
        linkBtn.textContent = 'Link';
        linkBtn.addEventListener('click', () => finish({ action: 'link', contactId: String(c.id) }));
        row.append(meta, linkBtn);
        results.append(row);
      }
    }

    search.addEventListener('input', () => {
      const q = search.value.trim();
      if (q) nameInput.value = q;
      renderResults();
    });

    createBtn.addEventListener('click', () => {
      const displayName = String(nameInput.value || search.value || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!displayName) {
        nameInput.focus();
        return;
      }
      finish({
        action: 'create',
        displayName,
        title: String(titleInput.value || '')
          .replace(/\s+/g, ' ')
          .trim(),
      });
    });

    closeBtn.addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });

    dialog.append(header, hint, search, results, createWrap);
    backdrop.append(dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    renderResults();
    search.focus();
  });
}
