/**
 * 👎 feedback log + automatic Prefer less → Soft skip → Never show escalation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUIDE_SECTION_KEYS,
  appendToGuideSection,
} from './gmail-daily-summary-guide-store.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Similar 👎 count before promoting to Soft skip. */
export const ESCALATION_SOFT_SKIP_AT = 3;
/** Similar 👎 count before promoting to Never show. */
export const ESCALATION_NEVER_SHOW_AT = 5;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'have',
  'not', 'no', 'mail', 'email', 'similar', 'like', 'need', 'needed', 'action', 'when', 'where',
]);

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailDailySummaryGuideFeedbackPath(env = process.env) {
  const override = String(env.GMAIL_DAILY_SUMMARY_GUIDE_FEEDBACK_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'gmail-daily-summary-guide-feedback.json');
}

/**
 * @param {string} append
 */
export function normalizeGuidePatternKey(append) {
  return String(append || '')
    .replace(/^-\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} key
 */
function patternTokens(key) {
  return key
    .split(' ')
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * @param {string} a
 * @param {string} b
 */
export function guidePatternSimilarity(a, b) {
  const ta = new Set(patternTokens(normalizeGuidePatternKey(a)));
  const tb = new Set(patternTokens(normalizeGuidePatternKey(b)));
  if (!ta.size || !tb.size) {
    return normalizeGuidePatternKey(a) === normalizeGuidePatternKey(b) ? 1 : 0;
  }
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  return inter / Math.min(ta.size, tb.size);
}

/**
 * @param {Array<{ patternKey?: string, append?: string }>} entries
 * @param {string} patternKey
 * @param {string} append
 */
export function countSimilarThumbsDown(entries, patternKey) {
  let count = 0;
  for (const entry of entries) {
    const otherKey = String(entry?.patternKey || normalizeGuidePatternKey(entry?.append || '')).trim();
    if (!otherKey) continue;
    if (otherKey === patternKey || guidePatternSimilarity(otherKey, patternKey) >= 0.55) {
      count += 1;
    }
  }
  return count + 1;
}

/**
 * @param {number} similarCount
 */
export function resolveThumbsDownEscalation(similarCount) {
  if (similarCount >= ESCALATION_NEVER_SHOW_AT) {
    return { tier: 'never_show', promoteSection: 'never_show', similarCount };
  }
  if (similarCount >= ESCALATION_SOFT_SKIP_AT) {
    return { tier: 'soft_skip', promoteSection: 'soft_skip', similarCount };
  }
  return { tier: 'prefer_less', promoteSection: null, similarCount };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function loadFeedbackLog(env = process.env) {
  try {
    const raw = await fs.readFile(gmailDailySummaryGuideFeedbackPath(env), 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { entries };
  } catch (e) {
    if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
    return { entries: [] };
  }
}

/**
 * @param {{ entries: unknown[] }} log
 * @param {NodeJS.ProcessEnv} [env]
 */
async function saveFeedbackLog(log, env = process.env) {
  const target = gmailDailySummaryGuideFeedbackPath(env);
  const body = `${JSON.stringify({ entries: log.entries }, null, 2)}\n`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, body, 'utf8');
  await fs.rename(staging, target);
}

/**
 * @param {string} append
 */
function canonicalGuideBullet(append) {
  const line = String(append || '').trim();
  if (!line) return '';
  return line.startsWith('-') ? line : `- ${line}`;
}

/**
 * @param {{
 *   append?: string,
 *   item?: { title?: string, company?: string, detail?: string },
 * }} input
 * @param {string} guide
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function recordThumbsDownAndEscalate(input, guide, env = process.env) {
  const append = canonicalGuideBullet(input?.append || '');
  const patternKey = normalizeGuidePatternKey(append);
  if (!patternKey) {
    return { guide, escalation: null };
  }

  const log = await loadFeedbackLog(env);
  const similarCount = countSimilarThumbsDown(log.entries, patternKey);
  log.entries.push({
    at: new Date().toISOString(),
    patternKey,
    append,
    itemTitle: String(input?.item?.title || '').trim() || null,
    company: String(input?.item?.company || '').trim() || null,
  });
  if (log.entries.length > 400) {
    log.entries = log.entries.slice(-400);
  }
  await saveFeedbackLog(log, env);

  const escalation = resolveThumbsDownEscalation(similarCount);
  let nextGuide = guide;
  if (escalation.promoteSection) {
    const heading = GUIDE_SECTION_KEYS[escalation.promoteSection];
    nextGuide = appendToGuideSection(nextGuide, heading, append);
  }

  return {
    guide: nextGuide,
    escalation: {
      ...escalation,
      promoteLine: escalation.promoteSection ? append : null,
    },
  };
}

/**
 * Replay 👎 feedback log into Prefer less / Soft skip / Never show when the guide
 * is missing those bullets (e.g. guide was overwritten after feedback was recorded).
 * @param {string} guide
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function syncFeedbackLogIntoGuide(guide, env = process.env) {
  const log = await loadFeedbackLog(env);
  if (!log.entries.length) {
    return { guide, changed: false, appended: 0, escalated: 0 };
  }

  let next = String(guide || '');
  let appended = 0;
  let escalated = 0;

  /** @type {Map<string, { append: string, count: number }>} */
  const clusters = new Map();

  for (const entry of log.entries) {
    const append = canonicalGuideBullet(entry?.append || '');
    const patternKey =
      String(entry?.patternKey || '').trim() || normalizeGuidePatternKey(append);
    if (!append || !patternKey) continue;

    const before = next;
    next = appendToGuideSection(next, GUIDE_SECTION_KEYS.prefer_less, append);
    if (next !== before) appended += 1;

    let matched = false;
    for (const [key, value] of clusters) {
      if (key === patternKey || guidePatternSimilarity(key, patternKey) >= 0.55) {
        value.count += 1;
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.set(patternKey, { append, count: 1 });
    }
  }

  for (const { append, count } of clusters.values()) {
    const escalation = resolveThumbsDownEscalation(count);
    if (!escalation.promoteSection) continue;
    const heading = GUIDE_SECTION_KEYS[escalation.promoteSection];
    const before = next;
    next = appendToGuideSection(next, heading, append);
    if (next !== before) escalated += 1;
  }

  return {
    guide: next,
    changed: next !== String(guide || ''),
    appended,
    escalated,
  };
}
