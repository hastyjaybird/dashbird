/** Stack depth so overlapping waits (chat + connectivity check) do not flicker the UI. */
let depth = 0;
let ghost = null;
/** @type {((ev: PointerEvent) => void) | null} */
let moveHandler = null;

/**
 * Shows the custom wait cursor follower and hides the system cursor ({@link endWaitCursor} pairs).
 * @param {Pick<PointerEvent, 'clientX' | 'clientY'> | MouseEvent | null} [ev] — anchor position (defaults to viewport center).
 */
export function beginWaitCursor(ev = null) {
  depth++;
  if (depth > 1) return;

  ghost = document.createElement('div');
  ghost.className = 'dashbird-check-cursor';
  ghost.setAttribute('aria-hidden', 'true');

  const plate = document.createElement('div');
  plate.className = 'dashbird-check-cursor__plate';

  const wheel = document.createElement('div');
  wheel.className = 'dashbird-check-cursor__wheel';
  for (let i = 0; i < 8; i++) {
    const dot = document.createElement('span');
    dot.className = 'dashbird-check-cursor__dot';
    wheel.append(dot);
  }
  plate.appendChild(wheel);
  ghost.appendChild(plate);

  const pe =
    ev && typeof ev.clientX === 'number' && typeof ev.clientY === 'number' ? ev : null;
  const x =
    pe && Number.isFinite(pe.clientX) ? pe.clientX : Math.floor(window.innerWidth * 0.5);
  const y =
    pe && Number.isFinite(pe.clientY) ? pe.clientY : Math.floor(window.innerHeight * 0.5);
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
  document.body.append(ghost);
  document.body.classList.add('dashbird-check-busy');

  moveHandler = (moveEv) => {
    if (!ghost) return;
    ghost.style.left = `${moveEv.clientX}px`;
    ghost.style.top = `${moveEv.clientY}px`;
  };
  document.addEventListener('pointermove', moveHandler, true);
}

export function endWaitCursor() {
  depth = Math.max(0, depth - 1);
  if (depth > 0) return;

  if (moveHandler) {
    document.removeEventListener('pointermove', moveHandler, true);
    moveHandler = null;
  }
  ghost?.remove();
  ghost = null;
  document.body.classList.remove('dashbird-check-busy');
}
