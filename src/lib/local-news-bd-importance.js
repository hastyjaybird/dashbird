/**
 * Anthropic Beneficial Deployments — heuristic Important tagging for Local News.
 * Policy: docs/anthropic-bd-news-importance.md
 */

/** Career-adjacency / BD program phrases that boost Important. */
const BOOST_PHRASES = [
  'beneficial deployments',
  'claude for nonprofits',
  'claude for teachers',
  'claude corps',
  'gates foundation',
  'gates partnership',
  'gaila',
  'raising the floor',
  'economic mobility',
  'smallholder',
  'agriculture',
  'agricultural',
  'agronomy',
  'rural',
  'energy access',
  'climate resilience',
  'field deployment',
  'public goods',
  'lmic',
  'underserved',
  'workforce',
  'skills infrastructure',
  'forward-deployed',
  'host enablement',
];

/** Leadership / team-growth signals (Kelly / Younai / Shad lanes). */
const LEADERSHIP_PHRASES = [
  'elizabeth kelly',
  'ariana younai',
  'shad ahmed',
  "we're building",
  'we are building',
  'joining the team',
  'hiring for',
  'we are hiring',
  "we're hiring",
  'team growth',
  'new vertical',
  'new segment',
];

/** Priority-1 / Priority-2 role families (apply-now hiring signal). */
const PRIORITY_ROLE_PHRASES = [
  'applied ai architect',
  'customer success',
  'partner success',
  'scaled csm',
  'partnerships',
  'gtm',
];

/** Do-not-burn / not apply-now (still track; canaries may still alert as Class E). */
const DEMOTE_PHRASES = [
  'life sciences',
  'global health',
  'clinical',
  'startup evangelist',
  'technical evangelist',
  'devrel',
  'head of applied ai architecture',
  'research scientist',
  'pretraining',
  'reinforcement learning',
  'open-weights',
  'claude opus',
  'claude sonnet',
  'claude fable',
  'claude mythos',
];

/**
 * Class E — IC-wave canaries. Important alert, but NOT apply-now.
 * See docs/anthropic-bd-ic-wave-trigger-prompt.md
 * @param {string} hay
 */
export function matchIcWaveCanary(hay) {
  const h = String(hay || '').toLowerCase();
  const reasons = [];

  // 1) Head of Applied AI Architecture, Beneficial Deployments
  if (
    /head of applied ai architecture/.test(h)
    && /beneficial\s*deployments/.test(h)
  ) {
    reasons.push('E:head-applied-ai-arch-bd');
  }

  // 2) Manager of Applied AI Architecture in BD / nonprofit / mobility lanes
  if (
    /manager of applied ai architecture|manager,\s*applied ai architecture/.test(h)
    && /beneficial\s*deployments|nonprofit|partnerships|global development|economic mobility|claude corps/.test(h)
  ) {
    reasons.push('E:manager-applied-ai-arch-bd');
  }

  // 3) Manager, Applied AI Engineering, Beneficial Deployments (any vertical)
  if (
    /manager,\s*applied ai engineering|manager of applied ai engineering/.test(h)
    && /beneficial\s*deployments/.test(h)
  ) {
    reasons.push('E:manager-applied-ai-eng-bd');
  }

  // 4) BD GTM / success leadership
  if (
    /head of nonprofits|head of partner success|head of customer success|head of programmatic customer success/.test(h)
    && (/beneficial\s*deployments|nonprofit|claude for nonprofits|claude corps/.test(h) || /head of nonprofits/.test(h))
  ) {
    reasons.push('E:bd-gtm-leadership');
  }

  // 5) Secondary — Communications Manager, BD
  if (
    /communications manager/.test(h)
    && /beneficial\s*deployments/.test(h)
  ) {
    reasons.push('E:comms-manager-bd-secondary');
  }

  // 6) Corps enablement / host success / office hours (BD-side capacity)
  if (
    /claude corps/.test(h)
    && /host success|host enablement|fellowship|office hours|enablement/.test(h)
  ) {
    reasons.push('E:claude-corps-ops');
  }

  return reasons;
}

/**
 * @param {object} article
 */
function haystack(article) {
  return [
    article?.title,
    article?.summary,
    article?.feedTitle,
    article?.category,
    article?.link,
    ...(Array.isArray(article?.tags) ? article.tags : []),
  ]
    .map((p) => String(p || '').toLowerCase())
    .join(' \n ');
}

/**
 * @param {string} hay
 * @param {string[]} phrases
 */
function matchedPhrases(hay, phrases) {
  return phrases.filter((p) => hay.includes(p));
}

/**
 * Evaluate BD Important policy for one article.
 * @param {object} article
 * @returns {{ important: boolean, demote: boolean, reasons: string[], matchedBoost: string[], matchedDemote: string[] }}
 */
