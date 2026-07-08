/** @returns {boolean} */
export function isPageVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Run `fn` on an interval, paused while the tab is hidden.
 * @param {() => void} fn
 * @param {number} ms
 */
export function setVisibleInterval(fn, ms) {
  let id = setInterval(() => {
    if (isPageVisible()) fn();
  }, ms);
  const onVis = () => {
    if (!isPageVisible()) return;
    fn();
  };
  document.addEventListener('visibilitychange', onVis);
  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVis);
  };
}
