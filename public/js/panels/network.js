/**
 * Network — personal CRM for friends and business contacts.
 * @param {HTMLElement | null} root
 */
export function mountNetwork(root) {
  if (!root) return;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'network-app';
  wrap.innerHTML = '<p class="muted">Loading contacts…</p>';
  root.append(wrap);

  // Full UI is attached after API modules land; this stub is replaced in network-ui step.
  // Cache-bust query so avatar clear-button removals always land after rebuilds.
  import('./network-ui.js?v=cols-persist-1')
    .then(({ mountNetworkUi }) => mountNetworkUi(wrap))
    .catch((e) => {
      console.error('Network UI mount failed:', e);
      wrap.replaceChildren();
      const err = document.createElement('p');
      err.className = 'muted';
      err.textContent = 'Could not load Network.';
      wrap.append(err);
    });
}
