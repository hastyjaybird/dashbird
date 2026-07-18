/**
 * Mobile topbar: non-commercial aircraft icon when live GPS is active.
 * Tap opens a popup describing nearby aircraft (ADS-B via /api/aircraft-nearby).
 */
import { subscribeDevicePlace, devicePlaceQueryString } from './device-location.js';

const POLL_MS = 90_000;
const SKY_AIRCRAFT_ICON = '/assets/sky/aircraft-strip.png';
const SKY_HELICOPTER_ICON = '/assets/sky/medical-helicopter-strip.png';

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

/** @type {HTMLElement | null} */
let mountEl = null;

/** @type {HTMLButtonElement | null} */
let iconBtn = null;

/** @type {object[]} */
let nearbyAircraft = [];

/** @type {HTMLElement | null} */
let popupBackdrop = null;

/** @type {(e: KeyboardEvent) => void | null} */
let popupKeyHandler = null;

/**
 * @param {number | null | undefined} trackDeg
 * @returns {'N' | 'E' | 'S' | 'W' | null}
 */
function headingCompass(trackDeg) {
  if (!Number.isFinite(Number(trackDeg))) return null;
  const d = ((Number(trackDeg) % 360) + 360) % 360;
  const labels = ['N', 'E', 'S', 'W'];
  return labels[Math.floor((d + 45) / 90) % 4];
}

/**
 * @param {object} ac
 */
function aircraftTitle(ac) {
  if (ac.anonymousOrTisb || String(ac.label || '') === 'Unidentified') {
    return 'Unidentified aircraft';
  }
  const cs = String(ac.callsign || ac.nNumber || '').trim().toUpperCase();
  if (cs) return cs;
  const cat =
    {
      police: 'Police aircraft',
      fire: 'Fire aircraft',
      medical: 'Medical aircraft',
      news: 'News aircraft',
      government: 'Government aircraft',
      private: 'General aviation',
    }[ac.category] || 'Aircraft nearby';
  return cat;
}

/**
 * @param {object} ac
 */
function aircraftDescription(ac) {
  const bits = [];
  const label = String(ac.label || '').trim();
  if (label && !['Aircraft', 'Light aircraft', 'Rotorcraft', 'Unidentified'].includes(label)) {
    bits.push(label);
  }
  if (ac.medicalHelicopter) bits.push('Medical helicopter');
  else if (ac.helicopter) bits.push('Helicopter');
  if (ac.operator) bits.push(String(ac.operator).trim());
  if (ac.equipment) bits.push(String(ac.equipment).trim());
  if (Number.isFinite(Number(ac.distMi))) bits.push(`${ac.distMi} mi away`);
  if (Number.isFinite(Number(ac.altFt))) {
    const ft = Math.round(Number(ac.altFt));
    bits.push(ft > 800 ? `${Math.round((ft / 5280) * 10) / 10} mi altitude` : `${ft.toLocaleString('en-US')} ft`);
  }
  const heading = headingCompass(ac.trackDeg);
  if (heading) bits.push(`heading ${heading}`);
  if (ac.nNumber) bits.push(String(ac.nNumber).trim().toUpperCase());
  if (ac.notes) bits.push(String(ac.notes).trim());
  return bits.length ? bits.join(' · ') : 'Non-commercial aircraft nearby';
}

/**
 * @param {object} ac
 */
function aircraftIconSrc(ac) {
  if (ac.medicalHelicopter || ac.helicopter) return SKY_HELICOPTER_ICON;
  return SKY_AIRCRAFT_ICON;
}

/**
 * @param {object} ac
 */
function aircraftIconClass(ac) {
  if (ac.medicalHelicopter || ac.helicopter) return 'mobile-aircraft-header__icon--heli';
  return 'mobile-aircraft-header__icon--plane';
}

function closePopup() {
  if (popupKeyHandler) {
    document.removeEventListener('keydown', popupKeyHandler);
    popupKeyHandler = null;
  }
  popupBackdrop?.remove();
  popupBackdrop = null;
  iconBtn?.setAttribute('aria-expanded', 'false');
}

