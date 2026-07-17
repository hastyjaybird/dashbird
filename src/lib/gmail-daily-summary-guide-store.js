/**
 * Daily Summary email ingestion guide (markdown source of truth).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordThumbsDownAndEscalate } from './gmail-daily-summary-guide-feedback.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const LEARNED_MORE_HEADING = '### Prefer more like this';
const LEARNED_LESS_HEADING = '### Prefer less like this';

/** @typedef {'show_these' | 'soft_skip' | 'never_show' | 'prefer_more' | 'prefer_less'} GuideSectionKey */

/** @type {Record<GuideSectionKey, string>} */
export const GUIDE_SECTION_KEYS = {
  show_these: '## Show these (important)',
  soft_skip: '## Soft skip',
  never_show: '## Never show',
  prefer_more: LEARNED_MORE_HEADING,
  prefer_less: LEARNED_LESS_HEADING,
};

/**
 * @param {string} [sectionKey]
 */
export function guideSectionHeading(sectionKey) {
  const key = String(sectionKey || '').trim();
  if (key in GUIDE_SECTION_KEYS) return GUIDE_SECTION_KEYS[/** @type {GuideSectionKey} */ (key)];
  return LEARNED_MORE_HEADING;
}

/**
 * @param {'up' | 'down'} vibe
 */
