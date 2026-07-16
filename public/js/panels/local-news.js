import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'local-news';
const CACHE_MAX_MS = 20 * 60 * 1000;

/**
 * @param {string | null | undefined} iso
 */
function fmtRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = Date.now() - t;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/**
 * @param {HTMLElement} root
 * @param {object} suggestion
 * @param {{ onRespond: (r: 'yes' | 'no') => void, onFresh: () => void, busy: boolean }} opts
 */
function renderSuggestionBlock(root, suggestion, opts) {
  const block = document.createElement('div');
  block.className = 'local-news__suggestion';

  const prompt = document.createElement('p');
  prompt.className = 'local-news__suggestion-prompt';
  prompt.textContent = 'Subscribe to this news feed?';
  block.append(prompt);

  const feed = document.createElement('div');
  feed.className = 'local-news__suggestion-feed';
  const title = document.createElement('a');
  title.className = 'local-news__suggestion-title';
  title.href = suggestion.feed.siteUrl || suggestion.feed.url;
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  title.textContent = suggestion.feed.title;
  feed.append(title);

  if (Array.isArray(suggestion.feed.tags) && suggestion.feed.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'local-news__suggestion-tags';
    tags.textContent = suggestion.feed.tags.slice(0, 3).join(' · ');
    feed.append(tags);
  }
  block.append(feed);

  const reason = document.createElement('p');
  reason.className = 'local-news__suggestion-reason';
  reason.textContent =
    suggestion.reason === 'similar'
      ? 'Similar to feeds you already follow'
      : 'Popular feed you might like';
  block.append(reason);

  const actions = document.createElement('div');
  actions.className = 'local-news__suggestion-actions';

  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'local-news__btn local-news__btn--yes';
  yesBtn.textContent = 'Yes';
  yesBtn.disabled = opts.busy;
  yesBtn.addEventListener('click', () => opts.onRespond('yes'));

  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'local-news__btn local-news__btn--no';
  noBtn.textContent = 'No';
  noBtn.disabled = opts.busy;
  noBtn.addEventListener('click', () => opts.onRespond('no'));

  const freshBtn = document.createElement('button');
  freshBtn.type = 'button';
  freshBtn.className = 'local-news__btn local-news__btn--fresh';
  freshBtn.textContent = 'Suggest fresh';
  freshBtn.disabled = opts.busy;
  freshBtn.addEventListener('click', () => opts.onFresh());

  actions.append(yesBtn, noBtn, freshBtn);
  block.append(actions);

  root.append(block);
}

/**
 * @param {HTMLElement} root
 * @param {() => void} onFresh
 */
function renderNoSuggestionRow(root, onFresh) {
  const row = document.createElement('div');
  row.className = 'local-news__no-suggestion';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'local-news__btn local-news__btn--fresh';
  btn.textContent = 'Suggest fresh';
  btn.addEventListener('click', onFresh);
  row.append(btn);
  root.append(row);
}

/**
 * Suggest Look for / grey-list lines from an article — same idea as
 * events-finder's suggestPreferenceLines, tuned to article fields.
 * @param {object} a
 * @param {'up' | 'down'} vibe
 * @returns {string}
 */
function suggestArticlePreferenceLines(a, vibe) {
  const title = String(a.title || '').trim();
  const lines = [];
  if (title) {
    const shortTitle = title
      .replace(/\s*[-–—|].*$/, '')
      .slice(0, 60)
      .trim();
    if (shortTitle) lines.push(shortTitle);
  }
  const blob = `${title} ${a.summary || ''}`;
  const hits = blob.match(
    /\b(ai|climate|space|astronomy|research|university|policy|startup|security|health|biology|physics|energy|sustainability|robotics|quantum|genomics|neuroscience)\b/gi,
  );
  if (hits) {
    for (const h of hits) {
      const n = h.toLowerCase();
      if (!lines.some((l) => l.toLowerCase() === n)) lines.push(n);
      if (lines.length >= 5) break;
    }
  }
  if (vibe === 'down' && a.feedTitle) {
    const src = String(a.feedTitle).trim().slice(0, 40);
    if (src && !lines.some((l) => l.toLowerCase() === src.toLowerCase())) lines.push(src);
  }
  return lines.slice(0, 6).join('\n');
}

/**
 * Append unique lines to a newline-separated taste list.
 * @param {string} existing
 * @param {string} additions
 * @returns {string}
 */
