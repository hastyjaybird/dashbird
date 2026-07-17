/**
 * Browser back / swipe-back for mobile shell: pushState on in-app navigation
 * so OS back returns to the previous Dashbird view instead of leaving the app.
 */

/** @typedef {'network' | 'events' | 'groups' | 'tasks'} MobileTab */

/**
 * @typedef {object} MobileNavState
 * @property {true} dashbirdMobile
 * @property {MobileTab} tab
 * @property {'list' | 'contact' | 'group' | 'project'} pane
 * @property {string} [contactId]
 * @property {string} [groupId]
 * @property {number} [projectId]
 * @property {string} [overlay]
 */

let applying = false;

/** @type {((state: MobileNavState) => void | Promise<void>) | null} */
let applyHandler = null;

/**
 * @param {MobileTab} initialTab
 */
export function initMobileHistory(initialTab) {
  if (!history.state?.dashbirdMobile) {
    history.replaceState(
      /** @type {MobileNavState} */ ({
        dashbirdMobile: true,
        tab: initialTab,
        pane: 'list',
      }),
      '',
    );
  }
  window.addEventListener('popstate', (e) => {
    const state = e.state;
    if (!state?.dashbirdMobile || !applyHandler) return;
    void applyHandler(/** @type {MobileNavState} */ (state));
  });
}

/**
 * @param {(state: MobileNavState) => void | Promise<void>} fn
 */
export function setMobileNavApplyHandler(fn) {
  applyHandler = fn;
}

export function isMobileNavApplying() {
  return applying;
}

/**
 * @param {Partial<MobileNavState> & { tab: MobileTab }} frame
 */
export function pushMobileNav(frame) {
  if (applying) return;
  const prev = history.state?.dashbirdMobile ? history.state : {};
  history.pushState(
    /** @type {MobileNavState} */ ({
      dashbirdMobile: true,
      pane: 'list',
      ...prev,
      ...frame,
    }),
    '',
  );
}

export function mobileNavBack() {
  history.back();
}

/**
 * @param {MobileNavState} state
 * @param {(state: MobileNavState) => void | Promise<void>} fn
 */
export async function runMobileNavApply(state, fn) {
  applying = true;
  try {
    await fn(state);
  } finally {
    applying = false;
  }
}
