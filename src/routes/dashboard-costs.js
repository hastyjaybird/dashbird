/**
 * Settings → Costs ledger API.
 */
import { Router } from 'express';
import express from 'express';
import {
  loadDashboardCosts,
  saveDashboardCosts,
} from '../lib/dashboard-costs-store.js';
import {
  getFacebookBillingMonthSummary,
  getFacebookBillingWeekSummary,
} from '../lib/events-finder-facebook-billing.js';
import { fetchOpenRouterUsageSummary } from '../lib/openrouter-usage.js';

const router = Router();
router.use(express.json({ limit: '64kb' }));

/**
 * @param {{ id: string, label: string, value: number }[]} raw
 * @param {{ estimated?: boolean, note?: string }} [meta]
 */
function normalizeBreakdown(raw, meta = {}) {
  const cleaned = (Array.isArray(raw) ? raw : [])
    .map((s) => ({
      id: String(s.id || s.label || '').slice(0, 48),
      label: String(s.label || s.id || 'Other').slice(0, 80),
      value: Math.max(0, Number(s.value) || 0),
    }))
    .filter((s) => s.id && s.value > 0);
  const total = cleaned.reduce((sum, s) => sum + s.value, 0);
  if (!total) {
    return {
      estimated: Boolean(meta.estimated),
      note: meta.note || null,
      slices: [],
    };
  }
  const slices = cleaned
    .map((s) => ({
      ...s,
      pct: Math.round((s.value / total) * 1000) / 10,
    }))
    .sort((a, b) => b.value - a.value);
  return {
    estimated: Boolean(meta.estimated),
    note: meta.note || null,
    slices,
  };
}

/**
 * @param {object | null | undefined} month
 */
function apifyBreakdown(month) {
  const runs = Array.isArray(month?.runs) ? month.runs : [];
  let queryCount = 0;
  let urlCount = 0;
  for (const run of runs) {
    queryCount += Array.isArray(run?.searchQueries) ? run.searchQueries.length : 0;
    urlCount += Array.isArray(run?.startUrls) ? run.startUrls.length : 0;
  }
  const uses = [
    {
      label: 'Facebook Events scrape',
      detail: 'Daily Apify Actor run (keyword searches + group/page event feeds)',
    },
  ];
  if (!queryCount && !urlCount) {
    return {
      uses,
      breakdown: normalizeBreakdown(
        [{ id: 'facebook-events', label: 'Facebook Events scrape', value: 1 }],
        { estimated: true, note: 'Single Actor · no run mix logged this month yet' },
      ),
    };
  }
  return {
    uses,
    breakdown: normalizeBreakdown(
      [
        { id: 'keyword-searches', label: 'Keyword searches', value: queryCount },
        { id: 'group-page-feeds', label: 'Group / page event feeds', value: urlCount },
      ],
      {
        estimated: false,
        note: 'Share of scrape targets this month (same Actor bill)',
      },
    ),
  };
}

/**
 * @param {object | null | undefined} openrouter
 */
function openRouterBreakdown(openrouter) {
  const programs = Array.isArray(openrouter?.programs) ? openrouter.programs : [];
  const uses = programs.map((p) => ({
    label: String(p.label || p.id || 'Program'),
    detail: String(p.triggers || p.area || '').trim() || null,
  }));
  const slices = programs.map((p) => ({
    id: String(p.id || p.label || 'program'),
    label: String(p.label || p.id || 'Program'),
    value: Math.max(0, Number(p.relativeWeight) || 1),
  }));
  return {
    uses,
    breakdown: normalizeBreakdown(slices, {
      estimated: true,
      note:
        openrouter?.perProgramNote ||
        'Estimated share of Dashbird OpenRouter activity (account $ is not split by feature)',
    }),
  };
}

/**
 * @param {object} item
 * @param {{
 *   week: object,
 *   month: object,
 *   openrouter: object,
 * }} measured
 */
