import { focusWebSearchInput } from './web-search.js';

const LS_PAGE_KEY = 'dashbirdPage';

/**
 * @param {{ onChange: (page: 'main' | 'settings') => void }} opts
 */
export function mountPageTabs(mountEl, opts) {
  if (!mountEl) return;

  mountEl.replaceChildren();
  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'topbar__tabs';
  tabsWrap.setAttribute('role', 'tablist');
  tabsWrap.setAttribute('aria-label', 'Dashboard pages');

  const tabMain = document.createElement('button');
  tabMain.type = 'button';
  tabMain.className = 'topbar__tab';
  tabMain.id = 'page-tab-main';
  tabMain.setAttribute('role', 'tab');
  tabMain.textContent = 'Main';

  const tabSettings = document.createElement('button');
  tabSettings.type = 'button';
  tabSettings.className = 'topbar__tab';
  tabSettings.id = 'page-tab-settings';
  tabSettings.setAttribute('role', 'tab');
  tabSettings.textContent = 'Settings';

  tabsWrap.append(tabMain, tabSettings);
  mountEl.append(tabsWrap);

  function loadPage() {
    const p = localStorage.getItem(LS_PAGE_KEY);
    return p === 'settings' ? 'settings' : 'main';
  }

  function setPage(page) {
    const isSettings = page === 'settings';
    tabMain.classList.toggle('topbar__tab--active', !isSettings);
    tabSettings.classList.toggle('topbar__tab--active', isSettings);
    tabMain.setAttribute('aria-selected', isSettings ? 'false' : 'true');
    tabSettings.setAttribute('aria-selected', isSettings ? 'true' : 'false');
    localStorage.setItem(LS_PAGE_KEY, isSettings ? 'settings' : 'main');
    document.body.classList.toggle('dashy--page-settings', isSettings);
    opts.onChange(isSettings ? 'settings' : 'main');
    if (!isSettings) focusWebSearchInput();
  }

  tabMain.addEventListener('click', () => setPage('main'));
  tabSettings.addEventListener('click', () => setPage('settings'));
  setPage(loadPage());
}
