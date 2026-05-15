import {
  refreshOpenRouterLimitMount,
  setOpenRouterLimitMount,
} from '../lib/openrouter-limit-ring.js';

const LS_KEY = 'dashbirdHealthCollapsed';

const RING_SIZE = 34;
const RING_STROKE = 3;

const ICON_WARN_TRI =
  '<svg class="health-check-warn__tri" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#e8b935" stroke="rgba(0,0,0,0.35)" stroke-width="0.35" d="M12 3 1 21h22L12 3zm0 3.9L18.2 19H5.8L12 6.9z"/><path fill="#1a1410" d="M11 15h2v3h-2v-3zm0-5.5h2v3.5h-2V9.5z"/></svg>';

const ICON_OK_CHECK =
  '<svg class="health-check-modal__okicon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#5cdd7a" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';

/** OpenRouter: rounded-square robot face, eyes, antennae (no mouth). */
const ICON_OPENROUTER = `<svg class="health-metric__icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="6.75" width="13" height="11" rx="3.5" fill="none"/><circle cx="9.45" cy="12.2" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.55" cy="12.2" r="1.4" fill="currentColor" stroke="none"/><path d="M8.35 6.75L6.85 3.85M15.65 6.75L17.15 3.85"/></svg>`;

const ICON_NET = `<svg class="health-metric__icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M 4.8 13.2 A 7.2 7.2 0 0 0 19.2 13.2" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" opacity="0.88"/><path d="M 12 13 L 16.2 7.8" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/><circle cx="12" cy="13" r="1.35" fill="currentColor"/></svg>`;

const ICON_THERM = `<svg class="health-metric__icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4zm-4-8c0-.55.45-1 1-1s1 .45 1 1h-1v1h1v2h-1v1h1v2h-2V5z"/></svg>`;

const ICON_RAM = `<svg class="health-metric__icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 3H7c-1.1 0-2 .9-2 2v14l4-2 4 2 4-2 4 2V5c0-1.1-.9-2-2-2zm0 12.97l-2-1.15-2 1.15V5h4v10.97z"/></svg>`;

const ICON_BACKUP = `<svg class="health-metric__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="2.75"/><path d="M5 6v12c0 1.52 3.13 2.75 7 2.75S19 19.52 19 18V6"/><ellipse cx="12" cy="18" rx="7" ry="2.75"/></svg>`;

/** Slightly smaller than `.health-metric__icon` (Feather-style ∞, MIT). */
const ICON_INFINITY_BACKUP = `<svg class="health-backup-infinity-icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 1 0 0-8c-2 0-4 1.33-6 4z"/></svg>`;

function hamburgerSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', '3');
    r.setAttribute('y', String(5 + i * 5));
    r.setAttribute('width', '18');
    r.setAttribute('height', '2');
    r.setAttribute('rx', '1');
    r.setAttribute('fill', 'currentColor');
    svg.appendChild(r);
  }
  return svg;
}

function pctLabel(pct) {
  if (pct == null || Number.isNaN(pct)) return '—';
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}

/**
 * @param {HTMLElement} wrap
 * @param {number|null} pct 0–100 fill
 * @param {string} _unusedTitle
 * @param {string|null|undefined} centerText
 * @param {'net'|undefined} ringVariant
 * @param {{ uploadMbps?: number|null, downloadMbps?: number|null, phaseUpload?: boolean }|null} [netOpts]
 *        When `ringVariant === 'net'` and set, center shows one rate (same type size as other rings);
 *        tailed upload/download arrow sits outside the ring to the right (alternates every 10s).
 */
