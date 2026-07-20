/**
 * Kīlauea summit livestream card — cycles USGS V1/V2/V3 YouTube cameras.
 *
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} mount
 */
export function mountKilaueaLivestream(card, mount) {
  if (!card || !mount) return;

  const STORAGE_KEY = 'dashbird-kilauea-live-camera';

  let cameras = [];
  let index = 0;
  /** @type {HTMLIFrameElement | null} */
  let iframe = null;
  /** @type {HTMLElement | null} */
  let labelEl = null;
  /** @type {HTMLElement | null} */
  let counterEl = null;
  /** @type {HTMLButtonElement | null} */
  let arrowPrev = null;
  /** @type {HTMLButtonElement | null} */
  let arrowNext = null;

  function readSavedCameraId() {
    try {
      return String(localStorage.getItem(STORAGE_KEY) || '').trim();
    } catch {
      return '';
    }
  }

  function writeSavedCameraId(id) {
    const key = String(id || '').trim();
    if (!key) return;
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      /* ignore quota / private mode */
    }
  }

  function indexForSavedCamera() {
    const saved = readSavedCameraId();
    if (!saved || !cameras.length) return 0;
    const found = cameras.findIndex((c) => c?.id === saved);
    return found >= 0 ? found : 0;
  }

  function setVisible(show) {
    card.hidden = !show;
  }

  function paintCamera() {
    if (!cameras.length || !iframe) return;
    const cam = cameras[index];
    if (!cam) return;
    iframe.src = cam.embedUrl;
    iframe.title = `Kīlauea livestream — ${cam.label}`;
    if (labelEl) labelEl.textContent = cam.label;
    if (counterEl) counterEl.textContent = `${index + 1} / ${cameras.length}`;
    if (cam.id) writeSavedCameraId(cam.id);
  }

  function step(delta) {
    if (cameras.length < 2) return;
    index = (index + delta + cameras.length) % cameras.length;
    paintCamera();
  }

  // Overlay arrows (mobile) only make sense with more than one camera.
  function syncArrows() {
    const multi = cameras.length > 1;
    if (arrowPrev) arrowPrev.hidden = !multi;
    if (arrowNext) arrowNext.hidden = !multi;
  }

  function buildUi() {
    mount.replaceChildren();
    mount.className = 'sky-sidebar__card-body sky-sidebar__card-body--kilauea-live kilauea-live';

    const frameWrap = document.createElement('div');
    frameWrap.className = 'kilauea-live__frame-wrap';

    iframe = document.createElement('iframe');
    iframe.className = 'kilauea-live__iframe';
    iframe.loading = 'lazy';
    iframe.allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    frameWrap.appendChild(iframe);

    // Mobile-only overlay arrows on the camera view (CSS reveals them ≤900px).
    arrowPrev = document.createElement('button');
    arrowPrev.type = 'button';
    arrowPrev.className = 'kilauea-live__arrow kilauea-live__arrow--prev';
    arrowPrev.setAttribute('aria-label', 'Previous Kīlauea camera');
    arrowPrev.textContent = '‹';
    arrowPrev.hidden = true;
    arrowPrev.addEventListener('click', () => step(-1));

    arrowNext = document.createElement('button');
    arrowNext.type = 'button';
    arrowNext.className = 'kilauea-live__arrow kilauea-live__arrow--next';
    arrowNext.setAttribute('aria-label', 'Next Kīlauea camera');
    arrowNext.textContent = '›';
    arrowNext.hidden = true;
    arrowNext.addEventListener('click', () => step(1));

    frameWrap.append(arrowPrev, arrowNext);

    const meta = document.createElement('div');
    meta.className = 'kilauea-live__meta';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'kilauea-live__nav kilauea-live__nav--prev';
    prev.setAttribute('aria-label', 'Previous Kīlauea camera');
    prev.textContent = '‹';
    prev.addEventListener('click', () => step(-1));

    labelEl = document.createElement('span');
    labelEl.className = 'kilauea-live__label';

    counterEl = document.createElement('span');
    counterEl.className = 'kilauea-live__counter';

    const publisher = document.createElement('a');
    publisher.className = 'kilauea-live__publisher';
    publisher.href = 'https://www.usgs.gov/volcanoes/kilauea/summit-webcams';
    publisher.target = '_blank';
    publisher.rel = 'noopener noreferrer';
    publisher.title = 'USGS Hawaiian Volcano Observatory summit webcams';
    publisher.setAttribute('aria-label', 'USGS summit webcams');

    const publisherImg = document.createElement('img');
    publisherImg.className = 'kilauea-live__publisher-icon';
    publisherImg.src = '/assets/usgs-mark.svg';
    publisherImg.alt = 'USGS';
    publisherImg.decoding = 'async';
    publisherImg.loading = 'lazy';
    publisher.appendChild(publisherImg);

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'kilauea-live__nav kilauea-live__nav--next';
    next.setAttribute('aria-label', 'Next Kīlauea camera');
    next.textContent = '›';
    next.addEventListener('click', () => step(1));

    meta.append(prev, labelEl, counterEl, publisher, next);
    mount.append(frameWrap, meta);
  }

  buildUi();

  fetch('/api/dashboard-kilauea', { cache: 'no-store' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`http_${r.status}`);
      return r.json();
    })
    .then((j) => {
      if (!j?.ok || j.disabled) {
        setVisible(false);
        return;
      }
      cameras = Array.isArray(j.cameras) ? j.cameras.filter((c) => c?.embedUrl) : [];
      if (!cameras.length) {
        setVisible(false);
        return;
      }
      index = indexForSavedCamera();
      paintCamera();
      syncArrows();
      setVisible(true);
    })
    .catch(() => {
      setVisible(false);
    });
}
