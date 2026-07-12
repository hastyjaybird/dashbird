/**
 * Network groups — SQLite (data/network.db).
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  JULIA_CONTACT_ID,
  RUNWAY_HOUSE_GROUP_ID,
  SAM_CONTACT_ID,
  SAM_LEVAC_LEVEY_ID,
  openNetworkDb,
  remapLegacyNetworkId,
  rowToGroup,
  upsertGroupRow,
} from './network-db.js';
import { addContact, findContactByNameOrAlias, updateContact } from './network-contacts-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export { RUNWAY_HOUSE_GROUP_ID, SAM_CONTACT_ID, SAM_LEVAC_LEVEY_ID, JULIA_CONTACT_ID };

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @deprecated JSON path unused
 */
export function networkGroupsPath(env = process.env) {
  const override = String(env.NETWORK_GROUPS_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data/network-groups.json');
}

/**
 * @param {unknown} v
 * @param {number} [max]
 */
function cleanStr(v, max = 2000) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.slice(0, max);
}

/**
 * @param {unknown} v
 */
function cleanIdList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const id of v) {
    const s = remapLegacyNetworkId(cleanStr(id, 80));
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {unknown} raw
 */
export function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = remapLegacyNetworkId(cleanStr(raw.id, 80) || newGroupId());
  const now = new Date().toISOString();
  let source = cleanStr(raw.source, 40) || 'manual';
  if (source === 'seed') source = 'manual';
  return {
    id,
    name: cleanStr(raw.name, 300),
    description: cleanStr(raw.description, 4000),
    memberIds: cleanIdList(raw.memberIds),
    commonalities: Array.isArray(raw.commonalities) ? raw.commonalities.slice(0, 40) : [],
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.slice(0, 40) : [],
    commonalitiesUpdatedAt: cleanStr(raw.commonalitiesUpdatedAt, 64) || null,
    createdAt: cleanStr(raw.createdAt, 64) || now,
    updatedAt: cleanStr(raw.updatedAt, 64) || now,
    source,
  };
}

export function newGroupId() {
  return randomUUID();
}

/**
 * @returns {Promise<{ version: number, groups: object[] }>}
 */
export async function loadNetworkGroups(env = process.env) {
  const db = openNetworkDb(env);
  const rows = db
    .prepare('SELECT id, name, payload, created_at, updated_at FROM groups ORDER BY created_at ASC, name ASC')
    .all();
  return {
    version: 1,
    groups: rows.map((r) => normalizeGroup(rowToGroup(r))).filter(Boolean),
  };
}

/**
 * @deprecated no-op
 */
export async function saveNetworkGroups(_data, _env = process.env) {
  /* no-op */
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function getGroupById(id, env = process.env) {
  const db = openNetworkDb(env);
  const row = db
    .prepare('SELECT id, name, payload, created_at, updated_at FROM groups WHERE id = ?')
    .get(remapLegacyNetworkId(id));
  if (!row) return null;
  return normalizeGroup(rowToGroup(row));
}

/**
 * @param {object} group
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addGroup(group, env = process.env) {
  const normalized = normalizeGroup({
    ...group,
    id: group?.id || newGroupId(),
    createdAt: group?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  if (!normalized) {
    const err = new Error('invalid_group');
    err.code = 'invalid_group';
    throw err;
  }
  upsertGroupRow(openNetworkDb(env), normalized);
  return normalized;
}

/**
 * @param {string} id
 * @param {object} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function updateGroup(id, patch, env = process.env) {
  const prev = await getGroupById(id, env);
  if (!prev) return null;
  const merged = {
    ...prev,
    ...(patch && typeof patch === 'object' ? patch : {}),
    id: prev.id,
    updatedAt: new Date().toISOString(),
  };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'memberIds')) {
    merged.memberIds = patch.memberIds;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'commonalities')) {
    merged.commonalities = patch.commonalities;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'suggestions')) {
    merged.suggestions = patch.suggestions;
  }
  const normalized = normalizeGroup(merged);
  if (!normalized) {
    const err = new Error('invalid_group');
    err.code = 'invalid_group';
    throw err;
  }
  upsertGroupRow(openNetworkDb(env), normalized);
  return normalized;
}

/**
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function deleteGroups(ids, env = process.env) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map((id) => remapLegacyNetworkId(String(id))))].filter(
    Boolean,
  );
  if (!want.length) return { deleted: 0 };
  const db = openNetworkDb(env);
  const stmt = db.prepare('DELETE FROM groups WHERE id = ?');
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of want) {
      deleted += Number(stmt.run(id).changes) || 0;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { deleted };
}

/**
 * @param {string} groupId
 * @param {string[]} contactIds
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function addMembersToGroup(groupId, contactIds, env = process.env) {
  const group = await getGroupById(groupId, env);
  if (!group) return null;
  const set = new Set(group.memberIds || []);
  for (const id of contactIds || []) {
    const s = remapLegacyNetworkId(cleanStr(id, 80));
    if (s) set.add(s);
  }
  return updateGroup(groupId, { memberIds: [...set] }, env);
}

/**
 * @param {string} groupId
 * @param {string[]} contactIds
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function removeMembersFromGroup(groupId, contactIds, env = process.env) {
  const group = await getGroupById(groupId, env);
  if (!group) return null;
  const drop = new Set((contactIds || []).map((id) => remapLegacyNetworkId(String(id))));
  return updateGroup(
    groupId,
    { memberIds: (group.memberIds || []).filter((id) => !drop.has(id)) },
    env,
  );
}

/**
 * @param {string} groupId
 * @param {unknown} names
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function ingestPeopleIntoGroup(groupId, names, env = process.env) {
  const group = await getGroupById(groupId, env);
  if (!group) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }

  /** @type {string[]} */
  let list = [];
  if (Array.isArray(names)) {
    list = names.map((n) => cleanStr(n, 200)).filter(Boolean);
  } else {
    list = String(names || '')
      .split(/\n+/)
      .map((n) => cleanStr(n, 200))
      .filter(Boolean);
  }

  const created = [];
  const linked = [];
  for (const displayName of list) {
    let contact = await findContactByNameOrAlias(displayName, env);
    if (!contact) {
      contact = await addContact(
        {
          displayName,
          kinds: ['friend'],
          networkCircles: group.name || '',
          source: 'manual',
        },
        env,
      );
      created.push(contact);
    } else {
      const circles = String(contact.networkCircles || '');
      if (group.name && !circles.toLowerCase().includes(String(group.name).toLowerCase())) {
        await updateContact(
          contact.id,
          { networkCircles: [circles, group.name].filter(Boolean).join(', ') },
          env,
        );
      }
      linked.push(contact);
    }
  }

  const memberIds = [
    ...new Set([...(group.memberIds || []), ...created.map((c) => c.id), ...linked.map((c) => c.id)]),
  ];
  const updated = await updateGroup(groupId, { memberIds }, env);
  return { group: updated, created, linked };
}
