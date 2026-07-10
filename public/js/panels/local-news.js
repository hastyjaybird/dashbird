/**
 * Personal / local news (v2 stub) — feed that learns what you do and don’t want to see.
 * @param {HTMLElement | null} root
 */
export function mountLocalNews(root) {
  if (!root) return;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'v2-stub';

  const msg = document.createElement('p');
  msg.className = 'muted';
  msg.textContent = 'Coming soon — personal/local news feed with preference learning.';

  wrap.append(msg);
  root.append(wrap);
}
