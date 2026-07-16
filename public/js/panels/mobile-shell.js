const MOBILE_TAB_KEY = 'dashbirdMobileTab';

/**
 * @returns {'network' | 'events' | 'groups' | 'tasks'}
 */
function loadTab() {
  try {
    const t = localStorage.getItem(MOBILE_TAB_KEY);
    if (t === 'network' || t === 'events' || t === 'groups' || t === 'tasks') return t;
  } catch {
    /* ignore */
  }
  return 'events';
}

/**
 * @param {'network' | 'events' | 'groups' | 'tasks'} tab
 */
function saveTab(tab) {
  try {
    localStorage.setItem(MOBILE_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

/**
 * Lean mobile shell: Events | Network | Groups | Tasks.
 * @param {{
 *   tabsRoot?: HTMLElement | null,
 *   networkRoot?: HTMLElement | null,
 *   eventsRoot?: HTMLElement | null,
 *   groupsRoot?: HTMLElement | null,
 *   tasksRoot?: HTMLElement | null,
 * }} mounts
 */
export function mountMobileShell(mounts = {}) {
  const page = document.getElementById('page-mobile');
  if (page) page.hidden = false;

  const tabsRoot = mounts.tabsRoot || document.getElementById('mount-mobile-tabs');
  const networkRoot = mounts.networkRoot || document.getElementById('mount-mobile-network');
  const eventsRoot = mounts.eventsRoot || document.getElementById('mount-mobile-events');
  const groupsRoot = mounts.groupsRoot || document.getElementById('mount-mobile-groups');
  const tasksRoot = mounts.tasksRoot || document.getElementById('mount-mobile-tasks');
  if (!tabsRoot || !networkRoot || !eventsRoot || !groupsRoot || !tasksRoot) return;

  tabsRoot.replaceChildren();
  tabsRoot.classList.add('mobile-shell__tabs');

  let tab = loadTab();
  let networkMounted = false;
  let eventsMounted = false;
  let groupsMounted = false;
  let tasksMounted = false;

  const eventsBtn = document.createElement('button');
  eventsBtn.type = 'button';
  eventsBtn.className = 'mobile-shell__tab';
  eventsBtn.textContent = 'Events';

  const networkBtn = document.createElement('button');
  networkBtn.type = 'button';
  networkBtn.className = 'mobile-shell__tab';
  networkBtn.textContent = 'Network';

  const groupsBtn = document.createElement('button');
  groupsBtn.type = 'button';
  groupsBtn.className = 'mobile-shell__tab';
  groupsBtn.textContent = 'Groups';

  const tasksBtn = document.createElement('button');
  tasksBtn.type = 'button';
  tasksBtn.className = 'mobile-shell__tab';
  tasksBtn.textContent = 'Tasks';

  tabsRoot.append(eventsBtn, networkBtn, groupsBtn, tasksBtn);

  function syncTabs() {
    networkBtn.classList.toggle('mobile-shell__tab--active', tab === 'network');
    eventsBtn.classList.toggle('mobile-shell__tab--active', tab === 'events');
    groupsBtn.classList.toggle('mobile-shell__tab--active', tab === 'groups');
    tasksBtn.classList.toggle('mobile-shell__tab--active', tab === 'tasks');
    networkBtn.setAttribute('aria-pressed', tab === 'network' ? 'true' : 'false');
    eventsBtn.setAttribute('aria-pressed', tab === 'events' ? 'true' : 'false');
    groupsBtn.setAttribute('aria-pressed', tab === 'groups' ? 'true' : 'false');
    tasksBtn.setAttribute('aria-pressed', tab === 'tasks' ? 'true' : 'false');
    networkRoot.hidden = tab !== 'network';
    eventsRoot.hidden = tab !== 'events';
    groupsRoot.hidden = tab !== 'groups';
    tasksRoot.hidden = tab !== 'tasks';
  }

  async function ensureNetwork() {
    if (networkMounted) return;
    networkMounted = true;
    networkRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading contacts…';
    networkRoot.append(status);
    try {
      const { mountNetworkContactsMobile } = await import('./network-contacts-mobile.js');
      mountNetworkContactsMobile(networkRoot);
    } catch (e) {
      status.textContent = `Contacts failed: ${e?.message || e}`;
      networkMounted = false;
    }
  }

  async function ensureEvents() {
    if (eventsMounted) return;
    eventsMounted = true;
    eventsRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading events…';
    eventsRoot.append(status);
    try {
      const { mountEventsFinderMobile } = await import('./events-finder-mobile.js');
      mountEventsFinderMobile(eventsRoot);
    } catch (e) {
      status.textContent = `Events failed: ${e?.message || e}`;
      eventsMounted = false;
    }
  }

  async function ensureGroups() {
    if (groupsMounted) return;
    groupsMounted = true;
    groupsRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading groups…';
    groupsRoot.append(status);
    try {
      const { mountNetworkGroupsMobile } = await import('./network-groups-mobile.js');
      mountNetworkGroupsMobile(groupsRoot);
    } catch (e) {
      status.textContent = `Groups failed: ${e?.message || e}`;
      groupsMounted = false;
    }
  }

  async function ensureTasks() {
    if (tasksMounted) return;
    tasksMounted = true;
    tasksRoot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = 'Loading tasks…';
    tasksRoot.append(status);
    try {
      const [{ mountTasksMobile }, config] = await Promise.all([
        import('./tasks-mobile.js'),
        fetch('/api/config', { cache: 'no-store' })
          .then((r) => r.json())
          .catch(() => ({})),
      ]);
      mountTasksMobile(tasksRoot, config && typeof config === 'object' ? config : {});
    } catch (e) {
      status.textContent = `Tasks failed: ${e?.message || e}`;
      tasksMounted = false;
    }
  }

  /**
   * @param {'network' | 'events' | 'groups' | 'tasks'} next
   */
  function setTab(next) {
    tab = next;
    saveTab(tab);
    syncTabs();
    if (tab === 'network') void ensureNetwork();
    else if (tab === 'groups') void ensureGroups();
    else if (tab === 'tasks') void ensureTasks();
    else void ensureEvents();
  }

  networkBtn.addEventListener('click', () => setTab('network'));
  eventsBtn.addEventListener('click', () => setTab('events'));
  groupsBtn.addEventListener('click', () => setTab('groups'));
  tasksBtn.addEventListener('click', () => setTab('tasks'));

  setTab(tab);
}
