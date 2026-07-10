import { focusWebSearchInput } from './web-search.js';

const LS_PAGE_KEY = 'dashbirdPage';

/** @typedef {'main' | 'house-hunter' | 'settings'} DashbirdPage */

/**
 * @param {{ onChange: (page: DashbirdPage) => void }} opts
 */
export function mountPageTabs(mountEl, opts) {
  if (!mountEl) return;

  mountEl.replaceChildren();
  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'topbar__tabs';
  tabsWrap.setAttribute('role', 'tablist');
  tabsWrap.setAttribute('aria-label', 'Dashboard pages');

  /** @type {{ id: DashbirdPage, label: string, el: HTMLButtonElement }[]} */
  const tabs = [
    { id: 'main', label: 'Main', el: document.createElement('button') },
    { id: 'house-hunter', label: 'House Hunter', el: document.createElement('button') },
    { id: 'settings', label: 'Settings', el: document.createElement('button') },
  ];

  for (const tab of tabs) {
    tab.el.type = 'button';
    tab.el.className = 'topbar__tab';
    tab.el.id = `page-tab-${tab.id}`;
    tab.el.setAttribute('role', 'tab');
    tab.el.textContent = tab.label;
    tab.el.addEventListener('click', () => setPage(tab.id));
    tabsWrap.append(tab.el);
  }

  mountEl.append(tabsWrap);

  /** @returns {DashbirdPage} */
  function loadPage() {
    const p = localStorage.getItem(LS_PAGE_KEY);
    if (p === 'settings' || p === 'house-hunter') return p;
    return 'main';
  }

  /** @param {DashbirdPage} page */
  function setPage(page) {
    for (const tab of tabs) {
      const active = tab.id === page;
      tab.el.classList.toggle('topbar__tab--active', active);
      tab.el.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    localStorage.setItem(LS_PAGE_KEY, page);
    document.body.classList.toggle('dashy--page-settings', page === 'settings');
    document.body.classList.toggle('dashy--page-house-hunter', page === 'house-hunter');
    opts.onChange(page);
    if (page === 'main') focusWebSearchInput();
  }

  setPage(loadPage());
}
