import { createSentimentDialBlock } from './sentiment-dial.js';

const REFRESH_MS = 5 * 60 * 1000;
const FNG_REFRESH_MS = 90 * 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const MW_UP = '#6ee7a8';
const MW_DOWN = '#f87171';
const MW_MUTED = 'var(--muted, #9aa3b2)';

/** @type {Array<{ id: string, label: string }>} */
const QUOTE_RANGE_OPTIONS = [
  { id: '5d', label: '5 days' },
  { id: '1mo', label: '1 month' },
  { id: '3mo', label: '3 months' },
  { id: '6mo', label: '6 months' },
  { id: '1y', label: '1 year' },
  { id: 'ytd', label: 'Year to date' },
];

/**
 * @param {number | null | undefined} pct
 */
function fmtChangePct(pct) {
  if (!Number.isFinite(pct)) return '—';
  return `${Math.abs(pct).toFixed(2)}%`;
}

/**
 * @param {boolean} up
 * @returns {SVGSVGElement}
 */
function buildTrendArrow(up) {
  const arrowSvg = document.createElementNS(SVG_NS, 'svg');
  arrowSvg.setAttribute('viewBox', '0 0 10 18');
  arrowSvg.setAttribute('width', '7');
  arrowSvg.setAttribute('height', '12');
  arrowSvg.setAttribute('class', 'market-watch__arrow-svg');
  arrowSvg.setAttribute('aria-hidden', 'true');

  const ap = document.createElementNS(SVG_NS, 'path');
  ap.setAttribute('fill', 'none');
  ap.setAttribute('stroke-width', '1.85');
  ap.setAttribute('stroke-linecap', 'round');
  ap.setAttribute('stroke-linejoin', 'round');
  if (up) {
    ap.setAttribute('stroke', MW_UP);
    ap.setAttribute('d', 'M5 15.5 V6 M5 6 L2 9.5 M5 6 L8 9.5');
  } else {
    ap.setAttribute('stroke', MW_DOWN);
    ap.setAttribute('d', 'M5 2.5 V12 M5 12 L2 8.5 M5 12 L8 8.5');
  }
  arrowSvg.appendChild(ap);
  return arrowSvg;
}

/**
 * @param {number[]} closes
 * @param {number | null | undefined} changePct
 * @returns {SVGSVGElement | null}
 */
