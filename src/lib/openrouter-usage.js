/**
 * OpenRouter account usage + Dashbird program catalog for Settings → Costs.
 * Account totals come from the API key; per-program spend is not separately
 * metered on a normal (non-management) key.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Programs that call OpenRouter from Dashbird.
 * `costMode`: free-first | paid-default | paid-always
 * @type {readonly {
 *   id: string,
 *   label: string,
 *   area: string,
 *   costMode: 'free-first' | 'paid-default' | 'paid-always',
 *   triggers: string,
 *   notes: string,
 * }[]}
 */
export const OPENROUTER_PROGRAMS = Object.freeze([
  {
    id: 'network-enrich',
    label: 'Network enrich',
    area: 'Network',
    costMode: 'free-first',
    triggers: 'Enrich / Enhance selected / Telegram contact ingest',
    notes:
      'Web/file/email/voice → LLM. Voice also uses paid Whisper. If OPENROUTER_MODEL is set without NETWORK_ENRICH_MODEL, enrich prefers that paid model first.',
  },
  {
    id: 'network-relationship-summary',
    label: 'Network relationship summary',
    area: 'Network',
    costMode: 'free-first',
    triggers: 'Contact detail → More attributes → Summarize relationship',
    notes: 'Shared Gmail threads + card facts → relationship narrative. Same free-first text chain as Network enrich.',
  },
  {
    id: 'network-org-enrich',
    label: 'Network company enrich',
    area: 'Network',
    costMode: 'free-first',
    triggers: 'Org Enrich button · background after contact enrich finds a company',
    notes: 'Same free-first text chain as contact enrich.',
  },
  {
    id: 'network-groups',
    label: 'Network group commonality',
    area: 'Network',
    costMode: 'paid-default',
    triggers: 'Auto when a group has >2 members',
    notes: 'Defaults to OPENROUTER_MODEL / gpt-4o-mini — no free fallback chain.',
  },
  {
    id: 'telegram-classify',
    label: 'Telegram message classify',
    area: 'Telegram / Events',
    costMode: 'free-first',
    triggers: 'Every Telegram intake text/voice/photo (background poller)',
    notes: 'Routes event vs contact vs company vs todo/note. Continuous while the bot runs.',
  },
  {
    id: 'telegram-invite-parse',
    label: 'Telegram invite / flyer parse',
    area: 'Telegram / Events',
    costMode: 'free-first',
    triggers: 'Event text or flyer image after classify',
    notes: 'Extracts event fields from invites and photos.',
  },
  {
    id: 'telegram-whisper',
    label: 'Voice transcription (Whisper)',
    area: 'Telegram / Events',
    costMode: 'paid-always',
    triggers: 'Telegram voice notes · Network voice enrich',
    notes: 'openai/whisper-1 by default — always billed when used.',
  },
  {
    id: 'tool-library',
    label: 'Tool Library AI',
    area: 'Tool Library',
    costMode: 'paid-default',
    triggers: 'Add/refresh/repair tool when Yahoo/HTML pricing & ratings fail',
    notes: 'gpt-4o-mini by default. Disable with TOOL_LIBRARY_AI_PROVIDER=none.',
  },
  {
    id: 'openrouter-proxy',
    label: 'OpenRouter API proxy',
    area: 'API',
    costMode: 'paid-default',
    triggers: 'POST /api/openrouter/chat/completions',
    notes: 'Generic proxy — not used by the main UI today.',
  },
  {
    id: 'gmail-daily-summary',
    label: 'Daily Summary',
    area: 'Main / Gmail',
    costMode: 'free-first',
    triggers: 'One-time bootstrap + every 30 min scan (or manual Refresh)',
    notes:
      'Digest + action items from jay.intake.box + julia.hasty. Rolling 10-day window (hard-delete older unless pinned; unpin grace 30s). Newest first. Defaults to free gpt-oss / gemma; falls back to gpt-4o-mini when free models 429. Override with GMAIL_DAILY_SUMMARY_MODEL.',
  },
]);

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || '').trim();
}

/**
 * @param {unknown} n
 */
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.round(v * 100) / 100;
}

