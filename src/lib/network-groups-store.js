/**
 * Network groups — SQLite (data/network.db).
 *
 * Two kinds:
 * - community — membership syncs Scene (`networkCircles`) on contacts
 * - event — friends-only grouping; optional `eventType` stays on the group only
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
import {
  addContact,
  findContactByNameOrAlias,
  getContactById,
  loadNetworkContacts,
  updateContact,
} from './network-contacts-store.js';
import {
  addSceneToken,
  canonicalizeSceneToken,
  isDroppedSceneToken,
  isOutOfTownToken,
  isPolidayToken,
  normalizeSceneGroupName,
  removeSceneToken,
  replaceSceneToken,
} from './network-scene-normalize.js';

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
 * @returns {'community' | 'event'}
 */
export function normalizeGroupKind(raw) {
  const k = String(raw ?? '')
    .trim()
    .toLowerCase();
  return k === 'event' ? 'event' : 'community';
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
  let kind = normalizeGroupKind(raw.kind);
  let name =
    kind === 'event' ? cleanStr(raw.name, 300) : normalizeSceneGroupName(raw.name, 300);
  // Poliday is event-only — never a community Scene circle.
  if (isPolidayToken(raw.name) || isPolidayToken(name)) {
    kind = 'event';
    name = 'Poliday';
  }
  return {
    id,
    kind,
    name,
    eventType: kind === 'event' ? cleanStr(raw.eventType, 200) : '',
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
 * Canonical scene labels from a contact's networkCircles string.
 * @param {unknown} networkCircles
 * @returns {string[]}
 */
export function sceneTokensFromCircles(networkCircles) {
  return String(networkCircles ?? '')
    .split(/[,;|/]+/)
    .map((p) => canonicalizeSceneToken(p))
    .filter(Boolean);
}

/**
 * Persist memberIds without touching contact Scene tags (avoids sync loops).
 * @param {object} group
 * @param {string[]} memberIds
 * @param {NodeJS.ProcessEnv} [env]
 */
function writeGroupMemberIds(group, memberIds, env = process.env) {
  const now = new Date().toISOString();
  const normalized = normalizeGroup({
    ...group,
    memberIds,
    updatedAt: now,
  });
  if (!normalized) return null;
  upsertGroupRow(openNetworkDb(env), normalized);
  return normalized;
}

/**
 * Align community group membership with a contact's Scene tags.
 * Creates missing community groups for new scene tokens. Event groups are untouched.
 * @param {string} contactId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ added: string[], removed: string[], created: string[] }>}
 */
export async function syncContactToCommunityGroups(contactId, env = process.env) {
  const id = remapLegacyNetworkId(cleanStr(contactId, 80));
  const empty = { added: [], removed: [], created: [] };
  if (!id) return empty;
  const contact = await getContactById(id, env);
  if (!contact) return empty;

  const sceneNames = sceneTokensFromCircles(contact.networkCircles);
  const sceneKeys = new Set(sceneNames.map((n) => n.toLowerCase()));
  const { groups } = await loadNetworkGroups(env);
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const created = [];
  /** @type {Set<string>} */
  const coveredKeys = new Set();

  for (const g of groups) {
    if (g.kind !== 'community') continue;
    const name = normalizeSceneGroupName(g.name, 300);
    if (!name || isOutOfTownToken(name) || isPolidayToken(name) || isDroppedSceneToken(name)) continue;
    const key = name.toLowerCase();
    coveredKeys.add(key);
    const isMember = (g.memberIds || []).includes(id);
    const shouldBe = sceneKeys.has(key);
    if (shouldBe && !isMember) {
      writeGroupMemberIds(g, [...(g.memberIds || []), id], env);
      added.push(g.id);
    } else if (!shouldBe && isMember) {
      writeGroupMemberIds(
        g,
        (g.memberIds || []).filter((mid) => mid !== id),
        env,
      );
      removed.push(g.id);
    }
  }

  for (const name of sceneNames) {
    const key = name.toLowerCase();
    if (coveredKeys.has(key)) continue;
    if (isOutOfTownToken(name) || isPolidayToken(name) || isDroppedSceneToken(name)) continue;
    const groupId = key === 'runway house' ? RUNWAY_HOUSE_GROUP_ID : newGroupId();
    const now = new Date().toISOString();
    const createdGroup = normalizeGroup({
      id: groupId,
      name,
      kind: 'community',
      memberIds: [id],
      description: '',
      source: 'scene-sync',
      createdAt: now,
      updatedAt: now,
    });
    if (!createdGroup) continue;
    upsertGroupRow(openNetworkDb(env), createdGroup);
    coveredKeys.add(key);
    created.push(createdGroup.id);
    added.push(createdGroup.id);
  }

  return { added, removed, created };
}

/**
 * Wipe all groups (without stripping contact Scene tags) and recreate
 * community groups from every contact's Scene tokens.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function rebuildCommunityGroupsFromScenes(env = process.env) {
  const { groups: prior } = await loadNetworkGroups(env);
  const priorIds = prior.map((g) => g.id).filter(Boolean);
  if (priorIds.length) {
    await deleteGroups(priorIds, env, { stripScenes: false });
  }

  const { contacts } = await loadNetworkContacts(env);
  /** @type {Map<string, { name: string, memberIds: string[] }>} */
  const byScene = new Map();
  for (const c of contacts) {
    if (!c?.id) continue;
    for (const name of sceneTokensFromCircles(c.networkCircles)) {
      if (isOutOfTownToken(name) || isPolidayToken(name) || isDroppedSceneToken(name)) continue;
      const key = name.toLowerCase();
      let entry = byScene.get(key);
      if (!entry) {
        entry = { name, memberIds: [] };
        byScene.set(key, entry);
      }
      if (!entry.memberIds.includes(c.id)) entry.memberIds.push(c.id);
    }
  }

  const now = new Date().toISOString();
  /** @type {object[]} */
  const created = [];
  const db = openNetworkDb(env);
  for (const entry of [...byScene.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )) {
    const id = entry.name.toLowerCase() === 'runway house' ? RUNWAY_HOUSE_GROUP_ID : newGroupId();
    const group = normalizeGroup({
      id,
      name: entry.name,
      kind: 'community',
      memberIds: entry.memberIds,
      description: '',
      source: 'scene-rebuild',
      createdAt: now,
      updatedAt: now,
    });
    if (!group) continue;
    upsertGroupRow(db, group);
    created.push(group);
  }

  // Foundation: keep Runway House even when no Scene tags currently reference it.
  const hasRunway = created.some(
    (g) => g.id === RUNWAY_HOUSE_GROUP_ID || String(g.name || '').toLowerCase() === 'runway house',
  );
  if (!hasRunway) {
    const memberIds = [];
    for (const cid of [JULIA_CONTACT_ID, SAM_CONTACT_ID]) {
      const c = await getContactById(cid, env);
      if (!c) continue;
      memberIds.push(c.id);
      const next = addSceneToken(c.networkCircles, 'Runway House');
      if (next !== String(c.networkCircles || '')) {
        await updateContact(c.id, { networkCircles: next }, env, { skipGroupSync: true });
      }
    }
    const runway = normalizeGroup({
      id: RUNWAY_HOUSE_GROUP_ID,
      name: 'Runway House',
      kind: 'community',
      memberIds,
      description: 'Runway House network circle.',
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    });
    if (runway) {
      upsertGroupRow(db, runway);
      created.push(runway);
    }
  }

  return {
    deleted: priorIds.length,
    created: created.length,
    groups: created,
  };
}

/**
 * Sync Scene / Out-of-town location for community group membership.
 * Event groups never touch contact attributes.
 * @param {object} group
 * @param {string[]} contactIds
 * @param {'add' | 'remove'} mode
 * @param {NodeJS.ProcessEnv} [env]
 */
async function syncCommunityMembership(group, contactIds, mode, env = process.env) {
  if (!group || group.kind !== 'community') return;
  const ids = cleanIdList(contactIds);
  if (!ids.length) return;

  const groupIsOutOfTown = isOutOfTownToken(group.name);
  for (const id of ids) {
    const contact = await getContactById(id, env);
    if (!contact) continue;

    if (groupIsOutOfTown) {
      if (mode === 'add' && !String(contact.location || '').trim()) {
        await updateContact(contact.id, { location: 'Out of town' }, env, { skipGroupSync: true });
      }
      // Do not clear location on remove — it may be set for other reasons.
      continue;
    }

    if (!group.name) continue;
    const next =
      mode === 'add'
        ? addSceneToken(contact.networkCircles, group.name)
        : removeSceneToken(contact.networkCircles, group.name);
    if (next === String(contact.networkCircles || '')) continue;
    await updateContact(contact.id, { networkCircles: next }, env, { skipGroupSync: true });
  }
}

/**
 * After a community rename or kind flip, rewrite Scene tags on members.
 * @param {object} prev
 * @param {object} next
 * @param {NodeJS.ProcessEnv} [env]
 */
async function syncCommunityMetaChange(prev, next, env = process.env) {
  const memberIds = cleanIdList(next?.memberIds || prev?.memberIds);
  if (!memberIds.length) return;

  const wasCommunity = prev?.kind === 'community';
  const isCommunity = next?.kind === 'community';

  if (wasCommunity && !isCommunity) {
    // Demoted to event — strip the old community Scene token.
    await syncCommunityMembership({ ...prev, kind: 'community' }, memberIds, 'remove', env);
    return;
  }

  if (!wasCommunity && isCommunity) {
    await syncCommunityMembership(next, memberIds, 'add', env);
    return;
  }

  if (!isCommunity) return;

  const oldName = String(prev?.name || '');
  const newName = String(next?.name || '');
  if (oldName.toLowerCase() === newName.toLowerCase()) return;

  const oldOut = isOutOfTownToken(oldName);
  const newOut = isOutOfTownToken(newName);

  for (const id of memberIds) {
    const contact = await getContactById(id, env);
    if (!contact) continue;

    if (oldOut || newOut) {
      // Out-of-town is location, not Scene — only set location when becoming Out of town.
      if (newOut && !String(contact.location || '').trim()) {
        await updateContact(contact.id, { location: 'Out of town' }, env, { skipGroupSync: true });
      }
      if (oldOut && !newOut && newName) {
        const nextCircles = addSceneToken(contact.networkCircles, newName);
        if (nextCircles !== String(contact.networkCircles || '')) {
          await updateContact(contact.id, { networkCircles: nextCircles }, env, { skipGroupSync: true });
        }
      }
      continue;
    }

    const nextCircles = replaceSceneToken(contact.networkCircles, oldName, newName);
    if (nextCircles === String(contact.networkCircles || '')) continue;
    await updateContact(contact.id, { networkCircles: nextCircles }, env, { skipGroupSync: true });
  }
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
  if (normalized.kind === 'community' && (normalized.memberIds || []).length) {
    await syncCommunityMembership(normalized, normalized.memberIds, 'add', env);
  }
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
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'kind')) {
    merged.kind = patch.kind;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'eventType')) {
    merged.eventType = patch.eventType;
  }
  const normalized = normalizeGroup(merged);
  if (!normalized) {
    const err = new Error('invalid_group');
    err.code = 'invalid_group';
    throw err;
  }
  upsertGroupRow(openNetworkDb(env), normalized);

  const kindChanged = prev.kind !== normalized.kind;
  const nameChanged = String(prev.name || '').toLowerCase() !== String(normalized.name || '').toLowerCase();
  if (kindChanged || nameChanged) {
    await syncCommunityMetaChange(prev, normalized, env);
  }

  return normalized;
}

