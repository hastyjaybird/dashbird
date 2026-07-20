/**
 * Import Google Keep notes from a Google Takeout export.
 *
 * Google Keep has no official public API, so the practical path is Takeout:
 * Takeout writes one file per note (`.json` — canonical — plus a mirror `.html`)
 * and any attachments as sibling image files. Jay unzips the archive and drops the
 * `Takeout/Keep/` contents (or just the note files) into `data/keep-import/`.
 *
 * `importKeepTakeout` parses every staged note, creates a Keep note in the store,
 * best-effort attaches the first image, then moves the processed files into an
 * `imported/<timestamp>/` subfolder so re-running never double-imports.
 */
import { mkdir, readdir, readFile, rename, copyFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeepNote, setKeepNoteAttachment } from './keep-notes-store.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEEP_IMPORT_ROOT = path.join(PKG_ROOT, 'data', 'keep-import');

/** Subfolder where already-imported source files are parked. */
const IMPORTED_DIR = 'imported';

const IMAGE_EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function keepImportRoot(env = process.env) {
  const override = String(env.KEEP_IMPORT_ROOT || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return KEEP_IMPORT_ROOT;
}

/**
 * Recursively list staged import files (skips the `imported/` archive subfolder).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ root: string, files: string[], jsonCount: number, htmlCount: number, total: number }>}
 */
export async function listKeepImportFiles(env = process.env) {
  const root = keepImportRoot(env);
  await mkdir(root, { recursive: true });
  let entries = [];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    entries = [];
  }
  /** @type {string[]} */
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const parent = ent.parentPath || ent.path || root;
    const abs = path.join(parent, ent.name);
    const rel = path.relative(root, abs);
    if (rel.split(path.sep)[0] === IMPORTED_DIR) continue;
    files.push(rel);
  }
  const jsonCount = files.filter((f) => f.toLowerCase().endsWith('.json')).length;
  const htmlCount = files.filter((f) => /\.html?$/i.test(f)).length;
  return { root, files, jsonCount, htmlCount, total: files.length };
}

/**
 * @param {string} html
 */
function decodeHtmlEntities(html) {
  return String(html || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    });
}

/**
 * @param {string} fragment
 */
