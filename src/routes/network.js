import { Router } from 'express';
import express from 'express';
import path from 'node:path';
import {
  addContact,
  addContactsBulk,
  deleteContacts,
  getContactById,
  loadNetworkContacts,
  networkAssetsDir,
  PREFERRED_CONTACT_METHODS,
  saveContactAvatar,
  updateContact,
} from '../lib/network-contacts-store.js';
import { loadNetworkNotes } from '../lib/network-notes-store.js';
import {
  applyContactAvatarFromUrl,
  applyOrganizationLogoFromUrl,
  enrichContact,
  enrichOrganization,
  findContactAvatarCandidates,
  findOrganizationLogoCandidates,
} from '../lib/network-enrich.js';
import {
  addOrganization,
  deleteOrganizations,
  getOrganizationById,
  loadNetworkOrganizations,
  updateOrganization,
} from '../lib/network-organizations-store.js';
import {
  addGroup,
  addMembersToGroup,
  deleteGroups,
  getGroupById,
  ingestPeopleIntoGroup,
  loadNetworkGroups,
  removeMembersFromGroup,
  updateGroup,
} from '../lib/network-groups-store.js';
import {
  analyzeGroupCommonalities,
  scheduleGroupCommonalityRefresh,
} from '../lib/network-group-commonality.js';
import { scheduleNetworkDedupSweepOnce } from '../lib/network-dedup.js';

const router = Router();
router.use(express.json({ limit: '12mb' }));

/** Kick a one-time fuzzy dedup sweep for data created before the routine existed. */
let dedupSweepKickoff = false;
function kickoffDedupSweep() {
  if (dedupSweepKickoff) return;
  dedupSweepKickoff = true;
  scheduleNetworkDedupSweepOnce().catch(() => {
    dedupSweepKickoff = false;
  });
}