function renderRing(wrap, pct, _unusedTitle, centerText, ringVariant, netOpts = null) {
  wrap.replaceChildren();
  const p = pct == null || Number.isNaN(pct) ? 0 : Math.min(100, Math.max(0, pct));
  const size = RING_SIZE;
  const stroke = RING_STROKE;
  const r = (size - stroke) / 2 - 0.5;
  const c = 2 * Math.PI * r;
  const dash = (c * p) / 100;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'health-ring__svg');
  svg.setAttribute('role', 'img');
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('transform', `translate(${size / 2},${size / 2}) rotate(-90)`);
  const track = document.createElementNS(ns, 'circle');
  track.setAttribute('r', String(r));
  track.setAttribute('fill', 'none');
  track.setAttribute('class', 'health-ring__track');
  track.setAttribute('stroke-width', String(stroke));
  const prog = document.createElementNS(ns, 'circle');
  prog.setAttribute('r', String(r));
  prog.setAttribute('fill', 'none');
  prog.setAttribute('class', 'health-ring__progress');
  prog.setAttribute('stroke-width', String(stroke));
  prog.setAttribute('stroke-linecap', 'round');
  prog.setAttribute('stroke-dasharray', `${dash} ${c}`);
  g.append(track, prog);

  const cx = size / 2;
  const cy = size / 2;
  const useNetCenter = ringVariant === 'net' && netOpts != null;

  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', String(cx));
  text.setAttribute('y', String(cy));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('class', 'health-ring__pct');

  if (useNetCenter) {
    const phaseUp = netOpts.phaseUpload !== false;
    const raw = phaseUp ? netOpts.uploadMbps : netOpts.downloadMbps;
    text.textContent = fmtMbpsInt(raw);
    svg.append(g, text);

    const arrowSvg = document.createElementNS(ns, 'svg');
    arrowSvg.setAttribute('viewBox', '0 0 10 18');
    arrowSvg.setAttribute('width', '8');
    arrowSvg.setAttribute('height', '16');
    arrowSvg.setAttribute('class', 'health-ring__net-arrow-svg');
    arrowSvg.setAttribute('aria-hidden', 'true');
    const ap = document.createElementNS(ns, 'path');
    ap.setAttribute('fill', 'none');
    ap.setAttribute('stroke-width', '1.85');
    ap.setAttribute('stroke-linecap', 'round');
    ap.setAttribute('stroke-linejoin', 'round');
    if (phaseUp) {
      ap.setAttribute('stroke', '#52c97a');
      ap.setAttribute('d', 'M5 15.5 V6 M5 6 L2 9.5 M5 6 L8 9.5');
    } else {
      ap.setAttribute('stroke', '#9d4b86');
      ap.setAttribute('d', 'M5 2.5 V12 M5 12 L2 8.5 M5 12 L8 8.5');
    }
    arrowSvg.appendChild(ap);

    const cap = document.createElement('div');
    cap.className = 'health-ring health-ring--net';
    cap.append(svg, arrowSvg);
    wrap.appendChild(cap);
    return;
  }

  text.textContent = centerText != null ? centerText : pctLabel(pct);
  svg.append(g, text);

  const cap = document.createElement('div');
  cap.className = 'health-ring';
  cap.appendChild(svg);
  wrap.appendChild(cap);
}

function metricRow(iconHtml, ringWrap, iconWrapExtraClass = '') {
  const row = document.createElement('div');
  row.className = 'health-metric';
  const iconHost = document.createElement('div');
  iconHost.className = 'health-metric__icon-wrap';
  if (iconWrapExtraClass) iconHost.classList.add(iconWrapExtraClass);
  iconHost.innerHTML = iconHtml;
  row.append(iconHost, ringWrap);
  return row;
}

function formatKiB(kib) {
  if (kib == null || !Number.isFinite(kib)) return '';
  const gb = kib / (1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = kib / 1024;
  return `${mb.toFixed(0)} MB`;
}

function fmtMbps(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 100) return `${Math.round(v)}`;
  return v.toFixed(1);
}

/** Compact Mbps label for ring center (download/upload). */
function fmtMbpsInt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return String(Math.round(Math.min(v, 9999)));
}

function buildNetworkRow(ringNet) {
  const row = document.createElement('div');
  row.className = 'health-metric health-metric--network';
  const iconHost = document.createElement('div');
  iconHost.className = 'health-metric__icon-wrap';
  iconHost.innerHTML = ICON_NET;
  row.append(iconHost, ringNet);
  return row;
}

