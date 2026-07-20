/**
 * Mobile Gmail Daily Summary — action items + simple 👍/👎 feedback sheet.
 */
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';
import {
  gmailMobileOpenUrl,
  gmailWebMessageUrl,
  isMobileGmailClient,
} from '../lib/gmail-open-url.js';

const CACHE_KEY = 'gmail-daily-summary';
const CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const PTR_THRESHOLD = 70;
const PTR_MAX = 100;

const PIN_ICON_SVG =
  '<svg class="mobile-mail__pin-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path class="mobile-mail__pin-svg-outline" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" d="M7 3h10a1.5 1.5 0 0 1 1.5 1.5V21L12 17.5 7 21V4.5A1.5 1.5 0 0 1 7 3Z"/>' +
  '<path class="mobile-mail__pin-svg-fill" fill="currentColor" d="M7 3h10a1.5 1.5 0 0 1 1.5 1.5V21L12 17.5 7 21V4.5A1.5 1.5 0 0 1 7 3Z"/></svg>';

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
 * @param {string} text
 * @param {number} [maxChars]
 */
function summarizeDetail(text, maxChars = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

/**
 * @param {string} sectionKey
 */
function clampSeeMoreSection(sectionKey) {
  const key = String(sectionKey || '').trim();
  return key === 'show_these' ? 'show_these' : 'prefer_more';
}

/**
 * @param {string} sectionKey
 */
function guideSaveMessageUp(sectionKey) {
  return clampSeeMoreSection(sectionKey) === 'show_these'
    ? 'Saved — show more like this'
    : 'Saved — prefer more like this';
}

/**
 * @param {{ similarCount?: number, promoteSection?: string | null } | null | undefined} escalation
 */
function guideEscalationMessage(escalation) {
  if (!escalation) return 'Saved — prefer less like this';
  const n = Number(escalation.similarCount) || 0;
  if (escalation.promoteSection === 'never_show') {
    return `Saved — ${n}× similar, now Never show`;
  }
  if (escalation.promoteSection === 'soft_skip') {
    return `Saved — ${n}× similar, now Soft skip`;
  }
  return n > 1 ? `Saved — prefer less (${n}× similar)` : 'Saved — prefer less like this';
}

/**
 * Touch pull-to-refresh on a scroll container.
 * @param {HTMLElement} scrollEl
 * @param {() => Promise<void>} onRefresh
 */
function attachPullToRefresh(scrollEl, onRefresh) {
  let startY = 0;
  let pullPx = 0;
  let tracking = false;
  let refreshing = false;

  const ptr = document.createElement('div');
  ptr.className = 'mobile-mail__ptr';
  ptr.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'mobile-mail__ptr-label';
  label.textContent = 'Pull to refresh';
  ptr.append(label);
  scrollEl.insertBefore(ptr, scrollEl.firstChild);

  function atTop() {
    return scrollEl.scrollTop <= 1;
  }

  function applyHeight(h) {
    pullPx = Math.min(Math.max(h, 0), PTR_MAX);
    ptr.style.height = `${pullPx}px`;
    ptr.classList.toggle('mobile-mail__ptr--ready', pullPx >= PTR_THRESHOLD);
    ptr.classList.toggle('mobile-mail__ptr--pulling', pullPx > 0);
  }

  function reset() {
    tracking = false;
    pullPx = 0;
    ptr.style.height = '';
    ptr.classList.remove('mobile-mail__ptr--ready', 'mobile-mail__ptr--pulling', 'mobile-mail__ptr--refreshing');
    label.textContent = 'Pull to refresh';
  }

  scrollEl.addEventListener(
    'touchstart',
    (e) => {
      if (refreshing || !atTop() || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      tracking = true;
    },
    { passive: true },
  );

  scrollEl.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || refreshing) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        applyHeight(0);
        return;
      }
      if (atTop()) {
        applyHeight(dy * 0.45);
        if (pullPx > 8) e.preventDefault();
      } else {
        tracking = false;
        applyHeight(0);
      }
    },
    { passive: false },
  );

  scrollEl.addEventListener(
    'touchend',
    async () => {
      if (!tracking || refreshing) return;
      tracking = false;
      if (pullPx >= PTR_THRESHOLD) {
        refreshing = true;
        ptr.classList.add('mobile-mail__ptr--refreshing');
        label.textContent = 'Refreshing…';
        try {
          await onRefresh();
        } finally {
          refreshing = false;
          reset();
        }
        return;
      }
      reset();
    },
    { passive: true },
  );
}

