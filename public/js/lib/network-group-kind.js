import { NETWORK_LABELS } from './network-labels.js';

/**
 * @param {object | null | undefined} g
 * @returns {'community' | 'event'}
 */
export function groupKind(g) {
  return g?.kind === 'event' ? 'event' : 'community';
}

/** Scene groups mirror contact Scene tags (`networkCircles`). */
export function isSceneGroup(g) {
  return groupKind(g) === 'community';
}

export function isEventGroup(g) {
  return groupKind(g) === 'event';
}

/**
 * @param {object | null | undefined} g
 * @returns {string}
 */
export function groupKindLabel(g) {
  return isEventGroup(g) ? NETWORK_LABELS.event : NETWORK_LABELS.scene;
}

/**
 * @param {'community' | 'event'} kind
 * @returns {string}
 */
export function groupSectionLabel(kind) {
  return kind === 'event' ? NETWORK_LABELS.events : NETWORK_LABELS.scenes;
}

const ICON_PEOPLE =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>' +
  '</svg>';

const ICON_CALENDAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/>' +
  '</svg>';

/**
 * @param {object | null | undefined} g
 * @param {string} [extraClass]
 * @returns {HTMLDivElement}
 */
export function createGroupKindIconEl(g, extraClass = '') {
  const kind = groupKind(g);
  const box = document.createElement('div');
  box.className = ['network-groups__kind-icon', extraClass].filter(Boolean).join(' ');
  box.dataset.kind = kind;
  box.title = groupKindLabel(g);
  box.setAttribute('aria-label', groupKindLabel(g));
  box.innerHTML = kind === 'event' ? ICON_CALENDAR : ICON_PEOPLE;
  return box;
}
