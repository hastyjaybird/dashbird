/**
 * House Hunter (v2 stub) — match listings to a criteria doc (features, price, location).
 * Sources TBD: Redfin, Zillow, LoopNet, etc.
 * @param {HTMLElement | null} root
 */
export function mountHouseHunter(root) {
  if (!root) return;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'v2-stub';

  const msg = document.createElement('p');
  msg.className = 'muted';
  msg.textContent = 'Coming soon — criteria doc + listing sources (Redfin, Zillow, LoopNet, …).';

  wrap.append(msg);
  root.append(wrap);
}
