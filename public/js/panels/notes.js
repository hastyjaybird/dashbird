export async function mountNotes(root) {
  root.replaceChildren();
  const r = await fetch('/data/notes.md', { cache: 'no-store' });
  if (!r.ok) {
    root.innerHTML = '<p class="muted">Could not load notes.</p>';
    return;
  }
  const text = await r.text();
  const pre = document.createElement('pre');
  pre.textContent = text.trim() || '(empty — edit public/data/notes.md)';
  root.appendChild(pre);
}