function htmlFragmentToText(fragment) {
  return decodeHtmlEntities(
    String(fragment || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Canonical Takeout Keep JSON note → normalized shape.
 * @param {unknown} raw
 */
export function parseTakeoutJson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const obj = /** @type {Record<string, any>} */ (raw);
  const title = String(obj.title || '').trim();
  let body = String(obj.textContent || '').trim();
  if (!body && Array.isArray(obj.listContent)) {
    body = obj.listContent
      .map((item) => {
        const text = String(item?.text || '').trim();
        if (!text) return '';
        return `${item?.isChecked ? '\u2611' : '\u2610'} ${text}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  const links = Array.isArray(obj.annotations)
    ? obj.annotations
        .map((a) => String(a?.url || '').trim())
        .filter((u) => /^https?:\/\//i.test(u))
    : [];
  if (links.length) {
    body = [body, links.join('\n')].filter(Boolean).join('\n\n');
  }
  const attachments = Array.isArray(obj.attachments)
    ? obj.attachments
        .map((a) => ({
          filePath: String(a?.filePath || '').trim(),
          mimetype: String(a?.mimetype || '').trim().toLowerCase(),
        }))
        .filter((a) => a.filePath)
    : [];
  return {
    title,
    body,
    pinned: obj.isPinned === true,
    archived: obj.isArchived === true,
    trashed: obj.isTrashed === true,
    attachments,
  };
}

/**
 * Fallback parser for Takeout Keep `.html` note files (used only when no `.json` twin exists).
 * @param {string} html
 */
export function parseTakeoutHtml(html) {
  const src = String(html || '');
  const titleMatch = src.match(/<div class="title"[^>]*>([\s\S]*?)<\/div>/i);
  const contentMatch = src.match(/<div class="content"[^>]*>([\s\S]*?)<\/div>/i);
  const title = titleMatch ? htmlFragmentToText(titleMatch[1]) : '';
  let body = contentMatch ? htmlFragmentToText(contentMatch[1]) : '';
  if (!body) {
    // Checklist notes render as list items rather than a .content block.
    const items = [...src.matchAll(/<span class="text"[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
      htmlFragmentToText(m[1]),
    );
    body = items.filter(Boolean).join('\n');
  }
  if (!title && !body) return null;
  return { title, body, pinned: false, archived: false, trashed: false, attachments: [] };
}

/**
 * @param {string} rel
 * @param {string} root
 */
async function readAttachmentPayload(rel, root, mimetype) {
  const abs = path.join(root, rel);
  const ext = path.extname(rel).toLowerCase();
  const mime = mimetype || IMAGE_EXT_MIME[ext] || '';
  if (!mime.startsWith('image/')) return null;
  try {
    const buf = await readFile(abs);
    return { kind: 'image', base64: buf.toString('base64'), mimeType: mime, filename: path.basename(rel) };
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} stamp
 */
async function parkImportedFile(root, rel, stamp) {
  const from = path.join(root, rel);
  const to = path.join(root, IMPORTED_DIR, stamp, rel);
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    // Cross-device or locked — fall back to copy + delete.
    try {
      await copyFile(from, to);
      await rm(from, { force: true });
    } catch {
      /* leave the source in place if it can't be moved */
    }
  }
}

/**
 * Parse staged Takeout note files and create Keep notes in the store.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ includeArchived?: boolean }} [opts]
 */
export async function importKeepTakeout(env = process.env, opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const { root, files } = await listKeepImportFiles(env);

  // Prefer the canonical JSON over the mirror HTML for the same note.
  const jsonKeys = new Set(
    files
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length).toLowerCase()),
  );
  const noteFiles = files.filter((f) => {
    if (f.toLowerCase().endsWith('.json')) return true;
    if (/\.html?$/i.test(f)) {
      const key = f.replace(/\.html?$/i, '').toLowerCase();
      return !jsonKeys.has(key);
    }
    return false;
  });

  const summary = {
    ok: true,
    created: 0,
    withImage: 0,
    skippedTrashed: 0,
    skippedArchived: 0,
    skippedEmpty: 0,
    failed: 0,
    scannedFiles: noteFiles.length,
    stagedFiles: files.length,
    /** @type {Array<{ file: string, error: string }>} */
    errors: [],
    root,
    parkedTo: null,
  };

  if (!noteFiles.length) return summary;

  /** @type {string[]} */
  const processedForPark = [];

  for (const rel of noteFiles) {
    const abs = path.join(root, rel);
    let parsed = null;
    try {
      const text = await readFile(abs, 'utf8');
      if (rel.toLowerCase().endsWith('.json')) {
        parsed = parseTakeoutJson(JSON.parse(text));
      } else {
        parsed = parseTakeoutHtml(text);
      }
    } catch (e) {
      summary.failed += 1;
      summary.errors.push({ file: rel, error: String(e?.message || e) });
      continue;
    }
    if (!parsed) {
      summary.skippedEmpty += 1;
      processedForPark.push(rel);
      continue;
    }
    if (parsed.trashed) {
      summary.skippedTrashed += 1;
      processedForPark.push(rel);
      continue;
    }
    if (parsed.archived && !includeArchived) {
      summary.skippedArchived += 1;
      processedForPark.push(rel);
      continue;
    }
    const title = String(parsed.title || '').trim().slice(0, 200);
    const body = String(parsed.body || '').trim().slice(0, 20000);
    if (!title && !body && !(parsed.attachments || []).length) {
      summary.skippedEmpty += 1;
      processedForPark.push(rel);
      continue;
    }
    try {
      const note = await createKeepNote({ title, body, pinned: parsed.pinned === true }, env);
      // Best-effort: attach the first image sibling if present.
      const firstImage = (parsed.attachments || []).find((a) => {
        const ext = path.extname(a.filePath).toLowerCase();
        return (a.mimetype || '').startsWith('image/') || Boolean(IMAGE_EXT_MIME[ext]);
      });
      if (firstImage) {
        const attRel = path.join(path.dirname(rel), firstImage.filePath);
        const payload = await readAttachmentPayload(attRel, root, firstImage.mimetype);
        if (payload) {
          try {
            await setKeepNoteAttachment(note.id, payload, env);
            summary.withImage += 1;
            processedForPark.push(attRel);
          } catch {
            /* attachment too large / unsupported — keep the text note anyway */
          }
        }
      }
      summary.created += 1;
      processedForPark.push(rel);
    } catch (e) {
      summary.failed += 1;
      summary.errors.push({ file: rel, error: String(e?.message || e) });
    }
  }

  if (summary.created > 0 || summary.skippedTrashed > 0 || summary.skippedArchived > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Park every staged file (notes + any leftover attachments) so re-runs are safe.
    const toPark = new Set(processedForPark);
    for (const f of files) toPark.add(f);
    for (const rel of toPark) {
      try {
        await stat(path.join(root, rel));
      } catch {
        continue;
      }
      await parkImportedFile(root, rel, stamp);
    }
    summary.parkedTo = path.join(IMPORTED_DIR, stamp);
  }

  return summary;
}
