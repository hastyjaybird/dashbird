/**
 * Daily Summary — synthesized digest + durable action items.
 * @param {HTMLElement | null} root
 */
import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

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
 * @param {{ title?: string, detail?: string, needsReply?: boolean }} item
 * @param {'up' | 'down'} vibe
 */
function suggestTopicLines(item, vibe) {
  const lines = [];
  const title = String(item?.title || '').trim();
  const detail = String(item?.detail || '').trim();
  if (title) lines.push(title.slice(0, 80));
  if (item?.needsReply) lines.push('Anything waiting on my reply');
  if (detail) {
    const short = detail.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (short && !lines.some((l) => l.toLowerCase() === short.toLowerCase())) {
      lines.push(short);
    }
  }
  if (vibe === 'down' && !lines.length) {
    lines.push('FYI with no action needed');
  }
  return lines.slice(0, 4).join('\n');
}

/**
 * @param {HTMLElement} root
 * @param {{ title?: string, detail?: string, needsReply?: boolean }} item
 * @param {'up' | 'down'} vibe
 * @param {() => void} onSaved
 */
function openPreferenceModal(root, item, vibe, onSaved) {
  const wantMore = vibe === 'up';
  const backdrop = document.createElement('div');
  backdrop.className = 'daily-summary__modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'daily-summary__modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h3');
  title.className = 'daily-summary__modal-title';
  title.textContent = wantMore ? 'See more like this?' : 'See less like this?';

  const hint = document.createElement('p');
  hint.className = 'daily-summary__modal-hint';
  hint.textContent = wantMore
    ? 'Add topic/circumstance lines to Look for (one per line).'
    : 'This item is dismissed. Add grey and/or black topic lines (one per line) so similar ones stay out.';

  const itemLabel = document.createElement('p');
  itemLabel.className = 'daily-summary__modal-item';
  itemLabel.textContent = item.title || 'Untitled item';

  /** @type {HTMLTextAreaElement} */
  let lookArea;
  /** @type {HTMLTextAreaElement | null} */
  let greyArea = null;
  /** @type {HTMLTextAreaElement | null} */
  let blackArea = null;

  const fields = document.createElement('div');
  fields.className = 'daily-summary__modal-fields';

  if (wantMore) {
    lookArea = document.createElement('textarea');
    lookArea.className = 'daily-summary__modal-textarea';
    lookArea.rows = 5;
    lookArea.placeholder = 'One topic or circumstance per line…';
    lookArea.value = suggestTopicLines(item, vibe);
    fields.append(lookArea);
  } else {
    lookArea = document.createElement('textarea');
    const greyLabel = document.createElement('label');
    greyLabel.textContent = 'Grey list';
    greyArea = document.createElement('textarea');
    greyArea.className = 'daily-summary__modal-textarea';
    greyArea.rows = 3;
    greyArea.placeholder = 'Soft exclude…';
    greyArea.value = suggestTopicLines(item, vibe);
    const blackLabel = document.createElement('label');
    blackLabel.textContent = 'Black list';
    blackArea = document.createElement('textarea');
    blackArea.className = 'daily-summary__modal-textarea';
    blackArea.rows = 3;
    blackArea.placeholder = 'Always exclude…';
    fields.append(greyLabel, greyArea, blackLabel, blackArea);
  }

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
  save.textContent = wantMore ? 'Add to Look for' : 'Save topics';

  const close = () => backdrop.remove();
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  save.addEventListener('click', async () => {
    const lookFor = wantMore ? lookArea.value : '';
    const skip = wantMore ? '' : greyArea?.value || '';
    const blacklist = wantMore ? '' : blackArea?.value || '';
    if (wantMore && !String(lookFor).trim()) {
      msg.hidden = false;
      msg.textContent = 'Add at least one Look-for line.';
      return;
    }
    if (!wantMore && !String(skip).trim() && !String(blacklist).trim()) {
      msg.hidden = false;
      msg.textContent = 'Add at least one grey or black line.';
      return;
    }
    save.disabled = true;
    msg.hidden = false;
    msg.textContent = 'Saving…';
    try {
      const r = await fetch('/api/gmail-daily-summary/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vibe: wantMore ? 'up' : 'down',
          lookFor,
          skip,
          blacklist,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'save_failed');
      close();
      onSaved();
    } catch (e) {
      msg.textContent = String(e?.message || e || 'Could not save');
      save.disabled = false;
    }
  });

  actions.append(cancel, save);
  modal.append(title, hint, itemLabel, fields, msg, actions);
  backdrop.append(modal);
  document.body.append(backdrop);
  (wantMore ? lookArea : greyArea)?.focus();
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
  /** @type {Set<string>} */
  const openDetailIds = new Set();

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
    const liveIds = new Set(items.map((it) => String(it.id || '')));
    for (const id of [...openDetailIds]) {
      if (!liveIds.has(id)) openDetailIds.delete(id);
    }
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
    openDetailIds.delete(id);
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
      openDetailIds.delete(id);
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
      li.className = 'daily-summary__summary-item';
      if (item.pinned) li.classList.add('daily-summary__summary-item--pinned');
      li.dataset.id = id;

      const urgency = itemUrgency(item);
      li.dataset.urgency = urgency;

      const details = document.createElement('details');
      details.className = 'daily-summary__item-details';
      details.open = openDetailIds.has(id);
      details.addEventListener('toggle', () => {
        if (details.open) openDetailIds.add(id);
        else openDetailIds.delete(id);
      });

      const row = document.createElement('summary');
      row.className = 'daily-summary__summary-row';

      const urgencyEl = makeUrgencyIcon(urgency);

      const title = document.createElement('span');
      title.className = 'daily-summary__summary-title';
      title.textContent = String(item.title || 'Untitled');

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'daily-summary__pin';
      if (item.pinned) pin.classList.add('daily-summary__pin--on');
      pin.title = item.pinned ? 'Unpin (keeps past 10 days until unpinned)' : 'Pin to keep past 10 days';
      pin.setAttribute('aria-label', item.pinned ? `Unpin ${String(item.title || 'item')}` : `Pin ${String(item.title || 'item')}`);
      pin.setAttribute('aria-pressed', item.pinned ? 'true' : 'false');
      pin.innerHTML = PIN_ICON_SVG;
      pin.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pin.disabled = true;
        void setItemPinned(item, !item.pinned)
          .catch((err) => {
            showStatus(String(err?.message || err), true);
          })
          .finally(() => {
            pin.disabled = false;
          });
      });

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'daily-summary__dismiss-x';
      dismiss.title = 'Dismiss';
      dismiss.setAttribute('aria-label', `Dismiss ${String(item.title || 'item')}`);
      dismiss.textContent = '×';
      dismiss.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismiss.disabled = true;
        void dismissItem(item).catch((err) => {
          showStatus(String(err?.message || err), true);
          dismiss.disabled = false;
        });
      });

      row.append(urgencyEl, title, pin, dismiss);

      const body = document.createElement('div');
      body.className = 'daily-summary__item-body';

      const company = String(item.company || '').trim();
      if (company) {
        const companyEl = document.createElement('p');
        companyEl.className = 'daily-summary__item-company';
        companyEl.textContent = company;
        companyEl.title = `Request from ${company}`;
        body.append(companyEl);
      }

      const detail = document.createElement('p');
      detail.className = 'daily-summary__item-detail';
      detail.textContent = String(item.detail || '');
      detail.hidden = !item.detail;

      const meta = document.createElement('div');
      meta.className = 'daily-summary__meta';
      const boxes = Array.isArray(item.mailboxes) ? item.mailboxes : [];
      for (const box of boxes) {
        const tag = document.createElement('span');
        tag.className = 'daily-summary__tag';
        tag.textContent = shortMailbox(box);
        meta.append(tag);
      }
      const due = formatDeadline(item.deadline);
      if (due) {
        const dueEl = document.createElement('span');
        dueEl.className = 'daily-summary__due';
        dueEl.textContent = `Due ${due}`;
        meta.append(dueEl);
      }
      if (item.pinned) {
        const pinTag = document.createElement('span');
        pinTag.className = 'daily-summary__tag daily-summary__tag--pinned';
        pinTag.textContent = 'pinned';
        meta.append(pinTag);
      }
      const sourceCount = Number(item.sourceCount) || (Array.isArray(item.sources) ? item.sources.length : 0);
      if (sourceCount > 1) {
        const src = document.createElement('span');
        src.className = 'daily-summary__sources';
        src.textContent = `${sourceCount} sources`;
        src.title = (item.sources || [])
          .map((s) => String(s.subject || s.messageId || '').trim())
          .filter(Boolean)
          .join('\n');
        meta.append(src);
      }
      meta.hidden = !meta.childElementCount;

      const thumbs = document.createElement('div');
      thumbs.className = 'daily-summary__thumbs daily-summary__thumbs--row';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'daily-summary__thumb daily-summary__thumb--more';
      up.title = 'See more like this';
      up.setAttribute('aria-label', 'See more like this');
      up.textContent = '👍';
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'daily-summary__thumb daily-summary__thumb--less';
      down.title = 'See less like this (dismisses this item)';
      down.setAttribute('aria-label', 'See less like this');
      down.textContent = '👎';
      up.addEventListener('click', () => openPreferenceModal(root, item, 'up', () => {}));
      down.addEventListener('click', () => {
        down.disabled = true;
        up.disabled = true;
        void dismissItem(item)
          .then(() => {
            openPreferenceModal(root, item, 'down', () => {});
          })
          .catch((e) => {
            showStatus(String(e?.message || e), true);
            down.disabled = false;
            up.disabled = false;
          });
      });
      thumbs.append(up, down);

      const actions = document.createElement('div');
      actions.className = 'daily-summary__actions';

      const reply = document.createElement(item.replyUrl ? 'a' : 'button');
      if (item.replyUrl) {
        /** @type {HTMLAnchorElement} */ (reply).href = String(item.replyUrl);
        /** @type {HTMLAnchorElement} */ (reply).target = '_blank';
        /** @type {HTMLAnchorElement} */ (reply).rel = 'noopener noreferrer';
      } else {
        /** @type {HTMLButtonElement} */ (reply).type = 'button';
        /** @type {HTMLButtonElement} */ (reply).disabled = true;
      }
      reply.className = 'daily-summary__btn';
      reply.textContent = 'Reply';

      const createTask = document.createElement('button');
      createTask.type = 'button';
      createTask.className = 'daily-summary__btn daily-summary__btn--primary';
      createTask.textContent = 'Create task';
      createTask.addEventListener('click', async () => {
        createTask.disabled = true;
        try {
          const r = await fetch(
            `/api/gmail-daily-summary/items/${encodeURIComponent(id)}/create-task`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
          );
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) throw new Error(j.error || j.detail || 'create_task_failed');
          items = Array.isArray(j.items) ? j.items : items.filter((x) => x.id !== id);
          openDetailIds.delete(id);
          renderList();
          persistCache();
          showStatus(j.dueDate ? `Task created · due ${formatDeadline(j.dueDate)}` : 'Task created');
        } catch (e) {
          showStatus(String(e?.message || e), true);
          createTask.disabled = false;
        }
      });

      actions.append(reply, createTask, thumbs);
      body.append(detail, meta, actions);
      details.append(row, body);
      li.append(details);
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
