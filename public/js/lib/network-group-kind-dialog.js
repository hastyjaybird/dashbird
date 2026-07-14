/**
 * In-app picker for network group kind (community vs event).
 * Replaces the native browser prompt.
 *
 * @param {{ title?: string, hint?: string }} [opts]
 * @returns {Promise<'community' | 'event' | null>}
 */
export function openGroupKindDialog(opts = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'network-crm__img-pick-backdrop network-crm__enrich-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'network-crm__img-pick-dialog network-crm__enrich-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.title || 'Group kind');

    const header = document.createElement('div');
    header.className = 'network-crm__img-pick-dialog-header';
    const title = document.createElement('h3');
    title.className = 'network-crm__img-pick-dialog-title';
    title.textContent = opts.title || 'Group kind';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
    closeBtn.textContent = 'Close';
    header.append(title, closeBtn);

    const hint = document.createElement('p');
    hint.className = 'network-crm__img-pick-hint muted';
    hint.textContent =
      opts.hint || 'Choose whether this is a community or an event group.';

    const listEl = document.createElement('div');
    listEl.className = 'network-crm__enrich-options';

    let settled = false;
    function finish(/** @type {'community' | 'event' | null} */ value) {
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
     * @param {'community' | 'event'} kind
     */
    function addOption(label, desc, kind) {
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
      btn.addEventListener('click', () => finish(kind));
      listEl.append(btn);
    }

    addOption('Community', 'Updates Scene on people', 'community');
    addOption('Event', 'Friends grouping only', 'event');

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
