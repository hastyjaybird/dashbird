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
let repairAttempted = false;

function collectOsOptions(list) {
  const set = new Set();
  for (const t of list) {
    for (const os of t.operatingSystems || []) {
      const s = String(os || '').trim();
      if (!s) continue;
      if (/^mac\s*os$/i.test(s) || /^macos$/i.test(s)) continue;
      set.add(s);
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

function normalizePricingText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const s = raw.toLowerCase();
  if (/\bfree\b/.test(s) && (/\bopen[-\s]?source\b/.test(s) || /\bpersonal use\b/.test(s))) {
    return 'Free';
  }
  if (/\bfree\b/.test(s)) return 'Free';
  return raw;
}

function ratingLabel(tool) {
  const source = String(tool?.ratingSource || '').trim();
  const rating = Number(tool?.rating);
  if (!source || !Number.isFinite(rating)) return '';
  return [stars(rating), rating.toFixed(1)].join(' ');
}

function pricingBadgeText(tool) {
  const lowestTier = normalizePricingText(tool?.pricing?.lowestTier);
  if (lowestTier && !/^(unknown|--|n\/a|na|none)$/i.test(lowestTier)) return lowestTier;
  const summary = normalizePricingText(tool?.pricing?.summary);
  if (summary) return summary;
  const bestUsedFor = normalizePricingText(tool?.bestUsedFor);
  if (bestUsedFor.includes('Free')) return 'Free';
  const model = normalizePricingText(tool?.pricing?.model);
  return /^unknown$/i.test(model) ? '' : model;
}

function filteredTools(list) {
  const q = searchQuery.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return list.filter((t) => {
    if (activeCategoryFilters.size) {
      const cats = [...(t.categories || []), ...(t.tags || [])];
      if (!cats.some((c) => activeCategoryFilters.has(c))) return false;
    }
    if (activeOsFilters.size) {
      const oss = t.operatingSystems || [];
      if (!oss.some((o) => activeOsFilters.has(o))) return false;
    }
    if (!tokens.length) return true;
    const blob = [
      t.name,
      t.bestUsedFor,
      t.url,
      t.pricing?.summary,
      t.pricing?.lowestTier,
      ...(t.features || []),
      ...(t.categories || []),
      ...(t.tags || []),
      ...(t.kindHints || []),
      ...(t.operatingSystems || []),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((tok) => blob.includes(tok));
  });
}

function statusChip(tool) {
  if (!tool.watchEnabled && tool.watchMode === 'off') return null;
  const st = String(tool.lastStatus || 'pending').toLowerCase();
  const chip = el('span');
  chip.className = `tool-library__status-chip tool-library__status-chip--${st}`;
  chip.textContent =
    st === 'up' ? 'up' : st === 'down' ? 'down' : tool.watchEnabled ? 'watch' : st;
  if (tool.lastCheckedAt) {
    chip.title = `Last checked ${tool.lastCheckedAt}`;
  }
  return chip;
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
  card.title = 'Click to open · Right-click queues background alternatives search';

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
  const chip = statusChip(tool);
  if (chip) logoRow.append(chip);

  const meta = el('p');
  meta.className = 'tool-library__card-meta';
  const priceBit = pricingBadgeText(tool);
  const ratingBit = ratingLabel(tool);
  meta.textContent = [ratingBit, priceBit].filter(Boolean).join(' · ');

  const categories = (tool.categories || []).map((c) => String(c || '').trim()).filter(Boolean);
  let catRow = null;
  if (categories.length) {
    catRow = el('div');
    catRow.className = 'tool-library__card-cats';
    for (const cat of categories.slice(0, 3)) {
      const tag = el('span');
      tag.className = 'tool-library__card-cat';
      tag.textContent = cat;
      catRow.append(tag);
    }
  }

  const blurb = el('p');
  blurb.className = 'tool-library__card-blurb';
  const bestForText =
    typeof tool.bestUsedFor === 'string' && tool.bestUsedFor.trim()
      ? tool.bestUsedFor.trim()
      : truncate(tool.pricing?.summary, 120);
  if (bestForText) {
    blurb.textContent = truncate(bestForText, 120);
  } else {
    blurb.hidden = true;
  }

  card.append(pick, snap, logoRow, meta, ...(catRow ? [catRow] : []), blurb);
  card.addEventListener('click', (e) => {
    if (e.target.closest('input, a, button, label, .tool-library__card-cats')) return;
    window.open(siteUrl, '_blank', 'noopener,noreferrer');
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    queueAlternativesJob(tool, card.closest('.tool-library'));
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
    const [r, cr] = await Promise.all([
      fetch('/api/tool-library', { cache: 'no-store' }),
      fetch('/api/web-catalog?project=dashbird&kind=tool', { cache: 'no-store' }).catch(() => null),
    ]);
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    const byUrl = new Map();
    for (const t of Array.isArray(data.tools) ? data.tools : []) {
      byUrl.set(String(t.url || '').toLowerCase(), t);
    }
    if (cr && cr.ok) {
      const cdata = await cr.json();
      for (const t of Array.isArray(cdata.tools) ? cdata.tools : []) {
        const key = String(t.url || '').toLowerCase();
        if (!byUrl.has(key)) byUrl.set(key, t);
        else {
          const prev = byUrl.get(key);
          byUrl.set(key, {
            ...prev,
            ...t,
            id: prev.id,
            catalogId: t.catalogId || t.id,
            watchEnabled: t.watchEnabled ?? prev.watchEnabled,
            watchMode: t.watchMode ?? prev.watchMode,
            lastStatus: t.lastStatus ?? prev.lastStatus,
            lastCheckedAt: t.lastCheckedAt ?? prev.lastCheckedAt,
          });
        }
      }
    }
    tools = [...byUrl.values()];
    categories = Array.isArray(data.categories) ? data.categories : [];
    for (const t of tools) {
      for (const c of t.categories || t.tags || []) {
        if (c && !categories.includes(c)) categories.push(c);
      }
    }
    categories.sort((a, b) => a.localeCompare(b));
    if (!repairAttempted) {
      repairAttempted = true;
      fetch('/api/tool-library/tools/repair-assets', { method: 'POST' })
        .then((rr) => rr.json())
        .then(async (repair) => {
          if (repair?.repaired > 0) await refresh(root);
        })
        .catch(() => {});
    }
    if (status) status.hidden = true;
    renderSidebar(root);
    renderGrid(root);
    updateDeleteBtn(root);
    refreshReview(root);
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
    'Paste the tool homepage URL to add it. Metadata is derived from the page title/description.';
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

async function ensureCatalogId(tool) {
  if (tool.catalogId) return tool.catalogId;
  // Sync tool URL into catalog so discovery jobs have a resource id
  const r = await fetch('/api/web-catalog/resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: tool.url || tool.website,
      title: tool.name,
      summary: tool.bestUsedFor || '',
      kind_hints: ['tool'],
      tags: tool.categories || [],
      project: 'dashbird',
      section: 'Tools',
      legacy_tool_id: tool.id,
      logo_url: tool.logoUrl || null,
      snapshot_url: tool.snapshotUrl || null,
      operating_systems: tool.operatingSystems || [],
      rating: tool.rating,
      rating_source: tool.ratingSource,
      pricing: tool.pricing || {},
    }),
  });
  const data = await r.json();
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  tool.catalogId = data.resource?.id;
  return tool.catalogId;
}

async function queueAlternativesJob(tool, root) {
  const status = root?.querySelector('.tool-library__status');
  try {
    if (status) {
      status.hidden = false;
      status.textContent = `Queuing alternatives search for ${tool.name}…`;
    }
    const resourceId = await ensureCatalogId(tool);
    const r = await fetch('/api/web-catalog/jobs/alternatives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceId }),
    });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    if (status) {
      status.textContent = `Searching alternatives for ${tool.name} in the background — check Review when ready.`;
      setTimeout(() => {
        if (status.textContent.includes('background')) status.hidden = true;
      }, 5000);
    }
    refreshReview(root);
  } catch (e) {
    if (status) {
      status.hidden = false;
      status.textContent = e?.message || 'Could not queue alternatives job';
    }
  }
}

async function refreshReview(root) {
  const wrap = root?.querySelector('.tool-library__review');
  const list = root?.querySelector('.tool-library__review-list');
  const heading = root?.querySelector('.tool-library__review-heading');
  if (!wrap || !list) return;
  try {
    const r = await fetch('/api/web-catalog/review?status=pending', { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    const items = Array.isArray(data.items) ? data.items : [];
    list.replaceChildren();
    if (heading) heading.textContent = items.length ? `Review (${items.length})` : 'Review';
    wrap.hidden = items.length === 0;
    for (const item of items) {
      const row = el('div');
      row.className = 'tool-library__review-row';
      const body = el('div');
      body.className = 'tool-library__review-body';
      const name = el('strong');
      name.textContent = item.candidate_title || item.candidate_url;
      const meta = el('p');
      meta.className = 'tool-library__review-meta';
      meta.textContent = item.reason || item.candidate_summary || item.candidate_url;
      body.append(name, meta);
      const actions = el('div');
      actions.className = 'tool-library__review-actions';
      const approve = el('button');
      approve.type = 'button';
      approve.className = 'tool-library__btn tool-library__btn--primary';
      approve.textContent = 'Add';
      const reject = el('button');
      reject.type = 'button';
      reject.className = 'tool-library__btn';
      reject.textContent = 'Skip';
      approve.addEventListener('click', async () => {
        approve.disabled = true;
        reject.disabled = true;
        await fetch(`/api/web-catalog/review/${encodeURIComponent(item.id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'approved' }),
        });
        await refresh(root);
        await refreshReview(root);
      });
      reject.addEventListener('click', async () => {
        approve.disabled = true;
        reject.disabled = true;
        await fetch(`/api/web-catalog/review/${encodeURIComponent(item.id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'rejected' }),
        });
        await refreshReview(root);
      });
      actions.append(approve, reject);
      row.append(body, actions);
      list.append(row);
    }
  } catch {
    wrap.hidden = true;
  }
}

/** Legacy sync alternatives modal (kept for import-batch from older flows). */
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
    const ranked = data.ranked || [];
    if (!ranked.length) {
      msg.textContent = 'No new alternatives found (web search returned no tools outside your toolbox).';
      addBtn.disabled = true;
      return;
    }
    msg.textContent = 'Web-discovered alternatives not already in your toolbox. Check rows to add.';
    for (const row of ranked) {
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
      name.textContent = row.name;
      const meta = el('span');
      const ratingBit = ratingLabel(row);
      meta.textContent = [
        ratingBit,
        row.pricing?.model || '',
        row.pricing?.lowestTier || '',
      ]
        .filter(Boolean)
        .join(' · ');
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
  mount.classList.add('tool-library');
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
  const exportBtn = el('button');
  exportBtn.type = 'button';
  exportBtn.className = 'tool-library__btn';
  exportBtn.textContent = 'Export';
  exportBtn.title = 'Download filtered catalog JSON for climate-dash import';
  exportBtn.addEventListener('click', () => {
    window.open('/api/web-catalog/export?kind=tool&project=dashbird', '_blank');
  });
  toolbar.append(search, addBtn, delBtn, exportBtn);

  const review = el('section');
  review.className = 'tool-library__review';
  review.hidden = true;
  const reviewHeading = el('h3');
  reviewHeading.className = 'tool-library__review-heading';
  reviewHeading.textContent = 'Review';
  const reviewList = el('div');
  reviewList.className = 'tool-library__review-list';
  review.append(reviewHeading, reviewList);

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

  mount.append(toolbar, review, body);
  refresh(mount);
  refreshReview(mount);
  setInterval(() => refreshReview(mount), 20_000);
}
