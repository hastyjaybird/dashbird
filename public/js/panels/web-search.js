const STORAGE_KEY = 'dashbird-search-engine';
export const WEB_SEARCH_INPUT_ID = 'web-search-input';

/**
 * Focus the web search field when the main dashboard is visible.
 * @param {HTMLElement | null} [root]
 */
export function focusWebSearchInput(root = document.getElementById('mount-web-search')) {
  const settingsPage = document.getElementById('page-settings');
  if (settingsPage && !settingsPage.hidden) return;

  const input =
    (root instanceof HTMLElement ? root.querySelector('.web-search__input') : null) ||
    document.getElementById(WEB_SEARCH_INPUT_ID);
  if (input instanceof HTMLInputElement) {
    input.focus({ preventScroll: true });
  }
}

const ENGINES = {
  brave: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
};

/** @param {string} html */
function svgFromString(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const el = t.content.firstElementChild;
  if (!el || !(el instanceof SVGElement)) return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('class', 'web-search__icon');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** @param {string} src */
function imgIcon(src) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.decoding = 'async';
  img.className = 'web-search__icon';
  img.setAttribute('aria-hidden', 'true');
  return img;
}

const ICON_GOOGLE = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;

const ENGINE_ORDER = /** @type {const} */ (['brave', 'duckduckgo', 'google']);

/** @typedef {{ label: string, icon?: string, iconSrc?: string }} EngineMeta */

/** @type {Record<string, EngineMeta>} */
const ENGINE_META = {
  brave: { label: 'Brave', iconSrc: '/assets/search-brave.png' },
  google: { label: 'Google', icon: ICON_GOOGLE },
  duckduckgo: { label: 'DuckDuckGo', iconSrc: '/assets/search-duckduckgo.png' },
};

/**
 * Wire search form (static HTML in index or built here). Idempotent.
 * @param {HTMLElement} root
 */
export function enhanceWebSearch(root) {
  if (!root || root.dataset.searchEnhanced === '1') return;

  let form = root.querySelector('form.web-search');
  let input = form?.querySelector('input.web-search__input');
  let enginesWrap = form?.querySelector('.web-search__engines');

  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
    root.replaceChildren();

    form = document.createElement('form');
    form.className = 'web-search';
    form.setAttribute('autocomplete', 'off');

    input = document.createElement('input');
    input.id = WEB_SEARCH_INPUT_ID;
    input.type = 'search';
    input.name = 'q';
    input.placeholder = 'Search the web…';
    input.className = 'web-search__input';
    input.setAttribute('aria-label', 'Search query');

    enginesWrap = document.createElement("div");
    enginesWrap.className = 'web-search__engines';
    enginesWrap.setAttribute('role', 'group');
    enginesWrap.setAttribute('aria-label', 'Search engine');

    for (const id of ENGINE_ORDER) {
      const meta = ENGINE_META[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'web-search__engine-btn';
      btn.dataset.engine = id;
      btn.setAttribute('aria-label', meta.label);
      btn.append(meta.iconSrc ? imgIcon(meta.iconSrc) : svgFromString(/** @type {string} */ (meta.icon)));
      enginesWrap.append(btn);
    }

    form.append(input, enginesWrap);
    root.append(form);
  }

  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) return;
  if (!(enginesWrap instanceof HTMLElement)) return;

  const saved = localStorage.getItem(STORAGE_KEY);
  let current = saved && saved in ENGINES ? saved : 'brave';

  /** @type {Record<string, HTMLButtonElement>} */
  const engineBtns = {};
  for (const btn of enginesWrap.querySelectorAll('button[data-engine]')) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    const id = btn.dataset.engine;
    if (id) engineBtns[id] = btn;
  }

  function setEngine(id) {
    if (!(id in ENGINES)) return;
    current = id;
    localStorage.setItem(STORAGE_KEY, current);
    for (const [key, btn] of Object.entries(engineBtns)) {
      const on = key === current;
      btn.classList.toggle('web-search__engine-btn--active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  for (const [id, btn] of Object.entries(engineBtns)) {
    btn.addEventListener('click', () => setEngine(id));
  }

  setEngine(current);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const url = ENGINES[current](q);
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  root.dataset.searchEnhanced = '1';
  focusWebSearchInput(root);
}

/** @param {HTMLElement} root */
export function mountWebSearch(root) {
  enhanceWebSearch(root);
}