function backupDaysFromIso(iso) {
  const t = typeof iso === 'string' ? iso.trim() : '';
  if (!t) {
    return {
      main: '',
      sub: '',
      title: 'Set LAST_BACKUP_AT in .env or public/data/last-backup.txt (ISO 8601).',
      showInfinityIcon: true,
    };
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) {
    return { main: '?', sub: 'bad date', title: `Could not parse: ${t}` };
  }
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  const when = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return {
    main: `${days} day${days === 1 ? '' : 's'}`,
    sub: 'since last backup',
    title: `Last backup: ${when}\n(${days} full calendar day(s) since that timestamp.)`,
  };
}

function buildBackupRow() {
  const row = document.createElement('div');
  row.className = 'health-metric health-backup-row';
  const iconHost = document.createElement('div');
  iconHost.className = 'health-metric__icon-wrap';
  iconHost.innerHTML = ICON_BACKUP;
  const stat = document.createElement('div');
  stat.className = 'health-backup-stat';
  const mainEl = document.createElement('div');
  mainEl.className = 'health-backup-main';
  const subEl = document.createElement('div');
  subEl.className = 'health-backup-sub';
  stat.append(mainEl, subEl);
  row.append(iconHost, stat);
  return { row, mainEl, subEl };
}

function setRowTip(row, name, body) {
  row.dataset.healthTipName = name;
  row.dataset.healthTipBody = encodeURIComponent((body || '').slice(0, 2800));
}

function tipFromTarget(aside, target) {
  if (!(target instanceof Element)) return null;
  const direct = target.closest('[data-health-tip-name]');
  if (direct && aside.contains(direct)) return direct;
  const row = target.closest('.health-metric');
  if (row && aside.contains(row)) {
    const inner = row.querySelector('[data-health-tip-name]');
    if (inner) return inner;
    if (row.dataset.healthTipName) return row;
  }
  const bk = target.closest('.health-backup-row');
  if (bk && aside.contains(bk) && bk.dataset.healthTipName) return bk;
  return null;
}

