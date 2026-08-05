/**
 * Resilient dynamic import for lazily mounted panels.
 *
 * A rejected `import()` is remembered by the module map, so a failed panel stays
 * broken until a full reload, and browsers report only "error loading dynamically
 * imported module" — the same message whether a file 404'd after a partial deploy,
 * the auth session expired, the phone dropped the request, or a cached dependency
 * no longer matches the module that imports it. Probe the module graph over HTTP,
 * refresh stale cache entries, then retry under a URL the module map has not seen.
 */

const PROBE_TIMEOUT_MS = 12000;
const PROBE_MAX_FILES = 30;
const PROBE_MAX_DEPTH = 4;

/**
 * Static `import`/`export … from '…'` statements (anchored to a line start, since
 * they may only appear at the top level), plus literal `import('…')` calls.
 */
const SPECIFIER_RE =
  /^\s*(?:import|export)\s+[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/**
 * @param {string} url
 * @returns {string}
 */
function bustUrl(url) {
  const abs = new URL(url, document.baseURI);
  abs.searchParams.set('reload', String(Date.now()));
  return abs.href;
}

/**
 * @param {string} url
 * @returns {string}
 */
function shortPath(url) {
  try {
    return new URL(url, document.baseURI).pathname;
  } catch {
    return String(url);
  }
}

/**
 * @typedef {{ url: string, status: number, reason: string }} ModuleProbeFailure
 */

/**
 * Re-fetch a module and its relative dependencies straight from the network.
 *
 * Doubles as a repair step: `cache: 'reload'` replaces stale HTTP cache entries,
 * so a retried import picks up dependencies that match the parent module.
 *
 * @param {string} entryUrl
 * @returns {Promise<ModuleProbeFailure[]>}
 */
async function refreshModuleGraph(entryUrl) {
  /** @type {ModuleProbeFailure[]} */
  const failures = [];
  const seen = new Set();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  /**
   * @param {string} url
   * @param {number} depth
   */
  async function visit(url, depth) {
    if (depth > PROBE_MAX_DEPTH || seen.size >= PROBE_MAX_FILES) return;
    const abs = new URL(url, document.baseURI).href;
    if (seen.has(abs)) return;
    seen.add(abs);

    let res;
    try {
      res = await fetch(abs, {
        cache: 'reload',
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch (e) {
      const detail = e?.name === 'AbortError' ? 'timed out' : String(e?.message || e);
      failures.push({ url: abs, status: 0, reason: `could not be fetched (${detail})` });
      return;
    }
    if (!res.ok) {
      failures.push({
        url: abs,
        status: res.status,
        reason:
          res.status === 404
            ? 'is missing on the server (HTTP 404)'
            : `returned HTTP ${res.status}`,
      });
      return;
    }

    const type = String(res.headers.get('content-type') || '');
    if (type && !/javascript|ecmascript/i.test(type)) {
      failures.push({
        url: abs,
        status: res.status,
        reason: `was served as ${type.split(';')[0]} instead of JavaScript`,
      });
      return;
    }

    let source = '';
    try {
      source = await res.text();
    } catch {
      return;
    }
    SPECIFIER_RE.lastIndex = 0;
    /** @type {string[]} */
    const deps = [];
    let m;
    while ((m = SPECIFIER_RE.exec(source))) {
      const spec = m[1] || m[2] || m[3];
      if (spec && spec.startsWith('.')) deps.push(spec);
    }
    for (const spec of deps) {
      await visit(new URL(spec, abs).href, depth + 1);
    }
  }

  try {
    await visit(entryUrl, 0);
  } finally {
    clearTimeout(timer);
  }
  return failures;
}

/**
 * @param {ModuleProbeFailure[]} failures
 * @param {unknown} err
 * @returns {string}
 */
function describeFailure(failures, err) {
  if (failures.length) {
    const f = failures[0];
    if (f.status === 401 || f.status === 403) return 'session expired — reload the page';
    return `${shortPath(f.url)} ${f.reason}`;
  }
  // Every file fetched cleanly, so the module itself is at fault: a mismatched
  // cached dependency already held in the module map, or a genuine script error.
  // The probe refreshed the cached copies, so a page reload clears the first case.
  const msg = String(err?.message || err || 'unknown error');
  return `script error — ${msg}; files re-fetched OK, try reloading`;
}

/**
 * Import a panel module, repairing and retrying once when the first attempt fails.
 *
 * @param {string} url
 * @returns {Promise<any>}
 */
export async function loadPanelModule(url) {
  try {
    return await import(url);
  } catch (firstErr) {
    const failures = await refreshModuleGraph(url);
    if (!failures.length) {
      try {
        return await import(bustUrl(url));
      } catch (retryErr) {
        console.error('[panel-loader] retry failed', url, retryErr);
        throw new Error(describeFailure(failures, retryErr));
      }
    }
    console.error('[panel-loader] load failed', url, firstErr, failures);
    throw new Error(describeFailure(failures, firstErr));
  }
}
