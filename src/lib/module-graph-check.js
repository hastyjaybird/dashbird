/**
 * Static-import integrity check for the browser bundle in public/.
 *
 * A module that never reached the server does not fail loudly: the browser
 * reports "error loading dynamically imported module" against the *entry*
 * module, so the panel that breaks is never the file that is missing. Scanning
 * the graph on disk turns that into a named file.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Static `import`/`export … from`, plus literal `import('…')`. */
const IMPORT_RE =
  /(?:^|[\s;}(])(?:import|export)\s*(?:[\w*{}\s,$]*?\sfrom\s*)?\(?\s*['"`]([^'"`]+)['"`]/g;

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walkJsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * @param {string} publicDir
 * @returns {{ files: number, imports: number, missing: { from: string, spec: string, target: string }[] }}
 */
export function findMissingModuleImports(publicDir) {
  const files = walkJsFiles(publicDir);
  /** @type {{ from: string, spec: string, target: string }[]} */
  const missing = [];
  let imports = 0;

  for (const file of files) {
    let source = '';
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    let match = IMPORT_RE.exec(source);
    while (match) {
      const spec = match[1];
      match = IMPORT_RE.exec(source);
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      const specPath = spec.split('?')[0].split('#')[0];
      const target = specPath.startsWith('/')
        ? path.join(publicDir, specPath)
        : path.resolve(path.dirname(file), specPath);
      imports += 1;
      if (!fs.existsSync(target)) {
        missing.push({ from: path.relative(publicDir, file), spec, target });
      }
    }
  }

  return { files: files.length, imports, missing };
}

/**
 * Log a loud warning when the served tree is incomplete (half-finished rsync,
 * stale bind mount, file added locally but never deployed).
 * @param {string} publicDir
 */
export function logMissingModuleImports(publicDir) {
  const { missing } = findMissingModuleImports(publicDir);
  if (!missing.length) return;
  console.error(
    `[module-graph] ${missing.length} import(s) point at files that are not on this server — panels using them will fail to load:`,
  );
  for (const m of missing.slice(0, 20)) {
    console.error(`[module-graph]   public/${m.from} → ${m.spec}`);
  }
  console.error('[module-graph] Re-run scripts/sync-to-cloud.sh (or rebuild) to fix.');
}
