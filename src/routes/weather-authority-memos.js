import { Router } from 'express';

const router = Router();

function nwsUserAgent() {
  const u = String(process.env.NWS_USER_AGENT || '').trim();
  return u || 'Dashbird/1.0 (dashbird dashboard; weather authority memos)';
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasHeatAdvisoryText(s) {
  const t = String(s || '');
  return /heat advisory/i.test(t) || /excessive heat warning/i.test(t);
}

router.get('/', async (req, res) => {
  const lat = toFiniteNumber(req.query.lat);
  const lon = toFiniteNumber(req.query.lon);
  const zip = String(req.query.zip || '')
    .trim()
    .replace(/\D/g, '');

  if (lat == null || lon == null) {
    res.status(400).json({ ok: false, error: 'lat_lon_required' });
    return;
  }

  try {
    const url = `https://api.weather.gov/alerts/active?point=${encodeURIComponent(`${lat},${lon}`)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': nwsUserAgent(),
        Accept: 'application/geo+json',
      },
    });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `nws_alerts_http_${r.status}` });
      return;
    }

    const j = await r.json();
    const features = Array.isArray(j?.features) ? j.features : [];
    const matched = [];
    for (const f of features) {
      const p = f?.properties || {};
      const event = String(p.event || '').trim();
      const headline = String(p.headline || '').trim();
      const description = String(p.description || '').trim();
      const areaDesc = String(p.areaDesc || '').trim();
      const zipMentioned = zip.length === 5 && new RegExp(`\\b${zip}\\b`).test(areaDesc);
      const mentionsHeat =
        hasHeatAdvisoryText(event) ||
        hasHeatAdvisoryText(headline) ||
        hasHeatAdvisoryText(description);
      if (!mentionsHeat) continue;
      // If NWS provides ZIPs in areaDesc and caller sent a ZIP, enforce ZIP match.
      if (zip.length === 5 && /\b\d{5}\b/.test(areaDesc) && !zipMentioned) continue;
      {
        matched.push({
          event,
          headline,
          areaDesc,
        });
      }
    }

    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({
      ok: true,
      heatAdvisory: matched.length > 0,
      count: matched.length,
      memos: matched,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
