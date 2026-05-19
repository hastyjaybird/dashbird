/** @typedef {object} Tool */

const el = (tag) => document.createElement(tag);

let tools = [];
let categories = [];
/** @type {Set<string>} */
let selectedIds = new Set();
/** @type {Set<string>} */
let activeCategoryFilters = new Set();
/** @type {Set<string>} */
let activeOsFilters = new Set();
let searchQuery = '';

function collectOsOptions(list) {
  const set = new Set();
  for (const t of list) {
    for (const os of t.operatingSystems || []) {
      const s = String(os || '').trim();
      if (s) set.add(s);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function truncate(text, max = 72) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function stars(n) {
  const v = Math.max(0, Math.min(5, Number(n) || 0));
  const full = Math.floor(v);
  const half = v - full >= 0.5 ? 1 : 0;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - half);
}

function filteredTools(list) {
  const q = searchQuery.trim().toLowerCase();
  return list.filter((t) => {
    if (activeCategoryFilters.size) {
      const cats = t.categories || [];
      if (!cats.some((c) => activeCategoryFilters.has(c))) return false;
    }
    if (activeOsFilters.size) {
      const oss = t.operatingSystems || [];
      if (!oss.some((o) => activeOsFilters.has(o))) return false;
    }
    if (!q) return true;
    const blob = [
      t.name,
      t.bestUsedFor,
      t.url,
      t.pricing?.summary,
      t.pricing?.lowestTier,
      ...(t.features || []),
      ...(t.categories || []),
      ...(t.operatingSystems || []),
    ]
      .join(' ')
      .toLowerCase();
    return blob.includes(q);
  });
}

function renderFilterGroup(container, label, values, activeSet) {
  if (!values.length) return;
  const group = el('div');
  group.className = 'tool-library__filter-group';
  const heading = el('h3');
  heading.className = 'tool-library__filter-heading';
  heading.textContent = label;
  const chips = el('div');
  chips.className = 'tool-library__filter-chips';
  for (const value of values) {
    const btn = el('button');
    btn.type = 'button';
    btn.className = 'tool-library__filter-chip';
    if (activeSet.has(value)) btn.classList.add('tool-library__filter-chip--on');
    btn.textContent = value;
    btn.addEventListener('click', () => {
      if (activeSet.has(value)) activeSet.delete(value);
      else activeSet.add(value);
      renderSidebar(container.closest('.tool-library'));
      renderGrid(container.closest('.tool-library'));
    });
    chips.append(btn);
  }
  group.append(heading, chips);
  container.append(group);
}

function renderSidebar(root) {
  const filtersWrap = root.querySelector('.tool-library__sidebar-filters');
  const clearBtn = root.querySelector('.tool-library__clear-filters');
  if (!filtersWrap) return;
  filtersWrap.replaceChildren();
  const osOptions = collectOsOptions(tools);
  renderFilterGroup(filtersWrap, 'OS', osOptions, activeOsFilters);
  renderFilterGroup(filtersWrap, 'Category', categories, activeCategoryFilters);
  const hasFilters = activeCategoryFilters.size > 0 || activeOsFilters.size > 0;
  if (clearBtn) {
    clearBtn.hidden = !hasFilters;
    clearBtn.onclick = () => {
      activeCategoryFilters.clear();
      activeOsFilters.clear();
      renderSidebar(root);
      renderGrid(root);
    };
  }
}

function buildToolCard(card, tool) {
  const selected = selectedIds.has(tool.id);
  card.className = 'tool-library__card';
  if (selected) card.classList.add('tool-library__card--selected');
  card.dataset.toolId = tool.id;
  card.title = 'Right-click: search for alternatives';

  const pick = el('input');
  pick.type = 'checkbox';
  pick.className = 'tool-library__card-pick';
  pick.checked = selected;
  pick.title = 'Select for delete';
  pick.addEventListener('click', (e) => e.stopPropagation());
  pick.addEventListener('change', () => {
    if (pick.checked) selectedIds.add(tool.id);
    else selectedIds.delete(tool.id);
    card.classList.toggle('tool-library__card--selected', pick.checked);
    updateDeleteBtn(card.closest('.tool-library'));
  });

  const snap = el('div');
  snap.className = 'tool-library__card-snap';
  if (tool.snapshotUrl) {
    const img = el('img');
    img.src = tool.snapshotUrl;
    img.alt = '';
    img.loading = 'lazy';
    snap.append(img);
  }

  const logoRow = el('div');
  logoRow.className = 'tool-library__card-head';
  if (tool.logoUrl) {
    const logo = el('img');
    logo.className = 'tool-library__card-logo';
    logo.src = tool.logoUrl;
    logo.alt = '';
    logo.loading = 'lazy';
    logoRow.append(logo);
  }
  const siteUrl = tool.website || tool.url;
  const title = el('a');
  title.className = 'tool-library__card-title';
  title.href = siteUrl;
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  title.textContent = tool.name || tool.url;
  logoRow.append(title);

  const meta = el('p');
  meta.className = 'tool-library__card-meta';
  const tier = tool.pricing?.lowestTier || tool.pricing?.model || '';
  const priceBit = tier ? String(tier) : '';
  meta.textContent = [stars(tool.rating), Number(tool.rating).toFixed(1), priceBit]
    .filter(Boolean)
    .join(' · ');

  const blurb = el('p');
  blurb.className = 'tool-library__card-blurb';
  const bestForText =
    typeof tool.bestUsedFor === 'string' && tool.bestUsedFor.trim()
      ? tool.bestUsedFor.trim()
      : truncate(tool.pricing?.summary, 72);
  if (bestForText) {
    blurb.textContent = truncate(bestForText, 72);
  } else {
    blurb.hidden = true;
  }

  card.append(pick, snap, logoRow, meta, blurb);
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openAlternativesModal(tool);
  });
}

