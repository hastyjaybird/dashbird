/**
 * Local News Reader — full-screen three-pane feed reader.
 *
 * Pane 1: folders/feeds tree with unread counts.
 * Pane 2: article list in compact / card / magazine density.
 * Pane 3: reading pane for the selected article.
 *
 * The sidebar card is too narrow for this, so the Reader is a popout. It renders
 * the same payload the panel already fetched and delegates every mutation back to
 * the panel so taste/preferences stay in one place.
 */

import {
  thumbUpIcon,
  thumbDownIcon,
  zzzIcon,
  eyeOffIcon,
  externalLinkIcon,
  closeIcon,
  feedsIcon,
  listsIcon,
  feedEditorIcon,
} from '../lib/local-news-icons.js';
import {
  isRead,
  markRead,
  markAllRead,
  toggleRead,
  unreadCount,
} from '../lib/local-news-read-state.js';

const PREFS_KEY = 'dashbird-news-reader-v1';
const MODES = [
  { id: 'compact', label: 'Compact' },
  { id: 'card', label: 'Card' },
  { id: 'magazine', label: 'Magazine' },
];

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && typeof j === 'object') return j;
  } catch {
    /* ignore */
  }
  return {};
}

/** @param {object} patch */
function savePrefs(patch) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    /* quota */
  }
}

/**
 * @param {string | null | undefined} iso
 */
function fmtRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/**
 * @param {string | null | undefined} iso
 */
