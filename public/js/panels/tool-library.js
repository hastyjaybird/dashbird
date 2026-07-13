/** @typedef {object} Tool */

import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const TOOL_LIBRARY_CACHE_KEY = 'tool-library';
const TOOL_LIBRARY_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

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
/** @type {Set<string>} */
const assetPollInFlight = new Set();
/** @type {Map<string, number>} */
const assetPollAttempts = new Map();
/** @type {ReturnType<typeof setInterval> | null} */
let assetPollTimer = null;
const ASSET_POLL_MAX_ATTEMPTS = 4;

/**
 * Same 8-dot spinning wheel as the old health-sidebar "Check" wait cursor.
 * @returns {HTMLElement}
 */
function createWaitWheel() {
  const wrap = el('div');
  wrap.className = 'tool-library__wait-wheel';
  wrap.setAttribute('aria-hidden', 'true');
  const spin = el('div');
  spin.className = 'tool-library__wait-wheel-spin';
  for (let i = 0; i < 8; i += 1) {
    const dot = el('span');
    dot.className = 'tool-library__wait-wheel-dot';
    spin.append(dot);
  }
  wrap.append(spin);
  return wrap;
}

/**
 * Modal status line with animated chasing dots (cleared by later textContent sets).
 * @param {HTMLElement} msgEl
 * @param {string} label
 */
function setChasingDotsMsg(msgEl, label) {
  if (!msgEl) return;
  msgEl.replaceChildren();
  msgEl.append(document.createTextNode(label));
  const dots = el('span');
  dots.className = 'tool-library__chase-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) {
    const d = el('span');
    d.textContent = '.';
    dots.append(d);
  }
  msgEl.append(dots);
}

function needsSnapshot(tool) {
  if (!tool?.id || String(tool?.snapshotUrl || '').trim()) return false;
  return (assetPollAttempts.get(tool.id) || 0) < ASSET_POLL_MAX_ATTEMPTS;
}

/**
 * Kick refresh-assets for tools missing snapshots, then re-poll the library.
 * @param {HTMLElement} root
 */