router.get('/contacts', async (_req, res) => {
  try {
    kickoffDedupSweep();
    const data = await loadNetworkContacts();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      contacts: data.contacts,
      preferredContactMethods: PREFERRED_CONTACT_METHODS,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/contacts', async (req, res) => {
  try {
    const contact = await addContact({ ...req.body, source: req.body?.source || 'manual' });
    res.status(201).json({ ok: true, contact });
  } catch (e) {
    const code = e?.code === 'invalid_contact' ? 400 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/contacts/bulk', async (req, res) => {
  try {
    const result = await addContactsBulk(req.body?.names ?? req.body?.text, {
      kinds: req.body?.kinds,
      preferredContactMethods: req.body?.preferredContactMethods,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) {
    const code = e?.code === 'names_required' ? 400 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/contacts/:id', async (req, res) => {
  try {
    const contact = await getContactById(String(req.params.id || ''));
    if (!contact) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, contact });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/contacts/:id', async (req, res) => {
  try {
    const contact = await updateContact(String(req.params.id || ''), req.body || {});
    if (!contact) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, contact });
  } catch (e) {
    const code = e?.code === 'invalid_contact' ? 400 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/contacts/:id/avatar', async (req, res) => {
  try {
    const contact = await saveContactAvatar(String(req.params.id || ''), req.body || {});
    res.json({ ok: true, contact });
  } catch (e) {
    const map = {
      not_found: 404,
      invalid_image: 400,
      invalid_image_size: 400,
    };
    const status = map[e?.code] || 500;
    res.status(status).json({ ok: false, error: String(e?.code || e?.message || e) });
  }
});

router.post('/contacts/:id/avatar-candidates', async (req, res) => {
  try {
    const result = await findContactAvatarCandidates(String(req.params.id || ''), {
      offset: req.body?.offset,
      limit: req.body?.limit,
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 500;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/contacts/:id/avatar-from-url', async (req, res) => {
  try {
    const result = await applyContactAvatarFromUrl(
      String(req.params.id || ''),
      String(req.body?.url || ''),
    );
    if (!result.ok) {
      const map = { not_found: 404, invalid_url: 400, download_failed: 422 };
      res.status(map[result.error] || 500).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    const result = await deleteContacts([String(req.params.id || '')]);
    if (!result.deleted) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/contacts/:id/enrich', async (req, res) => {
  try {
    const result = await enrichContact(String(req.params.id || ''), {
      force: Boolean(req.body?.force),
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : result.error === 'openrouter_not_configured' ? 503 : 502;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/organizations', async (_req, res) => {
  try {
    kickoffDedupSweep();
    const data = await loadNetworkOrganizations();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, organizations: data.organizations });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/dedup', async (req, res) => {
  try {
    const result = await scheduleNetworkDedupSweepOnce(process.env, {
      force: Boolean(req.body?.force),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/organizations', async (req, res) => {
  try {
    const organization = await addOrganization({ ...req.body, source: req.body?.source || 'manual' });
    res.status(201).json({ ok: true, organization });
  } catch (e) {
    const code = e?.code === 'invalid_organization' ? 400 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/organizations/:id', async (req, res) => {
  try {
    const organization = await getOrganizationById(String(req.params.id || ''));
    if (!organization) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, organization });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/organizations/:id', async (req, res) => {
  try {
    const organization = await updateOrganization(String(req.params.id || ''), req.body || {});
    if (!organization) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, organization });
  } catch (e) {
    const code = e?.code === 'invalid_organization' ? 400 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/organizations/:id/enrich', async (req, res) => {
  try {
    const result = await enrichOrganization(String(req.params.id || ''), {
      force: Boolean(req.body?.force),
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : result.error === 'openrouter_not_configured' ? 503 : 502;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/organizations/:id/logo-candidates', async (req, res) => {
  try {
    const result = await findOrganizationLogoCandidates(String(req.params.id || ''), {
      offset: req.body?.offset,
      limit: req.body?.limit,
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 500;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/organizations/:id/logo-from-url', async (req, res) => {
  try {
    const result = await applyOrganizationLogoFromUrl(
      String(req.params.id || ''),
      String(req.body?.url || ''),
    );
    if (!result.ok) {
      const map = { not_found: 404, invalid_url: 400, download_failed: 422 };
      res.status(map[result.error] || 500).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.delete('/organizations/:id', async (req, res) => {
  try {
    const result = await deleteOrganizations([String(req.params.id || '')]);
    if (!result.deleted) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/groups', async (_req, res) => {
  try {
    const data = await loadNetworkGroups();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, groups: data.groups });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/groups', async (req, res) => {
  try {
    const group = await addGroup({ ...req.body, source: req.body?.source || 'manual' });
    res.status(201).json({ ok: true, group });
  } catch (e) {
    const code = e?.code === 'invalid_group' ? 400 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/groups/:id', async (req, res) => {
  try {
    const group = await getGroupById(String(req.params.id || ''));
    if (!group) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, group });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/groups/:id', async (req, res) => {
  try {
    const group = await updateGroup(String(req.params.id || ''), req.body || {});
    if (!group) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    if ((group.memberIds || []).length > 2) {
      scheduleGroupCommonalityRefresh(group.id);
    }
    res.json({ ok: true, group });
  } catch (e) {
    const code = e?.code === 'invalid_group' ? 400 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/groups/:id/members', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.contactIds) ? req.body.contactIds : [];
    const group = await addMembersToGroup(String(req.params.id || ''), ids);
    if (!group) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    if ((group.memberIds || []).length > 2) {
      scheduleGroupCommonalityRefresh(group.id);
    }
    res.json({ ok: true, group });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.delete('/groups/:id/members', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.contactIds) ? req.body.contactIds : [];
    const group = await removeMembersFromGroup(String(req.params.id || ''), ids);
    if (!group) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, group });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/groups/:id/ingest', async (req, res) => {
  try {
    const result = await ingestPeopleIntoGroup(
      String(req.params.id || ''),
      req.body?.names ?? req.body?.text,
    );
    if ((result.group?.memberIds || []).length > 2) {
      scheduleGroupCommonalityRefresh(result.group.id);
    }
    res.status(201).json({ ok: true, ...result });
  } catch (e) {
    const code = e?.code === 'not_found' ? 404 : 500;
    res.status(code).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/groups/:id/analyze', async (req, res) => {
  try {
    const result = await analyzeGroupCommonalities(String(req.params.id || ''));
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : result.error === 'openrouter_not_configured' ? 503 : 502;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.delete('/groups/:id', async (req, res) => {
  try {
    const result = await deleteGroups([String(req.params.id || '')]);
    if (!result.deleted) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/notes', async (_req, res) => {
  try {
    const data = await loadNetworkNotes();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, notes: data.notes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/assets/:file', async (req, res) => {
  try {
    const file = String(req.params.file || '');
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      res.status(400).json({ ok: false, error: 'invalid_file' });
      return;
    }
    const abs = path.join(networkAssetsDir(), file);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(abs, (err) => {
      if (err) {
        if (!res.headersSent) res.status(404).json({ ok: false, error: 'not_found' });
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
