/**
 * Daily Summary — synthesized digest + durable action items.
 * @param {HTMLElement | null} root
 */
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import {
  gmailMobileOpenUrl,
  gmailWebMessageUrl,
  isMobileGmailClient,
} from '../lib/gmail-open-url.js';
import {
  focusTasksPanel,
  notifyTaskCreated,
  readTasksProjectId,
} from '../lib/task-bridge.js';

const CACHE_KEY = 'gmail-daily-summary';
const CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const COLLAPSE_KEY = 'dashbird-daily-summary-collapsed';

/**
 * @returns {boolean}
 */
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {boolean} collapsed
 */
function writeCollapsed(collapsed) {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * Wire card heading collapse (body hide/show).
 * @param {HTMLElement} root
 * @returns {{ setUrgency: (level: 'high' | 'med' | 'low' | null) => void }}
 */
function wireCardChrome(root) {
  const card = root.closest('.sky-sidebar__card--daily-summary');
  const btn = document.getElementById('daily-summary-collapse');
  const bar = card?.querySelector('.sky-sidebar__card-bar--daily-summary');
  const heading = card?.querySelector('#h-daily-summary');

  /** @type {HTMLElement | null} */
  let urgencyEl = null;
  if (bar && heading && !bar.querySelector('.daily-summary__card-urgency')) {
    urgencyEl = document.createElement('span');
    urgencyEl.className = 'daily-summary__card-urgency daily-summary__urgency daily-summary__urgency--low';
    urgencyEl.setAttribute('role', 'img');
    urgencyEl.hidden = true;
    bar.insertBefore(urgencyEl, heading);
  } else if (bar) {
    urgencyEl = /** @type {HTMLElement | null} */ (bar.querySelector('.daily-summary__card-urgency'));
  }

  /**
   * @param {'high' | 'med' | 'low' | null} level
   */
  const setUrgency = (level) => {
    if (!urgencyEl) return;
    if (!level) {
      urgencyEl.hidden = true;
      urgencyEl.className = 'daily-summary__card-urgency daily-summary__urgency';
      urgencyEl.removeAttribute('aria-label');
      urgencyEl.textContent = '';
      return;
    }
    urgencyEl.hidden = false;
    urgencyEl.className = `daily-summary__card-urgency daily-summary__urgency daily-summary__urgency--${level}`;
    urgencyEl.title = urgencyLabel(level);
    urgencyEl.setAttribute('aria-label', urgencyLabel(level));
    urgencyEl.textContent = level === 'high' ? '▲' : level === 'med' ? '●' : '▽';
  };

  if (card && btn instanceof HTMLButtonElement) {
    const apply = (collapsed) => {
      card.classList.toggle('sky-sidebar__card--collapsed', collapsed);
      root.hidden = collapsed;
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', collapsed ? 'Expand Daily Summary' : 'Collapse Daily Summary');
      btn.title = collapsed ? 'Expand Daily Summary' : 'Collapse Daily Summary';
    };

    apply(readCollapsed());
    btn.addEventListener('click', () => {
      const next = !card.classList.contains('sky-sidebar__card--collapsed');
      writeCollapsed(next);
      apply(next);
    });
  }

  return { setUrgency };
}

/**
 * @param {Array<{ deadline?: string | null, needsReply?: boolean }>} list
 * @returns {'high' | 'med' | 'low' | null}
 */
function maxUrgency(list) {
  if (!Array.isArray(list) || !list.length) return null;
  let worst = /** @type {'high' | 'med' | 'low'} */ ('low');
  for (const item of list) {
    const u = itemUrgency(item);
    if (u === 'high') return 'high';
    if (u === 'med') worst = 'med';
  }
  return worst;
}

/**
 * @param {string} email
 */
function shortMailbox(email) {
  const s = String(email || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('jay.intake')) return 'intake';
  if (s.startsWith('julia')) return 'julia';
  return s.split('@')[0] || s;
}

/**
 * @param {string | null | undefined} iso
 */
function formatDeadline(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * @param {{ deadline?: string | null, needsReply?: boolean }} item
 * @param {number} [nowMs]
 * @returns {'high' | 'med' | 'low'}
 */
function itemUrgency(item, nowMs = Date.now()) {
  const dueMs = Date.parse(String(item?.deadline || ''));
  if (Number.isFinite(dueMs)) {
    const hours = (dueMs - nowMs) / (60 * 60 * 1000);
    if (hours <= 24) return 'high';
    if (hours <= 72) return 'med';
  }
  if (item?.needsReply) return 'med';
  return 'low';
}

/**
 * @param {'high' | 'med' | 'low'} level
 */
function urgencyLabel(level) {
  if (level === 'high') return 'High urgency';
  if (level === 'med') return 'Medium urgency';
  return 'Low urgency';
}

/**
 * @param {string} text
 * @param {number} [maxChars]
 */
function summarizeDetail(text, maxChars = 132) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

/** Bookmark ribbon — outline when off, filled when pinned (currentColor). */
const PIN_ICON_SVG =
  '<svg class="daily-summary__pin-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path class="daily-summary__pin-svg-outline" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" d="M7 3h10a1.5 1.5 0 0 1 1.5 1.5V21L12 17.5 7 21V4.5A1.5 1.5 0 0 1 7 3Z"/>' +
  '<path class="daily-summary__pin-svg-fill" fill="currentColor" d="M7 3h10a1.5 1.5 0 0 1 1.5 1.5V21L12 17.5 7 21V4.5A1.5 1.5 0 0 1 7 3Z"/></svg>';

/**
 * Compact signal icon for item urgency.
 * @param {'high' | 'med' | 'low'} level
 */
function makeUrgencyIcon(level) {
  const el = document.createElement('span');
  el.className = `daily-summary__urgency daily-summary__urgency--${level}`;
  el.title = urgencyLabel(level);
  el.setAttribute('aria-label', urgencyLabel(level));
  el.setAttribute('role', 'img');
  el.textContent = level === 'high' ? '▲' : level === 'med' ? '●' : '▽';
  return el;
}

/**
 * @param {string} sectionKey
 */
function clampSeeMoreSection(sectionKey) {
  const key = String(sectionKey || '').trim();
  return key === 'show_these' ? 'show_these' : 'prefer_more';
}

/**
 * What changes on future refreshes — not how thumbs/guide storage works.
 * @param {'up' | 'down'} vibe
 * @param {string} [sectionKey]
 */
function guideBehaviorExplainer(vibe, sectionKey) {
  if (vibe === 'down') {
    return (
      'Next refresh should show fewer items matching this pattern. '
      + 'Repeated 👎 on similar mail tightens the filter (Soft skip at 3×, Never show at 5×).'
    );
  }
  if (clampSeeMoreSection(sectionKey) === 'show_these') {
    return 'Next refresh is more likely to surface matching mail as action items.';
  }
  return 'Next refresh will rank similar mail higher in Daily Summary.';
}

/**
 * @param {string} sectionKey
 */
function guideSaveMessageUp(sectionKey) {
  return clampSeeMoreSection(sectionKey) === 'show_these'
    ? 'Saved under Show these'
    : 'Saved under Prefer more';
}

/**
 * @param {{ similarCount?: number, promoteSection?: string | null, tier?: string } | null | undefined} escalation
 */
function guideEscalationMessage(escalation) {
  if (!escalation) return 'Saved under Prefer less';
  const n = Number(escalation.similarCount) || 0;
  if (escalation.promoteSection === 'never_show') {
    return `Saved — ${n}× similar 👎, promoted to Never show`;
  }
  if (escalation.promoteSection === 'soft_skip') {
    return `Saved — ${n}× similar 👎, promoted to Soft skip`;
  }
  return n > 1 ? `Saved under Prefer less (${n}× similar)` : 'Saved under Prefer less';
}

/**
 * @param {unknown} err
 */
function isNetworkFetchError(err) {
  if (err instanceof TypeError) return true;
  const msg = String(err?.message || err || '');
  return (
    msg.includes('NetworkError')
    || msg.includes('Failed to fetch')
    || msg.includes('Load failed')
    || msg.includes('Network request failed')
  );
}

/**
 * @param {unknown} err
 */
function networkErrorLabel(err) {
  if (isNetworkFetchError(err)) {
    return 'Could not reach Dashbird (server may be restarting). Edit the line below or try again.';
  }
  return String(err?.message || err || 'Could not save guide update');
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [retries]
 */
async function fetchJsonWithRetry(url, init, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const r = await fetch(url, init);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        throw new Error(String(j.error || j.detail || `http_${r.status}`));
      }
      return j;
    } catch (e) {
      lastErr = e;
      if (!isNetworkFetchError(e) || attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 650 + attempt * 450));
    }
  }
  throw lastErr;
}

