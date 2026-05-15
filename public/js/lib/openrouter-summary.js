/**
 * Human-readable line for GET /api/openrouter/summary response (used for ring tooltips).
 */
function describeOpenRouterSummary(j) {
  if (!j || j.ok === false) {
    const err =
      typeof j?.error === 'string'
        ? j.error
        : j?.error?.message || (j?.status ? `HTTP ${j.status}` : 'unavailable');
    return `OpenRouter: ${err}`;
  }
  if (typeof j.monthly_percent_remaining === 'number') {
    const pct = j.monthly_percent_remaining;
    if (j.source === 'credits') {
      return `OpenRouter: ~${pct}% of purchased credits left`;
    }
    const reset =
      typeof j.limit_reset === 'string' ? j.limit_reset.toLowerCase() : '';
    const period =
      reset === 'monthly'
        ? 'monthly'
        : reset === 'weekly'
          ? 'weekly'
          : reset === 'daily'
            ? 'daily'
            : 'spend';
    return `OpenRouter: ~${pct}% of ${period} limit left`;
  }
  return 'OpenRouter: summary loaded';
}

/**
 * Parsed summary for UI (e.g. chat donut vs text fallback).
 * @returns {{ mode: 'ring', pct: number, period: string, source?: string, title: string } | { mode: 'error', message: string, title?: string } | { mode: 'text', message: string }}
 */
export function getOpenRouterLimitDisplay(j) {
  if (!j || j.ok === false) {
    const err =
      typeof j?.error === 'string'
        ? j.error
        : j?.error?.message || (j?.status ? `HTTP ${j.status}` : 'unavailable');
    return { mode: 'error', message: `OpenRouter: ${err}` };
  }
  if (typeof j.monthly_percent_remaining === 'number') {
    const raw = j.monthly_percent_remaining;
    const pct = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
    let period = 'limit';
    if (j.source === 'credits') period = 'credits';
    else {
      const reset = typeof j.limit_reset === 'string' ? j.limit_reset.toLowerCase() : '';
      if (reset === 'monthly') period = 'monthly';
      else if (reset === 'weekly') period = 'weekly';
      else if (reset === 'daily') period = 'daily';
      else period = 'spend';
    }
    return {
      mode: 'ring',
      pct,
      period,
      source: typeof j.source === 'string' ? j.source : undefined,
      title: describeOpenRouterSummary(j),
    };
  }
  return { mode: 'text', message: 'OpenRouter: summary loaded' };
}
