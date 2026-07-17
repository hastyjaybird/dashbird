/**
 * Thoughtful 👍/👎 guide proposals — pattern rules, not one-off mail quotes.
 */
import {
  GUIDE_SECTION_KEYS,
  guideSectionHeading,
  loadGmailDailySummaryGuide,
  vibeDefaultSection,
} from './gmail-daily-summary-guide-store.js';
import { openRouterChatJson } from './openrouter-chat-json.js';

/** @typedef {'show_these' | 'soft_skip' | 'never_show' | 'prefer_more' | 'prefer_less'} GuideSectionKey */

const DOWN_SECTION_KEYS = new Set(['never_show', 'soft_skip', 'prefer_less']);

/**
 * @param {GuideSectionKey | null} sectionKey
 * @param {'up' | 'down'} vibe
 * @returns {GuideSectionKey}
 */
function clampSectionForVibe(sectionKey, vibe) {
  const key = sectionKey || vibeDefaultSection(vibe);
  if (vibe === 'down') {
    return DOWN_SECTION_KEYS.has(key) ? key : 'prefer_less';
  }
  if (key === 'show_these' || key === 'prefer_more') return key;
  return 'prefer_more';
}

/**
 * @param {unknown} value
 * @returns {GuideSectionKey | null}
 */
function normalizeSectionKey(value) {
  const key = String(value || '').trim();
  return key in GUIDE_SECTION_KEYS ? /** @type {GuideSectionKey} */ (key) : null;
}

/**
 * @param {unknown} lines
 */