/**
 * Fetch live key + credits snapshot from OpenRouter.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function fetchOpenRouterUsageSummary(env = process.env) {
  const key = openRouterKey(env);
  if (!key) {
    return {
      ok: false,
      configured: false,
      error: 'openrouter_not_configured',
      programs: OPENROUTER_PROGRAMS,
    };
  }

  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': env.OPENROUTER_HTTP_REFERER || 'http://localhost',
    'X-Title': env.OPENROUTER_X_TITLE || 'dashbird-costs',
  };

  /** @type {object | null} */
  let keyData = null;
  /** @type {object | null} */
  let creditsData = null;
  /** @type {string | null} */
  let error = null;

  try {
    const [keyRes, creditsRes] = await Promise.all([
      fetch(`${OPENROUTER_BASE}/auth/key`, { headers, signal: AbortSignal.timeout(12_000) }),
      fetch(`${OPENROUTER_BASE}/credits`, { headers, signal: AbortSignal.timeout(12_000) }),
    ]);
    if (keyRes.ok) {
      const j = await keyRes.json().catch(() => ({}));
      keyData = j?.data && typeof j.data === 'object' ? j.data : null;
    } else {
      error = `openrouter_http_${keyRes.status}`;
    }
    if (creditsRes.ok) {
      const j = await creditsRes.json().catch(() => ({}));
      creditsData = j?.data && typeof j.data === 'object' ? j.data : null;
    }
  } catch (e) {
    error = String(e?.message || e || 'openrouter_fetch_failed');
  }

  if (!keyData && !creditsData) {
    return {
      ok: false,
      configured: true,
      error: error || 'openrouter_fetch_failed',
      programs: OPENROUTER_PROGRAMS,
    };
  }

  const usageLifetime = money(keyData?.usage);
  const usageDaily = money(keyData?.usage_daily);
  const usageWeekly = money(keyData?.usage_weekly);
  const usageMonthly = money(keyData?.usage_monthly);
  const limit = keyData?.limit != null && Number.isFinite(Number(keyData.limit)) ? money(keyData.limit) : null;
  const limitRemaining =
    keyData?.limit_remaining != null && Number.isFinite(Number(keyData.limit_remaining))
      ? money(keyData.limit_remaining)
      : null;
  const totalUsage = creditsData?.total_usage != null ? money(creditsData.total_usage) : usageLifetime;
  const totalCredits = creditsData?.total_credits != null ? money(creditsData.total_credits) : 0;

  // Prefer explicit weekly; otherwise prorate month-to-date for the Costs “Measured / wk” column.
  const measuredWeeklyUsd =
    usageWeekly > 0 ? usageWeekly : usageMonthly > 0 ? money(usageMonthly / 4.33) : 0;
  const measuredMonthlyUsd = usageMonthly > 0 ? usageMonthly : totalUsage;

  const envModel = String(env.OPENROUTER_MODEL || '').trim() || null;
  const enrichPrimary = String(
    env.NETWORK_ENRICH_MODEL || env.OPENROUTER_FREE_TEXT_MODEL || env.OPENROUTER_MODEL || '',
  ).trim();

  return {
    ok: true,
    configured: true,
    error: null,
    isFreeTier: Boolean(keyData?.is_free_tier),
    label: keyData?.label ? String(keyData.label).slice(0, 24) : null,
    limitUsd: limit,
    remainingUsd: limitRemaining,
    usageLifetimeUsd: usageLifetime,
    usageDailyUsd: usageDaily,
    usageWeeklyUsd: usageWeekly,
    usageMonthlyUsd: usageMonthly,
    totalCreditsUsd: totalCredits,
    totalUsageUsd: totalUsage,
    measuredWeeklyUsd,
    measuredMonthlyUsd,
    envModel,
    enrichPrimaryModel: enrichPrimary || null,
    perProgramMetered: false,
    perProgramNote:
      'OpenRouter only reports account totals on this key. Per-program $ is not available without a management key or local generation logging.',
    programs: OPENROUTER_PROGRAMS.map((p) => ({
      ...p,
      /** Hint when env makes “free-first” behave like paid. */
      envOverride:
        p.id === 'network-enrich' && enrichPrimary && !enrichPrimary.includes(':free')
          ? `Primary model from env: ${enrichPrimary}`
          : null,
    })),
  };
}
