/**
 * Explain a failed dynamic import().
 *
 * Browsers report only the entry module URL ("error loading dynamically
 * imported module: …/events-finder-mobile.js"), even when the real problem is
 * a nested import that came back missing or as HTML. On a phone there is no
 * console to check, so walk the static import graph and name the broken file.
 */

const MAX_MODULES = 60;
const MAX_DEPTH = 4;

const JS_CONTENT_TYPE = /^(application|text)\/(javascript|ecmascript)/i;

/** Static `import`/`export … from` specifiers, plus bare side-effect imports. */
const STATIC_IMPORT_RE =
  /(?:^|[\s;}])(?:import|export)\s*(?:[\w*{}\s,$]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

/**
 * @param {string} source
 * @param {string} baseUrl
 * @returns {string[]}
 */
function collectImportUrls(source, baseUrl) {
  const out = [];
  STATIC_IMPORT_RE.lastIndex = 0;
  let match = STATIC_IMPORT_RE.exec(source);
  while (match) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('/')) {
      try {
        out.push(new URL(spec, baseUrl).href);
      } catch {
        /* ignore unresolvable specifier */
      }
    }
    match = STATIC_IMPORT_RE.exec(source);
  }
  return out;
}

/**
 * @param {string} url
 * @returns {string}
 */
function shortName(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * @param {string} entryUrl absolute or page-relative URL of the module that failed
 * @returns {Promise<string>} one-line, phone-readable reason
 */
export async function diagnoseModuleLoad(entryUrl) {
  let entry = '';
  try {
    entry = new URL(entryUrl, window.location.href).href;
  } catch {
    return 'could not parse the module URL';
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'device is offline';
  }

  const seen = new Set();
  /** @type {{ url: string, depth: number }[]} */
  const queue = [{ url: entry, depth: 0 }];

  while (queue.length && seen.size < MAX_MODULES) {
    const { url, depth } = /** @type {{ url: string, depth: number }} */ (queue.shift());
    if (seen.has(url)) continue;
    seen.add(url);

    let res;
    try {
      // `reload` bypasses a poisoned cache entry and refreshes it, so a retry
      // after this diagnosis can succeed on its own.
      res = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
    } catch (e) {
      return `${shortName(url)} could not be fetched (${e?.message || 'network error'})`;
    }

    if (res.status === 401 || res.status === 403) {
      return `${shortName(url)} → HTTP ${res.status} (sign-in expired — reload the page)`;
    }
    if (!res.ok) {
      return `${shortName(url)} → HTTP ${res.status} (not deployed on this server?)`;
    }

    const contentType = String(res.headers.get('content-type') || '');
    if (!JS_CONTENT_TYPE.test(contentType)) {
      return `${shortName(url)} was served as ${contentType.split(';')[0] || 'an unknown type'}, not JavaScript (file missing on the server — redeploy)`;
    }

    if (depth >= MAX_DEPTH) continue;

    let source = '';
    try {
      source = await res.text();
    } catch {
      return `${shortName(url)} could not be read`;
    }
    for (const next of collectImportUrls(source, url)) {
      if (!seen.has(next)) queue.push({ url: next, depth: depth + 1 });
    }
  }

  return 'every module file downloaded fine — the script itself threw (check the console)';
}