/**
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ stripScenes?: boolean }} [opts] When stripScenes is false, delete rows
 *   without removing Scene tags from contacts (used by rebuild-from-scenes).
 */
export async function deleteGroups(ids, env = process.env, opts = {}) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map((id) => remapLegacyNetworkId(String(id))))].filter(
    Boolean,
  );
  if (!want.length) return { deleted: 0 };
  const stripScenes = opts.stripScenes !== false;

  if (stripScenes) {
    for (const id of want) {
      const group = await getGroupById(id, env);
      if (group?.kind === 'community' && (group.memberIds || []).length) {
        await syncCommunityMembership(group, group.memberIds, 'remove', env);
      }
    }
  }

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
  const before = new Set(group.memberIds || []);
  const set = new Set(before);
  /** @type {string[]} */
  const added = [];
  for (const id of contactIds || []) {
    const s = remapLegacyNetworkId(cleanStr(id, 80));
    if (!s || set.has(s)) continue;
    set.add(s);
    added.push(s);
  }
  const updated = await updateGroup(groupId, { memberIds: [...set] }, env);
  if (updated && added.length) {
    await syncCommunityMembership(updated, added, 'add', env);
  }
  return updated;
}

/**
 * @param {string} groupId
 * @param {string[]} contactIds
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function removeMembersFromGroup(groupId, contactIds, env = process.env) {
  const group = await getGroupById(groupId, env);
  if (!group) return null;
  const drop = cleanIdList(contactIds);
  const dropSet = new Set(drop);
  const removed = (group.memberIds || []).filter((id) => dropSet.has(id));
  if (removed.length) {
    await syncCommunityMembership(group, removed, 'remove', env);
  }
  return updateGroup(
    groupId,
    { memberIds: (group.memberIds || []).filter((id) => !dropSet.has(id)) },
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
  const isCommunity = group.kind === 'community';
  const groupIsOutOfTown = isCommunity && isOutOfTownToken(group.name);

  for (const displayName of list) {
    let contact = await findContactByNameOrAlias(displayName, env);
    if (!contact) {
      /** @type {Record<string, unknown>} */
      const seed = {
        displayName,
        kinds: ['friend'],
        source: 'manual',
      };
      if (isCommunity) {
        if (groupIsOutOfTown) seed.location = 'Out of town';
        else if (group.name) seed.networkCircles = group.name;
      }
      contact = await addContact(seed, env);
      created.push(contact);
    } else {
      if (isCommunity) {
        if (groupIsOutOfTown) {
          if (!String(contact.location || '').trim()) {
            await updateContact(contact.id, { location: 'Out of town' }, env, { skipGroupSync: true });
          }
        } else if (group.name) {
          const next = addSceneToken(contact.networkCircles, group.name);
          if (next !== String(contact.networkCircles || '')) {
            await updateContact(contact.id, { networkCircles: next }, env, { skipGroupSync: true });
          }
        }
      }
      linked.push(contact);
    }
  }

  const memberIds = [
    ...new Set([...(group.memberIds || []), ...created.map((c) => c.id), ...linked.map((c) => c.id)]),
  ];
  // Members already got Scene via ingest above; updateGroup only stores memberIds.
  const updated = await updateGroup(groupId, { memberIds }, env);
  return { group: updated, created, linked };
}