export function vibeDefaultSection(vibe) {
  return vibe === 'down' ? 'prefer_less' : 'prefer_more';
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gmailDailySummaryGuidePath(env = process.env) {
  for (const key of ['GMAIL_DAILY_SUMMARY_GUIDE_PATH', 'GMAIL_WEEKLY_SUMMARY_GUIDE_PATH']) {
    const override = String(env[key] || '').trim();
    if (override) {
      return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
    }
  }
  return path.join(PKG_ROOT, 'data', 'gmail-daily-summary-guide.md');
}

function defaultGuideTemplatePath() {
  return path.join(PKG_ROOT, 'docs', 'gmail-daily-summary-guide.md');
}

/** @deprecated legacy JSON criteria path */
function legacyCriteriaPath(env = process.env) {
  for (const key of ['GMAIL_DAILY_SUMMARY_CRITERIA_PATH', 'GMAIL_WEEKLY_SUMMARY_CRITERIA_PATH']) {
    const override = String(env[key] || '').trim();
    if (override) {
      return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
    }
  }
  return path.join(PKG_ROOT, 'data', 'gmail-weekly-summary-criteria.json');
}

/**
 * @param {string[]} lines
 */
function bulletBlock(lines) {
  return lines
    .map((l) => String(l || '').trim())
    .filter(Boolean)
    .map((l) => `- ${l.replace(/^-\s*/, '')}`)
    .join('\n');
}

/**
 * @param {{ lookFor?: string, skip?: string, blacklist?: string }} criteria
 */
function guideFromLegacyCriteria(criteria) {
  const look = bulletBlock(String(criteria?.lookFor || '').split('\n'));
  const skip = bulletBlock(String(criteria?.skip || '').split('\n'));
  const black = bulletBlock(String(criteria?.blacklist || '').split('\n'));
  return `# Daily Summary — email ingestion guide

Migrated from legacy Look for / Grey / Black rubrics.

## Show these (important)

${look || '- (none)'}

## Soft skip

${skip || '- (none)'}

## Never show

${black || '- (none)'}

## Learned preferences

### Prefer more like this

<!-- thumbs-up appends below -->

### Prefer less like this

<!-- thumbs-down appends below -->
`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function seedDefaultGuide(env = process.env) {
  try {
    return await fs.readFile(defaultGuideTemplatePath(), 'utf8');
  } catch {
    return guideFromLegacyCriteria({});
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
async function migrateLegacyCriteria(env = process.env) {
  try {
    const raw = await fs.readFile(legacyCriteriaPath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return guideFromLegacyCriteria(parsed);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadGmailDailySummaryGuide(env = process.env) {
  const target = gmailDailySummaryGuidePath(env);
  try {
    const text = await fs.readFile(target, 'utf8');
    if (String(text || '').trim()) return text;
  } catch (e) {
    if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
  }
  const migrated = await migrateLegacyCriteria(env);
  const guide = migrated || (await seedDefaultGuide(env));
  await saveGmailDailySummaryGuide(guide, env);
  return guide;
}

/**
 * @param {string} markdown
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function saveGmailDailySummaryGuide(markdown, env = process.env) {
  const target = gmailDailySummaryGuidePath(env);
  const body = String(markdown ?? '').trimEnd();
  const normalized = body ? `${body}\n` : '\n';
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(staging, normalized, 'utf8');
  await fs.rename(staging, target);
  return normalized;
}

/**
 * @param {string} guide
 * @param {string} heading
 * @param {string} appendText
 */
export function appendToGuideSection(guide, heading, appendText) {
  const lines = String(appendText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return guide;

  const text = String(guide || '');
  const idx = text.indexOf(heading);
  if (idx < 0) {
    const suffix = lines.map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n');
    return `${text.trimEnd()}\n\n${heading}\n\n${suffix}\n`;
  }

  const afterHeading = idx + heading.length;
  const rest = text.slice(afterHeading);
  const nextSection = rest.search(/\n(?:##|###)\s+/);
  const sectionEnd = nextSection >= 0 ? afterHeading + nextSection : text.length;
  const sectionBody = text.slice(afterHeading, sectionEnd);
  const existing = new Set(
    sectionBody
      .split('\n')
      .map((l) => l.trim().replace(/^-\s*/, '').toLowerCase())
      .filter(Boolean),
  );

  const additions = [];
  for (const line of lines) {
    const bullet = line.startsWith('-') ? line : `- ${line}`;
    const key = bullet.replace(/^-\s*/, '').trim().toLowerCase();
    if (!key || existing.has(key)) continue;
    existing.add(key);
    additions.push(bullet);
  }
  if (!additions.length) return text;

  const insertAt = sectionEnd;
  const prefix = text.slice(0, insertAt).replace(/\s*$/, '');
  const suffix = text.slice(insertAt);
  const block = `\n${additions.join('\n')}`;
  return `${prefix}${block}${suffix.startsWith('\n') ? '' : '\n'}${suffix}`.replace(/\n{3,}/g, '\n\n');
}

/**
 * @param {{
 *   title?: string,
 *   company?: string,
 *   detail?: string,
 *   needsReply?: boolean,
 * }} item
 * @param {'up' | 'down'} vibe
 */
export function suggestGuideAppend(item, vibe) {
  const company = String(item?.company || '').trim();
  const title = String(item?.title || '').trim();
  const detail = String(item?.detail || '').trim().replace(/\s+/g, ' ');
  const from = company ? `From **${company}**` : 'Similar mail';

  if (vibe === 'up') {
    let line = `- ${from}: ${title || 'Important follow-up'}`;
    if (detail) line += ` — ${detail.slice(0, 120)}`;
    return line;
  }

  let line = `- ${from}: ${title || 'FYI with no action needed'}`;
  if (item?.needsReply === false) line += ' (no reply needed)';
  else if (detail) line += ` — ${detail.slice(0, 80)}`;
  return line;
}

/**
 * @param {{
 *   vibe: 'up' | 'down',
 *   section?: string,
 *   append?: string,
 *   item?: { title?: string, company?: string, detail?: string },
 * }} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function applyGmailDailySummaryGuidePreference(patch, env = process.env) {
  const vibe = patch?.vibe === 'down' ? 'down' : 'up';
  const append = String(patch?.append || '').trim();
  const prev = await loadGmailDailySummaryGuide(env);
  let guide = prev;
  let escalation = null;

  if (vibe === 'down') {
    guide = appendToGuideSection(guide, LEARNED_LESS_HEADING, append);
    const escalated = await recordThumbsDownAndEscalate(
      { append, item: patch?.item },
      guide,
      env,
    );
    guide = escalated.guide;
    escalation = escalated.escalation;
  } else {
    const sectionKey = String(patch?.section || '').trim();
    const heading =
      sectionKey in GUIDE_SECTION_KEYS
        ? GUIDE_SECTION_KEYS[/** @type {GuideSectionKey} */ (sectionKey)]
        : LEARNED_MORE_HEADING;
    guide = appendToGuideSection(guide, heading, append);
  }

  if (guide === prev) {
    return { guide: prev, escalation };
  }
  const saved = await saveGmailDailySummaryGuide(guide, env);
  return { guide: saved, escalation };
}

/** @deprecated use loadGmailDailySummaryGuide */
export async function loadGmailWeeklySummaryCriteria(env = process.env) {
  const guide = await loadGmailDailySummaryGuide(env);
  return { guide };
}

/** @deprecated use saveGmailDailySummaryGuide */
export async function saveGmailWeeklySummaryCriteria(body, env = process.env) {
  const src = body && typeof body === 'object' ? body : {};
  if (src.guide != null) {
    return { guide: await saveGmailDailySummaryGuide(String(src.guide), env) };
  }
  if (src.lookFor != null || src.skip != null || src.blacklist != null) {
    return { guide: await saveGmailDailySummaryGuide(guideFromLegacyCriteria(src), env) };
  }
  return { guide: await loadGmailDailySummaryGuide(env) };
}

/** @deprecated use applyGmailDailySummaryGuidePreference */
export async function applyGmailWeeklySummaryPreference(patch, env = process.env) {
  const { guide } = await applyGmailDailySummaryGuidePreference(
    { vibe: patch?.vibe, append: patch?.append || patch?.lookFor || patch?.skip || patch?.blacklist },
    env,
  );
  return { guide };
}

export {
  LEARNED_MORE_HEADING,
  LEARNED_LESS_HEADING,
};
