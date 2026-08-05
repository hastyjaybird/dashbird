/**
 * Cache-bust tag for every dynamically imported mobile panel module.
 * Bump when any mobile panel module changes.
 *
 * Lives here (not in mobile-shell.js) because app.js needs the same value to
 * import the shell itself — when the two copies drifted, phones kept serving a
 * stale panel bundle after a deploy.
 */
export const MOBILE_PANELS_V = 'mobile-panels-20260805-module-diag-1';