function attachServiceInsight(item, measured) {
  const id = String(item.id || '');
  if (id === 'openrouter' || item.measuredSource === 'openrouter-key') {
    return openRouterBreakdown(measured.openrouter);
  }
  if (id === 'apify' || item.measuredSource === 'facebook-billing') {
    return apifyBreakdown(measured.month);
  }
  if (id === 'vultr') {
    return {
      uses: [
        {
          label: 'Cloud host',
          detail: 'Always-on VPS for dashbird.duckdns.org',
        },
      ],
      breakdown: normalizeBreakdown(
        [{ id: 'hosting', label: 'Cloud host', value: 1 }],
        { estimated: false, note: 'Fixed monthly plan' },
      ),
    };
  }
  if (id === 'cursor') {
    return {
      uses: [
        {
          label: 'IDE / agents',
          detail: 'Building and editing Dashbird',
        },
      ],
      breakdown: normalizeBreakdown(
        [{ id: 'ide', label: 'IDE / agents', value: 1 }],
        { estimated: false, note: 'Fixed monthly plan' },
      ),
    };
  }
  return {
    uses: item.usedFor
      ? [{ label: String(item.usedFor), detail: item.notes || null }]
      : [],
    breakdown: normalizeBreakdown([], { estimated: true }),
  };
}

/**
 * @param {object} ledger
 * @param {{
 *   week: object,
 *   month: object,
 *   openrouter: object,
 * }} measured
 */
