/**
 * Shared tooltip used by system health sidebar, chat footer, etc.
 *
 * Targets carry `dataset.healthTipName` and optionally `dataset.healthTipBody`
 * (URI-encoded UTF-8, same as prior health-sidebar conventions).
 */

/**
 * @param {Element} root
 * @param {EventTarget | null} target
 * @returns {HTMLElement | null}
 */
export function dashbirdHoverTipSrc(root, target) {
  if (!(target instanceof Element) || !(root instanceof Element)) return null;
  const hit = target.closest('[data-health-tip-name]');
  return hit instanceof HTMLElement && root.contains(hit) ? hit : null;
}

/**
 * @param {HTMLElement} tipMount
 */
export function positionDashbirdHoverTip(tipMount, clientX, clientY) {
  const pad = 12;
  let left = clientX + pad;
  let top = clientY + pad;
  const rect = tipMount.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  tipMount.style.left = `${Math.max(8, left)}px`;
  tipMount.style.top = `${Math.max(8, top)}px`;
}

/**
 * @param {HTMLElement} tipMount
 * @param {HTMLElement} src Must have dataset.healthTipName
 */
export function showDashbirdHoverTip(tipMount, clientX, clientY, src) {
  const name = src.dataset.healthTipName;
  if (!name) return;
  let body = '';
  try {
    body = src.dataset.healthTipBody ? decodeURIComponent(src.dataset.healthTipBody) : '';
  } catch {
    body = '';
  }
  tipMount.replaceChildren();
  const title = document.createElement('div');
  title.className = 'dashbird-health-tip__title';
  title.textContent = name;
  tipMount.append(title);
  if (body) {
    const detail = document.createElement('div');
    detail.className = 'dashbird-health-tip__detail';
    detail.textContent = body;
    tipMount.appendChild(detail);
  }
  tipMount.hidden = false;
  positionDashbirdHoverTip(tipMount, clientX, clientY);
}

/**
 * @param {HTMLElement} root
 * @param {HTMLElement} tipMount
 */
export function attachDashbirdHoverTip(root, tipMount) {
  root.addEventListener(
    'pointerenter',
    (e) => {
      const src = dashbirdHoverTipSrc(root, e.target);
      if (!src) return;
      showDashbirdHoverTip(tipMount, e.clientX, e.clientY, src);
    },
    true,
  );

  root.addEventListener('pointermove', (e) => {
    if (tipMount.hidden) return;
    const src = dashbirdHoverTipSrc(root, e.target);
    if (!src) {
      tipMount.hidden = true;
      return;
    }
    positionDashbirdHoverTip(tipMount, e.clientX, e.clientY);
  });

  root.addEventListener('pointerleave', (e) => {
    const rel = e.relatedTarget;
    if (rel && root.contains(rel)) return;
    tipMount.hidden = true;
  });
}
