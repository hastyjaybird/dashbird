/**
 * Open dev requests list — shared overlay for desktop sticky + mobile sheet.
 */

/** @typedef {{
 *   id: string,
 *   folder: string,
 *   title: string,
 *   body?: string,
 *   platform: string,
 *   areaLabel: string,
 *   priority: number,
 *   priorityLabel: string,
 *   attachments?: string[],
 * }} DevRequestRow */

let mounted = false;

/** @type {HTMLElement | null} */
let backdrop = null;

/** @type {HTMLElement | null} */
let panel = null;

/** @type {HTMLElement | null} */
let listEl = null;

/** @type {HTMLElement | null} */
let statusEl = null;

function ensureMounted() {
  if (mounted) return;
  mounted = true;

  backdrop = document.createElement('div');
  backdrop.className = 'dev-request-view-backdrop';
  backdrop.hidden = true;

  panel = document.createElement('div');
  panel.className = 'dev-request-view';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Open dev requests');

  const header = document.createElement('div');
  header.className = 'dev-request-view__header';

  const title = document.createElement('h2');
  title.className = 'dev-request-view__title';
  title.textContent = 'Open dev requests';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dev-request-view__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';

  header.append(title, closeBtn);

  statusEl = document.createElement('p');
  statusEl.className = 'dev-request-view__status';
  statusEl.textContent = 'Loading…';

  listEl = document.createElement('div');
  listEl.className = 'dev-request-view__list';

  const hint = document.createElement('p');
  hint.className = 'dev-request-view__hint';
  hint.textContent = 'Also in data/dev-requests/inbox.md for Cursor agents.';

  panel.append(header, statusEl, listEl, hint);
  document.body.append(backdrop, panel);

  closeBtn.addEventListener('click', closeDevRequestsViewer);
  backdrop.addEventListener('click', closeDevRequestsViewer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && !panel.hidden) closeDevRequestsViewer();
  });
}

export function closeDevRequestsViewer() {
  if (!backdrop || !panel) return;
  backdrop.hidden = true;
  panel.hidden = true;
  document.body.classList.remove('dev-request-view-open');
}

/**
 * @param {DevRequestRow[]} requests
 */
function renderList(requests) {
  if (!listEl || !statusEl) return;
  listEl.replaceChildren();

  if (!requests.length) {
    statusEl.textContent = 'No open dev requests.';
    statusEl.hidden = false;
    return;
  }

  statusEl.hidden = true;

  for (const req of requests) {
    const card = document.createElement('article');
    card.className = 'dev-request-view__card';
    card.dataset.id = req.id;

    const cardHead = document.createElement('div');
    cardHead.className = 'dev-request-view__card-head';

    const badge = document.createElement('span');
    const pri = Number(req.priority) || 2;
    const priShort = pri === 1 ? 'high' : pri === 3 ? 'low' : 'med';
    badge.className = `dev-request-view__priority dev-request-view__priority--${priShort}`;
    badge.textContent = req.priorityLabel || (pri === 1 ? 'High' : pri === 3 ? 'Low' : 'Med');

    const cardTitle = document.createElement('h3');
    cardTitle.className = 'dev-request-view__card-title';
    cardTitle.textContent = req.title;

    cardHead.append(badge, cardTitle);

    const meta = document.createElement('p');
    meta.className = 'dev-request-view__meta';
    meta.textContent = `${req.areaLabel} (${req.platform})`;

    card.append(cardHead, meta);

    if (req.body) {
      const body = document.createElement('p');
      body.className = 'dev-request-view__body';
      body.textContent = req.body;
      card.append(body);
    }

    const attachments = Array.isArray(req.attachments) ? req.attachments : [];
    if (attachments.length) {
      const thumbs = document.createElement('div');
      thumbs.className = 'dev-request-view__thumbs';
      for (const name of attachments) {
        const img = document.createElement('img');
        img.className = 'dev-request-view__thumb';
        img.src = `/api/dev-requests/${encodeURIComponent(req.id)}/files/${encodeURIComponent(name)}`;
        img.alt = name;
        img.loading = 'lazy';
        thumbs.append(img);
      }
      card.append(thumbs);
    }

    const folder = document.createElement('p');
    folder.className = 'dev-request-view__folder';
    folder.textContent = `data/dev-requests/${req.folder}/`;

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'dev-request-view__done';
    doneBtn.textContent = 'Mark done';
    doneBtn.addEventListener('click', () => {
      void markDone(req.id, doneBtn);
    });

    card.append(folder, doneBtn);
    listEl.append(card);
  }
}

/**
 * @param {string} id
 * @param {HTMLButtonElement} btn
 */
async function markDone(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await fetch(`/api/dev-requests/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || 'Update failed');
    await loadAndRender();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Mark done';
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = String(err?.message || err);
      statusEl.classList.add('dev-request-view__status--err');
    }
  }
}

async function loadAndRender() {
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = 'Loading…';
    statusEl.classList.remove('dev-request-view__status--err');
  }
  const r = await fetch('/api/dev-requests?status=open', { cache: 'no-store' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    if (statusEl) {
      statusEl.textContent = data.error || 'Failed to load requests';
      statusEl.classList.add('dev-request-view__status--err');
    }
    if (listEl) listEl.replaceChildren();
    return;
  }
  renderList(/** @type {DevRequestRow[]} */ (data.requests || []));
}

/** Show overlay with open dev requests. */
export function openDevRequestsViewer() {
  ensureMounted();
  if (!backdrop || !panel) return;
  backdrop.hidden = false;
  panel.hidden = false;
  document.body.classList.add('dev-request-view-open');
  void loadAndRender();
}
