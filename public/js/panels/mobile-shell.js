import {
  initMobileHistory,
  pushMobileNav,
  setMobileNavApplyHandler,
  runMobileNavApply,
  isMobileNavApplying,
} from '../lib/mobile-history.js';
import { MOBILE_PANELS_V } from '../lib/mobile-panels-version.js';
import { diagnoseModuleLoad } from '../lib/module-load-diagnose.js';

const MOBILE_TAB_KEY = 'dashbirdMobileTab';

/**
 * @returns {import('../lib/mobile-history.js').MobileTab}
 */
function loadTab() {
  try {
    const t = localStorage.getItem(MOBILE_TAB_KEY);
    if (
      t === 'notes' ||
      t === 'network' ||
      t === 'events' ||
      t === 'groups' ||
      t === 'tasks' ||
      t === 'gmail'
    ) {
      return t;
    }
  } catch {
    /* ignore */
  }
  return 'notes';
}

/**
 * @param {import('../lib/mobile-history.js').MobileTab} tab
 */
function saveTab(tab) {
  try {
    localStorage.setItem(MOBILE_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

/**
 * Lean mobile shell: Notes | Tasks | Mail | Events | Contacts | Groups.
 * @param {{
 *   tabsRoot?: HTMLElement | null,
 *   notesRoot?: HTMLElement | null,
 *   networkRoot?: HTMLElement | null,
 *   eventsRoot?: HTMLElement | null,
 *   groupsRoot?: HTMLElement | null,
 *   tasksRoot?: HTMLElement | null,
 *   gmailRoot?: HTMLElement | null,
 * }} mounts
 */
export function mountMobileShell(mounts = {}) {
  const page = document.getElementById('page-mobile');
  if (page) page.hidden = false;

  const tabsRoot = mounts.tabsRoot || document.getElementById('mount-mobile-tabs');
  const notesRoot = mounts.notesRoot || document.getElementById('mount-mobile-notes');
  const networkRoot = mounts.networkRoot || document.getElementById('mount-mobile-network');
  const eventsRoot = mounts.eventsRoot || document.getElementById('mount-mobile-events');
  const groupsRoot = mounts.groupsRoot || document.getElementById('mount-mobile-groups');
  const tasksRoot = mounts.tasksRoot || document.getElementById('mount-mobile-tasks');
  const gmailRoot = mounts.gmailRoot || document.getElementById('mount-mobile-gmail');
  if (
    !tabsRoot ||
    !notesRoot ||
    !networkRoot ||
    !eventsRoot ||
    !groupsRoot ||
    !tasksRoot ||
    !gmailRoot
  ) {
    return;
  }

  tabsRoot.replaceChildren();
  tabsRoot.classList.add('mobile-shell__tabs');

  let tab = loadTab();
  let notesMounted = false;
  let networkMounted = false;
  let eventsMounted = false;
  let groupsMounted = false;
  let tasksMounted = false;
  let gmailMounted = false;

  const notesBtn = document.createElement('button');
  notesBtn.type = 'button';
  notesBtn.className = 'mobile-shell__tab mobile-shell__tab--notes';
  notesBtn.textContent = 'Notes';

  const tasksBtn = document.createElement('button');
  tasksBtn.type = 'button';
  tasksBtn.className = 'mobile-shell__tab mobile-shell__tab--tasks';
  tasksBtn.textContent = 'Tasks';

  const gmailBtn = document.createElement('button');
  gmailBtn.type = 'button';
  gmailBtn.className = 'mobile-shell__tab mobile-shell__tab--mail';
  gmailBtn.textContent = 'Mail';

  const eventsBtn = document.createElement('button');
  eventsBtn.type = 'button';
  eventsBtn.className = 'mobile-shell__tab mobile-shell__tab--events';
  eventsBtn.textContent = 'Events';

  const networkBtn = document.createElement('button');
  networkBtn.type = 'button';
  networkBtn.className = 'mobile-shell__tab mobile-shell__tab--contacts';
  networkBtn.textContent = 'Contacts';

  const groupsBtn = document.createElement('button');
  groupsBtn.type = 'button';
  groupsBtn.className = 'mobile-shell__tab mobile-shell__tab--groups';
  groupsBtn.textContent = 'Groups';

  tabsRoot.append(notesBtn, tasksBtn, gmailBtn, eventsBtn, networkBtn, groupsBtn);

  function syncTabs() {
    notesBtn.classList.toggle('mobile-shell__tab--active', tab === 'notes');
    tasksBtn.classList.toggle('mobile-shell__tab--active', tab === 'tasks');
    gmailBtn.classList.toggle('mobile-shell__tab--active', tab === 'gmail');
    eventsBtn.classList.toggle('mobile-shell__tab--active', tab === 'events');
    networkBtn.classList.toggle('mobile-shell__tab--active', tab === 'network');
    groupsBtn.classList.toggle('mobile-shell__tab--active', tab === 'groups');
    notesBtn.setAttribute('aria-pressed', tab === 'notes' ? 'true' : 'false');
    tasksBtn.setAttribute('aria-pressed', tab === 'tasks' ? 'true' : 'false');
    gmailBtn.setAttribute('aria-pressed', tab === 'gmail' ? 'true' : 'false');
    eventsBtn.setAttribute('aria-pressed', tab === 'events' ? 'true' : 'false');
    networkBtn.setAttribute('aria-pressed', tab === 'network' ? 'true' : 'false');
    groupsBtn.setAttribute('aria-pressed', tab === 'groups' ? 'true' : 'false');
    notesRoot.hidden = tab !== 'notes';
    tasksRoot.hidden = tab !== 'tasks';
    gmailRoot.hidden = tab !== 'gmail';
    eventsRoot.hidden = tab !== 'events';
    networkRoot.hidden = tab !== 'network';
    groupsRoot.hidden = tab !== 'groups';
  }

  /**
   * Mount one lazy panel, and when its module cannot load, say which file
   * broke instead of the browser's generic "error loading dynamically imported
   * module" (which always blames the entry module, never the missing import).
   * @param {HTMLElement} root
   * @param {{
   *   label: string,
   *   loadingText: string,
   *   moduleFile: string,
   *   mount: (mod: any) => void | Promise<void>,
   *   clearBeforeMount?: boolean,
   * }} spec
   * @returns {Promise<boolean>} true when the panel mounted
   */
  async function loadPanel(root, spec) {
    const moduleUrl = new URL(
      `./${spec.moduleFile}?v=${MOBILE_PANELS_V}`,
      import.meta.url,
    ).href;
    root.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = spec.loadingText;
    root.append(status);
    try {
      const mod = await import(moduleUrl);
      if (spec.clearBeforeMount) root.replaceChildren();
      await spec.mount(mod);
      return true;
    } catch (e) {
      console.error(`[mobile-shell] ${spec.label} panel failed to load`, e);
      root.replaceChildren();
      status.textContent = `${spec.label} failed: ${e?.message || e}`;
      const detail = document.createElement('p');
      detail.className = 'mobile-shell__status mobile-shell__status--detail';
      detail.textContent = 'Checking why…';
      // A module that failed to load stays failed in the document's module map,
      // so retrying the import in place can never succeed — reload instead.
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'mobile-shell__retry';
      retry.textContent = 'Reload page';
      retry.addEventListener('click', () => {
        window.location.reload();
      });
      root.append(status, detail, retry);
      diagnoseModuleLoad(moduleUrl)
        .then((reason) => {
          detail.textContent = reason;
        })
        .catch(() => {
          detail.textContent = 'Could not work out why — reload the page.';
        });
      return false;
    }
  }

  async function ensureNotes() {
    if (notesMounted) return;
    notesMounted = true;
    const ok = await loadPanel(notesRoot, {
      label: 'Notes',
      loadingText: 'Loading notes…',
      moduleFile: 'keep-notes.js',
      clearBeforeMount: true,
      mount: ({ mountKeepNotes }) => mountKeepNotes(notesRoot),
    });
    if (!ok) notesMounted = false;
  }

  async function ensureNetwork() {
    if (networkMounted) return;
    networkMounted = true;
    const ok = await loadPanel(networkRoot, {
      label: 'Contacts',
      loadingText: 'Loading contacts…',
      moduleFile: 'network-contacts-mobile.js',
      mount: ({ mountNetworkContactsMobile }) => mountNetworkContactsMobile(networkRoot),
    });
    if (!ok) networkMounted = false;
  }

  async function ensureEvents() {
    if (eventsMounted) return;
    eventsMounted = true;
    const ok = await loadPanel(eventsRoot, {
      label: 'Events',
      loadingText: 'Loading events…',
      moduleFile: 'events-finder-mobile.js',
      mount: ({ mountEventsFinderMobile }) => mountEventsFinderMobile(eventsRoot),
    });
    if (!ok) eventsMounted = false;
  }

  async function ensureGroups() {
    if (groupsMounted) return;
    groupsMounted = true;
    const ok = await loadPanel(groupsRoot, {
      label: 'Groups',
      loadingText: 'Loading groups…',
      moduleFile: 'network-groups-mobile.js',
      mount: ({ mountNetworkGroupsMobile }) => mountNetworkGroupsMobile(groupsRoot),
    });
    if (!ok) groupsMounted = false;
  }

  async function ensureTasks() {
    if (tasksMounted) return;
    tasksMounted = true;
    const configPromise = fetch('/api/config', { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => ({}));
    const ok = await loadPanel(tasksRoot, {
      label: 'Tasks',
      loadingText: 'Loading tasks…',
      moduleFile: 'tasks-mobile.js',
      mount: async ({ mountTasksMobile }) => {
        const config = await configPromise;
        mountTasksMobile(tasksRoot, config && typeof config === 'object' ? config : {});
      },
    });
    if (!ok) tasksMounted = false;
  }

  async function ensureGmail() {
    if (gmailMounted) return;
    gmailMounted = true;
    const ok = await loadPanel(gmailRoot, {
      label: 'Mail',
      loadingText: 'Loading mail…',
      moduleFile: 'gmail-summary-mobile.js',
      mount: ({ mountGmailSummaryMobile }) => mountGmailSummaryMobile(gmailRoot),
    });
    if (!ok) gmailMounted = false;
  }

  /**
   * @param {import('../lib/mobile-history.js').MobileTab} next
   * @param {{ fromHistory?: boolean }} [opts]
   */
  async function setTab(next, opts = {}) {
    tab = next;
    saveTab(tab);
    syncTabs();
    if (tab === 'notes') {
      await ensureNotes();
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: { tab: 'notes', pane: 'list' } }));
    } else if (tab === 'network') await ensureNetwork();
    else if (tab === 'groups') await ensureGroups();
    else if (tab === 'tasks') {
      await ensureTasks();
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: { tab: 'tasks', pane: 'list' } }));
    } else if (tab === 'gmail') await ensureGmail();
    else await ensureEvents();
  }

  /**
   * @param {import('../lib/mobile-history.js').MobileTab} next
   */
  function onTabClick(next) {
    if (isMobileNavApplying()) return;
    if (next === tab) {
      pushMobileNav({ tab: next, pane: 'list' });
      document.dispatchEvent(
        new CustomEvent('dashbird:mobile-nav', { detail: { tab: next, pane: 'list' } }),
      );
      return;
    }
    pushMobileNav({ tab: next, pane: 'list' });
    void setTab(next).then(() => {
      document.dispatchEvent(
        new CustomEvent('dashbird:mobile-nav', { detail: { tab: next, pane: 'list' } }),
      );
    });
  }

  initMobileHistory(tab);

  setMobileNavApplyHandler((state) =>
    runMobileNavApply(state, async (s) => {
      if (s.tab !== tab) await setTab(s.tab, { fromHistory: true });
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: s }));
    }),
  );

  notesBtn.addEventListener('click', () => onTabClick('notes'));
  tasksBtn.addEventListener('click', () => onTabClick('tasks'));
  gmailBtn.addEventListener('click', () => onTabClick('gmail'));
  eventsBtn.addEventListener('click', () => onTabClick('events'));
  networkBtn.addEventListener('click', () => onTabClick('network'));
  groupsBtn.addEventListener('click', () => onTabClick('groups'));

  document.addEventListener('dashbird:mobile-goto', (e) => {
    const d = e.detail;
    if (!d?.tab) return;
    const frame = {
      tab: d.tab,
      pane: d.pane || 'list',
      contactId: d.contactId,
      groupId: d.groupId,
      projectId: d.projectId,
    };
    pushMobileNav(/** @type {import('../lib/mobile-history.js').MobileNavState} */ (frame));
    void setTab(d.tab).then(() => {
      document.dispatchEvent(new CustomEvent('dashbird:mobile-nav', { detail: frame }));
    });
  });

  void setTab(tab);
}
