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
let favoritesOnly = false;
let searchQuery = '';
let repairAttempted = false;
/** Max review candidates shown in the dropdown. */
const REVIEW_MAX = 10;
/** @type {ReturnType<typeof setInterval> | null} */
let thinkingDotsTimer = null;
/** @type {string} */
let thinkingDotsLabel = '';
/** Hide review panel until new items arrive (Cancel). */
let reviewDismissed = false;

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

function isPlaceholderPricingText(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return true;
  return /^(unknown|--|n\/a|na|none)$/i.test(s)
    || /pricing not auto-detected|could not auto-detect pricing/i.test(s);
}

function normalizePricingText(text) {
  const raw = String(text || '').trim();
  if (!raw || isPlaceholderPricingText(raw)) return '';
  const s = raw.toLowerCase();
  if (/\bfreemium\b/.test(s)) return 'Freemium';
  if (/\bfree\b/.test(s) && (/\bopen[-\s]?source\b/.test(s) || /\bpersonal use\b/.test(s))) {
    return 'Free';
  }
  if (/^free(\s+plan)?$/i.test(raw) || /\bfree\b/.test(s) && s.length < 48) return 'Free';
  if (/^paid$/i.test(raw)) return 'Paid';
  if (/^\$/.test(raw)) return raw;
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
  if (lowestTier) return lowestTier;
  const model = String(tool?.pricing?.model || '').trim().toLowerCase();
  if (model === 'free') return 'Free';
  if (model === 'freemium') return 'Freemium';
  if (model === 'paid') {
    const summary = normalizePricingText(tool?.pricing?.summary);
    return summary || 'Paid';
  }
  const summary = normalizePricingText(tool?.pricing?.summary);
  if (summary) return summary;
  const bestUsedFor = String(tool?.bestUsedFor || '');
  if (/\bfree\b/i.test(bestUsedFor)) return 'Free';
  return '';
}

