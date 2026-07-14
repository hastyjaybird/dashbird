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

const router = Router();
router.use(express.json({ limit: '64kb' }));

/**
 * @param {object} ledger
 * @param {{ week: object, month: object }} measured
 */
function enrichPayload(ledger, measured) {
  const weekUsd = Number(measured.week?.totalUsd) || 0;
  const monthUsd = Number(measured.month?.totalUsd) || 0;
  const monthCredits = Number(measured.month?.monthlyCreditsUsd) || 5;
  const monthRemaining =
    measured.month?.remainingCreditsUsd != null
      ? Number(measured.month.remainingCreditsUsd)
      : Math.max(0, monthCredits - monthUsd);

  const items = (ledger.items || []).map((item) => {
    const out = { ...item };
    if (item.measuredSource === 'facebook-billing') {
      out.measuredWeeklyUsd = Math.round(weekUsd * 100) / 100;
      out.measuredMonthlyUsd = Math.round(monthUsd * 100) / 100;
      out.monthlyCreditsUsd = monthCredits;
      out.remainingCreditsUsd = Math.round(monthRemaining * 100) / 100;
      out.effectiveWeeklyUsd =
        weekUsd > 0 ? Math.round(weekUsd * 100) / 100 : Number(item.weeklyUsd) || 0;
    } else {
      out.measuredWeeklyUsd = null;
      out.measuredMonthlyUsd = null;
      out.effectiveWeeklyUsd = item.active === false ? 0 : Number(item.weeklyUsd) || 0;
    }
    if (item.active === false) out.effectiveWeeklyUsd = 0;
    return out;
  });

  let budgetedWeeklyUsd = 0;
  let effectiveWeeklyUsd = 0;
  let measuredWeeklyUsd = 0;
  /** @type {Record<string, number>} */
  const byCategory = {};

  for (const item of items) {
    if (item.active === false) continue;
    const budget = Number(item.weeklyUsd) || 0;
    const effective = Number(item.effectiveWeeklyUsd) || 0;
    budgetedWeeklyUsd += budget;
    effectiveWeeklyUsd += effective;
    if (item.measuredWeeklyUsd != null && Number.isFinite(Number(item.measuredWeeklyUsd))) {
      measuredWeeklyUsd += Number(item.measuredWeeklyUsd);
    }
    const cat = String(item.category || 'Other');
    byCategory[cat] = Math.round(((byCategory[cat] || 0) + effective) * 100) / 100;
  }

  return {
    ok: true,
    currency: ledger.currency || 'USD',
    updatedAt: ledger.updatedAt || null,
    summary: {
      budgetedWeeklyUsd: Math.round(budgetedWeeklyUsd * 100) / 100,
      effectiveWeeklyUsd: Math.round(effectiveWeeklyUsd * 100) / 100,
      measuredWeeklyUsd: Math.round(measuredWeeklyUsd * 100) / 100,
      projectedMonthlyUsd: Math.round(effectiveWeeklyUsd * 4.33 * 100) / 100,
      byCategory,
    },
    items,
    measured: {
      facebook: {
        week: measured.week,
        month: measured.month,
      },
    },
  };
}

async function loadMeasured() {
  const [week, month] = await Promise.all([
    getFacebookBillingWeekSummary(),
    getFacebookBillingMonthSummary(),
  ]);
  return { week, month };
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