function mergeTasteLines(existing, additions) {
  const seen = new Set();
  const out = [];
  for (const line of `${existing || ''}\n${additions || ''}`.split(/\n/).map((l) => l.trim())) {
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join('\n');
}

/**
 * @param {object} a
 * @param {{ taste: object, onSave: (patch: object) => Promise<void> }} opts
 */
function openArticlePreferenceModal(a, vibe, opts) {
  const wantMore = vibe === 'up';
  const backdrop = document.createElement('div');
  backdrop.className = 'events-finder__modal-backdrop';
  const modal = document.createElement('div');
  modal.className = wantMore
    ? 'events-finder__modal'
    : 'events-finder__modal events-finder__modal--taste-down';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h3');
  title.className = 'events-finder__modal-title';
  title.textContent = wantMore ? 'See more like this?' : 'See less like this?';

  const hint = document.createElement('p');
  hint.className = 'events-finder__modal-hint';
  hint.textContent = wantMore
    ? 'Add ideas to Look for (one per line). These steer future headlines toward similar articles.'
    : 'This article is hidden. Add grey-list and/or black-list words (one per line). Grey hides only when no Look for word matches; black always hides.';

  const articleLabel = document.createElement('p');
  articleLabel.className = 'events-finder__modal-event';
  articleLabel.textContent = a.title || 'Untitled article';

  modal.append(title, hint, articleLabel);

  /** @type {HTMLTextAreaElement} */
  let area;
  /** @type {HTMLTextAreaElement | null} */
  let greyArea = null;
  /** @type {HTMLTextAreaElement | null} */
  let blackArea = null;

  if (wantMore) {
    area = document.createElement('textarea');
    area.className = 'events-finder__modal-textarea';
    area.rows = 6;
    area.spellcheck = true;
    area.placeholder = 'One idea per line…';
    area.value = suggestArticlePreferenceLines(a, vibe);
    modal.append(area);
  } else {
    const suggested = suggestArticlePreferenceLines(a, vibe);

    const greyLabel = document.createElement('label');
    greyLabel.className = 'events-finder__modal-field-label';
    greyLabel.htmlFor = 'local-news-pref-grey';
    greyLabel.textContent = 'Grey list';
    const greyHint = document.createElement('p');
    greyHint.className = 'events-finder__modal-field-hint';
    greyHint.textContent = 'Hide matching articles only if no Look for word also matches.';
    greyArea = document.createElement('textarea');
    greyArea.id = 'local-news-pref-grey';
    greyArea.className = 'events-finder__modal-textarea events-finder__modal-textarea--compact';
    greyArea.rows = 4;
    greyArea.spellcheck = true;
    greyArea.placeholder = 'One idea per line…';
    greyArea.value = suggested;

    const blackLabel = document.createElement('label');
    blackLabel.className = 'events-finder__modal-field-label';
    blackLabel.htmlFor = 'local-news-pref-black';
    blackLabel.textContent = 'Black list';
    const blackHint = document.createElement('p');
    blackHint.className = 'events-finder__modal-field-hint';
    blackHint.textContent = 'Always hide matching articles, even if a Look for word matches.';
    blackArea = document.createElement('textarea');
    blackArea.id = 'local-news-pref-black';
    blackArea.className = 'events-finder__modal-textarea events-finder__modal-textarea--compact';
    blackArea.rows = 4;
    blackArea.spellcheck = true;
    blackArea.placeholder = 'One idea per line…';
    blackArea.value = '';

    modal.append(greyLabel, greyHint, greyArea, blackLabel, blackHint, blackArea);
  }

  const msg = document.createElement('p');
  msg.className = 'events-finder__modal-msg';
  msg.hidden = true;
  modal.append(msg);

  const actions = document.createElement('div');
  actions.className = 'events-finder__modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'events-finder__modal-btn';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'events-finder__modal-btn events-finder__modal-btn--primary';
  save.textContent = wantMore ? 'Add to Look for' : 'Save & hide article';
  actions.append(cancel, save);
  modal.append(actions);

  const close = () => backdrop.remove();
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  save.addEventListener('click', async () => {
    const lookAdditions = wantMore ? area.value : '';
    const greyAdditions = wantMore ? '' : greyArea?.value || '';
    const blackAdditions = wantMore ? '' : blackArea?.value || '';
    const hasLook = Boolean(lookAdditions.trim());
    const hasGrey = Boolean(greyAdditions.trim());
    const hasBlack = Boolean(blackAdditions.trim());
    if (wantMore && !hasLook) {
      msg.hidden = false;
      msg.textContent = 'Add at least one preference line.';
      return;
    }
    if (!wantMore && !hasGrey && !hasBlack) {
      msg.hidden = false;
      msg.textContent = 'Add at least one grey-list or black-list line (or both).';
      return;
    }
    save.disabled = true;
    msg.hidden = false;
    msg.textContent = 'Saving…';

    const taste = opts.taste || {};
    const patch = {
      lookFor: wantMore ? mergeTasteLines(taste.lookFor, lookAdditions) : taste.lookFor ?? '',
      skip: !wantMore && hasGrey ? mergeTasteLines(taste.skip, greyAdditions) : taste.skip ?? '',
      blacklist:
        !wantMore && hasBlack ? mergeTasteLines(taste.blacklist, blackAdditions) : taste.blacklist ?? '',
    };
    if (!wantMore && a.id) patch.hiddenArticleIds = [a.id];

    try {
      await opts.onSave(patch);
      close();
    } catch (e) {
      save.disabled = false;
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save';
    }
  });

  backdrop.append(modal);
  document.body.append(backdrop);
}

/**
 * @param {HTMLElement} root
 * @param {Array<object>} articles
 * @param {{ taste: object, onSave: (patch: object) => Promise<void> }} tasteOpts
 */
function renderArticleList(root, articles, tasteOpts) {
  if (!articles.length) {
    const empty = document.createElement('p');
    empty.className = 'muted local-news__empty';
    empty.textContent = 'No articles yet — subscribe to a feed above to start seeing headlines.';
    root.append(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'local-news__list';
  for (const a of articles) {
    const li = document.createElement('li');
    li.className = 'local-news__row';

    const link = document.createElement('a');
    link.className = 'local-news__row-link';
    link.href = a.link || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = a.title;
    li.append(link);

    const metaRow = document.createElement('div');
    metaRow.className = 'local-news__row-meta-row';

    const meta = document.createElement('span');
    meta.className = 'local-news__row-meta';
    meta.textContent = [a.feedTitle, fmtRelative(a.publishedAt)].filter(Boolean).join(' · ');
    metaRow.append(meta);

    const rowActions = document.createElement('span');
    rowActions.className = 'local-news__row-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'events-finder__card-action events-finder__card-action--up';
    upBtn.textContent = '👍';
    upBtn.setAttribute('aria-label', 'See more like this');
    upBtn.title = 'See more like this';
    upBtn.addEventListener('click', () => openArticlePreferenceModal(a, 'up', tasteOpts));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'events-finder__card-action events-finder__card-action--down';
    downBtn.textContent = '👎';
    downBtn.setAttribute('aria-label', 'See less like this');
    downBtn.title = 'See less like this';
    downBtn.addEventListener('click', () => openArticlePreferenceModal(a, 'down', tasteOpts));

    rowActions.append(upBtn, downBtn);
    metaRow.append(rowActions);
    li.append(metaRow);

    list.append(li);
  }
  root.append(list);
}

/**
 * @param {HTMLElement | null} root
 */
export function mountLocalNews(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('local-news');

  const suggestionMount = document.createElement('div');
  suggestionMount.className = 'local-news__suggestion-mount';

  const body = document.createElement('div');
  body.className = 'local-news__body';

  const msg = document.createElement('p');
  msg.className = 'local-news__status';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  root.append(suggestionMount, body, msg);

  let busy = false;
  /** @type {{ lookFor: string, skip: string, blacklist: string }} */
  let taste = { lookFor: '', skip: '', blacklist: '' };

  async function saveTaste(patch) {
    const r = await fetch('/api/local-news/criteria', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    taste = { lookFor: j.lookFor ?? '', skip: j.skip ?? '', blacklist: j.blacklist ?? '' };
    await refresh();
  }

  /**
   * @param {object} j
   */
  function applyPayload(j) {
    if (j.criteria && typeof j.criteria === 'object') {
      taste = {
        lookFor: j.criteria.lookFor ?? '',
        skip: j.criteria.skip ?? '',
        blacklist: j.criteria.blacklist ?? '',
      };
    }

    suggestionMount.replaceChildren();
    if (j.pendingSuggestion) {
      renderSuggestionBlock(suggestionMount, j.pendingSuggestion, {
        busy,
        onRespond: respond,
        onFresh: suggestFresh,
      });
    } else {
      renderNoSuggestionRow(suggestionMount, suggestFresh);
    }

    body.replaceChildren();
    renderArticleList(body, Array.isArray(j.articles) ? j.articles : [], {
      taste,
      onSave: saveTaste,
    });
  }

  async function refresh() {
    try {
      const r = await fetch('/api/local-news', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      writePanelCache(CACHE_KEY, j);
      applyPayload(j);
      msg.hidden = true;
    } catch (e) {
      if (body.querySelector('.local-news__list') || body.querySelector('.local-news__empty')) return;
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load news feed';
      msg.hidden = false;
    }
  }

  async function respond(response) {
    if (busy) return;
    busy = true;
    msg.hidden = true;
    try {
      const r = await fetch('/api/local-news/suggestion/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      busy = false;
      await refresh();
    } catch (e) {
      busy = false;
      msg.classList.add('local-news__status--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not save response';
      msg.hidden = false;
    }
  }

  async function suggestFresh() {
    if (busy) return;
    busy = true;
    msg.hidden = true;
    try {
      const r = await fetch('/api/local-news/suggestion/fresh', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      busy = false;
      await refresh();
      if (j.exhausted) {
        msg.classList.remove('local-news__status--err');
        msg.textContent = "You're subscribed to or have declined every feed we know about.";
        msg.hidden = false;
      }
    } catch (e) {
      busy = false;
      msg.classList.add('local-news__status--err');
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not fetch a suggestion';
      msg.hidden = false;
    }
  }

  const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
  if (cached && typeof cached === 'object') applyPayload(cached);

  refresh();
  window.setInterval(refresh, REFRESH_MS);
}
