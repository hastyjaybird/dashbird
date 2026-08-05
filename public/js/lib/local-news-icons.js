/**
 * Line icons for Local News feedback controls, drawn as SVG rather than emoji so
 * they inherit button color and stay legible at sidebar sizes.
 *
 * Snooze is faceless typographic "Zzz" — three ascending Z letters, no sleeping face.
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} d
 * @param {{ size?: number, strokeWidth?: number, transform?: string }} [opts]
 * @returns {SVGSVGElement}
 */
function lineIcon(d, opts = {}) {
  const size = opts.size || 14;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', String(opts.strokeWidth || 1.4));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (opts.transform) path.setAttribute('transform', opts.transform);

  svg.append(path);
  return svg;
}

/**
 * @param {number} size
 * @returns {SVGSVGElement}
 */
function emptySvg(size) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

const THUMB_D =
  'M4.7 7.3 7.3 2.5a1.05 1.05 0 0 1 2 .5V6.5h3.2a1.45 1.45 0 0 1 1.4 1.8l-1.1 4.3a1.45 1.45 0 0 1-1.4 1.1H4.7z'
  + 'M4.7 7.3H2v6.4h2.7z';

/** @param {{ size?: number }} [opts] */
export function thumbUpIcon(opts = {}) {
  return lineIcon(THUMB_D, opts);
}

/** @param {{ size?: number }} [opts] */
export function thumbDownIcon(opts = {}) {
  // Same hand, mirrored vertically inside the 16x16 box.
  return lineIcon(THUMB_D, { ...opts, transform: 'translate(0 16) scale(1 -1)' });
}

/**
 * Faceless snooze — plain typographic "Zzz", no moon/face.
 * @param {{ size?: number }} [opts]
 */
export function zzzIcon(opts = {}) {
  const size = opts.size || 14;
  const svg = emptySvg(size);
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', '8');
  t.setAttribute('y', '11.2');
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('font-size', '7.2');
  t.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif');
  t.setAttribute('font-weight', '700');
  t.setAttribute('letter-spacing', '-0.35');
  t.setAttribute('fill', 'currentColor');
  t.textContent = 'Zzz';
  svg.append(t);
  return svg;
}

/** Hide-this-headline action. @param {{ size?: number }} [opts] */
export function eyeOffIcon(opts = {}) {
  return lineIcon(
    'M2 2l12 12M6.3 3.6A6.6 6.6 0 0 1 8 3.4c3.4 0 5.7 2.6 6.4 4.6-.3.8-.9 1.8-1.8 2.7'
    + 'M4.2 4.9C2.9 5.9 2 7.3 1.6 8c.7 2 3 4.6 6.4 4.6.9 0 1.7-.2 2.4-.5'
    + 'M6.6 6.7a2 2 0 0 0 2.8 2.8',
    opts,
  );
}

/** Open the original article on the publisher site. @param {{ size?: number }} [opts] */
export function externalLinkIcon(opts = {}) {
  return lineIcon('M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.8v3.7h-9v-9h3.7', opts);
}

/** @param {{ size?: number }} [opts] */
export function closeIcon(opts = {}) {
  return lineIcon('M4 4l8 8M12 4l-8 8', { strokeWidth: 1.5, ...opts });
}

/** Feeds / folder tree. @param {{ size?: number }} [opts] */
export function feedsIcon(opts = {}) {
  return lineIcon('M2.5 3.8h11M2.5 8h11M2.5 12.2h11', opts);
}

/** Keyword lists (white / grey / black). @param {{ size?: number }} [opts] */
export function listsIcon(opts = {}) {
  const size = opts.size || 14;
  const svg = emptySvg(size);
  for (const y of [3.5, 8, 12.5]) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '2.6');
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '1.05');
    c.setAttribute('fill', 'currentColor');
    svg.append(c);
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', `M5.2 ${y}h8.3`);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
  }
  return svg;
}

/** Feed editor / subscribe. @param {{ size?: number }} [opts] */
export function feedEditorIcon(opts = {}) {
  return lineIcon('M8 3v10M3 8h10', { strokeWidth: 1.55, ...opts });
}
