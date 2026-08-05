import { Router } from 'express';
import express from 'express';
import {
  loadAwayBase,
  saveAwayBasePatch,
  getActiveAwayProfile,
} from '../lib/away-base-store.js';
import { resolveActiveLocation } from '../lib/resolve-active-location.js';
import { geocodeUsZip5 } from '../lib/zip-geocode.js';

const router = Router();
router.use(express.json({ limit: '16kb' }));

router.get('/', async (_req, res) => {
  try {
    const state = await loadAwayBase();
    const active = await resolveActiveLocation({
      forceMode: state.autoAway ? 'away' : state.preview ? 'preview' : 'home',
    });
    const profile = getActiveAwayProfile(state);
    let resolved = null;
    if (profile) {
      const g = await geocodeUsZip5(profile.zip);
      if (g) {
        resolved = {
          lat: g.lat,
          lon: g.lon,
          place: g.place,
          city: g.city,
          stateAbbrev: g.stateAbbrev,
        };
      }
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...state,
      locationMode: active.mode,
      activeProfile: profile,
      resolved,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.patch('/', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    /** @type {Parameters<typeof saveAwayBasePatch>[0]} */
    const patch = {};
    if (typeof body.preview === 'boolean') patch.preview = body.preview;
    if (typeof body.autoAway === 'boolean') patch.autoAway = body.autoAway;
    if (typeof body.activeProfileId === 'string') patch.activeProfileId = body.activeProfileId;
    if (body.profile && typeof body.profile === 'object') {
      patch.profile = body.profile;
    }
    // Convenience: top-level zip/label edits apply to active profile
    if (body.zip != null || body.label != null || body.timeZone != null || body.radiusMi != null) {
      const state = await loadAwayBase();
      const id = String(body.activeProfileId || state.activeProfileId || 'nyc-climate-week');
      patch.profile = {
        ...(patch.profile || {}),
        id,
        ...(body.zip != null ? { zip: body.zip } : {}),
        ...(body.label != null ? { label: body.label } : {}),
        ...(body.timeZone != null ? { timeZone: body.timeZone } : {}),
        ...(body.radiusMi != null ? { radiusMi: body.radiusMi } : {}),
      };
    }
    const saved = await saveAwayBasePatch(patch);
    if (!saved.ok) {
      res.status(400).json(saved);
      return;
    }
    const active = await resolveActiveLocation({
      forceMode: saved.state.autoAway
        ? 'away'
        : saved.state.preview
          ? 'preview'
          : 'home',
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      ...saved.state,
      locationMode: active.mode,
      activeProfile: getActiveAwayProfile(saved.state),
      active,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