/**
 * @param {HTMLElement} root
 * @param {{ title?: string, detail?: string, company?: string, needsReply?: boolean }} item
 * @param {'up' | 'down'} vibe
 * @param {() => void} onSaved
 * @param {(msg: string, isErr?: boolean) => void} showStatus
 */
function openPreferenceFeedbackModal(root, item, vibe, onSaved, showStatus) {
  const backdrop = document.createElement('div');
  backdrop.className = 'daily-summary__modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'daily-summary__modal daily-summary__modal--guide daily-summary__modal--feedback';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h3');
  title.className = 'daily-summary__modal-title';
  title.textContent = vibe === 'down' ? 'Less like this?' : 'More like this?';

  const itemLabel = document.createElement('p');
  itemLabel.className = 'daily-summary__modal-item';
  itemLabel.textContent = item.title || 'Untitled item';

  let saveSection = vibe === 'down' ? 'prefer_less' : 'prefer_more';

  const explainer = document.createElement('p');
  explainer.className = 'daily-summary__modal-explainer';
  explainer.textContent = guideBehaviorExplainer(vibe, saveSection);

  const lineLabel = document.createElement('label');
  lineLabel.className = 'daily-summary__modal-field-label';
  lineLabel.textContent = 'Pattern to match';

  const lineArea = document.createElement('textarea');
  lineArea.className = 'daily-summary__modal-textarea daily-summary__modal-textarea--guide';
  lineArea.rows = 3;
  lineArea.spellcheck = true;

  const msg = document.createElement('p');
  msg.className = 'daily-summary__modal-msg';
  msg.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'daily-summary__modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'daily-summary__btn';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'daily-summary__btn daily-summary__btn--primary';
  save.textContent = 'Save to guide';
  save.disabled = true;

  const syncExplainer = () => {
    explainer.textContent = guideBehaviorExplainer(vibe, saveSection);
  };

  const close = () => backdrop.remove();
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  save.addEventListener('click', async () => {
    const append = String(lineArea.value || '').trim();
    if (!append) {
      msg.hidden = false;
      msg.textContent = 'Add a guide line to append.';
      return;
    }
    save.disabled = true;
    msg.hidden = false;
    msg.textContent = 'Saving…';
    try {
      const j = await fetchJsonWithRetry('/api/gmail-daily-summary/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vibe,
          section: vibe === 'up' ? saveSection : undefined,
          append,
          item,
        }),
      }, 1);
      close();
      showStatus(
        vibe === 'down' ? guideEscalationMessage(j.escalation) : guideSaveMessageUp(saveSection),
      );
      onSaved();
    } catch (e) {
      msg.textContent = networkErrorLabel(e);
      save.disabled = false;
    }
  });

  actions.append(cancel, save);
  modal.append(title, itemLabel, explainer, lineLabel, lineArea, msg, actions);
  backdrop.append(modal);
  document.body.append(backdrop);

  void (async () => {
    try {
      const j = await fetchJsonWithRetry(
        '/api/gmail-daily-summary/guide/suggest',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vibe, item, skipLlm: true }),
        },
        1,
      );
      saveSection = vibe === 'down' ? 'prefer_less' : clampSeeMoreSection(j.section);
      lineArea.value = String(j.proposedLines || j.append || '').trim();
      syncExplainer();
      save.disabled = false;
      lineArea.focus();
    } catch {
      lineArea.value =
        vibe === 'down'
          ? '- FYI or automated notices that do not need a reply or decision'
          : '- Important follow-ups that deserve a dedicated action item';
      save.disabled = false;
      lineArea.focus();
    }
  })();
}

