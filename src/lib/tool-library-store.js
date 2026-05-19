/**
 * Tool Library persistence — data/tool-library.json + assets on disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** @typedef {object} ToolRecord */
export const SEED_CATEGORIES = [
  'video',
  'audio',
  'audio-only',
  '3D modeling',
  'project mgmt',
  'design',
  'development',
  'writing',
  'automation',
  'AI',
  'notes',
  'communication',
  'finance',
  'security',
  'utilities',
];

export function toolLibraryPath(env = process.env) {
  const override = String(env.TOOL_LIBRARY_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/tool-library.json');
}

export function toolLibraryAssetsDir(env = process.env) {
  const override = String(env.TOOL_LIBRARY_ASSETS_DIR || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/tool-library-assets');
}

/**
 * @returns {Promise<{ version: number, tools: ToolRecord[] }>}
 */
export async function loadToolLibrary() {
  const p = toolLibraryPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw);
    const tools = Array.isArray(j?.tools) ? j.tools : [];
    return { version: Number(j?.version) || 1, tools };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      return { version: 1, tools: [] };
    }
    throw e;
  }
}

/**
 * @param {{ version: number, tools: ToolRecord[] }} data
 */
export async function saveToolLibrary(data) {
  const p = toolLibraryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * @param {ToolRecord[]} tools
 */
export function collectCategories(tools) {
  const set = new Set(SEED_CATEGORIES);
  for (const t of tools) {
    for (const c of t.categories || []) {
      const s = String(c || '').trim();
      if (s) set.add(s);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {ToolRecord} tool
 */
export async function addTool(tool) {
  const data = await loadToolLibrary();
  data.tools.push(tool);
  await saveToolLibrary(data);
  return tool;
}

/**
 * @param {string} id
 */
export async function getToolById(id) {
  const data = await loadToolLibrary();
  return data.tools.find((t) => t.id === id) ?? null;
}

/**
 * @param {string[]} ids
 */
export async function deleteTools(ids) {
  const drop = new Set(ids.map((x) => String(x)));
  const data = await loadToolLibrary();
  const before = data.tools.length;
  data.tools = data.tools.filter((t) => !drop.has(t.id));
  await saveToolLibrary(data);
  return { removed: before - data.tools.length };
}

/**
 * @param {string} url
 */
export function normalizeToolUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('url_required');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_url');
  parsed.hash = '';
  return parsed.toString();
}

/**
 * @param {string} toolId
 * @param {Buffer} buf
 * @param {string} ext
 */
export async function saveToolAsset(toolId, kind, buf, ext = 'png') {
  const dir = toolLibraryAssetsDir();
  await fs.mkdir(dir, { recursive: true });
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'png';
  const name = `${toolId}-${kind}.${safeExt}`;
  const fp = path.join(dir, name);
  await fs.writeFile(fp, buf);
  return `/api/tool-library/assets/${name}`;
}

export function newToolId() {
  return randomUUID();
}
