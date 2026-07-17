/**
 * Task random-picker metadata: per-task tags + per-project default location.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeDifficulty,
  normalizeDuration,
  normalizeLocation,
  normalizeLocations,
  normalizeTimes,
  TASK_LOCATIONS,
} from './task-random-enums.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function taskRandomMetaJsonPath(env = process.env) {
  const override = String(env.TASK_RANDOM_META_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/task-random-meta.json');
}

export function taskProjectLocationsMdPath(env = process.env) {
  const override = String(env.TASK_PROJECT_LOCATIONS_MD_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/task-project-locations.md');
}

function normalizeTaskMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw;
  const out = {};
  const diff = normalizeDifficulty(r.difficulty);
  if (diff) out.difficulty = diff;
  const dur = normalizeDuration(r.duration);
  if (dur) out.duration = dur;
  const locs = normalizeLocations(r.locations ?? r.location);
  if (locs.length) out.locations = locs;
  const times = normalizeTimes(r.times ?? r.time);
  if (times.length) out.times = times;
  return Object.keys(out).length ? out : null;
}

function normalizeProjectMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw;
  const out = {};
  const loc = normalizeLocation(r.location);
  if (loc) out.location = loc;
  const notes = String(r.notes || '').trim().slice(0, 200);
  if (notes) out.notes = notes;
  return Object.keys(out).length ? out : null;
}

export function normalizeTaskRandomMeta(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const byTaskId = {};
  const taskRaw = o.byTaskId && typeof o.byTaskId === 'object' ? o.byTaskId : {};
  for (const [id, row] of Object.entries(taskRaw)) {
    const key = String(id || '').trim();
    if (!/^\d+$/.test(key)) continue;
    const norm = normalizeTaskMeta(row);
    if (norm) byTaskId[key] = norm;
  }
  const byProjectId = {};
  const projRaw = o.byProjectId && typeof o.byProjectId === 'object' ? o.byProjectId : {};
  for (const [id, row] of Object.entries(projRaw)) {
    const key = String(id || '').trim();
    if (!/^\d+$/.test(key)) continue;
    const norm = normalizeProjectMeta(row);
    if (norm) byProjectId[key] = norm;
  }
  return { byTaskId, byProjectId };
}

export async function loadTaskRandomMeta(env = process.env) {
  try {
    const raw = await fs.readFile(taskRandomMetaJsonPath(env), 'utf8');
    return normalizeTaskRandomMeta(JSON.parse(raw));
  } catch {
    const fromMd = await parseProjectLocationsMarkdown(env);
    if (Object.keys(fromMd.byProjectId).length) {
      const meta = { byTaskId: {}, byProjectId: fromMd.byProjectId };
      await writeTaskRandomMeta(meta, env);
      return meta;
    }
    return { byTaskId: {}, byProjectId: {} };
  }
}

async function writeTaskRandomMeta(meta, env = process.env) {
  const target = taskRandomMetaJsonPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, `${JSON.stringify(normalizeTaskRandomMeta(meta), null, 2)}\n`, 'utf8');
  await fs.rename(staging, target);
}

export async function parseProjectLocationsMarkdown(env = process.env) {
  const byProjectId = {};
  const rows = [];
  let text = '';
  try {
    text = await fs.readFile(taskProjectLocationsMdPath(env), 'utf8');
  } catch {
    return { byProjectId, rows };
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|\s*[-:]+/.test(trimmed)) continue;
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const idRaw = cells[0].replace(/\*/g, '').trim();
    if (!/^\d+$/.test(idRaw)) continue;
    const id = String(Number(idRaw));
    const title = cells[1] || '';
    const locRaw = cells[2].replace(/\*/g, '').trim();
    const notes = cells[3] || '';
    const loc = normalizeLocation(locRaw);
    const row = {};
    if (loc) row.location = loc;
    if (notes) row.notes = notes.slice(0, 200);
    if (Object.keys(row).length) byProjectId[id] = row;
    rows.push({ id: Number(id), title, ...(notes ? { notes } : {}) });
  }
  return { byProjectId, rows };
}

