/**
 * Notes slot — link to the local Vikunja UI (replaces the old notes.md panel).
 * @param {HTMLElement} root
 * @param {{ vikunjaPublicUrl?: string, vikunjaConfigured?: boolean }} [config]
 */
export function mountNotes(root, config = {}) {
  root.replaceChildren();

  const url = String(config.vikunjaPublicUrl || '').trim();
  if (!url) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Vikunja is not configured.';
    root.append(p);
    return;
  }

  const a = document.createElement('a');
  a.className = 'notes-link';
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Open Vikunja';
  a.title = 'Open Vikunja in a new tab';

  const hint = document.createElement('p');
  hint.className = 'notes-link__hint muted';
  hint.textContent = 'Full task lists, projects, and notes in Vikunja.';

  root.append(a, hint);
}