export function evaluateBdImportance(article) {
  const hay = haystack(article);
  const matchedBoost = matchedPhrases(hay, BOOST_PHRASES);
  const matchedLeadership = matchedPhrases(hay, LEADERSHIP_PHRASES);
  const matchedRoles = matchedPhrases(hay, PRIORITY_ROLE_PHRASES);
  const matchedDemote = matchedPhrases(hay, DEMOTE_PHRASES);
  const canaryReasons = matchIcWaveCanary(hay);

  const reasons = [];

  // Class E canaries alert as Important even when they are do-not-apply roles
  if (canaryReasons.length) {
    reasons.push(...canaryReasons);
    return {
      important: true,
      demote: false,
      reasons,
      matchedBoost,
      matchedDemote,
    };
  }

  // Never-Important apply-now roles / clinical / DevRel — even on BD-branded postings
  const neverApply = matchedDemote.some((p) =>
    [
      'life sciences',
      'global health',
      'clinical',
      'startup evangelist',
      'technical evangelist',
      'devrel',
      'head of applied ai architecture',
      'research scientist',
      'pretraining',
      'reinforcement learning',
    ].includes(p),
  );
  // Generic model launches without BD program/hiring cues
  const productOnly =
    matchedDemote.some((p) => p.startsWith('claude '))
    && !matchedBoost.length
    && !matchedRoles.length;

  if (neverApply || productOnly) {
    return {
      important: false,
      demote: true,
      reasons: [`demote:${matchedDemote.slice(0, 3).join(',') || 'product/clinical'}`],
      matchedBoost,
      matchedDemote,
    };
  }

  // A) Priority role hiring signal on BD-adjacent posting (not generic Higher Ed / Gov)
  const bdAdjacentHire =
    /beneficial\s*deployments|claude\s*corps|claude\s*for\s*nonprofits|economic\s*mobility|smallholder|agriculture|raising the floor|nonprofit/i.test(hay);
  const hiringSignal =
    (matchedRoles.length && bdAdjacentHire)
    || (/beneficial\s*deployments/.test(hay) && /architect|success|partner|hiring|job|careers|greenhouse/i.test(hay));
  if (hiringSignal) {
    reasons.push('A:priority-role-or-bd-hiring');
  }

  // B) New/expanded vertical adjacent to agri / mobility / field ops / BD programs
  // Gates×health-only (clinical) is tracked but not Important for Jay's apply lane.
  const gatesHealthOnly =
    /gates foundation|gates partnership/.test(hay)
    && /health|clinical|disease|malaria|pharma|life sciences/i.test(hay)
    && !/agriculture|smallholder|economic mobility|claude corps|claude for nonprofits|workforce|skills|nonprofit fellowship|raising the floor/i.test(hay);

  const verticalSignal = !gatesHealthOnly && matchedBoost.some((p) =>
    [
      'agriculture',
      'agricultural',
      'smallholder',
      'economic mobility',
      'rural',
      'energy access',
      'climate resilience',
      'field deployment',
      'public goods',
      'underserved',
      'claude corps',
      'claude for nonprofits',
      'gaila',
      'beneficial deployments',
      // Gates alone is not enough — needs agri/mobility/nonprofit program cues above,
      // unless the item is a non-health Gates×Anthropic partnership (checked next).
    ].includes(p),
  )
  || (
    !gatesHealthOnly
    && /gates foundation|gates partnership/.test(hay)
    && /anthropic|claude/.test(hay)
    && /education|economic|agriculture|mobility|nonprofit|skills|workforce/i.test(hay)
  );
  if (verticalSignal) reasons.push('B:agri-mobility-or-bd-program');

  // C) Named implementers / partners implying build-out (agri or mobility)
  if (/codepath|social finance|givingtuesday|teach for america|\baft\b|rescue committee|myfriendben|ymca|epilepsy foundation|virtual agronomist|digital green|farmer\.chat/i.test(hay)
    && (matchedBoost.length || /anthropic|claude/i.test(hay))) {
    reasons.push('C:named-partner-buildout');
  }

  // D) Leadership posts announcing growth / new segments
  if (matchedLeadership.length && (matchedBoost.length || verticalSignal || hiringSignal)) {
    reasons.push('D:leadership-growth-signal');
  }

  // Education-only teacher tooling with no hiring/mobility/agri → not Important
  const educationOnly =
    /claude for teachers|pk-12|k-12|teachers?/.test(hay)
    && !hiringSignal
    && !matchedBoost.some((p) =>
      ['economic mobility', 'agriculture', 'smallholder', 'claude corps', 'claude for nonprofits', 'gates foundation', 'beneficial deployments'].includes(p),
    )
    && !matchedLeadership.length;
  if (educationOnly) {
    return {
      important: false,
      demote: false,
      reasons: ['education-only'],
      matchedBoost,
      matchedDemote,
    };
  }

  const important = reasons.some((r) =>
    r.startsWith('A:')
    || r.startsWith('B:')
    || r.startsWith('C:')
    || r.startsWith('D:')
    || r.startsWith('E:'),
  );
  return {
    important,
    demote: false,
    reasons: important ? reasons : (reasons.length ? reasons : ['normal']),
    matchedBoost,
    matchedDemote,
  };
}

/**
 * Attach Important flag and nudge numeric importance for sort.
 * @param {object} article
 */
export function applyBdImportance(article) {
  const evalResult = evaluateBdImportance(article);
  let importance = Number(article?.importance);
  if (!Number.isFinite(importance) || importance <= 0) importance = null;

  if (evalResult.important) {
    importance = Math.max(importance || 0, 8);
  } else if (evalResult.demote && importance != null) {
    importance = Math.min(importance, 5);
  }

  return {
    ...article,
    important: evalResult.important,
    importantReasons: evalResult.reasons,
    ...(importance != null ? { importance } : {}),
  };
}