function positionTip(tip, clientX, clientY) {
  const pad = 12;
  let left = clientX + pad;
  let top = clientY + pad;
  const rect = tip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function showHealthTip(tipEl, clientX, clientY, src) {
  const name = src.dataset.healthTipName;
  if (!name) return;
  let body = '';
  try {
    body = src.dataset.healthTipBody ? decodeURIComponent(src.dataset.healthTipBody) : '';
  } catch {
    body = '';
  }
  tipEl.replaceChildren();
  const title = document.createElement('div');
  title.className = 'dashbird-health-tip__title';
  title.textContent = name;
  tipEl.append(title);
  if (body) {
    const detail = document.createElement('div');
    detail.className = 'dashbird-health-tip__detail';
    detail.textContent = body;
    tipEl.append(detail);
  }
  tipEl.hidden = false;
  positionTip(tipEl, clientX, clientY);
}

/**
 * @param {any} j
 */
function openCheckReportModal(j) {
  const existing = document.querySelector('.health-check-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'health-check-modal';
  overlay.setAttribute('role', 'presentation');

  const panel = document.createElement('div');
  panel.className = 'health-check-modal__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'health-check-modal-title');

  const head = document.createElement('div');
  head.className = 'health-check-modal__head';
  const h = document.createElement('h2');
  h.id = 'health-check-modal-title';
  h.className = 'health-check-modal__title';
  h.textContent = 'Connectivity check';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'health-check-modal__close';
  closeBtn.textContent = 'Close';
  head.append(h, closeBtn);

  const body = document.createElement('div');
  body.className = 'health-check-modal__body';

  if (j?.error && typeof j.error === 'string') {
    const p = document.createElement('p');
    p.className = 'health-check-modal__err';
    p.textContent = j.error;
    body.append(p);
  }

  const list = Array.isArray(j?.results) ? j.results : [];
  const failed = list.filter((x) => !x.ok);
  const passed = list.filter((x) => x.ok);

  for (const f of failed) {
    const li = document.createElement('div');
    li.className = 'health-check-modal__issue';
    const icon = document.createElement('span');
    icon.className = 'health-check-modal__issue-icon';
    icon.innerHTML = ICON_WARN_TRI;
    const text = document.createElement('div');
    text.className = 'health-check-modal__issue-text';
    const strong = document.createElement('strong');
    strong.textContent = f.label || f.id || 'Check';
    text.append(strong);
    if (f.detail) {
      const d = document.createElement('div');
      d.className = 'health-check-modal__issue-detail';
      d.textContent = f.detail;
      text.append(d);
    }
    li.append(icon, text);
    body.append(li);
  }

  if (passed.length) {
    const sep = document.createElement('div');
    sep.className = 'health-check-modal__sep';
    sep.textContent = 'Also verified';
    body.append(sep);
    for (const p of passed) {
      const li = document.createElement('div');
      li.className = 'health-check-modal__pass';
      const icon = document.createElement('span');
      icon.className = 'health-check-modal__pass-icon';
      icon.innerHTML = ICON_OK_CHECK;
      const span = document.createElement('span');
      span.className = 'health-check-modal__pass-label';
      span.textContent = p.detail ? `${p.label} (${p.detail})` : p.label || p.id;
      li.append(icon, span);
      body.append(li);
    }
  }

  if (!failed.length && !passed.length && !j?.error) {
    const p = document.createElement('p');
    p.className = 'health-check-modal__err';
    p.textContent = 'No check results returned.';
    body.append(p);
  }

  panel.append(head, body);
  overlay.append(panel);
  document.body.append(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (ev.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

/**
 * @param {HTMLElement} aside
 */
export function mountHealthSidebar(aside) {
  aside.className = 'health-sidebar';
  aside.setAttribute('aria-label', 'System health');

  const tipHost = document.createElement('div');
  tipHost.className = 'dashbird-health-tip';
  tipHost.hidden = true;
  document.body.append(tipHost);

  const inner = document.createElement('div');
  inner.className = 'health-sidebar__inner panel panel--glass';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'health-sidebar__toggle';
  toggle.setAttribute('aria-controls', 'health-sidebar-metrics');
  toggle.appendChild(hamburgerSvg());

  const metrics = document.createElement('div');
  metrics.id = 'health-sidebar-metrics';
  metrics.className = 'health-sidebar__metrics';

  const ringOr = document.createElement('div');
  const ringNet = document.createElement('div');
  const ringTemp = document.createElement('div');
  const ringRam = document.createElement('div');

  const netRingState = {
    pingFill: null,
    uploadMbps: null,
    downloadMbps: null,
    /** `true` = show upload rate + green arrow outside ring; toggles every 10s. */
    phaseUpload: true,
  };
  function paintNetRingFromState() {
    renderRing(ringNet, netRingState.pingFill, '', null, 'net', {
      uploadMbps: netRingState.uploadMbps,
      downloadMbps: netRingState.downloadMbps,
      phaseUpload: netRingState.phaseUpload,
    });
  }

  const rowOr = metricRow(ICON_OPENROUTER, ringOr);
  const networkRowEl = buildNetworkRow(ringNet);
  const rowTemp = metricRow(ICON_THERM, ringTemp);
  const rowRam = metricRow(ICON_RAM, ringRam);
  const backupParts = buildBackupRow();
  const backupRowEl = backupParts.row;

  metrics.append(rowOr, networkRowEl, rowTemp, rowRam, backupRowEl);

  const checkFooter = document.createElement('div');
  checkFooter.className = 'health-sidebar__check-footer';
  const checkRow = document.createElement('div');
  checkRow.className = 'health-sidebar__check-row';
  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'health-sidebar__check-btn';
  checkBtn.textContent = 'check';
  const warnWrap = document.createElement('span');
  warnWrap.className = 'health-check-warn';
  warnWrap.hidden = true;
  warnWrap.setAttribute('role', 'button');
  warnWrap.setAttribute('tabindex', '0');
  warnWrap.setAttribute('aria-label', 'Show connectivity report');
  warnWrap.innerHTML = ICON_WARN_TRI;
  const checkMeta = document.createElement('div');
  checkMeta.className = 'health-sidebar__check-meta';
  checkRow.append(checkBtn, warnWrap);
  checkFooter.append(checkRow, checkMeta);
  checkMeta.textContent = '';

  inner.append(toggle, metrics, checkFooter);
  aside.replaceChildren(inner);

  setOpenRouterLimitMount(ringOr);
  refreshOpenRouterLimitMount();

  let lastCheckPayload = null;

  aside.addEventListener(
    'pointerenter',
    (e) => {
      const src = tipFromTarget(aside, e.target);
      if (!src) return;
      showHealthTip(tipHost, e.clientX, e.clientY, src);
    },
    true,
  );

  aside.addEventListener('pointermove', (e) => {
    if (tipHost.hidden) return;
    const src = tipFromTarget(aside, e.target);
    if (!src) {
      tipHost.hidden = true;
      return;
    }
    positionTip(tipHost, e.clientX, e.clientY);
  });

  aside.addEventListener('pointerleave', (e) => {
    const rel = e.relatedTarget;
    if (rel && aside.contains(rel)) return;
    tipHost.hidden = true;
  });

  function loadCollapsed() {
    return localStorage.getItem(LS_KEY) === '1';
  }

  function setCollapsed(collapsed) {
    aside.classList.toggle('health-sidebar--collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute(
      'aria-label',
      collapsed ? 'Expand system health panel' : 'Collapse system health panel',
    );
    metrics.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    localStorage.setItem(LS_KEY, collapsed ? '1' : '0');
  }

  setCollapsed(loadCollapsed());
  toggle.addEventListener('click', () => setCollapsed(!aside.classList.contains('health-sidebar--collapsed')));

  async function runConnectivityCheck() {
    checkBtn.disabled = true;
    checkBtn.textContent = '…';
    try {
      const r = await fetch('/api/dashboard-check', { method: 'POST' });
      let j = await r.json().catch(() => ({}));
      if (!r.ok) {
        j = {
          ok: false,
          checkedAt: j.checkedAt || new Date().toISOString(),
          results: Array.isArray(j.results) ? j.results : [],
          error: j.error || j.message || `HTTP ${r.status}`,
        };
      }
      lastCheckPayload = j;
      const list = Array.isArray(j.results) ? j.results : [];
      const failed = list.filter((x) => !x.ok);
      const allOk = j.ok === true && failed.length === 0;
      warnWrap.hidden = allOk;
      openCheckReportModal(j);
      if (j.checkedAt) {
        checkMeta.textContent = `Last run ${new Date(j.checkedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`;
      }
    } catch (e) {
      warnWrap.hidden = false;
      const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      lastCheckPayload = { ok: false, results: [], error: msg };
      openCheckReportModal(lastCheckPayload);
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = 'check';
    }
  }
  checkBtn.addEventListener('click', runConnectivityCheck);

  function openLastReport() {
    if (lastCheckPayload) openCheckReportModal(lastCheckPayload);
  }
  warnWrap.addEventListener('click', openLastReport);
  warnWrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openLastReport();
    }
  });

  function applyBackupFromIso(iso) {
    const b = backupDaysFromIso(iso);
    backupRowEl.classList.toggle('health-backup-row--infinity', Boolean(b.showInfinityIcon));
    backupParts.mainEl.classList.toggle('health-backup-main--infinity', Boolean(b.showInfinityIcon));
    if (b.showInfinityIcon) {
      backupParts.mainEl.replaceChildren();
      const wrap = document.createElement('span');
      wrap.className = 'health-backup-infinity-wrap';
      wrap.innerHTML = ICON_INFINITY_BACKUP;
      backupParts.mainEl.appendChild(wrap);
    } else {
      backupParts.mainEl.textContent = b.main;
    }
    backupParts.subEl.textContent = b.sub;
    setRowTip(backupRowEl, 'Last backup', b.title);
    const ariaMain = b.showInfinityIcon ? 'No last backup date (unbounded)' : b.main;
    backupRowEl.setAttribute('aria-label', [ariaMain, b.sub].filter(Boolean).join(' '));
  }

  async function refresh() {
    const [hr, nr, cfg] = await Promise.all([
      fetch('/api/host-health')
        .then((r) => r.json())
        .catch(() => ({})),
      fetch('/api/network-health')
        .then((r) => r.json())
        .catch(() => ({})),
      fetch('/api/config')
        .then((r) => r.json())
        .catch(() => ({})),
    ]);

    applyBackupFromIso(cfg?.lastBackupAt);

    const j = hr;
    const ping = nr.pingMs;
    const pingFill = ping != null && Number.isFinite(ping) ? Math.min(100, Math.max(0, (ping / 150) * 100)) : null;
    netRingState.pingFill = pingFill;
    netRingState.uploadMbps = nr.uploadMbps;
    netRingState.downloadMbps = nr.downloadMbps;
    const pingTitleParts = [];
    if (ping != null && Number.isFinite(ping)) {
      pingTitleParts.push(
        nr.pingMethod === 'tcp'
          ? `Latency: TCP connect ~${Math.round(ping)} ms (${nr.pingHost || 'host'}:${nr.tcpPort ?? 443}).`
          : `Latency: ICMP RTT ~${Math.round(ping)} ms to ${nr.pingHost || 'host'}.`,
      );
    } else {
      pingTitleParts.push('Latency: unavailable.');
    }
    pingTitleParts.push(
      `Download: ~${fmtMbps(nr.downloadMbps)} Mbps (Cloudflare probe).`,
      `Upload: ~${fmtMbps(nr.uploadMbps)} Mbps (Cloudflare probe).`,
    );
    if (Array.isArray(nr.hints) && nr.hints.length) pingTitleParts.push(...nr.hints);
    paintNetRingFromState();
    setRowTip(networkRowEl, 'Network', pingTitleParts.join('\n'));

    const tC = j.temperatureC;
    const tSrc = j.temperatureSource === 'gpu' ? 'GPU' : j.temperatureSource === 'cpu' ? 'CPU' : '';
    const tips = Array.isArray(j.diagnostics?.tips) ? j.diagnostics.tips : [];
    const tTitleParts = [];
    if (tC != null) {
      tTitleParts.push(`Reading: ${Number(tC).toFixed(0)}°C (${tSrc || 'sensor'}).`);
    } else {
      tTitleParts.push('No temperature reading.');
      if (tips.length) tTitleParts.push(...tips);
    }
    const tCenter =
      tC != null && Number.isFinite(Number(tC)) ? `${Math.round(Number(tC))}°` : '—';
    renderRing(ringTemp, j.temperaturePercent, '', tCenter);
    setRowTip(rowTemp, 'Temperature', tTitleParts.join('\n'));

    const mem = j.memory;
    if (mem) {
      const avail = mem.memAvailableKiB;
      const total = mem.memTotalKiB;
      const swU = mem.swapUsedKiB;
      const swT = mem.swapTotalKiB;
      const parts = [`RAM used: ${mem.memUsedPercent.toFixed(0)}%.`, `Pressure index: ${mem.pressurePercent.toFixed(0)}%.`];
      if (avail != null && total) parts.push(`Available: ${formatKiB(avail)} / ${formatKiB(total)}.`);
      if (swT > 0) parts.push(`Swap: ${formatKiB(swU)} / ${formatKiB(swT)} (${mem.swapUsedPercent.toFixed(0)}%).`);
      renderRing(ringRam, mem.pressurePercent, '', undefined);
      setRowTip(rowRam, 'Host RAM & swap', parts.join('\n'));
    } else {
      renderRing(ringRam, null, '', undefined);
      setRowTip(rowRam, 'Host RAM & swap', 'Memory stats unavailable.');
    }

    await refreshOpenRouterLimitMount();
  }

  paintNetRingFromState();
  refresh();
  setInterval(() => {
    netRingState.phaseUpload = !netRingState.phaseUpload;
    paintNetRingFromState();
  }, 10_000);
  setInterval(refresh, 4000);
}