function renderGrid(root) {
  const grid = root.querySelector('.tool-library__grid');
  const empty = root.querySelector('.tool-library__empty');
  if (!grid) return;
  const list = filteredTools(tools);
  grid.replaceChildren();
  if (!list.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = tools.length
        ? 'No tools match your search or filters.'
        : 'No tools yet — add one with a website URL.';
    }
    return;
  }
  if (empty) empty.hidden = true;
  for (const tool of list) {
    const card = el('article');
    buildToolCard(card, tool);
    grid.append(card);
  }
}

function updateDeleteBtn(root) {
  const btn = root?.querySelector('.tool-library__delete-btn');
  if (!btn) return;
  const n = selectedIds.size;
  btn.disabled = n === 0;
  btn.textContent = n ? `Delete (${n})` : 'Delete';
}

async function refresh(root) {
  const status = root.querySelector('.tool-library__status');
  try {
    const r = await fetch('/api/tool-library', { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    tools = Array.isArray(data.tools) ? data.tools : [];
    categories = Array.isArray(data.categories) ? data.categories : [];
    if (status) status.hidden = true;
    renderSidebar(root);
    renderGrid(root);
    updateDeleteBtn(root);
  } catch (e) {
    if (status) {
      status.hidden = false;
      status.textContent = `Could not load tools (${e?.message || e}).`;
    }
  }
}

function openAddModal(root) {
  const backdrop = el('div');
  backdrop.className = 'tool-library__modal-backdrop';
  const modal = el('div');
  modal.className = 'tool-library__modal';
  const h = el('h3');
  h.className = 'tool-library__modal-title';
  h.textContent = 'Add tool';
  const hint = el('p');
  hint.className = 'tool-library__modal-hint';
  hint.textContent =
    'Type a tool name (e.g. Fusion 360) or paste its homepage URL. Details are auto-filled via OpenRouter (OPENROUTER_API_KEY required).';
  const input = el('input');
  input.type = 'text';
  input.className = 'tool-library__modal-input';
  input.placeholder = 'Fusion 360 or https://example.com';
  const actions = el('div');
  actions.className = 'tool-library__modal-actions';
  const cancel = el('button');
  cancel.type = 'button';
  cancel.className = 'tool-library__btn';
  cancel.textContent = 'Cancel';
  const submit = el('button');
  submit.type = 'button';
  submit.className = 'tool-library__btn tool-library__btn--primary';
  submit.textContent = 'Add tool';
  const msg = el('p');
  msg.className = 'tool-library__modal-msg';
  msg.hidden = true;
  cancel.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  submit.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) return;
    submit.disabled = true;
    msg.hidden = false;
    msg.textContent = 'Finding official site and researching tool…';
    try {
      const r = await fetch('/api/tool-library/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      backdrop.remove();
      await refresh(root);
    } catch (e) {
      msg.textContent = e?.message || 'Add failed';
      submit.disabled = false;
    }
  });
  actions.append(cancel, submit);
  modal.append(h, hint, input, actions, msg);
  backdrop.append(modal);
  document.body.append(backdrop);
  input.focus();
}