function normalizeProposedLines(lines) {
  const raw = Array.isArray(lines)
    ? lines.map((l) => String(l || '').trim()).filter(Boolean)
    : String(lines || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  return raw
    .map((l) => (l.startsWith('-') ? l : `- ${l}`))
    .join('\n');
}

/**
 * @param {string} guide
 */
function buildSuggestSystemPrompt(guide) {
  const sections = Object.entries(GUIDE_SECTION_KEYS)
    .map(([key, heading]) => `- ${key}: ${heading}`)
    .join('\n');
  return `You help Jay tune Dashbird's Daily Summary email ingestion guide.
Jay marks synthesized action items with thumbs up (keep more like this) or thumbs down (keep less / stop surfacing).

Return JSON only:
{
  "review": string,
  "section": "show_these" | "soft_skip" | "never_show" | "prefer_more" | "prefer_less",
  "proposedLines": string | string[]
}

Rules for review:
- 2-4 sentences. Explain what kind of mail this is and why Jay's feedback makes sense.
- If the item seems misclassified, say so and pick the section that fixes future scans.
- Plain language; no markdown headings.

Rules for proposedLines:
- Reusable pattern bullets for the guide — NOT a quote of this one email.
- Do NOT name specific order numbers, tracking IDs, product SKUs, or one-off subject lines.
- Prefer categories already in the guide when they fit (e.g. delivery confirmations → never_show).
- One bullet is enough; use multiple only for distinct sub-patterns.
- Each line should start with "- ".

Section pick guide:
- never_show: should never become a Daily Summary item (delivery noise, promos, OTP, events).
- soft_skip: usually omit unless it also matches Show these.
- show_these: durable important patterns Jay wants surfaced.
- prefer_more / prefer_less: learned taste on top of base rules (default for ambiguous 👍/👎).
- For thumbs DOWN feedback, section MUST be prefer_less only. Jay's UI always saves there; repeated similar 👎 auto-promotes patterns to Soft skip (3×) and Never show (5×).

Guide sections (keys → headings):
${sections}

Current guide:
${String(guide || '').trim() || '(empty)'}`;
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
function buildSuggestUserPrompt(item, vibe) {
  const company = String(item?.company || '').trim() || '(unknown sender)';
  const title = String(item?.title || '').trim() || '(untitled)';
  const detail = String(item?.detail || '').trim() || '(no detail)';
  const feedback = vibe === 'up' ? 'thumbs up — want more like this' : 'thumbs down — want less / stop surfacing';
  return `Feedback: ${feedback}

Synthesized Daily Summary item:
- company: ${company}
- title: ${title}
- detail: ${detail}
- needsReply: ${item?.needsReply === true ? 'yes' : item?.needsReply === false ? 'no' : 'unknown'}

Propose a guide update that adapts to Jay's preference.`;
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
export function suggestGuidePreferenceFallback(item, vibe) {
  const blob = `${item?.title || ''} ${item?.detail || ''} ${item?.company || ''}`.toLowerCase();
  const defaultSection = vibeDefaultSection(vibe);

  const delivery = /\b(deliver(ed|y|ies)|shipped|shipping|tracking|out for delivery|verify receipt|package arrived|on its way)\b/;
  const promo = /\b(sale|%\s*off|limited time|shop now|promo|deal of the day)\b/;
  const newsletter = /\b(newsletter|unsubscribe|weekly digest|mailing list)\b/;
  const verify = /\b(verify your|magic link|sign.?in code|one.?time password|otp|security code)\b/;
  const event = /\b(rsvp|invite|workshop|meetup|info session|calendar invite)\b/;

  if (vibe === 'down') {
    if (delivery.test(blob)) {
      return {
        review:
          'Shipping or delivery confirmation — usually FYI, not a task. '
          + 'Saved under Prefer less; repeat similar 👎 and Dashbird promotes to Soft skip, then Never show.',
        section: 'prefer_less',
        proposedLines: '- Package delivery confirmations and receipt notices (no action needed)',
        source: 'heuristic',
      };
    }
    if (verify.test(blob)) {
      return {
        review:
          'Account verification and sign-in codes should not become tasks. '
          + 'Prefer less now; repeated similar feedback escalates automatically.',
        section: 'prefer_less',
        proposedLines: '- Account verification, magic links, and OTP / security codes',
        source: 'heuristic',
      };
    }
    if (event.test(blob)) {
      return {
        review:
          'Event and RSVP mail belongs in Events Finder. '
          + 'Prefer less for now — enough similar 👎 promotes the pattern to Never show.',
        section: 'prefer_less',
        proposedLines: '- Event invites, RSVPs, and workshop announcements (Events Finder)',
        source: 'heuristic',
      };
    }
    if (promo.test(blob) || newsletter.test(blob)) {
      return {
        review:
          'Marketing or newsletter content without a concrete ask. '
          + 'Prefer less; similar repeats tighten toward Soft skip and Never show.',
        section: 'prefer_less',
        proposedLines: '- FYI newsletters and automated status updates with weak or no action',
        source: 'heuristic',
      };
    }
    return {
      review:
        'Marked down — similar mail should surface less. '
        + 'Repeat 👎 on the same kind of mail and Dashbird escalates the rule automatically.',
      section: defaultSection,
      proposedLines: '- FYI or automated notices that do not need a reply or decision',
      source: 'heuristic',
    };
  }

  if (item?.needsReply === true) {
    return {
      review:
        'This item needs your reply. Surfacing more mail where you are the bottleneck helps Daily Summary stay useful.',
      section: 'prefer_more',
      proposedLines: '- Mail where I need to reply or confirm something time-sensitive',
      source: 'heuristic',
    };
  }
  if (/\b(deadline|due|sign|contract|payment|invoice|confirm)\b/.test(blob)) {
    return {
      review:
        'This looks like a concrete obligation — money, docs, or a deadline. '
        + 'Show these patterns are a good fit when you want more of this kind of task.',
      section: 'show_these',
      proposedLines: '- Deadlines, payments, contracts, or documents that need my action',
      source: 'heuristic',
    };
  }
  return {
    review:
      'You marked this up — similar items are worth keeping in Daily Summary. '
      + 'Edit the pattern below if the category should be different.',
    section: defaultSection,
    proposedLines: '- Important follow-ups that deserve a dedicated action item',
    source: 'heuristic',
  };
}

/**
 * @param {{
 *   title?: string,
 *   company?: string,
 *   detail?: string,
 *   needsReply?: boolean,
 * }} item
 * @param {'up' | 'down'} vibe
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ skipLlm?: boolean }} [opts]
 */
export async function suggestGuidePreference(item, vibe, env = process.env, opts = {}) {
  const feedback = vibe === 'down' ? 'down' : 'up';
  const guide = await loadGmailDailySummaryGuide(env);
  const fallback = suggestGuidePreferenceFallback(item, feedback);

  if (opts.skipLlm) {
    const section = feedback === 'down' ? 'prefer_less' : fallback.section;
    return {
      ok: true,
      vibe: feedback,
      ...fallback,
      section,
      heading: guideSectionHeading(section),
    };
  }

  const chat = await openRouterChatJson(
    env,
    [
      { role: 'system', content: buildSuggestSystemPrompt(guide) },
      { role: 'user', content: buildSuggestUserPrompt(item, feedback) },
    ],
    { ignoreRateLimit: true },
  );

  if (!chat.ok || !chat.parsed || typeof chat.parsed !== 'object') {
    const section = feedback === 'down' ? 'prefer_less' : fallback.section;
    return {
      ok: true,
      vibe: feedback,
      ...fallback,
      section,
      heading: guideSectionHeading(section),
      llmError: chat.error || 'llm_unavailable',
    };
  }

  const parsed = /** @type {Record<string, unknown>} */ (chat.parsed);
  const section = feedback === 'down'
    ? 'prefer_less'
    : clampSectionForVibe(
      normalizeSectionKey(parsed.section) || normalizeSectionKey(fallback.section),
      feedback,
    );
  const proposedLines =
    normalizeProposedLines(parsed.proposedLines)
    || fallback.proposedLines;
  const review = String(parsed.review || '').trim() || fallback.review;

  return {
    ok: true,
    vibe: feedback,
    review,
    section,
    heading: guideSectionHeading(section),
    proposedLines,
    source: 'llm',
    model: chat.model || null,
  };
}
