import { Router } from 'express';
import { openDesktopEntry, resolveDesktopEntryPath } from '../lib/open-desktop.js';

const router = Router();

/**
 * GET /api/open-desktop/:id
 * Launch a Linux Applications-menu entry via xdg-open (e.g. org.kde.kdenlive).
 */
router.get('/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const desktopPath = await resolveDesktopEntryPath(id);
  if (!desktopPath) {
    const hint =
      id.includes('kdenlive')
        ? ' Set KDENLIVE_APPIMAGE in .env to your AppImage path (e.g. ~/Applications/kdenlive-….AppImage).'
        : ' Set OPEN_DESKTOP_<NAME> or install a .desktop file under Applications.';
    res.status(404).type('text/plain').send(`Desktop entry not found: ${id}.${hint}`);
    return;
  }

  try {
    await openDesktopEntry(desktopPath);
    const back = typeof req.get('referer') === 'string' && req.get('referer').startsWith('http')
      ? req.get('referer')
      : '/';
    res.redirect(302, back);
  } catch (e) {
    res
      .status(502)
      .type('text/plain')
      .send(`Could not launch ${desktopPath}: ${String(e?.message || e)}`);
  }
});

export default router;
