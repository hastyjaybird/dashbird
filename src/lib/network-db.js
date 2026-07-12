/**
 * Network CRM — local SQLite (data/network.db). Gitignored; not pushed with the repo.
 * Uses Node's built-in node:sqlite (DatabaseSync), same pattern as events-finder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Stable contact ids (not “seed” — normal first rows). */
export const JULIA_CONTACT_ID = 'julia-hasty';
export const SAM_CONTACT_ID = 'sam-levac-levey';

export const CORVIDAE_ORG_ID = 'corvidae-labs';
export const ALL_POWER_LABS_ORG_ID = 'all-power-labs';
export const STARSHOT_ORG_ID = 'starshot-capital';
export const RUNWAY_HOUSE_GROUP_ID = 'runway-house';

/** @deprecated use JULIA_CONTACT_ID */
export const JULIA_SEED_ID = JULIA_CONTACT_ID;
/** @deprecated use SAM_CONTACT_ID */
export const SAM_LEVAC_LEVEY_ID = SAM_CONTACT_ID;

const LEGACY_ID_MAP = {
  'seed-julia-hasty': JULIA_CONTACT_ID,
  'seed-sam-levac-levey': SAM_CONTACT_ID,
  'seed-org-corvidae-labs': CORVIDAE_ORG_ID,
  'seed-org-all-power-labs': ALL_POWER_LABS_ORG_ID,
  'seed-group-runway-house': RUNWAY_HOUSE_GROUP_ID,
};

