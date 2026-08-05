/**
 * Away base profiles — travel destination for preview + GPS auto-away.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEED_PATH = path.join(PKG_ROOT, 'src/data/away-base.default.json');

/** @typedef {{
 *   id: string,
 *   label: string,
 *   zip: string,
 *   timeZone: string,
 *   radiusMi: number,
 *   events?: {
 *     partifulRegion?: string,
 *     facebookLocation?: string,
 *     filterCities?: string[],
 *     maxMiles?: number,
 *   },
 *   hideEarth?: string[],
 * }} AwayProfile */

/** @typedef {{
 *   activeProfileId: string | null,
 *   preview: boolean,
 *   autoAway: boolean,
 *   profiles: AwayProfile[],
 * }} AwayBaseState */

export function awayBasePath(env = process.env) {
  const override = String(env.AWAY_BASE_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/away-base.json');
}

/**
 * @returns {AwayBaseState}
 */
function emptyState() {
  return {
    activeProfileId: null,
    preview: false,
    autoAway: false,
    profiles: [],
  };
}

/**
 * @param {unknown} raw
 * @returns {AwayBaseState}
 */
export function normalizeAwayBaseState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const o = /** @type {Record<string, unknown>} */ (raw);
  base.preview = o.preview === true;
  base.autoAway = o.autoAway === true;
  const profiles = Array.isArray(o.profiles) ? o.profiles : [];
  /** @type {AwayProfile[]} */
  const out = [];
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const pr = /** @type {Record<string, unknown>} */ (p);
    const id = String(pr.id || '').trim();
    const zip = String(pr.zip || '').replace(/\D/g, '');
    if (!id || zip.length !== 5) continue;
    const radiusMi = Number(pr.radiusMi);
    /** @type {AwayProfile} */
    const profile = {
      id,
      label: String(pr.label || '').trim() || zip,
      zip,
      timeZone: String(pr.timeZone || '').trim() || 'America/New_York',
      radiusMi: Number.isFinite(radiusMi) && radiusMi > 0 ? radiusMi : 40,
    };
    if (pr.events && typeof pr.events === 'object') {
      const ev = /** @type {Record<string, unknown>} */ (pr.events);
      profile.events = {
        partifulRegion: String(ev.partifulRegion || '').trim() || undefined,
        facebookLocation: String(ev.facebookLocation || '').trim() || undefined,
        filterCities: Array.isArray(ev.filterCities)
          ? ev.filterCities.map((c) => String(c || '').trim()).filter(Boolean)
          : undefined,
        maxMiles: Number.isFinite(Number(ev.maxMiles)) ? Number(ev.maxMiles) : undefined,
      };
    }
    if (Array.isArray(pr.hideEarth)) {
      profile.hideEarth = pr.hideEarth.map((x) => String(x || '').trim()).filter(Boolean);
    }
    out.push(profile);
  }
  base.profiles = out;
  const activeId = String(o.activeProfileId || '').trim();
  base.activeProfileId =
    activeId && out.some((p) => p.id === activeId)
      ? activeId
      : out[0]?.id || null;
  return base;
}

async function ensureFile() {
  const live = awayBasePath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    try {
      await fs.copyFile(SEED_PATH, live);
    } catch {
      await fs.writeFile(live, `${JSON.stringify(emptyState(), null, 2)}\n`, 'utf8');
    }
    return live;
  }
}

/**
 * @returns {Promise<AwayBaseState>}
 */
export async function loadAwayBase() {
  const live = await ensureFile();
  try {
    const j = JSON.parse(await fs.readFile(live, 'utf8'));
    return normalizeAwayBaseState(j);
  } catch {
    return emptyState();
  }
}

/**
 * @param {Partial<AwayBaseState> & { profile?: Partial<AwayProfile> }} patch
 * @returns {Promise<{ ok: true, state: AwayBaseState } | { ok: false, error: string }>}
 */
export async function saveAwayBasePatch(patch) {
  const state = await loadAwayBase();
  if (typeof patch.preview === 'boolean') state.preview = patch.preview;
  if (typeof patch.autoAway === 'boolean') state.autoAway = patch.autoAway;
  if (typeof patch.activeProfileId === 'string') {
    const id = patch.activeProfileId.trim();
    if (id && !state.profiles.some((p) => p.id === id)) {
      return { ok: false, error: 'unknown_profile' };
    }
    state.activeProfileId = id || state.activeProfileId;
  }
  if (patch.profile && typeof patch.profile === 'object') {
    const pr = patch.profile;
    const id = String(pr.id || state.activeProfileId || '').trim();
    if (!id) return { ok: false, error: 'missing_profile_id' };
    let idx = state.profiles.findIndex((p) => p.id === id);
    if (idx < 0) {
      const zip = String(pr.zip || '').replace(/\D/g, '');
      if (zip.length !== 5) return { ok: false, error: 'invalid_zip' };
      state.profiles.push({
        id,
        label: String(pr.label || '').trim() || zip,
        zip,
        timeZone: String(pr.timeZone || 'America/New_York').trim(),
        radiusMi: Number(pr.radiusMi) > 0 ? Number(pr.radiusMi) : 40,
        events: pr.events,
        hideEarth: pr.hideEarth,
      });
      idx = state.profiles.length - 1;
      state.activeProfileId = id;
    } else {
      const cur = state.profiles[idx];
      if (pr.zip != null) {
        const zip = String(pr.zip).replace(/\D/g, '');
        if (zip.length !== 5) return { ok: false, error: 'invalid_zip' };
        cur.zip = zip;
      }
      if (pr.label != null) cur.label = String(pr.label).trim() || cur.zip;
      if (pr.timeZone != null) cur.timeZone = String(pr.timeZone).trim() || cur.timeZone;
      if (pr.radiusMi != null && Number(pr.radiusMi) > 0) cur.radiusMi = Number(pr.radiusMi);
      if (pr.events != null) cur.events = pr.events;
      if (pr.hideEarth != null) cur.hideEarth = pr.hideEarth;
      state.profiles[idx] = cur;
    }
  }
  const live = await ensureFile();
  const normalized = normalizeAwayBaseState(state);
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
  return { ok: true, state: normalized };
}

/**
 * @param {AwayBaseState} [state]
 * @returns {AwayProfile | null}
 */
export function getActiveAwayProfile(state) {
  if (!state?.profiles?.length) return null;
  const id = state.activeProfileId;
  return state.profiles.find((p) => p.id === id) || state.profiles[0] || null;
}
