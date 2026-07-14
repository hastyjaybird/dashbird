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