function enrichPayload(ledger, measured) {
  const weekUsd = Number(measured.week?.totalUsd) || 0;
  const monthUsd = Number(measured.month?.totalUsd) || 0;
  const monthCredits = Number(measured.month?.monthlyCreditsUsd) || 5;
  const monthRemaining =
    measured.month?.remainingCreditsUsd != null
      ? Number(measured.month.remainingCreditsUsd)
      : Math.max(0, monthCredits - monthUsd);

  const or = measured.openrouter && measured.openrouter.ok ? measured.openrouter : null;
  const orWeek = or ? Number(or.measuredWeeklyUsd) || 0 : 0;
  const orMonth = or ? Number(or.measuredMonthlyUsd) || 0 : 0;

  const items = (ledger.items || []).map((item) => {
    const out = { ...item };
    const fixedMonthly =
      item.monthlyFixedUsd != null && Number.isFinite(Number(item.monthlyFixedUsd))
        ? Number(item.monthlyFixedUsd)
        : null;
    out.displayMonthlyUsd =
      fixedMonthly != null
        ? fixedMonthly
        : item.monthlyBudgetUsd != null && Number.isFinite(Number(item.monthlyBudgetUsd))
          ? Number(item.monthlyBudgetUsd)
          : Math.round((Number(item.weeklyUsd) || 0) * 4.33 * 100) / 100;
    if (item.measuredSource === 'facebook-billing') {
      out.measuredWeeklyUsd = Math.round(weekUsd * 100) / 100;
      out.measuredMonthlyUsd = Math.round(monthUsd * 100) / 100;
      out.monthlyCreditsUsd = monthCredits;
      out.remainingCreditsUsd = Math.round(monthRemaining * 100) / 100;
      out.effectiveWeeklyUsd =
        weekUsd > 0 ? Math.round(weekUsd * 100) / 100 : Number(item.weeklyUsd) || 0;
    } else if (item.measuredSource === 'openrouter-key') {
      out.measuredWeeklyUsd = or ? Math.round(orWeek * 100) / 100 : null;
      out.measuredMonthlyUsd = or ? Math.round(orMonth * 100) / 100 : null;
      out.monthlyCreditsUsd = or?.limitUsd != null ? or.limitUsd : item.monthlyBudgetUsd;
      out.remainingCreditsUsd = or?.remainingUsd != null ? or.remainingUsd : null;
      out.effectiveWeeklyUsd =
        or && orWeek > 0 ? Math.round(orWeek * 100) / 100 : Number(item.weeklyUsd) || 0;
    } else {
      out.measuredWeeklyUsd = null;
      out.measuredMonthlyUsd = null;
      out.effectiveWeeklyUsd =
        item.active === false
          ? 0
          : fixedMonthly != null
            ? Math.round((fixedMonthly / 4.33) * 100) / 100
            : Number(item.weeklyUsd) || 0;
    }
    if (item.active === false) out.effectiveWeeklyUsd = 0;
    const insight = attachServiceInsight(out, measured);
    out.uses = insight.uses;
    out.breakdown = insight.breakdown;
    return out;
  });

  let budgetedWeeklyUsd = 0;
  let effectiveWeeklyUsd = 0;
  let measuredWeeklyUsd = 0;
  let measuredMonthlyUsd = 0;
  /** @type {Record<string, number>} */
  const byCategory = {};
  /** @type {Record<string, number>} */
  const byCategoryMonthly = {};

  let budgetedMonthlyUsd = 0;
  let projectedMonthlyUsd = 0;

  for (const item of items) {
    if (item.active === false) continue;
    const budget = Number(item.weeklyUsd) || 0;
    const effective = Number(item.effectiveWeeklyUsd) || 0;
    budgetedWeeklyUsd += budget;
    effectiveWeeklyUsd += effective;
    if (item.measuredWeeklyUsd != null && Number.isFinite(Number(item.measuredWeeklyUsd))) {
      measuredWeeklyUsd += Number(item.measuredWeeklyUsd);
    }
    const displayMo = Number(item.displayMonthlyUsd) || 0;
    budgetedMonthlyUsd += displayMo;
    let monthAmt = 0;
    if (item.measuredMonthlyUsd != null && Number.isFinite(Number(item.measuredMonthlyUsd))) {
      monthAmt = Number(item.measuredMonthlyUsd);
      measuredMonthlyUsd += monthAmt;
      // Fixed plans still count full month; usage uses measured when available.
      projectedMonthlyUsd +=
        item.monthlyFixedUsd != null ? Number(item.monthlyFixedUsd) || 0 : monthAmt;
    } else {
      monthAmt = displayMo || Math.round(effective * 4.33 * 100) / 100;
      projectedMonthlyUsd += monthAmt;
    }
    const cat = String(item.usedFor || item.category || 'Other');
    byCategory[cat] = Math.round(((byCategory[cat] || 0) + effective) * 100) / 100;
    byCategoryMonthly[cat] =
      Math.round(((byCategoryMonthly[cat] || 0) + monthAmt) * 100) / 100;
  }

  projectedMonthlyUsd = Math.round(projectedMonthlyUsd * 100) / 100;
  budgetedMonthlyUsd = Math.round(budgetedMonthlyUsd * 100) / 100;

  return {
    ok: true,
    currency: ledger.currency || 'USD',
    updatedAt: ledger.updatedAt || null,
    summary: {
      budgetedWeeklyUsd: Math.round(budgetedWeeklyUsd * 100) / 100,
      effectiveWeeklyUsd: Math.round(effectiveWeeklyUsd * 100) / 100,
      measuredWeeklyUsd: Math.round(measuredWeeklyUsd * 100) / 100,
      measuredMonthlyUsd: Math.round(measuredMonthlyUsd * 100) / 100,
      budgetedMonthlyUsd,
      effectiveMonthlyUsd: projectedMonthlyUsd,
      projectedMonthlyUsd,
      byCategory,
      byCategoryMonthly,
    },
    items,
    measured: {
      facebook: {
        week: measured.week,
        month: measured.month,
      },
      openrouter: measured.openrouter,
    },
  };
}

async function loadMeasured() {
  const [week, month, openrouter] = await Promise.all([
    getFacebookBillingWeekSummary(),
    getFacebookBillingMonthSummary(),
    fetchOpenRouterUsageSummary(),
  ]);
  return { week, month, openrouter };
}

router.get('/', async (_req, res) => {
  try {
    const [ledger, measured] = await Promise.all([loadDashboardCosts(), loadMeasured()]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(enrichPayload(ledger, measured));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/', async (req, res) => {
  try {
    const saved = await saveDashboardCosts(req.body || {});
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    const measured = await loadMeasured();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(enrichPayload(saved.ledger, measured));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