async function openAlternativesModal(tool) {
  const backdrop = el('div');
  backdrop.className = 'tool-library__modal-backdrop';
  const modal = el('div');
  modal.className = 'tool-library__modal tool-library__modal--wide';
  const title = el('h3');
  title.className = 'tool-library__modal-title';
  title.textContent = `Alternatives to ${tool.name}`;
  const msg = el('p');
  msg.className = 'tool-library__modal-msg';
  msg.textContent = 'Searching for top alternatives…';
  const list = el('div');
  list.className = 'tool-library__alt-list';
  const actions = el('div');
  actions.className = 'tool-library__modal-actions';
  const cancel = el('button');
  cancel.type = 'button';
  cancel.className = 'tool-library__btn';
  cancel.textContent = 'Close';
  const addBtn = el('button');
  addBtn.type = 'button';
  addBtn.className = 'tool-library__btn tool-library__btn--primary';
  addBtn.textContent = 'Add selected to toolbox';
  addBtn.disabled = true;
  cancel.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  const rowById = new Map();
  addBtn.addEventListener('click', async () => {
    const items = [];
    for (const [id, row] of rowById) {
      const cb = list.querySelector(`input[data-alt-id="${id}"]`);
      if (cb?.checked && !row.isOriginal) items.push({ url: row.url });
    }
    if (!items.length) return;
    addBtn.disabled = true;
    msg.textContent = 'Adding tools…';
    try {
      await fetch('/api/tool-library/tools/import-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      backdrop.remove();
      const root = document.querySelector('.tool-library');
      if (root) await refresh(root);
    } catch (e) {
      msg.textContent = e?.message || 'Import failed';
      addBtn.disabled = false;
    }
  });
  actions.append(cancel, addBtn);
  modal.append(title, msg, list, actions);
  backdrop.append(modal);
  document.body.append(backdrop);
  try {
    const r = await fetch(`/api/tool-library/tools/${encodeURIComponent(tool.id)}/alternatives`, {
      method: 'POST',
    });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    list.replaceChildren();
    msg.textContent = 'Ranked by rating (current tool included). Check rows to add to toolbox.';
    for (const row of data.ranked || []) {
      rowById.set(row.tempId, row);
      const item = el('div');
      item.className = 'tool-library__alt-row';
      if (row.isOriginal) item.classList.add('tool-library__alt-row--original');
      const pick = el('input');
      pick.type = 'checkbox';
      pick.dataset.altId = row.tempId;
      pick.disabled = Boolean(row.isOriginal);
      pick.title = row.isOriginal ? 'Already in toolbox' : 'Add to toolbox';
      const body = el('div');
      body.className = 'tool-library__alt-body';
      const name = el('strong');
      name.textContent = row.isOriginal ? `${row.name} (current)` : row.name;
      const meta = el('span');
      meta.textContent = ` · ${stars(row.rating)} ${row.rating} · ${row.pricing?.model || ''} ${row.pricing?.lowestTier || ''}`;
      body.append(name, meta);
      const bestTxt = typeof row.bestUsedFor === 'string' ? row.bestUsedFor.trim() : '';
      if (bestTxt) {
        const bestLine = el('p');
        bestLine.className = 'tool-library__alt-best-for';
        bestLine.textContent = bestTxt;
        body.append(bestLine);
      }
      item.append(pick, body);
      list.append(item);
    }
    addBtn.disabled = false;
  } catch (e) {
    msg.textContent = e?.message || 'Could not find alternatives';
  }
}

export function mountToolLibrary(mount) {
  if (!mount) return;
  mount.className = 'tool-library';
  mount.replaceChildren();

  const toolbar = el('div');
  toolbar.className = 'tool-library__toolbar';
  const search = el('input');
  search.type = 'search';
  search.className = 'tool-library__search';
  search.placeholder = 'Search tools…';
  search.addEventListener('input', () => {
    searchQuery = search.value;
    renderGrid(mount);
  });
  const addBtn = el('button');
  addBtn.type = 'button';
  addBtn.className = 'tool-library__btn tool-library__btn--primary';
  addBtn.textContent = 'Add tool';
  addBtn.addEventListener('click', () => openAddModal(mount));
  const delBtn = el('button');
  delBtn.type = 'button';
  delBtn.className = 'tool-library__btn tool-library__delete-btn';
  delBtn.textContent = 'Delete';
  delBtn.disabled = true;
  delBtn.addEventListener('click', async () => {
    if (!selectedIds.size) return;
    if (!confirm(`Delete ${selectedIds.size} tool(s)?`)) return;
    delBtn.disabled = true;
    try {
      await fetch('/api/tool-library/tools/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      selectedIds.clear();
      await refresh(mount);
    } catch {
      delBtn.disabled = false;
    }
  });
  toolbar.append(search, addBtn, delBtn);

  const body = el('div');
  body.className = 'tool-library__body';
  const sidebar = el('aside');
  sidebar.className = 'tool-library__sidebar';
  sidebar.setAttribute('aria-label', 'Tool filters');
  const filtersWrap = el('div');
  filtersWrap.className = 'tool-library__sidebar-filters';
  const clearFilters = el('button');
  clearFilters.type = 'button';
  clearFilters.className = 'tool-library__clear-filters';
  clearFilters.textContent = 'Clear filters';
  clearFilters.hidden = true;
  sidebar.append(filtersWrap, clearFilters);
  const main = el('div');
  main.className = 'tool-library__main';
  const status = el('p');
  status.className = 'tool-library__status';
  status.hidden = true;
  const empty = el('p');
  empty.className = 'tool-library__empty';
  const grid = el('div');
  grid.className = 'tool-library__grid';
  main.append(status, empty, grid);
  body.append(sidebar, main);

  mount.append(toolbar, body);
  refresh(mount);
}
