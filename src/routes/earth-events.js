import { Router } from 'express';
import { resolveDashboardWeatherLatLon } from '../lib/hero-weather-location.js';
import { isEarthDebugShowInactive } from '../lib/earth-debug.js';
import {
  formatMonarchLikelihoodSubtext,
  lookupMonarchAllPhenology,
  MONARCH_REFERENCE_URLS,
  parseDateOnlyInTimeZone,
} from '../lib/monarch-earth.js';

const router = Router();

function primaryMonarchRef() {
  return MONARCH_REFERENCE_URLS[0] || 'https://www.monarchwatch.org/migration/';
}

function clusteringDetailLine(summary) {
  const mid = summary.midLabel ? `Mid ${summary.midLabel}` : '';
  const pct = formatMonarchLikelihoodSubtext(summary);
  return [mid, pct].filter(Boolean).join(' · ');
}

/**
 * @param {object} summary
 */
function peakPresenceDetailLine(summary) {
  const pct = formatMonarchLikelihoodSubtext(summary);
  const until = summary.peakEndLabel ? `Until ${summary.peakEndLabel}` : '';
  return [until, pct].filter(Boolean).join(' · ');
}

/**
 * @param {object} seasonSummary
 */
function appendSeasonEarthItems(items, seasonSummary, ref, labelPrefix, typePrefix) {
  if (seasonSummary.status === 'clustering') {
    items.push({
      earthType: `${typePrefix}_clustering`,
      label: `${labelPrefix} — clustering likely`,
      detailLine: clusteringDetailLine(seasonSummary),
      forecastUrl: ref,
    });
  } else if (seasonSummary.status === 'peak_presence') {
    items.push({
      earthType: `${typePrefix}_peak_presence`,
      label: `${labelPrefix} — peak presence likely`,
      detailLine: peakPresenceDetailLine(seasonSummary),
      forecastUrl: ref,
    });
  }
}

/**
 * @param {object} seasonSummary
 */
function appendSeasonEarthItemsInactive(items, seasonSummary, ref, labelPrefix, typePrefix) {
  const pl = Number(seasonSummary.peakLikelihood) || 0;
  const cl = Number(seasonSummary.clusteringLikelihood) || 0;
  const win = seasonSummary.peakWindowLabel ? String(seasonSummary.peakWindowLabel) : '';
  const mid = seasonSummary.midLabel ? String(seasonSummary.midLabel) : '';
  const detailParts = [
    `Below threshold (peak ${pl}%, cluster ${cl}%)`,
    mid ? `~${mid}` : null,
    win || null,
  ].filter(Boolean);
  items.push({
    earthType: `${typePrefix}_inactive`,
    label: `${labelPrefix} — not in high-likelihood window`,
    detailLine: detailParts.join(' · '),
    forecastUrl: ref,
  });
}

router.get('/', async (req, res) => {
  try {
    const { lat, lon } = await resolveDashboardWeatherLatLon();
    const locationLabel =
      (process.env.DASHBOARD_LOCATION_LABEL || '').trim() || 'Dashboard coordinates';

    const timeZone = (process.env.WEATHER_TIME_ZONE || '').trim() || 'America/Los_Angeles';

    let when = new Date();
    const qd = String(req.query.date || '').trim();
    if (qd) {
      const wall = parseDateOnlyInTimeZone(qd, timeZone);
      if (wall) when = wall;
      else {
        const parsed = new Date(qd);
        if (!Number.isNaN(parsed.getTime())) when = parsed;
      }
    }

    const { fall, spring } = lookupMonarchAllPhenology({ lat, lon, date: when, timeZone });

    /** @type {Array<{ earthType: string, label: string, detailLine: string, forecastUrl?: string }>} */
    const items = [];

    const ref = primaryMonarchRef();
    const debug = isEarthDebugShowInactive();

    function appendSeason(summary, labelPrefix, typePrefix) {
      if (summary.status === 'clustering' || summary.status === 'peak_presence') {
        appendSeasonEarthItems(items, summary, ref, labelPrefix, typePrefix);
      } else if (debug) {
        appendSeasonEarthItemsInactive(items, summary, ref, labelPrefix, typePrefix);
      }
    }

    appendSeason(spring, 'Monarchs (northbound)', 'monarch_spring');
    appendSeason(fall, 'Monarchs (southbound)', 'monarch_fall');

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({
      ok: true,
      locationLabel,
      timeZone,
      dateEvaluated: when.toISOString(),
      summary: { fall, spring },
      earthDebugShowInactive: debug,
      items,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
