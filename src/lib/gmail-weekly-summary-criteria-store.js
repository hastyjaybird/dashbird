/**
 * Daily Summary topic/circumstance rubrics (Look for / Grey / Black).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const DEFAULT_CRITERIA = {
  lookFor:
    'Deadlines I own or need to meet\nScheduling that needs a yes/no from me\nMoney, contracts, or docs to sign\nTravel or logistics needing confirmation\nAnything waiting on my reply\nImportant personal/family follow-ups',
  skip:
    'FYI newsletters with weak or no action\nAutomated status updates I only need to skim\nCC threads where someone else owns the next step',
  blacklist:
    'Pure marketing / promo blasts\nAccount verification / magic links / sign-in OTP emails\nPassword resets and security codes\nEvent invites, RSVPs, info sessions, workshops (Events Finder)\nShipping/delivery noise with no action needed\nUnsubscribe / list hygiene mail',
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailWeeklySummaryCriteriaPath(env = process.env) {
  for (const key of ['GMAIL_DAILY_SUMMARY_CRITERIA_PATH', 'GMAIL_WEEKLY_SUMMARY_CRITERIA_PATH']) {
    const override = String(env[key] || '').trim();
    if (override) {
      return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
    }
  }
  return path.join(PKG_ROOT, 'data', 'gmail-weekly-summary-criteria.json');
}

/**
 * @param {unknown} value
 */
function asText(value) {
  return String(value ?? '').trimEnd();
}

/**
 * @param {unknown} raw
 */
function normalizeCriteria(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    lookFor: asText(src.lookFor ?? DEFAULT_CRITERIA.lookFor),
    skip: asText(src.skip ?? DEFAULT_CRITERIA.skip),
    blacklist: asText(src.blacklist ?? DEFAULT_CRITERIA.blacklist),
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadGmailWeeklySummaryCriteria(env = process.env) {
  try {
    const raw = await fs.readFile(gmailWeeklySummaryCriteriaPath(env), 'utf8');
    return normalizeCriteria(JSON.parse(raw));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return { ...DEFAULT_CRITERIA };
    }
    throw e;
  }
}

/**
 * @param {unknown} body
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveGmailWeeklySummaryCriteria(body, env = process.env) {
  const prev = await loadGmailWeeklySummaryCriteria(env);
  const src = body && typeof body === 'object' ? body : {};
  const next = {
    lookFor: src.lookFor != null ? asText(src.lookFor) : prev.lookFor,
    skip: src.skip != null ? asText(src.skip) : prev.skip,
    blacklist: src.blacklist != null ? asText(src.blacklist) : prev.blacklist,
  };
  const p = gmailWeeklySummaryCriteriaPath(env);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Append unique lines into a rubric field.
 * @param {string} existing
 * @param {string} additions
 */
export function mergeRubricLines(existing, additions) {
  const seen = new Set();
  const out = [];
  for (const line of String(existing || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  for (const line of String(additions || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

/**
 * @param {{
 *   vibe: 'up' | 'down',
 *   lookFor?: string,
 *   skip?: string,
 *   blacklist?: string,
 * }} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function applyGmailWeeklySummaryPreference(patch, env = process.env) {
  const prev = await loadGmailWeeklySummaryCriteria(env);
  const vibe = patch?.vibe === 'down' ? 'down' : 'up';
  if (vibe === 'up') {
    return saveGmailWeeklySummaryCriteria(
      {
        lookFor: mergeRubricLines(prev.lookFor, patch?.lookFor || ''),
        skip: prev.skip,
        blacklist: prev.blacklist,
      },
      env,
    );
  }
  return saveGmailWeeklySummaryCriteria(
    {
      lookFor: prev.lookFor,
      skip: mergeRubricLines(prev.skip, patch?.skip || ''),
      blacklist: mergeRubricLines(prev.blacklist, patch?.blacklist || ''),
    },
    env,
  );
}

export { DEFAULT_CRITERIA as GMAIL_WEEKLY_SUMMARY_DEFAULT_CRITERIA };
