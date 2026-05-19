/**
 * Standalone caution mark (stem + dot) — no circle or triangle plate. Uses currentColor from the parent.
 * @param {{ className?: string, width?: number, height?: number }} [opts]
 * @returns {string}
 */
export function standaloneWarnExclamationSvgHtml(opts = {}) {
  const extraCls = opts.className ? ` ${opts.className}` : '';
  const w = opts.width ?? 14;
  const h = opts.height ?? 14;
  return `<svg class="dashbird-standalone-warn-exclam${extraCls}" viewBox="0 0 12 12" width="${w}" height="${h}" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><line x1="6" y1="2" x2="6" y2="7.75" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/><circle cx="6" cy="9.85" r="1.05" fill="currentColor"/></svg>`;
}
