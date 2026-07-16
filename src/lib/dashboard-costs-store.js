/**
 * Editable Dashbird spend ledger (weekly tracking for Settings → Costs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEED_PATH = path.join(PKG_ROOT, 'src/data/dashboard-costs.default.json');

const CADENCES = new Set([
  'usage',
  'fixed_weekly',
  'fixed_monthly',
  'free_tier',
  'optional',
]);

const DEFAULT_LEDGER = {
  currency: 'USD',
  items: [],
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dashboardCostsPath(env = process.env) {
  const override = String(env.DASHBOARD_COSTS_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data/dashboard-costs.json');
}

/**
 * @param {unknown} n
 * @param {number} [fallback]
 */
function money(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.round(v * 100) / 100;
}

/**
 * @param {unknown} raw
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!id) return null;
  const label = String(raw.label || id).trim().slice(0, 80) || id;
  const category = String(raw.category || 'Other').trim().slice(0, 40) || 'Other';
  const cadenceRaw = String(raw.cadence || 'usage').trim().toLowerCase();
  const cadence = CADENCES.has(cadenceRaw) ? cadenceRaw : 'usage';
  const notes = String(raw.notes || '').trim().slice(0, 240);
  const measuredSource = String(raw.measuredSource || '').trim().slice(0, 64) || null;
  const monthlyBudgetUsd =
    raw.monthlyBudgetUsd == null || raw.monthlyBudgetUsd === ''
      ? null
      : money(raw.monthlyBudgetUsd, null);
  return {
    id,
    label,
    category,
    cadence,
    weeklyUsd: money(raw.weeklyUsd, 0),
    monthlyBudgetUsd: monthlyBudgetUsd == null || !Number.isFinite(monthlyBudgetUsd) ? null : monthlyBudgetUsd,
    notes,
    measuredSource,
    active: raw.active !== false,
  };
}

/**
 * @param {unknown} raw
 */
export function normalizeDashboardCosts(raw) {
  const currency = String(raw?.currency || 'USD').trim().toUpperCase().slice(0, 8) || 'USD';
  const seen = new Set();
  /** @type {ReturnType<typeof normalizeItem>[]} */
  const items = [];
  const list = Array.isArray(raw?.items) ? raw.items : [];
  for (const entry of list) {
    const item = normalizeItem(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return {
    ok: true,
    ledger: {
      currency,
      items,
      updatedAt: raw?.updatedAt ? String(raw.updatedAt) : null,
    },
  };
}

async function ensureLedgerFile() {
  const live = dashboardCostsPath();
  try {
    await fs.access(live);
    return live;
  } catch {
    await fs.mkdir(path.dirname(live), { recursive: true });
    try {
      await fs.copyFile(SEED_PATH, live);
    } catch {
      await fs.writeFile(live, `${JSON.stringify(DEFAULT_LEDGER, null, 2)}\n`, 'utf8');
    }
    return live;
  }
}

/** @type {Promise<object> | null} */
let ledgerPromise = null;

export function invalidateDashboardCostsCache() {
  ledgerPromise = null;
}

/**
 * @returns {Promise<{ currency: string, items: object[], updatedAt: string | null }>}
 */
export async function loadDashboardCosts() {
  if (!ledgerPromise) {
    ledgerPromise = (async () => {
      const live = await ensureLedgerFile();
      const raw = JSON.parse(await fs.readFile(live, 'utf8'));
      const ledger = normalizeDashboardCosts(raw).ledger;
      // Merge any new seed items (by id) so Settings picks up catalog additions.
      try {
        const seedRaw = JSON.parse(await fs.readFile(SEED_PATH, 'utf8'));
        const seed = normalizeDashboardCosts(seedRaw).ledger;
        const have = new Set(ledger.items.map((i) => i.id));
        let changed = false;
        for (const item of seed.items) {
          if (have.has(item.id)) continue;
          ledger.items.push(item);
          have.add(item.id);
          changed = true;
        }
        // Refresh measuredSource / notes on known seed rows without wiping edits.
        for (const seedItem of seed.items) {
          const idx = ledger.items.findIndex((i) => i.id === seedItem.id);
          if (idx < 0) continue;
          const cur = ledger.items[idx];
          if (seedItem.measuredSource && cur.measuredSource !== seedItem.measuredSource) {
            ledger.items[idx] = {
              ...cur,
              measuredSource: seedItem.measuredSource,
              monthlyBudgetUsd: cur.monthlyBudgetUsd ?? seedItem.monthlyBudgetUsd,
              notes: cur.notes || seedItem.notes,
              label: cur.label || seedItem.label,
            };
            changed = true;
          }
        }
        if (changed) {
          const payload = {
            currency: ledger.currency,
            items: ledger.items,
            updatedAt: ledger.updatedAt || new Date().toISOString(),
          };
          const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
          await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
          await fs.rename(tmp, live);
          return payload;
        }
      } catch {
        // Seed missing or unreadable — keep live ledger as-is.
      }
      return ledger;
    })();
  }
  return ledgerPromise;
}

/**
 * Replace or merge items. Body may be full ledger `{ currency, items }` or `{ items }` patch.
 * @param {unknown} body
 */
export async function saveDashboardCosts(body) {
  const current = await loadDashboardCosts();
  const nextRaw =
    body && typeof body === 'object' && Array.isArray(body.items)
      ? {
          currency: body.currency != null ? body.currency : current.currency,
          items: body.items,
          updatedAt: new Date().toISOString(),
        }
      : {
          ...current,
          updatedAt: new Date().toISOString(),
        };

  const normalized = normalizeDashboardCosts(nextRaw);
  if (!normalized.ok) return normalized;
  if (!normalized.ledger.items.length && Array.isArray(body?.items) && body.items.length) {
    return { ok: false, error: 'invalid_items' };
  }

  const live = await ensureLedgerFile();
  const payload = {
    currency: normalized.ledger.currency,
    items: normalized.ledger.items,
    updatedAt: normalized.ledger.updatedAt || new Date().toISOString(),
  };
  const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, live);
  invalidateDashboardCostsCache();
  return { ok: true, ledger: payload };
}