/**
 * @param {HTMLElement} scrollEl
 * @param {{ title?: string, detail?: string, company?: string, needsReply?: boolean }} item
 * @param {'up' | 'down'} vibe
 * @param {(msg: string, isErr?: boolean) => void} showStatus
 */
async function openFeedbackSheet(scrollEl, item, vibe, showStatus) {
  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-mail__sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'mobile-mail__sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'mobile-mail__sheet-head';
  const title = document.createElement('h3');
  title.className = 'mobile-mail__sheet-title';
  title.textContent = vibe === 'down' ? 'Less like this' : 'More like this';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mobile-mail__sheet-close';
  closeBtn.textContent = 'Cancel';
  head.append(title, closeBtn);

  const itemLabel = document.createElement('p');
  itemLabel.className = 'mobile-mail__sheet-item';
  itemLabel.textContent = String(item.title || 'Untitled item');

  let saveSection = vibe === 'down' ? 'prefer_less' : 'prefer_more';

  const fieldWrap = document.createElement('div');
  fieldWrap.className = 'mobile-mail__sheet-field';

  const lineArea = document.createElement('textarea');
  lineArea.className = 'mobile-mail__sheet-input';
  lineArea.rows = 3;
  lineArea.spellcheck = true;
  lineArea.placeholder = 'Guide pattern…';

  const pending = document.createElement('div');
  pending.className = 'mobile-mail__sheet-pending';
  const pendingLabel = document.createElement('span');
  pendingLabel.className = 'mobile-mail__sheet-pending-label';
  pendingLabel.textContent = 'Tailoring to this email';
  const pendingDots = document.createElement('span');
  pendingDots.className = 'daily-summary__chase-dots';
  pendingDots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dot.textContent = '.';
    pendingDots.append(dot);
  }
  pending.append(pendingLabel, pendingDots);

  fieldWrap.append(lineArea, pending);

  const setFieldLoading = () => fieldWrap.classList.add('mobile-mail__sheet-field--loading');
  const clearFieldLoading = () => fieldWrap.classList.remove('mobile-mail__sheet-field--loading');

  let userEditedLine = false;
  lineArea.addEventListener('input', () => { userEditedLine = true; });

  const msg = document.createElement('p');
  msg.className = 'mobile-mail__sheet-msg';
  msg.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'mobile-mail__sheet-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mobile-mail__action mobile-mail__action--primary';
  saveBtn.textContent = 'Save';
  saveBtn.disabled = true;
  actions.append(saveBtn);

  const close = () => backdrop.remove();
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  sheet.append(head, itemLabel, fieldWrap, msg, actions);
  backdrop.append(sheet);
  document.body.append(backdrop);

  // No draft/example text until the tailored suggestion is ready — just the loader.
  setFieldLoading();
  try {
    const r = await fetch('/api/gmail-daily-summary/guide/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vibe, item }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'suggest_failed');
    saveSection = vibe === 'down' ? 'prefer_less' : clampSeeMoreSection(j.section);
    if (!userEditedLine) lineArea.value = String(j.proposedLines || j.append || '').trim();
  } catch (e) {
    if (!userEditedLine) {
      lineArea.value =
        vibe === 'down'
          ? '- FYI or automated notices that do not need a reply or decision'
          : '- Important follow-ups that deserve a dedicated action item';
    }
    msg.hidden = false;
    msg.textContent = 'Using a local draft — edit if needed.';
  } finally {
    clearFieldLoading();
    saveBtn.disabled = false;
    lineArea.focus();
  }

  saveBtn.addEventListener('click', async () => {
    const append = String(lineArea.value || '').trim();
    if (!append) {
      msg.hidden = false;
      msg.textContent = 'Add a guide line.';
      return;
    }
    saveBtn.disabled = true;
    msg.hidden = false;
    msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/gmail-daily-summary/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vibe,
          section: vibe === 'up' ? saveSection : undefined,
          append,
          item,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'save_failed');
      close();
      showStatus(
        vibe === 'down' ? guideEscalationMessage(j.escalation) : guideSaveMessageUp(saveSection),
      );
    } catch (e) {
      msg.textContent = String(e?.message || e || 'Could not save');
      saveBtn.disabled = false;
    }
  });
}

