import { getOpenRouterLimitDisplay } from './openrouter-summary.js';

/** Mount element for the limit ring; set by health sidebar. */
let mountEl = null;

export function setOpenRouterLimitMount(el) {
  mountEl = el;
}

const RING_SIZE = 34;
const RING_STROKE = 3;

function pctCenterLabel(pct) {
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}

/**
 * @param {HTMLElement} wrap
 * @param {ReturnType<typeof getOpenRouterLimitDisplay>} display
 */
function renderOpenRouterLimit(wrap, display) {
  wrap.replaceChildren();
  if (display.mode === 'ring') {
    const pct = display.pct;
    const size = RING_SIZE;
    const stroke = RING_STROKE;
    const r = (size - stroke) / 2 - 0.5;
    const c = 2 * Math.PI * r;
    const dash = (c * pct) / 100;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('class', 'or-limit-ring__svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', display.title);
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${size / 2},${size / 2}) rotate(-90)`);
    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('r', String(r));
    track.setAttribute('fill', 'none');
    track.setAttribute('class', 'or-limit-ring__track');
    track.setAttribute('stroke-width', String(stroke));
    const prog = document.createElementNS(ns, 'circle');
    prog.setAttribute('r', String(r));
    prog.setAttribute('fill', 'none');
    prog.setAttribute('class', 'or-limit-ring__progress');
    prog.setAttribute('stroke-width', String(stroke));
    prog.setAttribute('stroke-linecap', 'round');
    prog.setAttribute('stroke-dasharray', `${dash} ${c}`);
    g.append(track, prog);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(size / 2));
    text.setAttribute('y', String(size / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('class', 'or-limit-ring__pct');
    text.textContent = pctCenterLabel(pct);
    svg.append(g, text);
    const cap = document.createElement('div');
    cap.className = 'or-limit-ring';
    cap.dataset.healthTipName = 'OpenRouter';
    cap.dataset.healthTipBody = encodeURIComponent(
      (display.title || `Limit: ${pctCenterLabel(pct)}`).slice(0, 2400),
    );
    cap.appendChild(svg);
    wrap.appendChild(cap);
    return;
  }
  const p = document.createElement('p');
  p.className = 'or-limit-fallback muted';
  p.textContent = display.message;
  p.dataset.healthTipName = 'OpenRouter';
  p.dataset.healthTipBody = encodeURIComponent(String(display.message || '').slice(0, 2400));
  wrap.appendChild(p);
}

export async function refreshOpenRouterLimitMount() {
  if (!mountEl) return;
  try {
    const r = await fetch('/api/openrouter/summary');
    const j = await r.json().catch(() => ({}));
    renderOpenRouterLimit(mountEl, getOpenRouterLimitDisplay(j));
  } catch (e) {
    renderOpenRouterLimit(mountEl, {
      mode: 'error',
      message: `OpenRouter: error (${e.message})`,
    });
  }
}
