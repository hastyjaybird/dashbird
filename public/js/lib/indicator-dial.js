const SVG_NS = 'http://www.w3.org/2000/svg';

const CX = 100;
const CY = 98;
const R = 72;
const ARC_START_DEG = 180;
const ARC_END_DEG = 0;

/**
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {number} deg
 */
function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

/**
 * @param {number} startDeg
 * @param {number} endDeg
 */
function describeArc(startDeg, endDeg) {
  const start = polar(CX, CY, R, startDeg);
  const end = polar(CX, CY, R, endDeg);
  const delta = Math.abs(endDeg - startDeg);
  const large = delta > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/**
 * Map 0–100 to arc position (deg): 0 = left, 100 = right along the top semicircle.
 * @param {number} value
 */
export function indicatorDialArcDeg(value) {
  const v = Math.max(0, Math.min(100, Number(value)));
  return 180 - (v / 100) * 180;
}

/**
 * Map 0–100 to needle rotation (deg): 0 = left (red), 100 = right (green).
 * @param {number} value
 */
export function indicatorDialNeedleDeg(value) {
  const v = Math.max(0, Math.min(100, Number(value)));
  return -90 + (v / 100) * 180;
}

/**
 * @param {string} id
 */
function buildGaugeSvg(id) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 112');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', 'auto');
  svg.setAttribute('class', 'indicator-dial__svg');
  svg.setAttribute('role', 'img');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', `${id}-arc-grad`);
  grad.setAttribute('x1', '0%');
  grad.setAttribute('y1', '0%');
  grad.setAttribute('x2', '100%');
  grad.setAttribute('y2', '0%');
  for (const [offset, color] of [
    ['0%', '#ef4444'],
    ['35%', '#f97316'],
    ['55%', '#eab308'],
    ['75%', '#84cc16'],
    ['100%', '#22c55e'],
  ]) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    grad.append(stop);
  }
  defs.append(grad);
  svg.append(defs);

  const track = document.createElementNS(SVG_NS, 'path');
  track.setAttribute('d', describeArc(ARC_START_DEG, ARC_END_DEG));
  track.setAttribute('fill', 'none');
  track.setAttribute('class', 'indicator-dial__track');
  track.setAttribute('stroke-width', '14');
  track.setAttribute('stroke-linecap', 'round');

  const arc = document.createElementNS(SVG_NS, 'path');
  arc.setAttribute('d', describeArc(ARC_START_DEG, ARC_END_DEG));
  arc.setAttribute('fill', 'none');
  arc.setAttribute('class', 'indicator-dial__arc');
  arc.setAttribute('stroke', `url(#${id}-arc-grad)`);
  arc.setAttribute('stroke-width', '12');
  arc.setAttribute('stroke-linecap', 'round');

  const ticks = document.createElementNS(SVG_NS, 'g');
  ticks.setAttribute('class', 'indicator-dial__ticks');
  for (const v of [0, 25, 50, 75, 100]) {
    const deg = indicatorDialArcDeg(v);
    const outer = polar(CX, CY, R + 6, deg);
    const inner = polar(CX, CY, R - 2, deg);
    const tick = document.createElementNS(SVG_NS, 'line');
    tick.setAttribute('x1', String(inner.x));
    tick.setAttribute('y1', String(inner.y));
    tick.setAttribute('x2', String(outer.x));
    tick.setAttribute('y2', String(outer.y));
    ticks.append(tick);

    const lblPos = polar(CX, CY, R + 16, deg);
    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('x', String(lblPos.x));
    lbl.setAttribute('y', String(lblPos.y));
    lbl.setAttribute('text-anchor', 'middle');
    lbl.setAttribute('dominant-baseline', 'middle');
    lbl.setAttribute('class', 'indicator-dial__tick-label');
    lbl.textContent = String(v);
    ticks.append(lbl);
  }

  const needleGroup = document.createElementNS(SVG_NS, 'g');
  needleGroup.setAttribute('class', 'indicator-dial__needle-group');
  needleGroup.style.setProperty('--dial-cx', `${CX}px`);
  needleGroup.style.setProperty('--dial-cy', `${CY}px`);
  needleGroup.style.setProperty('--dial-deg', '-90deg');

  const needle = document.createElementNS(SVG_NS, 'polygon');
  needle.setAttribute('class', 'indicator-dial__needle');
  needle.setAttribute('points', '0,-58 5,0 -5,0');

  const hub = document.createElementNS(SVG_NS, 'circle');
  hub.setAttribute('r', '6');
  hub.setAttribute('class', 'indicator-dial__hub');

  needleGroup.append(needle, hub);
  svg.append(track, arc, ticks, needleGroup);
  return { svg, needleGroup };
}

/**
 * Semicircle hazard-style dial: 0 = red (left), 100 = green (right).
 *
 * @param {HTMLElement} container
 * @param {{ ariaLabel?: string }} [opts]
 */
export function createIndicatorDial(container, opts = {}) {
  const id = `dial-${Math.random().toString(36).slice(2, 9)}`;
  container.replaceChildren();
  container.classList.add('indicator-dial');

  const gauge = document.createElement('div');
  gauge.className = 'indicator-dial__gauge';
  const { svg, needleGroup } = buildGaugeSvg(id);
  gauge.append(svg);

  const readout = document.createElement('div');
  readout.className = 'indicator-dial__readout';

  const valueEl = document.createElement('span');
  valueEl.className = 'indicator-dial__value';
  valueEl.textContent = '—';

  const captionEl = document.createElement('p');
  captionEl.className = 'indicator-dial__caption';
  captionEl.textContent = '';

  readout.append(valueEl, captionEl);
  container.append(gauge, readout);

  const baseLabel = opts.ariaLabel || 'Indicator dial';
  container.setAttribute('role', 'group');

  /**
   * @param {number|null|undefined} raw
   * @param {{ caption?: string, ariaValueText?: string }} [meta]
   */
  function setValue(raw, meta = {}) {
    container.classList.remove('indicator-dial--error');
    const n = Number(raw);
    const has = Number.isFinite(n);
    const v = has ? Math.max(0, Math.min(100, Math.round(n))) : null;

    if (v == null) {
      valueEl.textContent = '—';
      captionEl.textContent = meta.caption || '';
      needleGroup.style.setProperty('--dial-deg', '-90deg');
      container.setAttribute('aria-label', `${baseLabel}: no reading`);
      container.removeAttribute('aria-valuenow');
      container.removeAttribute('aria-valuemin');
      container.removeAttribute('aria-valuemax');
      return;
    }

    const deg = indicatorDialNeedleDeg(v);
    needleGroup.style.setProperty('--dial-deg', `${deg}deg`);
    valueEl.textContent = String(v);
    captionEl.textContent = meta.caption || '';
    const valueText = meta.ariaValueText || `${v} of 100`;
    container.setAttribute('aria-label', `${baseLabel}: ${valueText}`);
    container.setAttribute('aria-valuenow', String(v));
    container.setAttribute('aria-valuemin', '0');
    container.setAttribute('aria-valuemax', '100');
  }

  function setLoading(on) {
    container.classList.toggle('indicator-dial--loading', Boolean(on));
  }

  /**
   * @param {string} message
   */
  function setError(message) {
    valueEl.textContent = '—';
    captionEl.textContent = message;
    needleGroup.style.setProperty('--dial-deg', '-90deg');
    container.classList.add('indicator-dial--error');
    container.setAttribute('aria-label', `${baseLabel}: unavailable`);
  }

  setValue(null);
  return { setValue, setLoading, setError, valueEl, captionEl, needleGroup };
}