/**
 * @param {HTMLElement | null} root
 */
export function mountGmailSummaryMobile(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('mobile-mail');

  /** @type {Array<object>} */
  let items = [];
  let summaryText = '';

  const status = document.createElement('p');
  status.className = 'mobile-mail__status';
  status.hidden = true;

  const list = document.createElement('ul');
  list.className = 'mobile-mail__list';
  list.setAttribute('role', 'list');

  root.append(status, list);
  attachPullToRefresh(root, () => load(true));

  /**
   * @param {string} msg
   * @param {boolean} [isErr]
   */
  function showStatus(msg, isErr = false) {
    status.hidden = !msg;
    status.textContent = msg || '';
    status.classList.toggle('mobile-mail__status--err', Boolean(isErr));
    if (msg && !isErr) {
      window.clearTimeout(showStatus._t);
      showStatus._t = window.setTimeout(() => {
        status.hidden = true;
        status.textContent = '';
      }, 4200);
    }
  }
  showStatus._t = 0;

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
    if (payload?.lastError) showStatus(String(payload.lastError), true);
    else if (!status.textContent) showStatus('');
  }

  /**
   * @param {object} item
   */
  async function dismissItem(item) {
    const id = String(item?.id || '').trim();
    if (!id) return;
    const r = await fetch(
      `/api/gmail-daily-summary/items/${encodeURIComponent(id)}/dismiss`,
      { method: 'POST' },
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'dismiss_failed');
    items = Array.isArray(j.items) ? j.items : items.filter((x) => x.id !== id);
    renderList();
    persistCache();
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
    renderList();
    persistCache();
    if (!pinned && j.unpinDeleteAt) scheduleUnpinRemoval(id, j.unpinDeleteAt);
    else {
      const prev = pendingUnpinTimers.get(id);
      if (prev) clearTimeout(prev);
      pendingUnpinTimers.delete(id);
    }
  }

  /**
   * @param {object} item
   */
  function buildCard(item) {
    const id = String(item.id || '');
    const urgency = itemUrgency(item);
    const company = String(item.company || '').trim();

    const card = document.createElement('article');
    card.className = 'mobile-mail__card';
    card.classList.add(`mobile-mail__card--urgency-${urgency}`);
    if (item.pinned) card.classList.add('mobile-mail__card--pinned');

    const head = document.createElement('div');
    head.className = 'mobile-mail__head';

    const title = document.createElement('h3');
    title.className = 'mobile-mail__title';
    title.textContent = String(item.title || 'Untitled');

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'mobile-mail__pin';
    if (item.pinned) pinBtn.classList.add('mobile-mail__pin--on');
    pinBtn.title = item.pinned ? 'Unpin' : 'Pin';
    pinBtn.setAttribute('aria-label', item.pinned ? 'Unpin item' : 'Pin item');
    pinBtn.setAttribute('aria-pressed', item.pinned ? 'true' : 'false');
    pinBtn.innerHTML = PIN_ICON_SVG;
    pinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pinBtn.disabled = true;
      void setItemPinned(item, !item.pinned)
        .catch((err) => showStatus(String(err?.message || err), true))
        .finally(() => {
          pinBtn.disabled = false;
        });
    });

    head.append(title, pinBtn);

    const companyEl = document.createElement('p');
    companyEl.className = 'mobile-mail__company';
    if (company) companyEl.textContent = company;
    else companyEl.hidden = true;

    const meta = document.createElement('p');
    meta.className = 'mobile-mail__meta';
    const metaBits = [];
    const due = formatDeadline(item.deadline);
    if (due) metaBits.push(`Due ${due}`);
    if (item.needsReply) metaBits.push('Needs reply');
    const boxes = Array.isArray(item.mailboxes) ? item.mailboxes : [];
    for (const box of boxes) metaBits.push(shortMailbox(box));
    if (metaBits.length) meta.textContent = metaBits.join(' · ');
    else meta.hidden = true;

    const blurb = document.createElement('p');
    blurb.className = 'mobile-mail__blurb';
    const blurbText = summarizeDetail(item.detail);
    if (blurbText) blurb.textContent = blurbText;
    else blurb.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'mobile-mail__actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'mobile-mail__action mobile-mail__action--vote';
    upBtn.title = 'More like this';
    upBtn.setAttribute('aria-label', 'More like this');
    upBtn.textContent = '👍';
    upBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openFeedbackSheet(root, item, 'up', showStatus);
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'mobile-mail__action mobile-mail__action--vote';
    downBtn.title = 'Less like this';
    downBtn.setAttribute('aria-label', 'Less like this');
    downBtn.textContent = '👎';
    downBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      downBtn.disabled = true;
      upBtn.disabled = true;
      void dismissItem(item)
        .then(() => openFeedbackSheet(root, item, 'down', showStatus))
        .catch((err) => {
          showStatus(String(err?.message || err), true);
          downBtn.disabled = false;
          upBtn.disabled = false;
        });
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'mobile-mail__action';
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
    // Intake mailboxes come in over IMAP, so threadId/messageId are decimal UIDs.
    // A googlegmail:///cv?th=<decimal> link is unroutable and lands on nothing, so
    // strip non-hex ids and let the native handoff fall back to the reliable
    // rfc822msgid search deep link built from the web URL.
    const nativeSource = primary ? { ...primary } : null;
    if (nativeSource) {
      const hexId = (v) => /^[0-9a-f]+$/i.test(String(v || '')) && !/^\d+$/.test(String(v || ''));
      if (!hexId(nativeSource.threadId)) nativeSource.threadId = '';
      if (!hexId(nativeSource.gmailId)) nativeSource.gmailId = '';
      if (!hexId(nativeSource.messageId)) nativeSource.messageId = '';
    }
    const openLink = document.createElement(webUrl ? 'a' : 'button');
    if (webUrl) {
      /** @type {HTMLAnchorElement} */ (openLink).href = isMobileGmailClient()
        ? gmailMobileOpenUrl(webUrl, nativeSource)
        : webUrl;
      if (!isMobileGmailClient()) {
        /** @type {HTMLAnchorElement} */ (openLink).target = '_blank';
        /** @type {HTMLAnchorElement} */ (openLink).rel = 'noopener noreferrer';
      }
    } else {
      /** @type {HTMLButtonElement} */ (openLink).type = 'button';
      /** @type {HTMLButtonElement} */ (openLink).disabled = true;
    }
    openLink.className = 'mobile-mail__action mobile-mail__action--open';
    openLink.title = 'Open in Gmail';
    openLink.textContent = 'Open';

    actions.append(upBtn, downBtn, dismissBtn, openLink);
    card.append(head, companyEl, meta, blurb, actions);

    if (item.unpinDeleteAt) scheduleUnpinRemoval(id, item.unpinDeleteAt);
    return card;
  }

  function renderList() {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'mobile-mail__empty';
      empty.textContent = summaryText
        ? 'No open action items.'
        : 'No summary yet — pull down to refresh after Gmail is connected.';
      list.append(empty);
      return;
    }

    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'mobile-mail__list-item';
      li.append(buildCard(item));
      list.append(li);
    }
  }

  /**
   * @param {boolean} [force]
   */
  async function load(force = false) {
    try {
      const url = force ? '/api/gmail-daily-summary/refresh' : '/api/gmail-daily-summary';
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
        empty.className = 'mobile-mail__empty';
        empty.textContent = 'Could not load mail summary.';
        list.append(empty);
      }
    }
  }

  const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
  if (cached) applyPayload(cached);
  void load(false);
}