function openPopup() {
  if (!nearbyAircraft.length) return;
  closePopup();

  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-aircraft-header__backdrop';
  const shell = document.createElement('div');
  shell.className = 'mobile-aircraft-header__dialog';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', 'Aircraft nearby');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mobile-aircraft-header__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>';
  closeBtn.addEventListener('click', closePopup);

  const list = document.createElement('div');
  list.className = 'mobile-aircraft-header__list';

  for (const ac of nearbyAircraft) {
    const row = document.createElement('div');
    row.className = 'mobile-aircraft-header__row';

    const glyph = document.createElement('span');
    glyph.className = `mobile-aircraft-header__row-icon ${aircraftIconClass(ac)}`;
    const img = document.createElement('img');
    img.src = aircraftIconSrc(ac);
    img.alt = '';
    img.decoding = 'async';
    glyph.append(img);

    const text = document.createElement('div');
    text.className = 'mobile-aircraft-header__row-text';
    const title = document.createElement('div');
    title.className = 'mobile-aircraft-header__row-title';
    title.textContent = aircraftTitle(ac);
    const desc = document.createElement('div');
    desc.className = 'mobile-aircraft-header__row-desc';
    desc.textContent = aircraftDescription(ac);
    text.append(title, desc);
    row.append(glyph, text);
    list.append(row);
  }

  shell.append(closeBtn, list);
  backdrop.append(shell);
  document.body.append(backdrop);
  popupBackdrop = backdrop;
  iconBtn?.setAttribute('aria-expanded', 'true');

  popupKeyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    }
  };
  document.addEventListener('keydown', popupKeyHandler);
}

function renderIcon() {
  if (!mountEl || !iconBtn) return;

  if (!nearbyAircraft.length) {
    mountEl.hidden = true;
    iconBtn.hidden = true;
    return;
  }

  const primary = nearbyAircraft[0];
  const img = iconBtn.querySelector('img');
  if (img) {
    img.src = aircraftIconSrc(primary);
    img.className = aircraftIconClass(primary);
  }
  iconBtn.title = nearbyAircraft.length === 1
    ? aircraftDescription(primary)
    : `${nearbyAircraft.length} aircraft nearby`;
  iconBtn.setAttribute(
    'aria-label',
    nearbyAircraft.length === 1
      ? `Aircraft nearby: ${aircraftTitle(primary)}`
      : `${nearbyAircraft.length} aircraft nearby`,
  );

  mountEl.hidden = false;
  iconBtn.hidden = false;
}

async function refreshAircraft(useDeviceCoords) {
  if (!useDeviceCoords) {
    nearbyAircraft = [];
    renderIcon();
    return;
  }

  const qs = devicePlaceQueryString({ includeLabel: false });
  if (!qs) {
    nearbyAircraft = [];
    renderIcon();
    return;
  }

  try {
    const r = await fetch(`/api/aircraft-nearby${qs}`);
    if (!r.ok) return;
    const j = await r.json();
    if (!j?.ok || j.disabled || j.geocodeError || j.fetchError) {
      nearbyAircraft = [];
    } else {
      nearbyAircraft = Array.isArray(j.aircraft) ? j.aircraft.slice(0, 5) : [];
    }
    renderIcon();
  } catch {
    /* keep last snapshot */
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * @param {import('./device-location.js').DevicePlace} place
 */
function onPlaceChange(place) {
  const useDevice = place?.source === 'device';
  if (!useDevice) {
    stopPolling();
    nearbyAircraft = [];
    renderIcon();
    closePopup();
    return;
  }

  void refreshAircraft(true);
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void refreshAircraft(true);
    }, POLL_MS);
  }
}

/**
 * @param {HTMLElement | null} root
 */
export function mountMobileAircraftHeader(root) {
  if (!root) return;
  mountEl = root;
  mountEl.hidden = true;
  mountEl.className = 'topbar__aircraft mobile-aircraft-header';

  iconBtn = document.createElement('button');
  iconBtn.type = 'button';
  iconBtn.className = 'mobile-aircraft-header__btn';
  iconBtn.hidden = true;
  iconBtn.setAttribute('aria-expanded', 'false');
  const img = document.createElement('img');
  img.src = SKY_AIRCRAFT_ICON;
  img.alt = '';
  img.decoding = 'async';
  iconBtn.append(img);
  iconBtn.addEventListener('click', () => {
    if (popupBackdrop) closePopup();
    else openPopup();
  });

  mountEl.append(iconBtn);
  subscribeDevicePlace(onPlaceChange);
}
