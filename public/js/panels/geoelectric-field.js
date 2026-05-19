const POLL_MS = 15 * 60 * 1000;

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
  card.classList.toggle('sky-sidebar__card--geoelectric-off', !show);
  const img = mount.querySelector('.geoelectric-field__img');
  const cap = mount.querySelector('.geoelectric-field__caption');
  const status = mount.querySelector('.geoelectric-field__status');
  if (!show) {
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
    if (cap) cap.hidden = true;
    if (status) status.hidden = true;
    mount._geoelectricStormActive = false;
    return;
  }
  mount._geoelectricStormActive = true;
}

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} mount
 * @param {object} data
 */
function applyPayload(card, mount, data) {
  const img = mount.querySelector('.geoelectric-field__img');
  const cap = mount.querySelector('.geoelectric-field__caption');
  const status = mount.querySelector('.geoelectric-field__status');
  if (!img || !cap || !status) return;

  if (!data?.ok || data.disabled || !stormGte2(data)) {
    setSectionVisible(card, mount, false);
    return;
  }

  const src = typeof data.imageSrc === 'string' ? data.imageSrc : data.imageUrl;
  if (!src) {
    setSectionVisible(card, mount, false);
    return;
  }

  setSectionVisible(card, mount, true);

  const stormLabel =
    typeof data.caption === 'string' && data.caption.trim()
      ? data.caption.trim()
      : data.storm?.label || 'Geomagnetic storm';
  const refreshed =
    typeof data.refreshedAt === 'number'
      ? new Date(data.refreshedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
  cap.textContent = refreshed
    ? `${stormLabel} · map updated ${refreshed}`
    : stormLabel;

  const showMap = () => {
    status.hidden = true;
    img.hidden = false;
    cap.hidden = false;
  };

  if (img.getAttribute('src') === src && img.complete && img.naturalWidth > 0) {
    showMap();
    return;
  }

  status.hidden = false;
  status.textContent = 'Loading geoelectric map…';
  img.hidden = true;
  cap.hidden = true;

  img.onload = () => showMap();
  img.onerror = () => {
    if (!mount._geoelectricStormActive) {
      setSectionVisible(card, mount, false);
      return;
    }
    status.hidden = false;
    status.textContent = 'Geoelectric map image failed to load.';
    img.hidden = true;
    cap.hidden = true;
  };

  if (img.getAttribute('src') !== src) {
    img.src = src;
  } else if (img.complete && img.naturalWidth > 0) {
    showMap();
  }
}

/**
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} mount
 */
export function mountGeoelectricField(card, mount) {
  if (!card || !mount) return;

  mount.className = 'geoelectric-field';
  mount.replaceChildren();

  const frameWrap = document.createElement('div');
  frameWrap.className = 'geoelectric-field__frame';

  const img = document.createElement('img');
  img.className = 'geoelectric-field__img';
  img.alt = 'NOAA 1-minute geoelectric field map for the continental United States';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.hidden = true;

  const cap = document.createElement('p');
  cap.className = 'geoelectric-field__caption';
  cap.hidden = true;

  const status = document.createElement('p');
  status.className = 'geoelectric-field__status';
  status.hidden = true;

  frameWrap.append(img);
  mount.append(frameWrap, cap, status);

  let pollTimer = null;

  async function refresh() {
    try {
      const r = await fetch('/api/geoelectric-field', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
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
  };
}