function ensureAssetPolling(root) {
  const missing = tools.filter(needsSnapshot);
  if (!missing.length) {
    if (assetPollTimer) {
      clearInterval(assetPollTimer);
      assetPollTimer = null;
    }
    return;
  }
  for (const tool of missing.slice(0, 4)) {
    if (assetPollInFlight.has(tool.id)) continue;
    assetPollInFlight.add(tool.id);
    assetPollAttempts.set(tool.id, (assetPollAttempts.get(tool.id) || 0) + 1);
    fetch(`/api/tool-library/tools/${encodeURIComponent(tool.id)}/refresh-assets`, {
      method: 'POST',
    })
      .then((r) => r.json().catch(() => ({})))
      .then((data) => {
        if (data?.ok && data.tool) {
          const idx = tools.findIndex((t) => t.id === tool.id);
          if (idx >= 0) {
            tools[idx] = { ...tools[idx], ...data.tool };
            if (data.tool.snapshotUrl) {
              const card = root.querySelector(`.tool-library__card[data-tool-id="${CSS.escape(tool.id)}"]`);
              if (card) {
                // Soft update: re-render grid so spinner swaps for the image.
                renderGrid(root);
              }
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        assetPollInFlight.delete(tool.id);
      });
  }
  if (!assetPollTimer) {
    assetPollTimer = setInterval(() => {
      if (!tools.some(needsSnapshot)) {
        clearInterval(assetPollTimer);
        assetPollTimer = null;
        return;
      }
      // Prefer soft refresh of assets without a full library reload when possible.
      ensureAssetPolling(root);
      if (tools.some((t) => t.snapshotUrl && root.querySelector(`.tool-library__card-snap--loading`))) {
        renderGrid(root);
      }
    }, 4000);
  }
}

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
  if (/\bfreemium\b/.test(s)) return 'Free';
  const freeSlash = raw.match(/^free\s*\/\s*(\$\s*[\d,.]+(?:\s*\/\s*(?:mo|month|yr|year|user|seat))?)/i);
  if (freeSlash) {
    const paid = freeSlash[1].replace(/\s+/g, '').replace(/\/month/i, '/mo').replace(/\/year/i, '/yr');
    return `Free / ${paid}`;
  }
  if (/\bfree\b/.test(s) && (/\bopen[-\s]?source\b/.test(s) || /\bpersonal use\b/.test(s))) {
    return 'Free';
  }
  if (/^free(\s+plan)?$/i.test(raw) || (/\bfree\b/.test(s) && s.length < 48 && !/\bfree trial\b/.test(s))) {
    return 'Free';
  }
  // Prefer an explicit dollar amount over the bare word "Paid".
  const dollar = raw.match(
    /\$\s*[\d,.]+(?:\s*\/\s*(?:mo|month|yr|year|user|seat))?/i,
  );
  if (dollar) {
    return dollar[0]
      .replace(/\s+/g, '')
      .replace(/\/month/i, '/mo')
      .replace(/\/year/i, '/yr');
  }
  const from = raw.match(/^from\s+(\$\S+)/i);
  if (from) return from[1];
  if (/^paid$/i.test(raw)) return '';
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
  const pricing = tool?.pricing || {};
  const lowestTier = normalizePricingText(pricing.lowestTier);
  if (lowestTier) return lowestTier;
  const summary = normalizePricingText(pricing.summary);
  if (summary) return summary;
  const model = String(pricing.model || '').trim().toLowerCase();
  if (model === 'free' || model === 'freemium') return 'Free';
  // Never show bare "Paid" — leave blank until a lowest tier price is known.
  if (model === 'paid') return '';
  const bestUsedFor = String(tool?.bestUsedFor || '');
  if (/\bfree\b/i.test(bestUsedFor) && !/\bfree trial\b/i.test(bestUsedFor)) return 'Free';
  return '';
}

/** Prefer concrete Free/$ price over unknown/freemium placeholders when merging catalog. */
function preferPricing(a, b) {
  const score = (p) => {
    const model = String(p?.model || '').toLowerCase();
    const tier = String(p?.lowestTier || '');
    const summary = String(p?.summary || '');
    if (!p || model === 'unknown' || !model) return 0;
    if (/pricing not auto-detected/i.test(summary)) return 0;
    if (model === 'freemium' || /\bfreemium\b/i.test(tier) || /\bfreemium\b/i.test(summary)) return 1;
    if (model === 'free' && /^free\s*\//i.test(tier)) return 4;
    if (model === 'free' && tier.toLowerCase() === 'free') return 2;
    if (/^\$/.test(tier)) return 3;
    if (model === 'paid') return 2;
    if (model === 'free') return 2;
    return 1;
  };
  return score(a) >= score(b) ? a || b || {} : b || a || {};
}

function filteredTools(list) {
  const q = searchQuery.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return list.filter((t) => {
    if (isAppleOrMacOnlyTool(t)) return false;
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
    const name = String(t.name || '').toLowerCase();
    const nameCompact = name.replace(/[^a-z0-9]+/g, '');
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
    return tokens.every((tok) => {
      if (blob.includes(tok)) return true;
      const fixed = COMMON_SEARCH_TYPOS[tok] || COMMON_SEARCH_TYPOS[tok.replace(/\s+/g, '')];
      if (fixed && (blob.includes(fixed) || nameCompact.includes(fixed))) return true;
      const tokCompact = tok.replace(/[^a-z0-9]+/g, '');
      if (
        tokCompact.length >= 4 &&
        nameCompact &&
        Math.abs(tokCompact.length - nameCompact.length) <= 2 &&
        editDistance(tokCompact, nameCompact) <= 2
      ) {
        return true;
      }
      return false;
    });
  });
}

/** @type {Record<string, string>} */
const COMMON_SEARCH_TYPOS = {
  pintrest: 'pinterest',
  pinterst: 'pinterest',
  pinteres: 'pinterest',
  notoin: 'notion',
  figam: 'figma',
  midjounrey: 'midjourney',
  chatgbt: 'chatgpt',
  chatgtp: 'chatgpt',
};

/**
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  if (Math.abs(s.length - t.length) > 3) return 99;
  /** @type {number[]} */
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    /** @type {number[]} */
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/** OS labels that are Apple-ecosystem only. */
const APPLE_ONLY_OS = new Set(['macos', 'mac', 'osx', 'ios', 'ipados', 'watchos', 'tvos']);

/**
 * @param {string} os
 */
function normalizeOsLabel(os) {
  return String(os || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * Hide Apple/macOS-only tools from search and browse.
 * Cross-platform tools that also support macOS are kept.
 * @param {object} tool
 */
function isAppleOrMacOnlyTool(tool) {
  if (!tool) return false;
  let host = '';
  try {
    host = new URL(String(tool.url || tool.website || ''))
      .hostname.replace(/^www\./, '')
      .toLowerCase();
  } catch {
    host = '';
  }
  if (
    host === 'apple.com' ||
    host.endsWith('.apple.com') ||
    host === 'apps.apple.com' ||
    host === 'developer.apple.com' ||
    host === 'itunes.apple.com'
  ) {
    return true;
  }
  const name = String(tool.name || '').toLowerCase();
  if (
    /\bfinal\s*cut\b/.test(name) ||
    /\blogic\s*pro\b/.test(name) ||
    /\bxcode\b/.test(name) ||
    /\bgarageband\b/.test(name) ||
    /\bapple\s+(keynote|pages|numbers|motion|compressor)\b/.test(name)
  ) {
    return true;
  }
  const oss = (tool.operatingSystems || []).map(normalizeOsLabel).filter(Boolean);
  if (!oss.length) return false;
  return oss.every((o) => APPLE_ONLY_OS.has(o));
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
  card.dataset.toolId = tool.id || '';
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
    if (favBtn.disabled) return;
    const next = !Boolean(tool.favorite);
    favBtn.disabled = true;
    const root = card.closest('.tool-library');
    const status = root?.querySelector('.tool-library__status');
    try {
      const r = await fetch(`/api/tool-library/tools/${encodeURIComponent(tool.id)}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          favorite: next,
          url: tool.url || tool.website || '',
          catalogId: tool.catalogId || '',
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `Could not update favorite (HTTP ${r.status})`);
      }
      const saved = Boolean(data.tool?.favorite ?? next);
      tool.favorite = saved;
      const idx = tools.findIndex((t) => t.id === tool.id);
      if (idx >= 0) tools[idx] = { ...tools[idx], favorite: saved };
      favBtn.classList.toggle('tool-library__card-fav--on', saved);
      favBtn.textContent = saved ? '★' : '☆';
      favBtn.title = saved ? 'Remove from favorites' : 'Add to favorites';
      favBtn.setAttribute('aria-label', favBtn.title);
      if (status?.textContent?.startsWith('Could not')) {
        status.hidden = true;
        status.textContent = '';
      }
      if (favoritesOnly) renderGrid(root);
      else renderSidebar(root);
    } catch (err) {
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
  } else {
    snap.classList.add('tool-library__card-snap--loading');
    snap.title = 'Fetching preview image…';
    snap.setAttribute('aria-busy', 'true');
    snap.append(createWaitWheel());
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
  altBtn.title = 'Search the web for this tool and alternatives';
  altBtn.setAttribute('aria-label', `Find alternatives to ${tool.name || 'this tool'}`);
  altBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const q = String(tool.name || tool.url || tool.website || '').trim();
    if (!q) return;
    openOnlineSearchModal(q, card.closest('.tool-library'));
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
        hint.textContent = `Press Enter to search the web for “${q}”.`;
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

/** Hide the “Press Enter to search…” empty hint after Enter starts an online search. */
function clearEmptyEnterHint(root) {
  const empty = root?.querySelector('.tool-library__empty');
  if (!empty || empty.hidden) return;
  const hint = empty.querySelector('.tool-library__empty-hint');
  if (hint) hint.remove();
  const q = searchQuery.trim();
  if (q && !filteredTools(tools).length) {
    empty.textContent = `Searching the web for “${q}”…`;
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
  setChasingDotsMsg(msg, 'Searching the web for this tool and alternatives');
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
  const ac = new AbortController();
  let closed = false;
  const clearSearchAndShowLibrary = () => {
    searchQuery = '';
    const searchInput = root.querySelector('.tool-library__search');
    if (searchInput) searchInput.value = '';
    renderGrid(root);
  };
  const closeModal = () => {
    closed = true;
    ac.abort();
    backdrop.remove();
    clearSearchAndShowLibrary();
  };
  cancel.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  const rowById = new Map();
  addBtn.addEventListener('click', async () => {
    const items = [];
    for (const [id, row] of rowById) {
      const cb = list.querySelector(`input[data-alt-id="${id}"]`);
      if (cb?.checked) items.push({ url: row.url });
    }
    if (!items.length) return;
    addBtn.disabled = true;
    setChasingDotsMsg(msg, 'Adding tools');
    try {
      const r = await fetch('/api/tool-library/tools/import-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
        signal: ac.signal,
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      closed = true;
      backdrop.remove();
      clearSearchAndShowLibrary();
      await refresh(root);
    } catch (e) {
      if (closed || e?.name === 'AbortError') return;
      msg.textContent = e?.message || 'Import failed';
      addBtn.disabled = false;
    }
  });
  actions.append(cancel, addBtn);
  modal.append(title, msg, list, actions);
  backdrop.append(modal);
  document.body.append(backdrop);

  try {
    let data = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (closed) return;
      const timeout = setTimeout(() => ac.abort(), 50_000);
      let r;
      try {
        r = await fetch('/api/tool-library/tools/search-online', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      data = await r.json().catch(() => ({}));
      if (r.status === 429 || data?.error === 'search_busy') {
        setChasingDotsMsg(msg, 'Waiting for the previous search to finish');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      break;
    }
    if (closed) return;
    if (!data || data.ok === false) {
      throw new Error(data?.error === 'search_busy' ? 'search_busy' : data?.error || 'search_failed');
    }
    list.replaceChildren();
    const ranked = (Array.isArray(data.ranked) ? data.ranked : []).filter(
      (row) => !isAppleOrMacOnlyTool(row) && !row.alreadyInLibrary,
    );
    if (!ranked.length) {
      msg.textContent = 'No new tools found online (matches are already in your toolbox).';
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
      const pick = el('input');
      pick.type = 'checkbox';
      pick.dataset.altId = id;
      pick.checked = Boolean(row.tempId === 'matched' || row.source === 'search');
      pick.title = 'Add to toolbox';
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
    if (closed || e?.name === 'AbortError') {
      if (!closed) msg.textContent = 'Search timed out — try again, or paste the website URL.';
      return;
    }
    msg.textContent =
      e?.message === 'search_busy'
        ? 'Another search is still running. Close and try again in a moment.'
        : e?.message === 'search_timeout'
          ? 'Search timed out — try again, or paste the website URL.'
          : e?.message || 'Online search failed';
  }
}

function updateDeleteBtn(root) {
  const btn = root?.querySelector('.tool-library__delete-btn');
  if (!btn) return;
  const n = selectedIds.size;
  btn.disabled = n === 0;
  btn.textContent = n ? `Delete (${n})` : 'Delete';
}

/**
 * @param {HTMLElement} root
 * @param {{ tools: object[], categories: string[] }} payload
 */
function applyToolLibraryPayload(root, payload) {
  tools = Array.isArray(payload?.tools) ? payload.tools : [];
  categories = Array.isArray(payload?.categories) ? [...payload.categories] : [];
  for (const t of tools) {
    for (const c of t.categories || t.tags || []) {
      if (c && !categories.includes(c)) categories.push(c);
    }
  }
  categories.sort((a, b) => a.localeCompare(b));
  const status = root.querySelector('.tool-library__status');
  if (status) status.hidden = true;
  renderSidebar(root);
  renderGrid(root);
  updateDeleteBtn(root);
  ensureAssetPolling(root);
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
        // Skip bare catalog stubs (name-only search used to upsert these by mistake).
        const isStub =
          !t.bestUsedFor &&
          !t.logoUrl &&
          !t.snapshotUrl &&
          !(t.categories || []).length &&
          !(t.tags || []).length &&
          !t.favorite;
        if (!byUrl.has(key)) {
          if (isStub) continue;
          byUrl.set(key, t);
        } else {
          const prev = byUrl.get(key);
          const mergedPricing = preferPricing(prev?.pricing, t.pricing);
          byUrl.set(key, {
            ...prev,
            ...t,
            id: prev.id,
            catalogId: t.catalogId || t.id,
            pricing: mergedPricing,
            favorite: Boolean(prev.favorite || t.favorite),
            watchEnabled: t.watchEnabled ?? prev.watchEnabled,
            watchMode: t.watchMode ?? prev.watchMode,
            lastStatus: t.lastStatus ?? prev.lastStatus,
            lastCheckedAt: t.lastCheckedAt ?? prev.lastCheckedAt,
          });
        }
      }
    }
    const nextTools = [...byUrl.values()];
    const nextCategories = Array.isArray(data.categories) ? data.categories : [];
    writePanelCache(TOOL_LIBRARY_CACHE_KEY, { tools: nextTools, categories: nextCategories });
    applyToolLibraryPayload(root, { tools: nextTools, categories: nextCategories });
    if (!repairAttempted) {
      repairAttempted = true;
      fetch('/api/tool-library/tools/repair-assets', { method: 'POST' })
        .then((rr) => rr.json())
        .then(async (repair) => {
          if (repair?.repaired > 0) await refresh(root);
        })
        .catch(() => {});
    }
  } catch (e) {
    if (tools.length) return;
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

export function mountToolLibrary(mount) {
  if (!mount) return;
  mount.classList.add('tool-library');
  mount.replaceChildren();

  const toolbar = el('div');
  toolbar.className = 'tool-library__toolbar';
  const search = el('input');
  search.type = 'search';
  search.className = 'tool-library__search';
  search.placeholder = 'Search tools… Enter searches the web when nothing matches';
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
    if (matches.length > 1) return;
    // Zero or one local match — open web search (match + alternatives).
    clearEmptyEnterHint(mount);
    openOnlineSearchModal(q, mount);
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

  const cached = readPanelCache(TOOL_LIBRARY_CACHE_KEY, TOOL_LIBRARY_CACHE_MAX_MS);
  if (cached && typeof cached === 'object' && Array.isArray(cached.tools) && cached.tools.length) {
    applyToolLibraryPayload(mount, cached);
  } else {
    status.hidden = false;
    status.textContent = 'Loading tools…';
  }

  refresh(mount);
}