function fmtAbsolute(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** @param {object} a */
function isImportant(a) {
  return a?.important === true || Number(a?.importance) >= 8;
}

/** @param {object} a */
function articleBody(a) {
  if (a?.relevance) return a.relevance;
  if (a?.summary) return a.summary;
  if (a?.relevancePending) return 'Summarizing article…';
  return '';
}

/**
 * @param {HTMLElement} btn
 * @param {SVGElement} icon
 * @param {string} label
 */
function iconButton(btn, icon, label) {
  btn.type = 'button';
  btn.append(icon);
  btn.setAttribute('aria-label', label);
  btn.title = label;
  return btn;
}

/**
 * @param {{
 *   payload: object,
 *   refresh: () => Promise<void>,
 *   feedback: (a: object, vibe: 'up' | 'down') => Promise<void>,
 *   snooze: (a: object) => Promise<void>,
 *   skip: (a: object) => Promise<void>,
 *   openFeedEditor: () => void,
 *   openLists: () => void,
 *   onClose?: () => void,
 * }} ctl
 */
export function openLocalNewsReader(ctl) {
  const prefs = loadPrefs();

  let payload = ctl.payload && typeof ctl.payload === 'object' ? ctl.payload : {};
  let mode = MODES.some((m) => m.id === prefs.mode) ? prefs.mode : 'card';
  /** @type {{ kind: string, id: string | null }} */
  let view =
    prefs.view && typeof prefs.view === 'object' && prefs.view.kind
      ? { kind: String(prefs.view.kind), id: prefs.view.id ?? null }
      : { kind: 'all', id: null };
  let sort = prefs.sort === 'newest' ? 'newest' : 'ranked';
  let unreadOnly = prefs.unreadOnly === true;
  let query = '';
  /** @type {string | null} */
  let selectedId = null;
  /** @type {object | null} keeps the reading pane populated if the item leaves the feed */
  let selectedSnapshot = null;
  /** @type {Set<string>} collapsed folder ids */
  const collapsed = new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed : []);

  const backdrop = document.createElement('div');
  backdrop.className = 'local-news__reader-backdrop';

  const shell = document.createElement('div');
  shell.className = 'local-news__reader';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', 'News reader');

  // Feeds pane starts collapsed on narrower windows where three panes don't fit.
  let navOpen =
    typeof prefs.navOpen === 'boolean' ? prefs.navOpen : window.innerWidth > 1180;

  // ---------- Inoreader-style icon rail (far left) ----------
  const rail = document.createElement('nav');
  rail.className = 'local-news__reader-rail';
  rail.setAttribute('aria-label', 'Reader tools');

  const navToggle = document.createElement('button');
  iconButton(navToggle, feedsIcon({ size: 16 }), 'Feeds');
  navToggle.className = 'local-news__reader-rail-btn';
  navToggle.addEventListener('click', () => {
    navOpen = !navOpen;
    savePrefs({ navOpen });
    paintNavOpen();
  });

  const listsBtn = document.createElement('button');
  iconButton(listsBtn, listsIcon({ size: 16 }), 'Keyword lists');
  listsBtn.className = 'local-news__reader-rail-btn';
  listsBtn.title = 'Look for (white) / Skip (grey) / Blacklist keywords';
  listsBtn.addEventListener('click', () => ctl.openLists());

  const editorBtn = document.createElement('button');
  iconButton(editorBtn, feedEditorIcon({ size: 16 }), 'Feed editor');
  editorBtn.className = 'local-news__reader-rail-btn';
  editorBtn.addEventListener('click', () => ctl.openFeedEditor());

  const railSpacer = document.createElement('span');
  railSpacer.className = 'local-news__reader-rail-spacer';

  const closeBtn = document.createElement('button');
  iconButton(closeBtn, closeIcon({ size: 15 }), 'Close reader');
  closeBtn.className = 'local-news__reader-rail-btn local-news__reader-rail-btn--close';
  closeBtn.addEventListener('click', () => close());

  rail.append(navToggle, listsBtn, editorBtn, railSpacer, closeBtn);

  // ---------- main column (top bar + panes) ----------
  const main = document.createElement('div');
  main.className = 'local-news__reader-main';

  const bar = document.createElement('header');
  bar.className = 'local-news__reader-bar';

  const barTitle = document.createElement('h2');
  barTitle.className = 'local-news__reader-title';
  barTitle.textContent = 'Reader';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'local-news__reader-search';
  search.placeholder = 'Search headlines…';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search headlines');

  const modeGroup = document.createElement('div');
  modeGroup.className = 'local-news__reader-modes';
  modeGroup.setAttribute('role', 'group');
  modeGroup.setAttribute('aria-label', 'List density');
  /** @type {Map<string, HTMLButtonElement>} */
  const modeButtons = new Map();
  for (const m of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'local-news__reader-mode';
    b.textContent = m.label;
    b.addEventListener('click', () => {
      mode = m.id;
      savePrefs({ mode });
      paintModes();
      paintList();
    });
    modeButtons.set(m.id, b);
    modeGroup.append(b);
  }

  const sortBtn = document.createElement('button');
  sortBtn.type = 'button';
  sortBtn.className = 'local-news__reader-bar-btn';
  sortBtn.addEventListener('click', () => {
    sort = sort === 'ranked' ? 'newest' : 'ranked';
    savePrefs({ sort });
    paintSort();
    paintList();
  });

  bar.append(barTitle, search, modeGroup, sortBtn);

  // ---------- panes ----------
  const panes = document.createElement('div');
  panes.className = 'local-news__reader-panes';

  const nav = document.createElement('aside');
  nav.className = 'local-news__reader-nav';
  nav.setAttribute('aria-label', 'Feeds');

  const listCol = document.createElement('div');
  listCol.className = 'local-news__reader-list-col';

  const listHead = document.createElement('div');
  listHead.className = 'local-news__reader-list-head';

  const listHeadTitle = document.createElement('p');
  listHeadTitle.className = 'local-news__reader-list-title';

  const unreadToggle = document.createElement('button');
  unreadToggle.type = 'button';
  unreadToggle.className = 'local-news__reader-bar-btn local-news__reader-bar-btn--slim';
  unreadToggle.addEventListener('click', () => {
    unreadOnly = !unreadOnly;
    savePrefs({ unreadOnly });
    paintUnreadToggle();
    paintList();
    paintNav();
  });

  const markAllBtn = document.createElement('button');
  markAllBtn.type = 'button';
  markAllBtn.className = 'local-news__reader-bar-btn local-news__reader-bar-btn--slim';
  markAllBtn.textContent = 'Mark all read';
  markAllBtn.addEventListener('click', () => {
    markAllRead(visibleArticles().map((a) => a.id).filter(Boolean));
    paintList();
    paintNav();
  });

  listHead.append(listHeadTitle, unreadToggle, markAllBtn);

  const listWrap = document.createElement('div');
  listWrap.className = 'local-news__reader-list';

  listCol.append(listHead, listWrap);

  const readingPane = document.createElement('article');
  readingPane.className = 'local-news__reader-pane';
  readingPane.setAttribute('aria-live', 'polite');

  panes.append(nav, listCol, readingPane);

  const status = document.createElement('p');
  status.className = 'local-news__reader-status';
  status.hidden = true;
  status.setAttribute('aria-live', 'polite');

  main.append(bar, panes, status);
  shell.append(rail, main);
  backdrop.append(shell);
  document.body.append(backdrop);

  // ---------- data shaping ----------
  /** No `articles` key at all means the panel's first fetch has not landed yet. */
  function loading() {
    return !Array.isArray(payload.articles);
  }

  function allArticles() {
    return Array.isArray(payload.articles) ? payload.articles : [];
  }

  function skippedArticles() {
    return Array.isArray(payload.skippedArticles) ? payload.skippedArticles : [];
  }

  function subscriptions() {
    return Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
  }

  /**
   * Folders come from feed categories; feeds with no category land in "Other".
   * Subscriptions drive the tree so a quiet feed still shows up.
   */
  function feedTree() {
    const articles = allArticles();
    /** @type {Map<string, object[]>} */
    const byFeed = new Map();
    for (const a of articles) {
      const id = String(a?.feedId || '').trim();
      if (!id) continue;
      if (!byFeed.has(id)) byFeed.set(id, []);
      byFeed.get(id).push(a);
    }

    /** @type {Map<string, { id: string, title: string, feeds: object[] }>} */
    const folders = new Map();
    for (const feed of subscriptions()) {
      const cat = String(feed.category || '').trim() || 'Other';
      if (!folders.has(cat)) folders.set(cat, { id: cat, title: cat, feeds: [] });
      const items = byFeed.get(feed.id) || [];
      folders.get(cat).feeds.push({
        id: feed.id,
        title: feed.title || feed.id,
        total: items.length,
        unread: unreadCount(items),
      });
    }

    return [...folders.values()]
      .map((f) => ({
        ...f,
        feeds: f.feeds.sort((a, b) => a.title.localeCompare(b.title)),
        total: f.feeds.reduce((n, x) => n + x.total, 0),
        unread: f.feeds.reduce((n, x) => n + x.unread, 0),
      }))
      .sort((a, b) => b.unread - a.unread || a.title.localeCompare(b.title));
  }

  /** @param {string} feedId */
  function categoryOf(feedId) {
    const feed = subscriptions().find((f) => f.id === feedId);
    return String(feed?.category || '').trim() || 'Other';
  }

  function viewLabel() {
    if (view.kind === 'important') return 'Important';
    if (view.kind === 'unread') return 'Unread';
    if (view.kind === 'skipped') return 'Skipped';
    if (view.kind === 'feed') {
      const feed = subscriptions().find((f) => f.id === view.id);
      return feed?.title || 'Feed';
    }
    if (view.kind === 'category') return view.id || 'Folder';
    return 'All articles';
  }

  function visibleArticles() {
    let rows = view.kind === 'skipped' ? skippedArticles() : allArticles();

    if (view.kind === 'important') rows = rows.filter(isImportant);
    else if (view.kind === 'unread') rows = rows.filter((a) => !isRead(a.id));
    else if (view.kind === 'feed') rows = rows.filter((a) => a.feedId === view.id);
    else if (view.kind === 'category') rows = rows.filter((a) => categoryOf(a.feedId) === view.id);

    if (unreadOnly && view.kind !== 'skipped') rows = rows.filter((a) => !isRead(a.id));

    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((a) =>
        [a.title, a.relevance, a.summary, a.feedTitle]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
    }

    if (sort === 'newest') {
      rows = [...rows].sort((a, b) => {
        const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return tb - ta;
      });
    }
    return rows;
  }

  // ---------- painting ----------
  function paintModes() {
    for (const [id, b] of modeButtons) {
      const on = id === mode;
      b.classList.toggle('local-news__reader-mode--active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function paintSort() {
    sortBtn.textContent = sort === 'ranked' ? 'Sort: Ranked' : 'Sort: Newest';
    sortBtn.title =
      sort === 'ranked'
        ? 'Ranked by importance and your thumbs — click for newest first'
        : 'Newest first — click for ranked order';
  }

  function paintUnreadToggle() {
    unreadToggle.textContent = unreadOnly ? 'Unread only' : 'All items';
    unreadToggle.classList.toggle('local-news__reader-bar-btn--on', unreadOnly);
    unreadToggle.setAttribute('aria-pressed', unreadOnly ? 'true' : 'false');
  }

  function paintNavOpen() {
    shell.classList.toggle('local-news__reader--no-nav', !navOpen);
    navToggle.classList.toggle('local-news__reader-rail-btn--on', navOpen);
    navToggle.setAttribute('aria-pressed', navOpen ? 'true' : 'false');
  }

  /**
   * @param {string} label
   * @param {{ kind: string, id: string | null }} target
   * @param {{ unread?: number, total?: number, depth?: number, className?: string }} [opts]
   */
  function navRow(label, target, opts = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'local-news__reader-nav-row';
    if (opts.className) btn.classList.add(opts.className);
    if (view.kind === target.kind && view.id === target.id) {
      btn.classList.add('local-news__reader-nav-row--active');
      btn.setAttribute('aria-current', 'true');
    }

    const text = document.createElement('span');
    text.className = 'local-news__reader-nav-label';
    text.textContent = label;
    btn.append(text);

    const n = Number(opts.unread) || 0;
    if (n > 0) {
      const count = document.createElement('span');
      count.className = 'local-news__reader-nav-count';
      count.textContent = String(n);
      btn.append(count);
    } else if (Number.isFinite(opts.total) && opts.total > 0) {
      const count = document.createElement('span');
      count.className = 'local-news__reader-nav-count local-news__reader-nav-count--muted';
      count.textContent = String(opts.total);
      btn.append(count);
    }

    btn.addEventListener('click', () => {
      view = { ...target };
      savePrefs({ view });
      paintNav();
      paintList();
    });
    return btn;
  }

  function paintNav() {
    nav.replaceChildren();
    const articles = allArticles();

    const viewsLabel = document.createElement('p');
    viewsLabel.className = 'local-news__reader-nav-section';
    viewsLabel.textContent = 'Views';
    nav.append(viewsLabel);

    nav.append(
      navRow('All articles', { kind: 'all', id: null }, {
        unread: unreadCount(articles),
        total: articles.length,
      }),
    );
    const importantRows = articles.filter(isImportant);
    nav.append(
      navRow('Important', { kind: 'important', id: null }, {
        unread: unreadCount(importantRows),
        total: importantRows.length,
      }),
    );
    nav.append(
      navRow('Unread', { kind: 'unread', id: null }, { unread: unreadCount(articles) }),
    );
    const skipped = skippedArticles();
    if (skipped.length) {
      nav.append(navRow('Skipped', { kind: 'skipped', id: null }, { total: skipped.length }));
    }

    const feedsLabel = document.createElement('p');
    feedsLabel.className = 'local-news__reader-nav-section';
    feedsLabel.textContent = 'Feeds';
    nav.append(feedsLabel);

    const tree = feedTree();
    if (!tree.length) {
      const empty = document.createElement('p');
      empty.className = 'muted local-news__reader-nav-empty';
      empty.textContent = loading() ? 'Loading…' : 'No feeds yet — open Feed editor.';
      nav.append(empty);
    }

    for (const folder of tree) {
      const folderWrap = document.createElement('div');
      folderWrap.className = 'local-news__reader-nav-folder';

      const twist = document.createElement('button');
      twist.type = 'button';
      twist.className = 'local-news__reader-nav-twist';
      const isCollapsed = collapsed.has(folder.id);
      twist.textContent = isCollapsed ? '▸' : '▾';
      twist.setAttribute('aria-label', isCollapsed ? `Expand ${folder.title}` : `Collapse ${folder.title}`);
      twist.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      twist.addEventListener('click', () => {
        if (collapsed.has(folder.id)) collapsed.delete(folder.id);
        else collapsed.add(folder.id);
        savePrefs({ collapsed: [...collapsed] });
        paintNav();
      });

      const head = document.createElement('div');
      head.className = 'local-news__reader-nav-folder-head';
      head.append(
        twist,
        navRow(folder.title, { kind: 'category', id: folder.id }, {
          unread: folder.unread,
          total: folder.total,
          className: 'local-news__reader-nav-row--folder',
        }),
      );
      folderWrap.append(head);

      if (!isCollapsed) {
        for (const feed of folder.feeds) {
          folderWrap.append(
            navRow(feed.title, { kind: 'feed', id: feed.id }, {
              unread: feed.unread,
              total: feed.total,
              className: 'local-news__reader-nav-row--feed',
            }),
          );
        }
      }
      nav.append(folderWrap);
    }
  }

  /**
   * Feedback controls shared by list rows and the reading pane.
   * @param {object} a
   * @param {'row' | 'pane'} placement
   */
  function actionBar(a, placement) {
    const wrap = document.createElement('div');
    wrap.className =
      placement === 'pane'
        ? 'local-news__reader-pane-actions'
        : 'local-news__reader-item-actions';

    const size = placement === 'pane' ? 16 : 13;

    const up = document.createElement('button');
    iconButton(up, thumbUpIcon({ size }), 'More like this');
    up.className = 'local-news__reader-action local-news__reader-action--up';
    up.addEventListener('click', (e) => {
      e.stopPropagation();
      void run(() => ctl.feedback(a, 'up'), 'Noted — more like this.', a);
    });

    const snooze = document.createElement('button');
    iconButton(snooze, zzzIcon({ size }), 'Tired of this topic — snooze 2 weeks');
    snooze.className = 'local-news__reader-action local-news__reader-action--snooze';
    snooze.addEventListener('click', (e) => {
      e.stopPropagation();
      void run(() => ctl.snooze(a), 'Snoozed for 2 weeks.', a);
    });

    const down = document.createElement('button');
    iconButton(down, thumbDownIcon({ size }), 'Less like this');
    down.className = 'local-news__reader-action local-news__reader-action--down';
    down.addEventListener('click', (e) => {
      e.stopPropagation();
      void run(() => ctl.feedback(a, 'down'), 'Noted — less like this.', a);
    });

    const skip = document.createElement('button');
    iconButton(skip, eyeOffIcon({ size }), 'Skip this headline');
    skip.className = 'local-news__reader-action local-news__reader-action--skip';
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      void run(() => ctl.skip(a), 'Skipped.', a);
    });

    wrap.append(up, snooze, down, skip);

    if (placement === 'pane') {
      const openLink = document.createElement('a');
      openLink.className = 'local-news__reader-action local-news__reader-action--open';
      openLink.href = a.link || '#';
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.append(externalLinkIcon({ size }));
      const label = document.createElement('span');
      label.textContent = 'Open original';
      openLink.append(label);
      wrap.append(openLink);
    }

    return wrap;
  }

  /**
   * Run a mutation, then keep the reading pane on the next unread neighbour when
   * the current article drops out of the feed (thumbs down / skip both hide it).
   * @param {() => Promise<void>} fn
   * @param {string} okMsg
   * @param {object} a
   */
  async function run(fn, okMsg, a) {
    const rows = visibleArticles();
    const idx = rows.findIndex((x) => x.id === a.id);
    setStatus('Saving…');
    try {
      await fn();
      setStatus(okMsg, 1800);
      const after = visibleArticles();
      if (a.id === selectedId && !after.some((x) => x.id === a.id)) {
        const next = after[Math.min(Math.max(idx, 0), after.length - 1)];
        if (next) select(next.id);
      }
    } catch (e) {
      setStatus(
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Action failed',
        4000,
        true,
      );
    }
  }

  let statusTimer = null;
  /**
   * @param {string} text
   * @param {number} [clearAfter]
   * @param {boolean} [isError]
   */
  function setStatus(text, clearAfter, isError = false) {
    status.hidden = false;
    status.textContent = text;
    status.classList.toggle('local-news__reader-status--err', isError);
    if (statusTimer) window.clearTimeout(statusTimer);
    if (clearAfter) {
      statusTimer = window.setTimeout(() => {
        status.hidden = true;
        status.textContent = '';
      }, clearAfter);
    }
  }

  /**
   * @param {object} a
   */
  function renderItem(a) {
    const li = document.createElement('li');
    li.className = `local-news__reader-item local-news__reader-item--${mode}`;
    li.dataset.id = a.id;
    if (isRead(a.id)) li.classList.add('local-news__reader-item--read');
    if (a.id === selectedId) li.classList.add('local-news__reader-item--active');
    if (isImportant(a)) li.classList.add('local-news__reader-item--important');

    const openRow = document.createElement('button');
    openRow.type = 'button';
    openRow.className = 'local-news__reader-item-open';
    openRow.addEventListener('click', () => select(a.id));

    const unreadBar = document.createElement('span');
    unreadBar.className = 'local-news__reader-item-bar';
    unreadBar.setAttribute('aria-hidden', 'true');

    const title = document.createElement('span');
    title.className = 'local-news__reader-item-title';
    title.textContent = a.title || 'Untitled';

    const feedName = document.createElement('span');
    feedName.className = 'local-news__reader-item-feed';
    feedName.textContent = a.feedTitle || '';

    const time = document.createElement('span');
    time.className = 'local-news__reader-item-time';
    time.textContent = fmtRelative(a.publishedAt);

    const imageUrl = String(a.imageUrl || '').trim();

    if (mode === 'compact') {
      // Inoreader list: source · title ········· time
      openRow.append(unreadBar, feedName, title, time);
    } else {
      const textWrap = document.createElement('span');
      textWrap.className = 'local-news__reader-item-text';

      const sourceLine = document.createElement('span');
      sourceLine.className = 'local-news__reader-item-source';
      sourceLine.append(feedName, time);
      textWrap.append(sourceLine);

      const topLine = document.createElement('span');
      topLine.className = 'local-news__reader-item-line';
      topLine.append(title);
      if (isImportant(a)) {
        const badge = document.createElement('span');
        badge.className = 'local-news__important-badge';
        badge.textContent = 'Important';
        const why = Array.isArray(a.importantReasons)
          ? a.importantReasons
            .filter((r) => r && r !== 'normal' && !String(r).startsWith('demote'))
            .join(' · ')
          : '';
        if (why) badge.title = why;
        topLine.append(badge);
      }
      textWrap.append(topLine);

      const body = articleBody(a);
      if (body) {
        const snippet = document.createElement('span');
        snippet.className = 'local-news__reader-item-snippet';
        if (a.relevancePending && !a.relevance && !a.summary) {
          snippet.classList.add('local-news__reader-item-snippet--pending');
        }
        snippet.textContent = body;
        textWrap.append(snippet);
      }

      openRow.append(unreadBar, textWrap);

      // Card: thumbnail on the right (Inoreader expanded/list+images).
      // Magazine: larger thumbnail on the left of the text.
      if (imageUrl && (mode === 'card' || mode === 'magazine')) {
        const media = document.createElement('span');
        media.className = 'local-news__reader-item-media';
        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => media.remove());
        media.append(img);
        if (mode === 'magazine') openRow.insertBefore(media, textWrap);
        else openRow.append(media);
      }
    }

    li.append(openRow, actionBar(a, 'row'));
    return li;
  }

  function paintList() {
    const rows = visibleArticles();
    listHeadTitle.textContent = `${viewLabel()} · ${rows.length}`;

    listWrap.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted local-news__reader-empty';
      if (loading()) empty.textContent = 'Loading your feeds…';
      else if (query) empty.textContent = 'Nothing matches that search.';
      else if (unreadOnly) empty.textContent = 'All caught up here.';
      else empty.textContent = 'No articles in this view yet.';
      listWrap.append(empty);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = `local-news__reader-items local-news__reader-items--${mode}`;
    for (const a of rows) ul.append(renderItem(a));
    listWrap.append(ul);
  }

  function paintReadingPane() {
    readingPane.replaceChildren();
    const a = selectedSnapshot;
    shell.classList.toggle('local-news__reader--reading', Boolean(a));
    if (a) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'local-news__reader-bar-btn local-news__reader-back';
      back.textContent = '← Back to list';
      back.addEventListener('click', () => {
        selectedId = null;
        selectedSnapshot = null;
        paintList();
        paintReadingPane();
      });
      readingPane.append(back);
    }
    if (!a) {
      const empty = document.createElement('div');
      empty.className = 'local-news__reader-pane-empty';
      const h = document.createElement('p');
      h.className = 'local-news__reader-pane-empty-title';
      h.textContent = 'Pick a headline';
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent =
        'Choose an article to read its summary here. j / k move through the list, o opens the original, u toggles read.';
      empty.append(h, p);
      readingPane.append(empty);
      return;
    }

    if (isImportant(a)) {
      const badge = document.createElement('span');
      badge.className = 'local-news__important-badge';
      badge.textContent = 'Important';
      readingPane.append(badge);
    }

    const h = document.createElement('h3');
    h.className = 'local-news__reader-pane-title';
    const link = document.createElement('a');
    link.href = a.link || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = a.title || 'Untitled';
    h.append(link);
    readingPane.append(h);

    const meta = document.createElement('p');
    meta.className = 'local-news__reader-pane-meta';
    meta.textContent = [a.feedTitle, fmtAbsolute(a.publishedAt), a.category]
      .filter(Boolean)
      .join(' · ');
    readingPane.append(meta);

    readingPane.append(actionBar(a, 'pane'));

    const imageUrl = String(a.imageUrl || '').trim();
    if (imageUrl) {
      const img = document.createElement('img');
      img.className = 'local-news__reader-pane-image';
      img.src = imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => img.remove());
      readingPane.append(img);
    }

    if (a.relevance) {
      const label = document.createElement('p');
      label.className = 'local-news__reader-pane-label';
      label.textContent = 'Why this matters to you';
      const blurb = document.createElement('p');
      blurb.className = 'local-news__reader-pane-body';
      blurb.textContent = a.relevance;
      readingPane.append(label, blurb);
    } else if (a.relevancePending) {
      const blurb = document.createElement('p');
      blurb.className = 'local-news__reader-pane-body local-news__reader-pane-body--pending';
      blurb.textContent = 'Summarizing article…';
      readingPane.append(blurb);
    }

    if (a.summary) {
      const label = document.createElement('p');
      label.className = 'local-news__reader-pane-label';
      label.textContent = 'From the feed';
      const body = document.createElement('p');
      body.className = 'local-news__reader-pane-body';
      body.textContent = a.summary;
      readingPane.append(label, body);
    }

    const footer = document.createElement('p');
    footer.className = 'local-news__reader-pane-footer';
    const openLink = document.createElement('a');
    openLink.href = a.link || '#';
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = 'Read the full article on the publisher site';
    footer.append(openLink);
    readingPane.append(footer);
  }

  /**
   * @param {string | null} id
   */
  function select(id) {
    selectedId = id;
    const rows = view.kind === 'skipped' ? skippedArticles() : allArticles();
    const found = rows.find((a) => a.id === id) || visibleArticles().find((a) => a.id === id);
    if (found) selectedSnapshot = found;
    if (id) markRead(id);
    paintList();
    paintReadingPane();
    paintNav();
    const el = listWrap.querySelector(`[data-id="${CSS.escape(String(id))}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }

  /** @param {number} delta */
  function step(delta) {
    const rows = visibleArticles();
    if (!rows.length) return;
    const idx = rows.findIndex((a) => a.id === selectedId);
    const nextIdx = idx < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, idx + delta));
    select(rows[nextIdx].id);
  }

  // ---------- events ----------
  search.addEventListener('input', () => {
    query = search.value;
    paintList();
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    // Nested popouts (feed editor / lists) own the keyboard while they are open.
    if (document.querySelector('.local-news__find-backdrop, .local-news__lists-backdrop')) return;
    const t = e.target;
    const typing =
      t instanceof HTMLElement
      && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    if (e.key === 'Escape') {
      if (typing && t instanceof HTMLInputElement && t.value) {
        t.value = '';
        query = '';
        paintList();
        return;
      }
      e.preventDefault();
      close();
      return;
    }
    if (typing) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'o' || e.key === 'Enter') {
      const link = String(selectedSnapshot?.link || '').trim();
      if (/^https?:\/\//i.test(link)) {
        e.preventDefault();
        window.open(link, '_blank', 'noopener,noreferrer');
      }
    } else if (e.key === 'u') {
      if (!selectedId) return;
      e.preventDefault();
      toggleRead(selectedId);
      paintList();
      paintNav();
    }
  };
  document.addEventListener('keydown', onKey);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    if (statusTimer) window.clearTimeout(statusTimer);
    backdrop.remove();
    ctl.onClose?.();
  }

  // ---------- first paint ----------
  paintModes();
  paintSort();
  paintUnreadToggle();
  paintNavOpen();
  paintNav();
  paintList();
  paintReadingPane();
  search.focus();

  return {
    /** @param {object} next */
    update(next) {
      if (closed) return;
      payload = next && typeof next === 'object' ? next : {};
      if (selectedId) {
        const fresh = [...allArticles(), ...skippedArticles()].find((a) => a.id === selectedId);
        if (fresh) selectedSnapshot = fresh;
      }
      paintNav();
      paintList();
      paintReadingPane();
    },
    close,
    isOpen() {
      return !closed;
    },
  };
}
