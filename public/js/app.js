import { mountCalendar } from './panels/calendar.js';
import { mountBookmarkGrid } from './panels/bookmarks.js';
import { mountNotes } from './panels/notes.js';
import { mountChat } from './panels/chat.js';
import { mountHero } from './panels/hero.js';
import { mountHealthSidebar } from './panels/health-sidebar.js';
import { mountWebSearch } from './panels/web-search.js';

async function loadConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('config failed');
  return r.json();
}

async function main() {
  const config = await loadConfig();

  mountHero(document.getElementById('mount-hero'), config);

  const webSearchMount = document.getElementById('mount-web-search');
  if (webSearchMount) mountWebSearch(webSearchMount);

  await mountBookmarkGrid(
    document.getElementById('mount-bookmarks-personal'),
    '/data/bookmarks-personal.json',
    'Add tiles in public/data/bookmarks-personal.json (up to 9).',
  );
  await mountBookmarkGrid(
    document.getElementById('mount-bookmarks-work'),
    '/data/bookmarks-work.json',
    'Add tiles in public/data/bookmarks-work.json.',
  );

  mountCalendar(document.getElementById('mount-calendar'), config);
  await mountNotes(document.getElementById('mount-notes'));

  const healthAside = document.getElementById('mount-health-sidebar');
  if (healthAside) mountHealthSidebar(healthAside);

  mountChat(document.getElementById('mount-chat'), config);
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p class="err err--banner">Failed to start dashboard: ${String(e.message)}</p>`,
  );
});