function buildSparkline(closes, changePct) {
  const valid = (closes || []).filter((v) => Number.isFinite(v));
  if (valid.length < 2) return null;

  const w = 54;
  const h = 20;
  const pad = 2;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const span = max - min || 1;

  const pts = valid.map((v, i) => {
    const x = pad + (i / (valid.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  let stroke = MW_MUTED;
  if (Number.isFinite(changePct)) {
    if (changePct > 0) stroke = MW_UP;
    else if (changePct < 0) stroke = MW_DOWN;
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('class', 'market-watch__sparkline');
  svg.setAttribute('aria-hidden', 'true');

  const poly = document.createElementNS(SVG_NS, 'polyline');
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', stroke);
  poly.setAttribute('stroke-width', '1.35');
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('points', pts.join(' '));
  svg.appendChild(poly);
  return svg;
}

/**
 * @param {string | null | undefined} label
 * @param {string | null | undefined} symbol
 */
function displayTickerLabel(label, symbol) {
  const raw = String(label || symbol || '—').trim();
  return raw ? raw.toUpperCase() : '—';
}

/**
 * @param {HTMLElement} body
 * @param {{ tickers: Array<object>, fearGreed?: object, settings?: object }} data
 * @param {{ editing?: boolean, onRemove?: (symbol: string) => void }} [opts]
 */
function renderMarketWatch(body, data, opts = {}) {
  const editing = Boolean(opts.editing);
  body.replaceChildren();
  if (editing) body.classList.add('market-watch__body--editing');
  else body.classList.remove('market-watch__body--editing');

  const quotes = Array.isArray(data?.tickers) ? data.tickers : [];
  if (!quotes.length) {
    const empty = document.createElement('p');
    empty.className = 'market-watch__status';
    empty.textContent = editing ? 'No tickers left.' : 'No tickers — use Edit to add symbols.';
    body.append(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'market-watch__list';

  for (const q of quotes) {
    const li = document.createElement('li');
    li.className = editing ? 'market-watch__row market-watch__row--editing' : 'market-watch__row';

    const sym = document.createElement('span');
    sym.className = 'market-watch__symbol';
    sym.textContent = displayTickerLabel(q.label, q.symbol);

    const vals = document.createElement('span');
    vals.className = 'market-watch__vals';

    const spark = buildSparkline(q.sparkline, q.changePct);
    if (spark) vals.append(spark);

    const chgWrap = document.createElement('span');
    chgWrap.className = 'market-watch__chg-wrap';

    const chg = document.createElement('span');
    chg.className = 'market-watch__chg';

    if (q.ok && Number.isFinite(q.changePct)) {
      if (q.changePct > 0) {
        chg.classList.add('market-watch__chg--up');
        chgWrap.append(buildTrendArrow(true));
      } else if (q.changePct < 0) {
        chg.classList.add('market-watch__chg--down');
        chgWrap.append(buildTrendArrow(false));
      } else {
        chg.classList.add('market-watch__chg--muted');
      }
      chg.textContent = fmtChangePct(q.changePct);
    } else {
      chg.textContent = q.error ? '…' : '—';
      chg.classList.add('market-watch__chg--muted');
    }

    chgWrap.append(chg);
    vals.append(chgWrap);

    const href =
      typeof q.marketUrl === 'string' && /^https?:\/\//i.test(q.marketUrl.trim())
        ? q.marketUrl.trim()
        : typeof q.symbol === 'string'
          ? `https://finance.yahoo.com/quote/${encodeURIComponent(q.symbol)}`
          : '';

    if (href && !editing) {
      const link = document.createElement('a');
      link.className = 'market-watch__link';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(sym, vals);
      link.title = q.shortName ? `${q.shortName} on Yahoo Finance` : 'Open quote on Yahoo Finance';
      li.append(link);
    } else {
      const row = document.createElement('div');
      row.className = 'market-watch__link';
      row.append(sym, vals);
      li.append(row);
    }

    if (editing && typeof opts.onRemove === 'function' && q.symbol) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'market-watch__remove-btn';
      del.textContent = '×';
      del.setAttribute('aria-label', `Remove ${displayTickerLabel(q.label, q.symbol)}`);
      del.title = 'Remove ticker';
      del.addEventListener('click', () => opts.onRemove(q.symbol));
      li.append(del);
    }

    list.append(li);
  }

  body.append(list);
}

/**
 * @param {HTMLElement} footer
 * @param {{ settings: object, onChange: (patch: object) => Promise<void> }} opts
 */
function renderQuoteWindowRow(footer, opts) {
  const row = document.createElement('div');
  row.className = 'market-watch__settings-row market-watch__settings-row--quote';

  const quoteField = document.createElement('label');
  quoteField.className = 'market-watch__settings-field';
  const quoteLbl = document.createElement('span');
  quoteLbl.className = 'market-watch__settings-label';
  quoteLbl.textContent = 'Quote window';
  const quoteSel = document.createElement('select');
  quoteSel.className = 'market-watch__select';
  quoteSel.setAttribute('aria-label', 'Quote time window');
  for (const opt of QUOTE_RANGE_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = opt.label;
    if (opt.id === (opts.settings?.quoteRange || '5d')) o.selected = true;
    quoteSel.append(o);
  }
  quoteField.append(quoteLbl, quoteSel);

  let saving = false;
  quoteSel.addEventListener('change', async () => {
    if (saving) return;
    saving = true;
    quoteSel.disabled = true;
    try {
      await opts.onChange({ quoteRange: quoteSel.value });
    } finally {
      saving = false;
      quoteSel.disabled = false;
    }
  });

  row.append(quoteField);
  footer.append(row);
}

function renderEditAddRow(footer, opts) {
  const addRow = document.createElement('div');
  addRow.className = 'market-watch__add-row market-watch__add-row--footer';

  const newSym = document.createElement('input');
  newSym.type = 'text';
  newSym.className = 'market-watch__input market-watch__input--symbol';
  newSym.placeholder = 'Add symbol (e.g. AAPL)';
  newSym.setAttribute('aria-label', 'New ticker symbol');
  newSym.autocomplete = 'off';
  newSym.spellcheck = false;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'market-watch__add-btn';
  addBtn.textContent = 'Add';

  async function tryAdd() {
    const symbol = newSym.value.trim().toUpperCase();
    if (!symbol) return;
    addBtn.disabled = true;
    try {
      await opts.onAdd(symbol);
      newSym.value = '';
      newSym.focus();
    } finally {
      addBtn.disabled = false;
    }
  }

  addBtn.addEventListener('click', tryAdd);
  newSym.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tryAdd();
    }
  });

  addRow.append(newSym, addBtn);
  footer.append(addRow);
}

/**
 * @param {unknown} sj
 * @param {number} status
 */
function marketWatchSaveErrorMessage(sj, status) {
  const code = sj && typeof sj === 'object' && 'error' in sj ? String(sj.error) : '';
  if (code === 'invalid_symbol') return 'Use a valid symbol (letters, numbers, . ^ = -).';
  if (code === 'duplicate_symbol') return 'That symbol is already in the list.';
  if (code) return code;
  return `HTTP ${status}`;
}

/**
 * @param {HTMLElement | null} container
 */
export function mountMarketWatch(container) {
  if (!container) return;

  const card = document.getElementById('market-sidebar-card');
  container.replaceChildren();
  container.classList.add('market-watch');

  const body = document.createElement('div');
  body.className = 'market-watch__body';
  body.setAttribute('aria-busy', 'true');

  const msg = document.createElement('p');
  msg.className = 'market-watch__status market-watch__msg';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  const footer = document.createElement('div');
  footer.className = 'market-watch__footer';

  const sentimentDial = createSentimentDialBlock();
  const sentimentSub = document.createElement('section');
  sentimentSub.className = 'market-watch__subsection market-watch__subsection--sentiment';
  sentimentSub.setAttribute('aria-labelledby', 'market-watch-sentiment-heading');
  const sentimentHeading = document.createElement('h3');
  sentimentHeading.id = 'market-watch-sentiment-heading';
  sentimentHeading.className = 'market-watch__subsection-heading';
  sentimentHeading.textContent = 'Sentiment';
  sentimentSub.append(sentimentHeading, sentimentDial.section);

  container.append(sentimentSub, body, footer, msg);

  let editing = false;
  /** @type {Array<{ label: string, symbol: string }>} */
  let savedTickers = [];
  /** @type {{ quoteRange: string, fearGreedHorizon: string }} */
  let marketSettings = { quoteRange: '5d', fearGreedHorizon: 'all' };

  function showViewFooter() {
    footer.replaceChildren();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'market-watch__edit-btn';
    btn.textContent = 'Edit';
    btn.addEventListener('click', startEdit);
    footer.append(btn);
  }

  async function saveSettings(patch) {
    const r = await fetch('/api/market-watch/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ...marketSettings, ...patch } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    marketSettings = j.settings || { ...marketSettings, ...patch };
    await refreshQuotes();
  }

  function showEditFooter() {
    footer.replaceChildren();
    renderEditAddRow(footer, { onAdd: addTicker });
    renderQuoteWindowRow(footer, { settings: marketSettings, onChange: saveSettings });
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'market-watch__edit-btn market-watch__edit-btn--primary';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', () => {
      editing = false;
      msg.hidden = true;
      refreshQuotes();
    });
    footer.append(doneBtn);
  }

  async function saveTickerList(tickers) {
    const sr = await fetch('/api/market-watch/tickers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers }),
    });
    const sj = await sr.json().catch(() => ({}));
    if (!sr.ok || sj.ok === false) {
      throw new Error(marketWatchSaveErrorMessage(sj, sr.status));
    }
    savedTickers = Array.isArray(sj.tickers) ? sj.tickers : tickers;
    return savedTickers;
  }

  async function removeTicker(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return;
    const next = savedTickers.filter((t) => t.symbol !== sym);
    msg.textContent = 'Saving…';
    msg.hidden = false;
    msg.classList.remove('market-watch__status--err');
    try {
      await saveTickerList(next);
      msg.hidden = true;
      await refreshQuotes();
    } catch (e) {
      msg.classList.add('market-watch__status--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not remove ticker';
      msg.hidden = false;
    }
  }

  async function addTicker(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return;
    if (savedTickers.some((t) => t.symbol === sym)) {
      msg.textContent = `${sym} is already in the list.`;
      msg.classList.remove('market-watch__status--err');
      msg.hidden = false;
      return;
    }
    msg.textContent = 'Saving…';
    msg.hidden = false;
    msg.classList.remove('market-watch__status--err');
    try {
      await saveTickerList([...savedTickers, { label: sym, symbol: sym }]);
      msg.hidden = true;
      await refreshQuotes();
    } catch (e) {
      msg.classList.add('market-watch__status--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not add ticker';
      msg.hidden = false;
      throw e;
    }
  }

  async function refreshQuotes() {
    body.setAttribute('aria-busy', 'true');
    if (!body.querySelector('.market-watch__list') && !body.querySelector('.market-watch__status--err')) {
      body.replaceChildren();
      const loading = document.createElement('p');
      loading.className = 'market-watch__status';
      loading.textContent = 'Loading…';
      body.append(loading);
    }
    try {
      const r = await fetch('/api/market-watch', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.disabled) {
        body.textContent = 'Market watch disabled';
        sentimentSub.hidden = true;
        if (card) card.hidden = true;
        return;
      }
      sentimentSub.hidden = false;
      const tickers = Array.isArray(j.tickers) ? j.tickers : [];
      savedTickers = tickers.map((q) => ({
        label: displayTickerLabel(q.label, q.symbol),
        symbol: String(q.symbol || '').trim().toUpperCase(),
      }));
      if (j.settings && typeof j.settings === 'object') {
        marketSettings = {
          quoteRange: String(j.settings.quoteRange || '5d'),
          fearGreedHorizon: String(j.settings.fearGreedHorizon || 'all'),
        };
      }
      renderMarketWatch(
        body,
        { tickers, settings: marketSettings },
        editing ? { editing: true, onRemove: removeTicker } : {},
      );
      if (j.fearGreed) sentimentDial.applyFng(j.fearGreed);
      else void sentimentDial.refresh();
      body.removeAttribute('aria-busy');
      msg.hidden = true;
      if (card) card.hidden = false;
      if (editing) showEditFooter();
      else showViewFooter();
    } catch (e) {
      body.replaceChildren();
      const err = document.createElement('p');
      err.className = 'market-watch__status market-watch__status--err';
      err.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load quotes';
      body.append(err);
      body.removeAttribute('aria-busy');
      if (editing) showEditFooter();
      else showViewFooter();
    }
  }

  async function startEdit() {
    editing = true;
    msg.hidden = true;
    try {
      const r = await fetch('/api/market-watch/tickers', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      savedTickers = (Array.isArray(j.tickers) ? j.tickers : []).map((t) => ({
        label: displayTickerLabel(t.label, t.symbol),
        symbol: String(t.symbol || '').trim().toUpperCase(),
      }));
      await refreshQuotes();
    } catch (e) {
      editing = false;
      msg.classList.add('market-watch__status--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load tickers';
      msg.hidden = false;
      showViewFooter();
    }
  }

  void sentimentDial.refresh();

  refreshQuotes();
  window.setInterval(refreshQuotes, REFRESH_MS);
  window.setInterval(() => {
    if (!editing) void sentimentDial.refresh();
  }, FNG_REFRESH_MS);
}