function filteredTools(list) {
  const q = searchQuery.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return list.filter((t) => {
    if (favoritesOnly && !t.favorite) return false;
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

  const favGroup = el('div');
  favGroup.className = 'tool-library__filter-group';
  const favHeading = el('h3');
  favHeading.className = 'tool-library__filter-heading';
  favHeading.textContent = 'Saved';
  const favChips = el('div');
  favChips.className = 'tool-library__filter-chips';
  const favBtn = el('button');
  favBtn.type = 'button';
  favBtn.className = 'tool-library__filter-chip';
  if (favoritesOnly) favBtn.classList.add('tool-library__filter-chip--on');
  favBtn.textContent = 'Favorites';
  favBtn.addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    renderSidebar(root);
    renderGrid(root);
  });
  favChips.append(favBtn);
  favGroup.append(favHeading, favChips);
  filtersWrap.append(favGroup);

  const osOptions = collectOsOptions(tools);
  renderFilterGroup(filtersWrap, 'OS', osOptions, activeOsFilters);
  renderFilterGroup(filtersWrap, 'Category', categories, activeCategoryFilters);
  const hasFilters =
    favoritesOnly || activeCategoryFilters.size > 0 || activeOsFilters.size > 0;
  if (clearBtn) {
    clearBtn.hidden = !hasFilters;
    clearBtn.onclick = () => {
      favoritesOnly = false;
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
  card.title = 'Click to open';

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

  const favBtn = el('button');
  favBtn.type = 'button';
  favBtn.className = 'tool-library__card-fav';
  if (tool.favorite) favBtn.classList.add('tool-library__card-fav--on');
  favBtn.setAttribute('aria-label', tool.favorite ? 'Remove from favorites' : 'Add to favorites');
  favBtn.title = tool.favorite ? 'Remove from favorites' : 'Add to favorites';
  favBtn.textContent = tool.favorite ? '★' : '☆';
  favBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !tool.favorite;
    favBtn.disabled = true;
    try {
      const r = await fetch(`/api/tool-library/tools/${encodeURIComponent(tool.id)}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          favorite: next,
          url: tool.url || tool.website,
          catalogId: tool.catalogId || '',
        }),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      tool.favorite = next;
      const idx = tools.findIndex((t) => t.id === tool.id);
      if (idx >= 0) tools[idx] = { ...tools[idx], favorite: next };
      favBtn.classList.toggle('tool-library__card-fav--on', next);
      favBtn.textContent = next ? '★' : '☆';
      favBtn.title = next ? 'Remove from favorites' : 'Add to favorites';
      favBtn.setAttribute('aria-label', favBtn.title);
      const root = card.closest('.tool-library');
      if (favoritesOnly) renderGrid(root);
      renderSidebar(root);
    } catch (err) {
      const status = card.closest('.tool-library')?.querySelector('.tool-library__status');
      if (status) {
        status.hidden = false;
        status.textContent = err?.message || 'Could not update favorite';
      }
    } finally {
      favBtn.disabled = false;
    }
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
      : normalizePricingText(tool.pricing?.summary);
  if (bestForText) {
    blurb.textContent = truncate(bestForText, 120);
  } else {
    blurb.hidden = true;
  }

  const foot = el('div');
  foot.className = 'tool-library__card-foot';
  const altBtn = el('button');
  altBtn.type = 'button';
  altBtn.className = 'tool-library__card-alt';
  altBtn.textContent = 'find alt';
  altBtn.title = 'Search for alternatives in the background';
  altBtn.setAttribute('aria-label', `Find alternatives to ${tool.name || 'this tool'}`);
  altBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    queueAlternativesJob(tool, card.closest('.tool-library'));
  });
  foot.append(altBtn);

  card.append(pick, favBtn, snap, logoRow, meta, ...(catRow ? [catRow] : []), blurb, foot);
  card.addEventListener('click', (e) => {
    if (e.target.closest('input, a, button, label, .tool-library__card-cats')) return;
    window.open(siteUrl, '_blank', 'noopener,noreferrer');
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
      const q = searchQuery.trim();
      if (!tools.length) {
        empty.textContent = 'No tools yet — add one with a website URL.';
      } else if (q) {
        empty.replaceChildren();
        const line = el('span');
        line.textContent = 'No tools match your search or filters. ';
        const hint = el('span');
        hint.className = 'tool-library__empty-hint';
        hint.textContent = `Press Enter to search alternatives for “${q}” in the background.`;
        empty.append(line, hint);
      } else {
        empty.textContent = 'No tools match your search or filters.';
      }
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

/**
 * Online search modal: matched tool + alternatives with checkboxes to add.
 * @param {string} query
 * @param {HTMLElement} root
 */
async function openOnlineSearchModal(query, root) {
  const q = String(query || '').trim();
  if (!q) return;

  const backdrop = el('div');
  backdrop.className = 'tool-library__modal-backdrop';
  const modal = el('div');
  modal.className = 'tool-library__modal tool-library__modal--wide';
  const title = el('h3');
  title.className = 'tool-library__modal-title';
  title.textContent = `Search: ${q}`;
  const msg = el('p');
  msg.className = 'tool-library__modal-msg';
  msg.textContent = 'Searching the web for this tool and alternatives…';
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
  addBtn.textContent = 'Add selected';
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
      if (cb?.checked && !row.alreadyInLibrary) items.push({ url: row.url });
    }
    if (!items.length) return;
    addBtn.disabled = true;
    msg.textContent = 'Adding tools…';
    try {
      const r = await fetch('/api/tool-library/tools/import-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      backdrop.remove();
      searchQuery = '';
      const searchInput = root.querySelector('.tool-library__search');
      if (searchInput) searchInput.value = '';
      await refresh(root);
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
    const r = await fetch('/api/tool-library/tools/search-online', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    list.replaceChildren();
    const ranked = Array.isArray(data.ranked) ? data.ranked : [];
    if (!ranked.length) {
      msg.textContent = 'No tools found online for that name.';
      return;
    }
    msg.textContent =
      'Top match and alternatives. Check rows to add to your toolbox, then Add selected.';
    for (const row of ranked) {
      const id = row.tempId || row.url;
      rowById.set(id, row);
      const item = el('div');
      item.className = 'tool-library__alt-row';
      if (row.tempId === 'matched' || row.source === 'search') {
        item.classList.add('tool-library__alt-row--matched');
      }
      if (row.alreadyInLibrary) item.classList.add('tool-library__alt-row--original');
      const pick = el('input');
      pick.type = 'checkbox';
      pick.dataset.altId = id;
      pick.disabled = Boolean(row.alreadyInLibrary);
      pick.checked = Boolean(
        !row.alreadyInLibrary && (row.tempId === 'matched' || row.source === 'search'),
      );
      pick.title = row.alreadyInLibrary ? 'Already in toolbox' : 'Add to toolbox';
      const body = el('div');
      body.className = 'tool-library__alt-body';
      const name = el('strong');
      name.textContent =
        row.tempId === 'matched' || row.source === 'search'
          ? `${row.name} (match)`
          : row.name;
      const meta = el('span');
      const ratingBit = ratingLabel(row);
      meta.textContent = [ratingBit, row.url || ''].filter(Boolean).join(' · ');
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
    msg.textContent = e?.message || 'Online search failed';
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
            favorite: Boolean(prev.favorite),
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

/** Interchange v1 shape for third-party exporters (matches web-catalog import). */
const IMPORT_BUNDLE_PROMPT = `{
  "version": 1,
  "exported_at": "2026-07-09T00:00:00.000Z",
  "source": "your-tool-name",
  "filter": {},
  "resources": [
    {
      "url": "https://example.com/product",
      "title": "Product Name",
      "summary": "One-line description / best used for",
      "tags": ["design", "AI"],
      "kind_hints": ["tool"],
      "proficient": false,
      "watch_enabled": false,
      "watch_mode": "off",
      "ingest_candidate": false,
      "operating_systems": ["Web", "Windows", "macOS"],
      "icon_path": null
    }
  ]
}`;

function ensureToolKindHints(bundle) {
  const resources = Array.isArray(bundle?.resources) ? bundle.resources : [];
  return {
    ...bundle,
    version: Number(bundle?.version) || 1,
    resources: resources.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const hints = Array.isArray(item.kind_hints) ? [...item.kind_hints] : [];
      if (!hints.some((h) => String(h).toLowerCase() === 'tool')) hints.push('tool');
      return { ...item, kind_hints: hints };
    }),
  };
}

/**
 * Open a JSON file picker, preferring Downloads via the File System Access API.
 * @returns {Promise<{ name: string, text: string } | null>}
 */
async function pickImportJsonFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        startIn: 'downloads',
        types: [
          {
            description: 'Catalog JSON',
            accept: { 'application/json': ['.json'] },
          },
        ],
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, text: await file.text() };
    } catch (e) {
      if (e?.name === 'AbortError') return null;
      // Fall through to <input type="file"> if the picker API is blocked.
    }
  }

  return new Promise((resolve) => {
    const input = el('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    const cleanup = () => {
      input.remove();
      window.removeEventListener('focus', onFocus);
    };
    const onFocus = () => {
      // If the user cancels the dialog, change may never fire.
      setTimeout(() => {
        if (!input.files?.length) {
          cleanup();
          resolve(null);
        }
      }, 400);
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      resolve({ name: file.name, text: await file.text() });
    });
    document.body.append(input);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

function openImportModal(root) {
  const backdrop = el('div');
  backdrop.className = 'tool-library__modal-backdrop';
  const modal = el('div');
  modal.className = 'tool-library__modal tool-library__modal--wide';

  const h = el('h3');
  h.className = 'tool-library__modal-title';
  h.textContent = 'Import tools';

  const hint = el('p');
  hint.className = 'tool-library__modal-hint';
  hint.textContent =
    'Ask a third-party processing tool to export a JSON file in this exact interchange format (version 1). Then choose that file — the picker opens in Downloads when the browser allows it.';

  const pre = el('pre');
  pre.className = 'tool-library__import-schema';
  pre.textContent = IMPORT_BUNDLE_PROMPT;

  const schemaActions = el('div');
  schemaActions.className = 'tool-library__modal-actions tool-library__modal-actions--start';
  const copyBtn = el('button');
  copyBtn.type = 'button';
  copyBtn.className = 'tool-library__btn';
  copyBtn.textContent = 'Copy format prompt';
  copyBtn.title = 'Copy the JSON schema for a third-party tool';
  copyBtn.addEventListener('click', async () => {
    const promptText =
      'Export tools as a single JSON file matching this Dashbird web-catalog interchange v1 schema. ' +
      'Each resource needs at least a public https url. Include kind_hints: ["tool"] so items appear in the Tool Library.\n\n' +
      IMPORT_BUNDLE_PROMPT;
    try {
      await navigator.clipboard.writeText(promptText);
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy format prompt';
      }, 1600);
    } catch {
      copyBtn.textContent = 'Copy failed';
      setTimeout(() => {
        copyBtn.textContent = 'Copy format prompt';
      }, 1600);
    }
  });
  schemaActions.append(copyBtn);

  const fileRow = el('div');
  fileRow.className = 'tool-library__import-file-row';
  const fileLabel = el('span');
  fileLabel.className = 'tool-library__import-file-name';
  fileLabel.textContent = 'No file selected';
  const chooseBtn = el('button');
  chooseBtn.type = 'button';
  chooseBtn.className = 'tool-library__btn tool-library__btn--primary';
  chooseBtn.textContent = 'Choose JSON file…';
  chooseBtn.title = 'Open file explorer (defaults to Downloads)';
  fileRow.append(chooseBtn, fileLabel);

  const actions = el('div');
  actions.className = 'tool-library__modal-actions';
  const cancel = el('button');
  cancel.type = 'button';
  cancel.className = 'tool-library__btn';
  cancel.textContent = 'Cancel';
  const importBtn = el('button');
  importBtn.type = 'button';
  importBtn.className = 'tool-library__btn tool-library__btn--primary';
  importBtn.textContent = 'Import';
  importBtn.disabled = true;

  const msg = el('p');
  msg.className = 'tool-library__modal-msg';
  msg.hidden = true;

  /** @type {{ name: string, text: string } | null} */
  let picked = null;

  const close = () => backdrop.remove();
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  chooseBtn.addEventListener('click', async () => {
    msg.hidden = true;
    chooseBtn.disabled = true;
    try {
      const next = await pickImportJsonFile();
      if (!next) return;
      picked = next;
      fileLabel.textContent = next.name;
      importBtn.disabled = false;
    } catch (e) {
      msg.hidden = false;
      msg.textContent = e?.message || 'Could not open file picker';
    } finally {
      chooseBtn.disabled = false;
    }
  });

  importBtn.addEventListener('click', async () => {
    if (!picked) return;
    importBtn.disabled = true;
    chooseBtn.disabled = true;
    msg.hidden = false;
    msg.textContent = 'Importing…';
    try {
      let parsed;
      try {
        parsed = JSON.parse(picked.text);
      } catch {
        throw new Error('File is not valid JSON');
      }
      const bundle = ensureToolKindHints(parsed);
      if (!Array.isArray(bundle.resources) || !bundle.resources.length) {
        throw new Error('Bundle has no resources[] entries');
      }
      const r = await fetch('/api/web-catalog/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'dashbird',
          section: 'Imported',
          bundle,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      close();
      await refresh(root);
      const status = root.querySelector('.tool-library__status');
      if (status) {
        status.hidden = false;
        status.textContent = `Imported ${data.imported ?? 0} tool(s) from ${picked.name}.`;
      }
    } catch (e) {
      msg.textContent = e?.message || 'Import failed';
      importBtn.disabled = !picked;
      chooseBtn.disabled = false;
    }
  });

  actions.append(cancel, importBtn);
  modal.append(h, hint, pre, schemaActions, fileRow, actions, msg);
  backdrop.append(modal);
  document.body.append(backdrop);
  chooseBtn.focus();
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
  const url = tool.url || tool.website;
  if (!url) return '';
  // Sync tool URL into catalog so discovery jobs have a resource id
  const r = await fetch('/api/web-catalog/resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
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

function stopThinkingDots(root) {
  if (thinkingDotsTimer) {
    clearInterval(thinkingDotsTimer);
    thinkingDotsTimer = null;
  }
  thinkingDotsLabel = '';
  const status = root?.querySelector('.tool-library__status');
  if (status?.dataset.thinking === '1') {
    status.hidden = true;
    status.textContent = '';
    delete status.dataset.thinking;
  }
  const thinking = root?.querySelector('.tool-library__review-thinking');
  if (thinking) {
    thinking.hidden = true;
    thinking.textContent = '';
  }
}

/**
 * Animate trailing dots while a background alternatives search runs.
 * @param {HTMLElement} root
 * @param {string} label
 */
function startThinkingDots(root, label) {
  const status = root?.querySelector('.tool-library__status');
  const thinking = root?.querySelector('.tool-library__review-thinking');
  const wrap = root?.querySelector('.tool-library__review');
  thinkingDotsLabel = label || 'Searching for alternatives';
  if (thinkingDotsTimer) clearInterval(thinkingDotsTimer);
  let n = 0;
  const tick = () => {
    n = (n % 3) + 1;
    const dots = '.'.repeat(n);
    const text = `${thinkingDotsLabel}${dots}`;
    if (status) {
      status.hidden = false;
      status.dataset.thinking = '1';
      status.textContent = text;
    }
    if (thinking) {
      thinking.hidden = false;
      thinking.textContent = text;
    }
    if (wrap) wrap.hidden = false;
  };
  tick();
  thinkingDotsTimer = setInterval(tick, 450);
}

/**
 * @param {HTMLElement} root
 * @returns {Promise<boolean>} true if any discovery job is still pending/running
 */
async function hasActiveDiscoveryJobs() {
  try {
    const r = await fetch('/api/web-catalog/jobs', { cache: 'no-store' });
    const data = await r.json();
    if (!r.ok || data.ok === false) return false;
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs.some((j) => j.status === 'pending' || j.status === 'running');
  } catch {
    return false;
  }
}

/**
 * Queue a background alternatives search (no modal).
 * Accepts a library/catalog tool, or a plain name/query string.
 * @param {object|string} toolOrQuery
 * @param {HTMLElement} root
 */
async function queueAlternativesJob(toolOrQuery, root) {
  const status = root?.querySelector('.tool-library__status');
  const isQuery = typeof toolOrQuery === 'string';
  const tool = isQuery ? null : toolOrQuery;
  const label = isQuery
    ? String(toolOrQuery).trim()
    : tool?.name || tool?.url || tool?.website || 'tool';
  reviewDismissed = false;
  try {
    startThinkingDots(root, `Searching alternatives for ${label}`);
    /** @type {Record<string, string>} */
    const body = {};
    if (!isQuery) {
      const resourceId = await ensureCatalogId(tool);
      if (resourceId) body.resourceId = resourceId;
      else if (tool?.url || tool?.website) body.url = tool.url || tool.website;
      else if (tool?.name) body.name = tool.name;
    } else {
      body.name = String(toolOrQuery).trim();
    }
    if (!body.resourceId && !body.url && !body.name) {
      throw new Error('Could not identify tool for alternatives search');
    }
    const r = await fetch('/api/web-catalog/jobs/alternatives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    startThinkingDots(root, `Searching alternatives for ${label}`);
    refreshReview(root);
  } catch (e) {
    stopThinkingDots(root);
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
  const cancelBtn = root?.querySelector('.tool-library__review-cancel');
  if (!wrap || !list) return;
  try {
    const [reviewRes, active] = await Promise.all([
      fetch('/api/web-catalog/review?status=pending', { cache: 'no-store' }),
      hasActiveDiscoveryJobs(),
    ]);
    const data = await reviewRes.json();
    if (!reviewRes.ok || data.ok === false) throw new Error(data.error || `HTTP ${reviewRes.status}`);
    const allItems = Array.isArray(data.items) ? data.items : [];
    const items = allItems.slice(0, REVIEW_MAX);
    const total = allItems.length;

    if (active && !reviewDismissed) {
      if (!thinkingDotsTimer) {
        startThinkingDots(root, thinkingDotsLabel || 'Searching for alternatives');
      }
    } else if (thinkingDotsTimer && !active) {
      stopThinkingDots(root);
    }

    list.replaceChildren();
    if (heading) {
      if (items.length) {
        heading.textContent =
          total > REVIEW_MAX
            ? `Review (${items.length} of ${total})`
            : `Review (${items.length})`;
      } else {
        heading.textContent = 'Review';
      }
    }

    if (reviewDismissed && items.length) {
      // New candidates arrived after Cancel — show them again.
      reviewDismissed = false;
    }

    wrap.hidden = reviewDismissed || (items.length === 0 && !active);
    if (cancelBtn) cancelBtn.hidden = wrap.hidden;

    for (const item of items) {
      const row = el('div');
      row.className = 'tool-library__review-row';
      const thumbUrl = item.payload?.snapshot_url || item.payload?.logo_url || '';
      if (thumbUrl) {
        const thumb = el('img');
        thumb.className = 'tool-library__review-thumb';
        thumb.src = thumbUrl;
        thumb.alt = '';
        thumb.loading = 'lazy';
        row.append(thumb);
      }
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
    if (!thinkingDotsTimer) wrap.hidden = true;
  }
}

/**
 * Dismiss the review panel (and stop thinking indicator).
 * @param {HTMLElement} root
 */
function cancelReviewPanel(root) {
  reviewDismissed = true;
  stopThinkingDots(root);
  const wrap = root?.querySelector('.tool-library__review');
  if (wrap) wrap.hidden = true;
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
      const priceBit = pricingBadgeText(row);
      meta.textContent = [ratingBit, priceBit].filter(Boolean).join(' · ');
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
  search.placeholder = 'Search tools… Enter finds alternatives in the background';
  search.addEventListener('input', () => {
    searchQuery = search.value;
    renderGrid(mount);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = search.value.trim();
    if (!q) return;
    searchQuery = q;
    renderGrid(mount);
    const matches = filteredTools(tools);
    if (matches.length === 1) {
      queueAlternativesJob(matches[0], mount);
      return;
    }
    if (matches.length > 1) return;
    // No local match — queue background alternatives by name (no popup).
    queueAlternativesJob(q, mount);
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
    const selected = tools.filter((t) => selectedIds.has(t.id));
    const ids = selected.map((t) => t.id).filter(Boolean);
    const catalogIds = selected.map((t) => t.catalogId).filter(Boolean);
    const urls = selected.map((t) => t.url || t.website).filter(Boolean);
    try {
      const r = await fetch('/api/tool-library/tools/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, catalogIds, urls }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      selectedIds.clear();
      await refresh(mount);
    } catch (e) {
      const status = mount.querySelector('.tool-library__status');
      if (status) {
        status.hidden = false;
        status.textContent = e?.message || 'Delete failed';
      }
      delBtn.disabled = false;
      updateDeleteBtn(mount);
    }
  });
  const importBtn = el('button');
  importBtn.type = 'button';
  importBtn.className = 'tool-library__btn';
  importBtn.textContent = 'Import';
  importBtn.title = 'Import tools from a JSON file (Downloads folder)';
  importBtn.addEventListener('click', () => openImportModal(mount));
  const exportBtn = el('button');
  exportBtn.type = 'button';
  exportBtn.className = 'tool-library__btn';
  exportBtn.textContent = 'Export';
  exportBtn.title = 'Download filtered catalog JSON for climate-dash import';
  exportBtn.addEventListener('click', () => {
    window.open('/api/web-catalog/export?kind=tool&project=dashbird', '_blank');
  });
  toolbar.append(search, addBtn, delBtn, importBtn, exportBtn);

  const review = el('section');
  review.className = 'tool-library__review';
  review.hidden = true;
  const reviewHead = el('div');
  reviewHead.className = 'tool-library__review-head';
  const reviewHeading = el('h3');
  reviewHeading.className = 'tool-library__review-heading';
  reviewHeading.textContent = 'Review';
  const reviewCancel = el('button');
  reviewCancel.type = 'button';
  reviewCancel.className = 'tool-library__btn tool-library__review-cancel';
  reviewCancel.textContent = 'Cancel';
  reviewCancel.title = 'Hide review panel';
  reviewCancel.addEventListener('click', () => cancelReviewPanel(mount));
  reviewHead.append(reviewHeading, reviewCancel);
  const reviewThinking = el('p');
  reviewThinking.className = 'tool-library__review-thinking';
  reviewThinking.hidden = true;
  reviewThinking.setAttribute('aria-live', 'polite');
  const reviewList = el('div');
  reviewList.className = 'tool-library__review-list';
  review.append(reviewHead, reviewThinking, reviewList);

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