/** @type {DatabaseSync | null} */
let dbSingleton = null;
/** @type {string | null} */
let dbPathSingleton = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function networkDbPath(env = process.env) {
  const override = String(env.NETWORK_DB_PATH || '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  return path.join(PKG_ROOT, 'data', 'network.db');
}

/**
 * @param {string | null | undefined} id
 */
export function remapLegacyNetworkId(id) {
  const s = String(id || '').trim();
  if (!s) return s;
  return LEGACY_ID_MAP[s] || s;
}

/**
 * @param {DatabaseSync} db
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_orgs_name ON organizations(name);

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      org TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_contacts_name ON contacts(display_name);
    CREATE INDEX IF NOT EXISTS idx_network_contacts_created ON contacts(created_at);

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_groups_name ON groups(name);

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_network_notes_created ON notes(created_at DESC);
  `);
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 */
function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Allocate the next system-only numeric contact id (returned as a decimal string).
 * Existing slug/UUID ids are left alone; new contacts get 1, 2, 3, …
 * @param {DatabaseSync} db
 * @returns {string}
 */
export function allocateNextContactId(db) {
  const key = 'contact_id_seq';
  let next = Number(getMeta(db, key) || 0);
  if (!Number.isFinite(next) || next < 1) {
    const rows = db.prepare('SELECT id FROM contacts').all();
    let max = 0;
    for (const r of rows) {
      const n = Number(String(r.id || ''));
      if (Number.isInteger(n) && String(n) === String(r.id).trim() && n > max) max = n;
    }
    next = max + 1;
  }
  setMeta(db, key, String(next + 1));
  return String(next);
}

/**
 * @param {unknown} v
 */
function parsePayload(v) {
  if (v && typeof v === 'object') return v;
  try {
    return JSON.parse(String(v || '{}'));
  } catch {
    return {};
  }
}

/**
 * @param {object} contact
 */
export function contactToRow(contact) {
  return {
    id: contact.id,
    display_name: String(contact.displayName || ''),
    org: String(contact.org || ''),
    payload: JSON.stringify(contact),
    created_at: String(contact.createdAt || new Date().toISOString()),
    updated_at: String(contact.updatedAt || new Date().toISOString()),
  };
}

/**
 * @param {object} org
 */
export function orgToRow(org) {
  return {
    id: org.id,
    name: String(org.name || ''),
    payload: JSON.stringify(org),
    created_at: String(org.createdAt || new Date().toISOString()),
    updated_at: String(org.updatedAt || new Date().toISOString()),
  };
}

/**
 * @param {object} group
 */
export function groupToRow(group) {
  return {
    id: group.id,
    name: String(group.name || ''),
    payload: JSON.stringify(group),
    created_at: String(group.createdAt || new Date().toISOString()),
    updated_at: String(group.updatedAt || new Date().toISOString()),
  };
}

/**
 * @param {{ id: string, display_name?: string, org?: string, payload: string, created_at?: string, updated_at?: string }} row
 */
export function rowToContact(row) {
  const p = parsePayload(row.payload);
  return {
    ...p,
    id: row.id,
    displayName: p.displayName ?? row.display_name ?? '',
    org: p.org ?? row.org ?? '',
    createdAt: p.createdAt || row.created_at,
    updatedAt: p.updatedAt || row.updated_at,
  };
}

/**
 * @param {{ id: string, name?: string, payload: string, created_at?: string, updated_at?: string }} row
 */
export function rowToOrg(row) {
  const p = parsePayload(row.payload);
  return {
    ...p,
    id: row.id,
    name: p.name ?? row.name ?? '',
    createdAt: p.createdAt || row.created_at,
    updatedAt: p.updatedAt || row.updated_at,
  };
}

/**
 * @param {{ id: string, name?: string, payload: string, created_at?: string, updated_at?: string }} row
 */
export function rowToGroup(row) {
  const p = parsePayload(row.payload);
  return {
    ...p,
    id: row.id,
    name: p.name ?? row.name ?? '',
    createdAt: p.createdAt || row.created_at,
    updatedAt: p.updatedAt || row.updated_at,
  };
}

/**
 * @param {DatabaseSync} db
 * @param {object} contact
 */
export function upsertContactRow(db, contact) {
  const row = contactToRow(contact);
  db.prepare(
    `INSERT INTO contacts (id, display_name, org, payload, created_at, updated_at)
     VALUES (@id, @display_name, @org, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       org = excluded.org,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  ).run(row);
}

/**
 * @param {DatabaseSync} db
 * @param {object} org
 */
export function upsertOrgRow(db, org) {
  const row = orgToRow(org);
  db.prepare(
    `INSERT INTO organizations (id, name, payload, created_at, updated_at)
     VALUES (@id, @name, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  ).run(row);
}

/**
 * @param {DatabaseSync} db
 * @param {object} group
 */
export function upsertGroupRow(db, group) {
  const row = groupToRow(group);
  db.prepare(
    `INSERT INTO groups (id, name, payload, created_at, updated_at)
     VALUES (@id, @name, @payload, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  ).run(row);
}

/**
 * @param {string} rel
 * @param {NodeJS.ProcessEnv} [env]
 */
function dataFile(rel, env = process.env) {
  return path.join(PKG_ROOT, 'data', rel);
}

/**
 * @param {string} filePath
 */
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * One-time import from legacy JSON files into SQLite.
 * @param {DatabaseSync} db
 * @param {NodeJS.ProcessEnv} [env]
 */
function migrateFromJsonIfNeeded(db, env = process.env) {
  if (getMeta(db, 'json_migrated') === '1') return;

  const contactsPath = String(env.NETWORK_CONTACTS_PATH || '').trim()
    ? path.isAbsolute(env.NETWORK_CONTACTS_PATH)
      ? env.NETWORK_CONTACTS_PATH
      : path.join(PKG_ROOT, env.NETWORK_CONTACTS_PATH)
    : dataFile('network-contacts.json', env);
  const orgsPath = dataFile('network-organizations.json', env);
  const groupsPath = dataFile('network-groups.json', env);
  const notesPath = dataFile('network-notes.json', env);

  const contactsJson = readJsonFile(contactsPath);
  const orgsJson = readJsonFile(orgsPath);
  const groupsJson = readJsonFile(groupsPath);
  const notesJson = readJsonFile(notesPath);

  const hasAny =
    (contactsJson?.contacts?.length || 0) +
      (orgsJson?.organizations?.length || 0) +
      (groupsJson?.groups?.length || 0) +
      (notesJson?.notes?.length || 0) >
    0;

  if (!hasAny) {
    setMeta(db, 'json_migrated', '1');
    return;
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM contacts').get();
  if (Number(count?.n) > 0) {
    setMeta(db, 'json_migrated', '1');
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const raw of orgsJson?.organizations || []) {
      const id = remapLegacyNetworkId(raw.id);
      const source = raw.source === 'seed' ? 'manual' : raw.source || 'manual';
      upsertOrgRow(db, { ...raw, id, source });
    }
    for (const raw of contactsJson?.contacts || []) {
      const id = remapLegacyNetworkId(raw.id);
      const orgId = raw.orgId ? remapLegacyNetworkId(raw.orgId) : raw.orgId;
      const source = raw.source === 'seed' ? 'manual' : raw.source || 'manual';
      upsertContactRow(db, { ...raw, id, orgId, source });
    }
    for (const raw of groupsJson?.groups || []) {
      const id = remapLegacyNetworkId(raw.id);
      const memberIds = (Array.isArray(raw.memberIds) ? raw.memberIds : []).map(remapLegacyNetworkId);
      const source = raw.source === 'seed' ? 'manual' : raw.source || 'manual';
      upsertGroupRow(db, { ...raw, id, memberIds, source });
    }
    const noteStmt = db.prepare(
      `INSERT OR REPLACE INTO notes (id, contact_id, text, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const n of notesJson?.notes || []) {
      noteStmt.run(
        String(n.id || ''),
        n.contactId ? remapLegacyNetworkId(n.contactId) : null,
        String(n.text || ''),
        String(n.source || 'manual'),
        String(n.createdAt || new Date().toISOString()),
      );
    }
    setMeta(db, 'json_migrated', '1');
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Ensure Julia + Sam (and related orgs / Runway House) exist as normal rows.
 * @param {DatabaseSync} db
 * @param {NodeJS.ProcessEnv} [env]
 */
function ensureFoundationRows(db, env = process.env) {
  if (getMeta(db, 'foundation_v1') === '1') {
    // Still ensure the two people exist if deleted later? User asked for first entries on setup.
    // Only re-insert if missing.
  }

  const now = new Date().toISOString();
  const juliaCreated = '2020-01-01T00:00:00.000Z';
  const samCreated = '2020-01-01T00:00:01.000Z';

  const hasOrg = db.prepare('SELECT 1 AS ok FROM organizations WHERE id = ?').get(CORVIDAE_ORG_ID);
  if (!hasOrg) {
    upsertOrgRow(db, {
      id: CORVIDAE_ORG_ID,
      name: 'Corvidae Labs',
      aliases: ['Corvidae'],
      summary: 'clean-tech materials climate hardware co-founder venture',
      description: 'Clean technology venture associated with Julia / Jay Hasty.',
      website: null,
      location: 'California, USA',
      urls: [],
      logoUrl: null,
      enrichment: { sources: [], enrichedAt: null, rawSummary: null },
      createdAt: juliaCreated,
      updatedAt: now,
      source: 'manual',
    });
  }

  if (!db.prepare('SELECT 1 AS ok FROM organizations WHERE id = ?').get(ALL_POWER_LABS_ORG_ID)) {
    upsertOrgRow(db, {
      id: ALL_POWER_LABS_ORG_ID,
      name: 'All Power Labs',
      aliases: ['APL', 'ALL Power Labs'],
      summary: 'biomass gasification CHP Berkeley clean energy hardware',
      description: 'Berkeley biomass gasifier manufacturer; early clean-tech company.',
      website: 'https://www.allpowerlabs.com/',
      location: 'Berkeley, CA',
      urls: ['https://www.allpowerlabs.com/'],
      logoUrl: null,
      enrichment: { sources: [], enrichedAt: null, rawSummary: null },
      createdAt: juliaCreated,
      updatedAt: now,
      source: 'manual',
    });
  }

  if (!db.prepare('SELECT 1 AS ok FROM organizations WHERE id = ?').get(STARSHOT_ORG_ID)) {
    upsertOrgRow(db, {
      id: STARSHOT_ORG_ID,
      name: 'Starshot Capital',
      aliases: ['Starshot'],
      summary: 'climate VC Work on Climate',
      description: 'Climate venture capital firm.',
      website: 'https://starshotcapital.com/',
      location: '',
      urls: ['https://starshotcapital.com/'],
      logoUrl: null,
      enrichment: { sources: [], enrichedAt: null, rawSummary: null },
      createdAt: samCreated,
      updatedAt: now,
      source: 'manual',
    });
  }

  const assetsDir = path.join(PKG_ROOT, 'data', 'network-assets');
  let avatarUrl = null;
  try {
    fs.accessSync(path.join(assetsDir, 'julia-hasty.jpg'));
    avatarUrl = '/api/network/assets/julia-hasty.jpg';
  } catch {
    avatarUrl = null;
  }

  const hasJulia =
    db.prepare('SELECT 1 AS ok FROM contacts WHERE id = ?').get(JULIA_CONTACT_ID) ||
    db.prepare(`SELECT 1 AS ok FROM contacts WHERE lower(display_name) = 'julia hasty'`).get();
  if (!hasJulia) {
    upsertContactRow(db, {
      id: JULIA_CONTACT_ID,
      displayName: 'Julia Hasty',
      aliases: ['Jay Hasty', 'Jaybird', 'Dr. Jay Hasty', 'Dr. Julia Hasty'],
      kinds: ['friend'],
      summary: 'clean-tech materials biomass gasification climate hardware PhD Corvidae All Power Labs',
      notes: '',
      bio:
        'Clean technology and materials scientist. Founding / early roles at All Power Labs (customer & technical support for biomass gasification systems). Co-founder of Corvidae Labs. PhD in Material Science Engineering (Stony Brook); B.S. Chemistry (Radford / Oxford University in Virginia).',
      howWeMet: '',
      networkCircles: 'Runway House',
      alignedActivities: [
        'Clean tech / climate hardware projects',
        'Materials and energy systems R&D',
        'Building personal tools (Dashbird, Corvidae)',
      ],
      org: 'Corvidae Labs',
      orgId: CORVIDAE_ORG_ID,
      title: 'Co-founder',
      location: 'California, USA',
      preferredContactMethods: ['email', 'signal', 'phone'],
      channels: {
        email: null,
        phone: null,
        sms: null,
        signal: null,
        whatsapp: null,
        linkedin: 'https://www.linkedin.com/in/dr-jay/',
        urls: ['https://www.neoh2.com/team/', 'https://www.linkedin.com/in/dr-jay/'],
      },
      avatarUrl,
      lastContactAt: null,
      lastContactChannel: null,
      enrichment: {
        sources: [
          'https://www.neoh2.com/team/',
          'https://www.linkedin.com/in/dr-jay/',
        ],
        enrichedAt: now,
        rawSummary: 'Public Neo-H2 team bio and LinkedIn.',
      },
      createdAt: juliaCreated,
      updatedAt: now,
      source: 'manual',
    });
  }

  const hasSam =
    db.prepare('SELECT 1 AS ok FROM contacts WHERE id = ?').get(SAM_CONTACT_ID) ||
    db
      .prepare(`SELECT 1 AS ok FROM contacts WHERE lower(display_name) = 'sam levac-levey'`)
      .get();
  if (!hasSam) {
    upsertContactRow(db, {
      id: SAM_CONTACT_ID,
      displayName: 'Sam Levac-Levey',
      aliases: ['Samuel Levac-Levey', 'Sam Levac Levey'],
      kinds: ['friend', 'business'],
      summary: 'climate VC Starshot Capital Work on Climate SpaceX Tesla Lilium mechanical engineering',
      notes: '',
      bio: 'Founding Partner at Starshot Capital. Founding member of Work on Climate. Background in mechanical engineering (SpaceX, Tesla, Lilium).',
      howWeMet: '',
      networkCircles: 'Runway House',
      alignedActivities: [],
      org: 'Starshot Capital',
      orgId: STARSHOT_ORG_ID,
      title: 'Founding Partner',
      location: '',
      preferredContactMethods: ['email', 'linkedin'],
      channels: {
        email: null,
        phone: null,
        sms: null,
        signal: null,
        whatsapp: null,
        linkedin: 'https://www.linkedin.com/in/sam-levac-levey',
        urls: ['https://starshotcapital.com/'],
      },
      avatarUrl: null,
      lastContactAt: null,
      lastContactChannel: null,
      enrichment: { sources: [], enrichedAt: null, rawSummary: null },
      createdAt: samCreated,
      updatedAt: now,
      source: 'manual',
    });
  }

  const hasRunway =
    db.prepare('SELECT 1 AS ok FROM groups WHERE id = ?').get(RUNWAY_HOUSE_GROUP_ID) ||
    db.prepare(`SELECT 1 AS ok FROM groups WHERE lower(name) = 'runway house'`).get();
  if (!hasRunway) {
    upsertGroupRow(db, {
      id: RUNWAY_HOUSE_GROUP_ID,
      name: 'Runway House',
      description: 'Runway House network circle.',
      memberIds: [JULIA_CONTACT_ID, SAM_CONTACT_ID],
      commonalities: [],
      suggestions: [],
      commonalitiesUpdatedAt: null,
      createdAt: juliaCreated,
      updatedAt: now,
      source: 'manual',
    });
  } else {
    const gRow = db.prepare('SELECT id, payload FROM groups WHERE id = ? OR lower(name) = ?').get(
      RUNWAY_HOUSE_GROUP_ID,
      'runway house',
    );
    if (gRow) {
      const g = rowToGroup(gRow);
      const set = new Set(g.memberIds || []);
      set.add(JULIA_CONTACT_ID);
      set.add(SAM_CONTACT_ID);
      // Remap any legacy seed member ids
      const memberIds = [...set].map(remapLegacyNetworkId);
      upsertGroupRow(db, {
        ...g,
        id: remapLegacyNetworkId(g.id) || RUNWAY_HOUSE_GROUP_ID,
        memberIds,
        source: g.source === 'seed' ? 'manual' : g.source || 'manual',
        updatedAt: now,
      });
    }
  }

  // Keep Julia / Sam as the first two rows (by created_at) and drop seed labeling.
  const foundationTimes = {
    [JULIA_CONTACT_ID]: juliaCreated,
    [SAM_CONTACT_ID]: samCreated,
  };
  for (const id of [JULIA_CONTACT_ID, SAM_CONTACT_ID]) {
    const row = db
      .prepare('SELECT id, display_name, org, payload, created_at, updated_at FROM contacts WHERE id = ?')
      .get(id);
    if (!row) continue;
    const c = rowToContact(row);
    upsertContactRow(db, {
      ...c,
      source: 'manual',
      createdAt: foundationTimes[id],
      updatedAt: now,
    });
  }

  setMeta(db, 'foundation_v1', '1');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DatabaseSync}
 */
export function openNetworkDb(env = process.env) {
  const dbPath = networkDbPath(env);
  if (dbSingleton && dbPathSingleton === dbPath) return dbSingleton;

  if (dbSingleton) {
    try {
      dbSingleton.close();
    } catch {
      /* ignore */
    }
    dbSingleton = null;
    dbPathSingleton = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  migrate(db);
  migrateFromJsonIfNeeded(db, env);
  ensureFoundationRows(db, env);
  dbSingleton = db;
  dbPathSingleton = dbPath;
  return db;
}

export function closeNetworkDb() {
  if (!dbSingleton) return;
  try {
    dbSingleton.close();
  } catch {
    /* ignore */
  }
  dbSingleton = null;
  dbPathSingleton = null;
}
