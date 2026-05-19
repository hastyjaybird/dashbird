const POLL_MS = 90 * 1000;

/**
 * @param {object} data
 */
function stormGte2(data) {
  if (data?.stormGte2 === true) return true;
  if (data?.stormGte2 === false) return false;
  if (data?.stormActive !== true) return false;
  const g = Number(data?.storm?.g);
  return Number.isFinite(g) && g >= 2;
}

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} mount
 * @param {boolean} show
 */
function setSectionVisible(card, mount, show) {
  card.hidden = !show;
  card.classList.toggle('sky-sidebar__card--magnetosphere-off', !show);
  const img = mount.querySelector('.magnetosphere__img');
  const cap = mount.querySelector('.magnetosphere__caption');
  const status = mount.querySelector('.magnetosphere__status');
  if (!show) {
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
    if (cap) cap.hidden = true;
    if (status) status.hidden = true;
    mount._magFrames = null;
    mount._magPlayer?.stop?.();
    mount._magPlayer = null;
    mount._magFp = null;
    return;
  }
}

/**
 * @param {HTMLElement} mount
 * @param {HTMLElement} card
 * @param {object} data
 */
function applyPayload(card, mount, data) {
  const img = mount.querySelector('.magnetosphere__img');
  const cap = mount.querySelector('.magnetosphere__caption');
  const status = mount.querySelector('.magnetosphere__status');
  if (!img || !cap || !status) return;

  if (!data?.ok || data.disabled || !stormGte2(data)) {
    setSectionVisible(card, mount, false);
    return;
  }

  const frames = Array.isArray(data.frames) ? data.frames : [];
  setSectionVisible(card, mount, true);

  if (!frames.length) {
    status.hidden = false;
    status.textContent = 'Loading magnetosphere…';
    img.hidden = true;
    cap.hidden = true;
    mount._magPlayer?.stop?.();
    mount._magPlayer = null;
    return;
  }

  status.hidden = true;
  img.hidden = false;
  cap.hidden = true;

  const urls = frames.map((f) => f.url).filter(Boolean);
  const fp = `${data.runId}|${data.parameter}|${urls.length}|${urls.at(-1)}`;
  if (mount._magFp === fp && mount._magPlayer) return;

  mount._magFp = fp;
  mount._magFrames = urls;
  mount._magPlayer?.stop?.();
  mount._magPlayer = createFramePlayer(img, urls, Number(data.frameMs) || 450);
  mount._magPlayer.start();
}

/**
 * @param {HTMLImageElement} img
 * @param {string[]} urls
 * @param {number} frameMs
 */
function createFramePlayer(img, urls, frameMs) {
  let idx = 0;
  let timer = null;
  /** @type {HTMLImageElement[]} */
  const preloaded = [];

  function preload() {
    for (const url of urls) {
      const el = new Image();
      el.decoding = 'async';
      el.src = url;
      preloaded.push(el);
    }
  }

  function show(i) {
    const url = urls[i % urls.length];
    if (url) img.src = url;
  }

  function tick() {
    idx = (idx + 1) % urls.length;
    show(idx);
    timer = setTimeout(tick, frameMs);
  }

  function start() {
    stop();
    if (!urls.length) return;
    preload();
    show(0);
    timer = setTimeout(tick, frameMs);
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { start, stop };
}

/**
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} mount
 */
export function mountMagnetosphere(card, mount) {
  if (!mount || !card) return;

  mount.replaceChildren();
  mount.className = 'magnetosphere';

  const frameWrap = document.createElement('div');
  frameWrap.className = 'magnetosphere__frame';

  const img = document.createElement('img');
  img.className = 'magnetosphere__img';
  img.alt = 'Geospace magnetosphere cut-plane animation';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.hidden = true;

  frameWrap.append(img);

  const cap = document.createElement('p');
  cap.className = 'magnetosphere__caption';
  cap.hidden = true;

  const status = document.createElement('p');
  status.className = 'magnetosphere__status';
  status.hidden = true;

  mount.append(frameWrap, cap, status);

  let pollTimer = null;

  async function refresh() {
    try {
      const r = await fetch('/api/magnetosphere', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok && data.ok !== true) throw new Error(data.error || `HTTP ${r.status}`);
      applyPayload(card, mount, data);
    } catch {
      setSectionVisible(card, mount, false);
    }
  }

  setSectionVisible(card, mount, false);
  refresh();
  pollTimer = setInterval(refresh, POLL_MS);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    mount._magPlayer?.stop?.();
    mount._magPlayer = null;
  };
}