/**
 * @param {HTMLElement} root
 * @param {{ title?: string, detail?: string, company?: string, needsReply?: boolean }} item
 * @param {'up' | 'down'} vibe
 * @param {() => void} onSaved
 * @param {(msg: string, isErr?: boolean) => void} showStatus
 */
function openPreferenceModal(root, item, vibe, onSaved, showStatus) {
  openPreferenceFeedbackModal(root, item, vibe, onSaved, showStatus);
}

/**
 * @param {HTMLElement | null} root
 */
export function mountDailySummary(root) {
  if (!root) return;
  root.replaceChildren();
  const chrome = wireCardChrome(root);

  const wrap = document.createElement('div');
  wrap.className = 'daily-summary';

  const toolbar = document.createElement('div');
  toolbar.className = 'daily-summary__toolbar';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'daily-summary__btn daily-summary__btn--ghost';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.title = 'Re-fetch mail and regenerate summary';

  const status = document.createElement('p');
  status.className = 'daily-summary__status';
  status.hidden = true;

  toolbar.append(refreshBtn);

  const list = document.createElement('ul');
  list.className = 'daily-summary__summary-list';
  list.setAttribute('role', 'list');

  /** Kept for cache round-trips; items are the summary UI. */
  let summaryText = '';

  wrap.append(toolbar, list, status);
  root.append(wrap);

  /** @type {Array<object>} */
  let items = [];

  /**
   * @param {string} msg
   * @param {boolean} [isErr]
   */
  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg || '';
    status.classList.toggle('daily-summary__status--err', Boolean(isErr));
  }

  function persistCache() {
    writePanelCache(CACHE_KEY, {
      summaryText,
      items,
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * @param {object} payload
   */
  function applyPayload(payload) {
    summaryText = String(payload?.summaryText || '').trim();
    items = Array.isArray(payload?.items) ? payload.items : [];
    renderList();
    if (payload?.lastError) {
      showStatus(String(payload.lastError), true);
    } else {
      showStatus('');
    }
  }

  /**
   * Persist dismiss and drop from the open list.
   * @param {object} item
   */
  async function dismissItem(item) {
    const id = String(item?.id || '').trim();
    if (!id) return false;
    const r = await fetch(
      `/api/gmail-daily-summary/items/${encodeURIComponent(id)}/dismiss`,
      { method: 'POST' },
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'dismiss_failed');
    items = Array.isArray(j.items) ? j.items : items.filter((x) => x.id !== id);
    renderList();
    persistCache();
    return true;
  }

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingUnpinTimers = new Map();

  /**
   * @param {string} id
   * @param {string | null | undefined} unpinDeleteAt
   */
  function scheduleUnpinRemoval(id, unpinDeleteAt) {
    const prev = pendingUnpinTimers.get(id);
    if (prev) clearTimeout(prev);
    pendingUnpinTimers.delete(id);
    const deleteAtMs = Date.parse(String(unpinDeleteAt || ''));
    if (!Number.isFinite(deleteAtMs)) return;
    const delay = Math.max(0, deleteAtMs - Date.now()) + 50;
    const t = setTimeout(() => {
      pendingUnpinTimers.delete(id);
      items = items.filter((x) => x.id !== id);
      renderList();
      persistCache();
    }, delay);
    pendingUnpinTimers.set(id, t);
  }

  /**
   * @param {object} item
   * @param {boolean} pinned
   */
  async function setItemPinned(item, pinned) {
    const id = String(item?.id || '').trim();
    if (!id) return;
    const r = await fetch(
      `/api/gmail-daily-summary/items/${encodeURIComponent(id)}/pin`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      },
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'pin_failed');
    items = Array.isArray(j.items) ? j.items : items;
    // Keep chronological order from server; pin never reorders.
    renderList();
    persistCache();
    if (!pinned && j.unpinDeleteAt) {
      scheduleUnpinRemoval(id, j.unpinDeleteAt);
    } else {
      const prev = pendingUnpinTimers.get(id);
      if (prev) clearTimeout(prev);
      pendingUnpinTimers.delete(id);
    }
  }

  /**
   * @param {object} item
   */
  function buildMailCard(item) {
    const id = String(item.id || '');
    const urgency = itemUrgency(item);
    const company = String(item.company || '').trim();

    const card = document.createElement('article');
    card.className = 'daily-summary__card';
    card.classList.add(`daily-summary__card--urgency-${urgency}`);
    if (item.pinned) card.classList.add('daily-summary__card--pinned');
    card.dataset.id = id;
    card.dataset.urgency = urgency;

    const head = document.createElement('div');
    head.className = 'daily-summary__card-head';
    const title = document.createElement('div');
    title.className = 'daily-summary__card-title';
    title.textContent = String(item.title || 'Untitled');

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'daily-summary__card-pin';
    if (item.pinned) pinBtn.classList.add('daily-summary__card-pin--on');
    pinBtn.title = item.pinned ? 'Unpin (keeps past 10 days until unpinned)' : 'Pin to keep past 10 days';
    pinBtn.setAttribute(
      'aria-label',
      item.pinned ? `Unpin ${String(item.title || 'item')}` : `Pin ${String(item.title || 'item')}`,
    );
    pinBtn.setAttribute('aria-pressed', item.pinned ? 'true' : 'false');
    pinBtn.innerHTML = PIN_ICON_SVG;
    pinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pinBtn.disabled = true;
      void setItemPinned(item, !item.pinned)
        .catch((err) => {
          showStatus(String(err?.message || err), true);
        })
        .finally(() => {
          pinBtn.disabled = false;
        });
    });
    head.append(title, pinBtn);

    const companyEl = document.createElement('p');
    companyEl.className = 'daily-summary__card-company';
    if (company) {
      companyEl.textContent = company;
      companyEl.title = `Request from ${company}`;
    } else {
      companyEl.hidden = true;
    }

    const meta = document.createElement('p');
    meta.className = 'daily-summary__card-meta';
    const metaBits = [];
    const due = formatDeadline(item.deadline);
    if (due) metaBits.push(`Due ${due}`);
    if (item.needsReply) metaBits.push('Needs reply');
    const boxes = Array.isArray(item.mailboxes) ? item.mailboxes : [];
    for (const box of boxes) metaBits.push(shortMailbox(box));
    if (metaBits.length) meta.textContent = metaBits.join(' · ');
    else meta.hidden = true;

    const blurb = document.createElement('p');
    blurb.className = 'daily-summary__card-blurb';
    const blurbText = summarizeDetail(item.detail);
    if (blurbText) blurb.textContent = blurbText;
    else blurb.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'daily-summary__card-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'daily-summary__card-action daily-summary__card-action--up';
    upBtn.title = 'See more like this';
    upBtn.setAttribute('aria-label', 'See more like this');
    upBtn.textContent = '👍';
    upBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPreferenceModal(root, item, 'up', () => {}, showStatus);
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'daily-summary__card-action daily-summary__card-action--down';
    downBtn.title = 'See less like this (dismisses this item)';
    downBtn.setAttribute('aria-label', 'See less like this');
    downBtn.textContent = '👎';
    downBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      downBtn.disabled = true;
      upBtn.disabled = true;
      void dismissItem(item)
        .then(() => {
            openPreferenceModal(root, item, 'down', () => {}, showStatus);
        })
        .catch((err) => {
          showStatus(String(err?.message || err), true);
          downBtn.disabled = false;
          upBtn.disabled = false;
        });
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'daily-summary__card-action daily-summary__card-action--dismiss';
    dismissBtn.title = 'Dismiss';
    dismissBtn.setAttribute('aria-label', `Dismiss ${String(item.title || 'item')}`);
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissBtn.disabled = true;
      void dismissItem(item).catch((err) => {
        showStatus(String(err?.message || err), true);
        dismissBtn.disabled = false;
      });
    });

    const primary = Array.isArray(item.sources) && item.sources.length ? item.sources[0] : null;
    const webUrl = gmailWebMessageUrl(primary) || String(item.replyUrl || '').trim();
    const openLink = document.createElement(webUrl ? 'a' : 'button');
    if (webUrl) {
      /** @type {HTMLAnchorElement} */ (openLink).href = isMobileGmailClient()
        ? gmailMobileOpenUrl(webUrl, primary)
        : webUrl;
      if (!isMobileGmailClient()) {
        /** @type {HTMLAnchorElement} */ (openLink).target = '_blank';
        /** @type {HTMLAnchorElement} */ (openLink).rel = 'noopener noreferrer';
      }
    } else {
      /** @type {HTMLButtonElement} */ (openLink).type = 'button';
      /** @type {HTMLButtonElement} */ (openLink).disabled = true;
    }
    openLink.className = 'daily-summary__card-action daily-summary__card-action--open';
    openLink.textContent = 'Open';
    openLink.title = 'Open in Gmail';

    const createTask = document.createElement('button');
    createTask.type = 'button';
    createTask.className = 'daily-summary__card-action daily-summary__card-action--task';
    createTask.textContent = 'Task';
    createTask.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      createTask.disabled = true;
      try {
        const projectId = readTasksProjectId();
        const r = await fetch(
          `/api/gmail-daily-summary/items/${encodeURIComponent(id)}/create-task`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(projectId != null ? { projectId } : {}),
          },
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || j.detail || 'create_task_failed');
        items = Array.isArray(j.items) ? j.items : items.filter((x) => x.id !== id);
        renderList();
        persistCache();
        if (j.todo?.id) {
          notifyTaskCreated({
            id: String(j.todo.id),
            text: String(j.todo.text || item.title || '').trim(),
            projectId: j.todo.projectId != null ? Number(j.todo.projectId) : projectId,
            dueDate: j.dueDate || null,
          });
          focusTasksPanel();
        }
        showStatus(
          j.dueDate
            ? `Added to Tasks · due ${formatDeadline(j.dueDate)}`
            : 'Added to Tasks',
        );
      } catch (err) {
        showStatus(String(err?.message || err), true);
        createTask.disabled = false;
      }
    });

    actions.append(upBtn, downBtn, dismissBtn, createTask, openLink);

    const footerBits = [];
    if (item.pinned) footerBits.push('pinned');
    const sourceCount = Number(item.sourceCount) || (Array.isArray(item.sources) ? item.sources.length : 0);
    if (sourceCount > 1) footerBits.push(`${sourceCount} sources`);
    const footer = document.createElement('p');
    footer.className = 'daily-summary__card-footer';
    if (footerBits.length) footer.textContent = footerBits.join(' · ');
    else footer.hidden = true;
    if (sourceCount > 1) {
      footer.title = (item.sources || [])
        .map((s) => String(s.subject || s.messageId || '').trim())
        .filter(Boolean)
        .join('\n');
    }

    card.append(head, companyEl, meta, blurb, actions, footer);
    return card;
  }

  function renderList() {
    list.replaceChildren();
    chrome.setUrgency(maxUrgency(items));
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'daily-summary__empty';
      empty.textContent = summaryText
        ? 'No open action items.'
        : 'No summary yet — hit Refresh after Gmail is connected.';
      list.append(empty);
      return;
    }

    for (const item of items) {
      const id = String(item.id || '');
      const li = document.createElement('li');
      li.className = 'daily-summary__list-item';
      li.append(buildMailCard(item));
      list.append(li);

      if (item.unpinDeleteAt) scheduleUnpinRemoval(id, item.unpinDeleteAt);
    }
  }

  /**
   * @param {boolean} [force]
   */
  async function load(force = false) {
    refreshBtn.disabled = true;
    try {
      const url = force
        ? '/api/gmail-daily-summary/refresh'
        : '/api/gmail-daily-summary';
      const r = await fetch(url, {
        method: force ? 'POST' : 'GET',
        cache: 'no-store',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && j.ok === false && !j.summaryText && !Array.isArray(j.items)) {
        throw new Error(j.error || j.detail || `HTTP ${r.status}`);
      }
      applyPayload(j);
      writePanelCache(CACHE_KEY, j);
    } catch (e) {
      showStatus(String(e?.message || e), true);
      if (!items.length) {
        list.replaceChildren();
        const empty = document.createElement('li');
        empty.className = 'daily-summary__empty';
        empty.textContent = 'Could not load Daily Summary.';
        list.append(empty);
      }
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', () => {
    void load(true);
  });

  const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
  if (cached) applyPayload(cached);
  void load(false);
}
