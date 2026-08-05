import {
  initMobileHistory,
  pushMobileNav,
  setMobileNavApplyHandler,
  runMobileNavApply,
  isMobileNavApplying,
} from '../lib/mobile-history.js';
import { loadPanelModule } from '../lib/panel-module-loader.js';

const MOBILE_TAB_KEY = 'dashbirdMobileTab';
/** Bump when any mobile panel module changes (cache-bust dynamic imports). */
const MOBILE_PANELS_V = 'mobile-panels-20260805-panel-retry-1';

/**
 * Absolute URL for a panel module. The loader lives in another directory, so a
 * relative specifier handed to it would resolve against the wrong folder.
 *
 * @param {string} file
 * @returns {string}
 */
function panelUrl(file) {
  return new URL(`./${file}?v=${MOBILE_PANELS_V}`, import.meta.url).href;
}

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
  /** @type {Record<string, boolean>} */
  const mountedPanels = {};

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
   * @type {Record<string, {
   *   root: HTMLElement,
   *   label: string,
   *   loading: string,
   *   mount: (root: HTMLElement) => Promise<void>,
   * }>}
   */
  const panels = {
    notes: {
      root: notesRoot,
      label: 'Notes',
      loading: 'Loading notes…',
      async mount(root) {
        const { mountKeepNotes } = await loadPanelModule(panelUrl('keep-notes.js'));
        root.replaceChildren();
        mountKeepNotes(root);
      },
    },
    tasks: {
      root: tasksRoot,
      label: 'Tasks',
      loading: 'Loading tasks…',
      async mount(root) {
        const [{ mountTasksMobile }, config] = await Promise.all([
          loadPanelModule(panelUrl('tasks-mobile.js')),
          fetch('/api/config', { cache: 'no-store' })
            .then((r) => r.json())
            .catch(() => ({})),
        ]);
        mountTasksMobile(root, config && typeof config === 'object' ? config : {});
      },
    },
    gmail: {
      root: gmailRoot,
      label: 'Mail',
      loading: 'Loading mail…',
      async mount(root) {
        const { mountGmailSummaryMobile } = await loadPanelModule(
          panelUrl('gmail-summary-mobile.js'),
        );
        mountGmailSummaryMobile(root);
      },
    },
    events: {
      root: eventsRoot,
      label: 'Events',
      loading: 'Loading events…',
      async mount(root) {
        const { mountEventsFinderMobile } = await loadPanelModule(
          panelUrl('events-finder-mobile.js'),
        );
        mountEventsFinderMobile(root);
      },
    },
    network: {
      root: networkRoot,
      label: 'Contacts',
      loading: 'Loading contacts…',
      async mount(root) {
        const { mountNetworkContactsMobile } = await loadPanelModule(
          panelUrl('network-contacts-mobile.js'),
        );
        mountNetworkContactsMobile(root);
      },
    },
    groups: {
      root: groupsRoot,
      label: 'Groups',
      loading: 'Loading groups…',
      async mount(root) {
        const { mountNetworkGroupsMobile } = await loadPanelModule(
          panelUrl('network-groups-mobile.js'),
        );
        mountNetworkGroupsMobile(root);
      },
    },
  };

  /**
   * @param {HTMLElement} root
   * @param {string} label
   * @param {unknown} err
   * @param {() => void} retry
   */
  function renderPanelError(root, label, err, retry) {
    root.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'mobile-shell__error';

    const msg = document.createElement('p');
    msg.className = 'mobile-shell__status mobile-shell__status--error';
    msg.textContent = `${label} failed: ${err?.message || err}`;

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'mobile-shell__retry';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      retry();
    });

    wrap.append(msg, retryBtn);
    root.append(wrap);
  }

  /**
   * @param {string} key
   * @param {{ force?: boolean }} [opts]
   */
  async function ensurePanel(key, opts = {}) {
    const panel = panels[key];
    if (!panel) return;
    if (mountedPanels[key] && !opts.force) return;
    mountedPanels[key] = true;

    panel.root.replaceChildren();
    const status = document.createElement('p');
    status.className = 'mobile-shell__status';
    status.textContent = panel.loading;
    panel.root.append(status);

    try {
      await panel.mount(panel.root);
    } catch (e) {
      mountedPanels[key] = false;
      renderPanelError(panel.root, panel.label, e, () => {
        void ensurePanel(key, { force: true });
      });
    }
  }

  /**
   * @param {import('../lib/mobile-history.js').MobileTab} next
   * @param {{ fromHistory?: boolean }} [opts]
   */
  async function setTab(next, opts = {}) {
    tab = next;
    saveTab(tab);
    syncTabs();
    await ensurePanel(tab);
    if (tab === 'notes' || tab === 'tasks') {
      document.dispatchEvent(
        new CustomEvent('dashbird:mobile-nav', { detail: { tab, pane: 'list' } }),
      );
    }
  }

  /**
   * @param {import('../lib/mobile-history.js').MobileTab} next
   */
  function onTabClick(next) {
    if (isMobileNavApplying()) return;
    if (next === tab) {
      pushMobileNav({ tab: next, pane: 'list' });
      // A panel whose module failed to load stays unmounted, so re-tapping its own
      // tab is the most natural retry gesture on a phone.
      if (!mountedPanels[next]) void ensurePanel(next);
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