export function renderProjectLocationsMarkdown(projects, byProjectId) {
  const lines = [
    '# Task project locations',
    '',
    'Default location tag applied to all open tasks in each Vikunja project.',
    'Edit the Location column, save the file; Dashbird reloads on next read.',
    '',
    `Allowed values: *(blank / any)* | ${TASK_LOCATIONS.join(' | ')}`,
    '',
    '| ID | Project | Location | Notes |',
    '|----|---------|----------|-------|',
  ];
  for (const p of projects) {
    const id = String(p.id);
    const meta = byProjectId[id] || {};
    const loc = meta.location || '';
    const notes = meta.notes || '';
    lines.push(
      `| ${p.id} | ${String(p.title || '').replace(/\|/g, '\\|')} | ${loc} | ${notes.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export async function readProjectLocationsMarkdown(env = process.env) {
  try {
    return await fs.readFile(taskProjectLocationsMdPath(env), 'utf8');
  } catch {
    return '';
  }
}

export async function saveProjectLocationsMarkdown(markdown, env = process.env) {
  const target = taskProjectLocationsMdPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  await fs.rename(staging, target);
  const parsed = await parseProjectLocationsMarkdown(env);
  const meta = await loadTaskRandomMeta(env);
  meta.byProjectId = { ...meta.byProjectId, ...parsed.byProjectId };
  for (const [id, row] of Object.entries(parsed.byProjectId)) {
    if (!row.location && !row.notes) delete meta.byProjectId[id];
  }
  await writeTaskRandomMeta(meta, env);
  return meta;
}

export async function syncProjectLocationsMarkdown(projects, env = process.env) {
  const meta = await loadTaskRandomMeta(env);
  const parsed = await parseProjectLocationsMarkdown(env);
  for (const [id, row] of Object.entries(parsed.byProjectId)) {
    if (!meta.byProjectId[id]) meta.byProjectId[id] = row;
    else if (row.notes && !meta.byProjectId[id].notes) meta.byProjectId[id].notes = row.notes;
  }
  const md = renderProjectLocationsMarkdown(projects, meta.byProjectId);
  await saveProjectLocationsMarkdown(md, env);
  return { meta: await loadTaskRandomMeta(env), markdown: md };
}

export async function patchTaskMeta(taskId, patch, env = process.env) {
  const id = String(taskId || '').trim();
  if (!/^\d+$/.test(id)) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  const meta = await loadTaskRandomMeta(env);
  const prev = meta.byTaskId[id] || {};
  const next = { ...prev };
  if (patch.difficulty !== undefined) {
    const d = normalizeDifficulty(patch.difficulty);
    if (d) next.difficulty = d;
    else delete next.difficulty;
  }
  if (patch.duration !== undefined) {
    const d = normalizeDuration(patch.duration);
    if (d) next.duration = d;
    else delete next.duration;
  }
  if (patch.locations !== undefined) {
    const locs = normalizeLocations(patch.locations);
    if (locs.length) next.locations = locs;
    else delete next.locations;
  }
  if (patch.times !== undefined) {
    const times = normalizeTimes(patch.times);
    if (times.length) next.times = times;
    else delete next.times;
  }
  if (Object.keys(next).length) meta.byTaskId[id] = next;
  else delete meta.byTaskId[id];
  await writeTaskRandomMeta(meta, env);
  return meta;
}

export async function patchProjectMeta(projectId, patch, projects = [], env = process.env) {
  const id = String(projectId);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    const err = new Error('invalid_id');
    err.code = 'invalid_id';
    err.status = 400;
    throw err;
  }
  const meta = await loadTaskRandomMeta(env);
  const prev = meta.byProjectId[id] || {};
  const next = { ...prev };
  if (patch.location !== undefined) {
    const loc = patch.location == null || patch.location === '' ? null : normalizeLocation(patch.location);
    if (loc) next.location = loc;
    else delete next.location;
  }
  if (patch.notes !== undefined) {
    const notes = String(patch.notes || '').trim().slice(0, 200);
    if (notes) next.notes = notes;
    else delete next.notes;
  }
  if (Object.keys(next).length) meta.byProjectId[id] = next;
  else delete meta.byProjectId[id];
  if (projects.length) {
    const md = renderProjectLocationsMarkdown(projects, meta.byProjectId);
    await saveProjectLocationsMarkdown(md, env);
    return loadTaskRandomMeta(env);
  }
  await writeTaskRandomMeta(meta, env);
  return meta;
}
