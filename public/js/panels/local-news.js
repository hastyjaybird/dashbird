import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'local-news';
const CACHE_MAX_MS = 20 * 60 * 1000;
const SHOW_SKIPPED_KEY = 'dashbird.localNews.showSkipped';

/**
 * @returns {boolean}
 */
function readShowSkipped() {
  try {
    return localStorage.getItem(SHOW_SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {boolean} on
 */
function writeShowSkipped(on) {
  try {
    localStorage.setItem(SHOW_SKIPPED_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

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
 * @param {object} suggestion
 * @param {{ onRespond: (r: 'yes' | 'defer') => void | Promise<void>, busy: boolean }} opts
 */
function openSuggestionPreviewModal(suggestion, opts) {
  const backdrop = document.createElement('div');
  backdrop.className = 'events-finder__modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'events-finder__modal local-news__preview-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h3');
  title.className = 'events-finder__modal-title';
  title.textContent = suggestion.feed.title || 'Feed preview';

  const hint = document.createElement('p');
  hint.className = 'events-finder__modal-hint';
  hint.textContent =
    'Latest headlines that would appear if you subscribe — not added to your feed until you tap Yes. Defer brings this feed back in a few hours to review again.';

  const body = document.createElement('div');
  body.className = 'local-news__preview-body';
  body.textContent = 'Loading articles…';

  const msg = document.createElement('p');
  msg.className = 'events-finder__modal-msg';
  msg.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'events-finder__modal-actions local-news__preview-actions';
  const deferBtn = document.createElement('button');
  deferBtn.type = 'button';
  deferBtn.className = 'events-finder__modal-btn';
  deferBtn.textContent = 'Defer';
  deferBtn.disabled = opts.busy;
  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'events-finder__modal-btn local-news__btn local-news__btn--yes';
  yesBtn.textContent = 'Yes';
  yesBtn.disabled = opts.busy;
  actions.append(deferBtn, yesBtn);

  modal.append(title, hint, body, msg, actions);
  backdrop.append(modal);
  document.body.append(backdrop);

  const close = () => backdrop.remove();
  deferBtn.addEventListener('click', async () => {
    deferBtn.disabled = true;
    yesBtn.disabled = true;
    try {
      await opts.onRespond('defer');
      close();
    } catch {
      deferBtn.disabled = opts.busy;
      yesBtn.disabled = opts.busy;
    }
  });
  yesBtn.addEventListener('click', async () => {
    deferBtn.disabled = true;
    yesBtn.disabled = true;
    try {
      await opts.onRespond('yes');
      close();
    } catch {
      deferBtn.disabled = opts.busy;
      yesBtn.disabled = opts.busy;
    }
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  void (async () => {
    try {
      const r = await fetch('/api/local-news/suggestion/preview', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);

      body.replaceChildren();
      const articles = Array.isArray(j.articles) ? j.articles : [];
      if (!articles.length) {
        const empty = document.createElement('p');
        empty.className = 'muted local-news__preview-empty';
        empty.textContent = 'No recent articles match your taste filters for this feed.';
        body.append(empty);
        return;
      }

      const list = document.createElement('ul');
      list.className = 'local-news__preview-list';
      for (const a of articles) {
        const li = document.createElement('li');
        li.className = 'local-news__preview-row';

        const link = document.createElement('a');
        link.className = 'local-news__preview-link';
        link.href = a.link || '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = a.title || 'Untitled';
        li.append(link);

        if (a.relevance) {
          const summary = document.createElement('p');
          summary.className = 'local-news__preview-summary';
          summary.textContent = a.relevance;
          li.append(summary);
        } else if (a.summary) {
          const summary = document.createElement('p');
          summary.className = 'local-news__preview-summary local-news__preview-summary--rss';
          summary.textContent = a.summary;
          li.append(summary);
        } else if (a.relevancePending) {
          const summary = document.createElement('p');
          summary.className = 'local-news__preview-summary local-news__preview-summary--pending';
          summary.textContent = 'Summarizing…';
          li.append(summary);
        }

        const meta = document.createElement('span');
        meta.className = 'local-news__preview-meta';
        meta.textContent = fmtRelative(a.publishedAt);
        if (meta.textContent) li.append(meta);

        list.append(li);
      }
      body.append(list);
    } catch (e) {
      body.replaceChildren();
      msg.hidden = false;
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load preview';
    }
  })();
}

/**
 * @param {HTMLElement} root
 * @param {object} suggestion
 * @param {{ onRespond: (r: 'yes' | 'no' | 'defer') => void | Promise<void>, onFresh: () => void, busy: boolean }} opts
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
  const title = document.createElement('span');
  title.className = 'local-news__suggestion-title local-news__suggestion-title--plain';
  title.textContent = suggestion.feed.title;
  feed.append(title);

  if (Array.isArray(suggestion.feed.tags) && suggestion.feed.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'local-news__suggestion-tags';
    tags.textContent = suggestion.feed.tags.slice(0, 3).join(' · ');
    feed.append(tags);
  }
  block.append(feed);

  const explore = document.createElement('div');
  explore.className = 'local-news__suggestion-explore';

  const siteUrl = suggestion.feed.siteUrl || suggestion.feed.url;
  if (siteUrl) {
    const siteBtn = document.createElement('a');
    siteBtn.className = 'local-news__btn local-news__btn--site';
    siteBtn.href = siteUrl;
    siteBtn.target = '_blank';
    siteBtn.rel = 'noopener noreferrer';
    siteBtn.textContent = 'Visit website';
    explore.append(siteBtn);
  }

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'local-news__btn local-news__btn--preview';
  previewBtn.textContent = 'Preview articles';
  previewBtn.disabled = opts.busy;
  previewBtn.addEventListener('click', () =>
    openSuggestionPreviewModal(suggestion, { onRespond: opts.onRespond, busy: opts.busy }),
  );
  explore.append(previewBtn);
  block.append(explore);

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
 * @param {string} block
 * @returns {string[]}
 */
function tasteLinesFromBlock(block) {
  return String(block || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('//'));
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
    if (!wantMore && !hasGrey && !hasBlack && !a.id) {
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
    if (!wantMore && a.id) {
      patch.hiddenArticleIds = [a.id];
      const tasteEntry = {
        ...(hasGrey ? { grey: tasteLinesFromBlock(greyAdditions) } : {}),
        ...(hasBlack ? { black: tasteLinesFromBlock(blackAdditions) } : {}),
      };
      if (tasteEntry.grey?.length || tasteEntry.black?.length) {
        patch.hiddenArticleTaste = { [a.id]: tasteEntry };
      }
    }

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
 * @param {{ taste: object, showSkipped: boolean, onSave: (patch: object) => Promise<void>, onSkip: (a: object) => Promise<void>, onUnskip: (a: object) => Promise<void> }} tasteOpts
 */
function renderArticleList(root, articles, tasteOpts) {
  if (!articles.length) {
    const empty = document.createElement('p');
    empty.className = 'muted local-news__empty';
    empty.textContent = tasteOpts.showSkipped
      ? 'No skipped articles. Skip hides a headline without changing grey/black lists.'
      : 'No articles yet — subscribe to a feed above to start seeing headlines.';
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

    if (a.relevance) {
      const relevance = document.createElement('p');
      relevance.className = 'local-news__row-relevance';
      relevance.textContent = a.relevance;
      li.append(relevance);
    } else if (a.relevancePending) {
      const relevance = document.createElement('p');
      relevance.className = 'local-news__row-relevance local-news__row-relevance--pending';
      relevance.textContent = 'Summarizing article…';
      li.append(relevance);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'local-news__row-meta-row';

    const meta = document.createElement('span');
    meta.className = 'local-news__row-meta';
    meta.textContent = [a.feedTitle, fmtRelative(a.publishedAt)].filter(Boolean).join(' · ');
    metaRow.append(meta);

    const rowActions = document.createElement('span');
    rowActions.className = 'local-news__row-actions';

    if (!tasteOpts.showSkipped) {
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

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'events-finder__card-action events-finder__card-action--hide';
      skipBtn.textContent = 'Skip';
      skipBtn.setAttribute('aria-label', 'Skip this article');
      skipBtn.title = 'Not interested — skip this headline';
      skipBtn.addEventListener('click', () => {
        void tasteOpts.onSkip(a);
      });

      rowActions.append(upBtn, downBtn, skipBtn);
    } else {
      const unskipBtn = document.createElement('button');
      unskipBtn.type = 'button';
      unskipBtn.className = 'events-finder__card-action events-finder__card-action--unskip';
      unskipBtn.textContent = 'Unskip';
      unskipBtn.setAttribute('aria-label', 'Restore this article');
      unskipBtn.title = 'Unskip — show in feed again';
      unskipBtn.addEventListener('click', () => {
        void tasteOpts.onUnskip(a);
      });
      rowActions.append(unskipBtn);
    }

    metaRow.append(rowActions);
    li.append(metaRow);

    list.append(li);
  }
  root.append(list);
}

/**
 * Compact news feed for the main dashboard (beside Tasks).
 * First click expands summary; second click opens the article.
 * @param {HTMLElement | null} root
 */
export function mountMainNewsFeed(root) {
  if (!root) return;
  root.replaceChildren();
  root.classList.add('main-news');

  const body = document.createElement('div');
  body.className = 'main-news__body';

  const msg = document.createElement('p');
  msg.className = 'main-news__status';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  root.append(body, msg);

  /** @type {string | null} */
  let expandedId = null;
  let relevancePollTimer = null;
  /** @type {object | null} */
  let lastPayload = null;

  /**
   * @param {object} a
   */
  function articleSummary(a) {
    if (a.relevance) return a.relevance;
    if (a.summary) return a.summary;
    if (a.relevancePending) return 'Summarizing article…';
    return '';
  }

  /**
   * @param {HTMLElement} card
   * @param {object} a
   */
  function setCardExpanded(card, a, on) {
    card.classList.toggle('main-news__card--expanded', on);
    card.setAttribute('aria-expanded', on ? 'true' : 'false');
    const summaryEl = card.querySelector('.main-news__card-summary');
    if (!summaryEl) return;
    if (on) {
      summaryEl.hidden = false;
      summaryEl.textContent = articleSummary(a);
      summaryEl.classList.toggle('main-news__card-summary--pending', Boolean(a.relevancePending));
    } else {
      summaryEl.hidden = true;
      summaryEl.textContent = '';
    }
  }

  /**
   * @param {Array<object>} articles
   */
  function renderFeed(articles) {
    body.replaceChildren();
    const rows = Array.isArray(articles) ? articles.slice(0, 12) : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted main-news__empty';
      empty.textContent = 'No headlines yet.';
      body.append(empty);
      expandedId = null;
      return;
    }

    if (expandedId && !rows.some((a) => a.id === expandedId)) expandedId = null;

    const list = document.createElement('ul');
    list.className = 'main-news__list';
    for (const a of rows) {
      const li = document.createElement('li');
      li.className = 'main-news__item';

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'main-news__card';
      card.dataset.id = a.id;
      const isExpanded = expandedId === a.id;
      card.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      if (isExpanded) card.classList.add('main-news__card--expanded');

      const media = document.createElement('div');
      media.className = 'main-news__card-media';
      const img = document.createElement('img');
      img.className = 'main-news__card-img';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      const imageUrl = String(a.imageUrl || '').trim();
      if (imageUrl) {
        img.src = imageUrl;
        img.addEventListener('error', () => {
          img.remove();
          media.classList.add('main-news__card-media--fallback');
        });
        media.append(img);
      } else {
        media.classList.add('main-news__card-media--fallback');
      }

      const textWrap = document.createElement('div');
      textWrap.className = 'main-news__card-text';

      const title = document.createElement('span');
      title.className = 'main-news__card-title';
      title.textContent = a.title || 'Untitled';

      const meta = document.createElement('span');
      meta.className = 'main-news__card-meta';
      meta.textContent = [a.feedTitle, fmtRelative(a.publishedAt)].filter(Boolean).join(' · ');

      const summary = document.createElement('p');
      summary.className = 'main-news__card-summary';
      summary.hidden = !isExpanded;
      if (isExpanded) {
        summary.textContent = articleSummary(a);
        summary.classList.toggle('main-news__card-summary--pending', Boolean(a.relevancePending));
      }

      textWrap.append(title, meta, summary);
      card.append(media, textWrap);

      card.addEventListener('click', () => {
        const id = a.id;
        const link = String(a.link || '').trim();
        if (expandedId === id) {
          if (link && /^https?:\/\//i.test(link)) {
            window.open(link, '_blank', 'noopener,noreferrer');
          }
          return;
        }
        const prev = expandedId
          ? list.querySelector(`.main-news__card[data-id="${CSS.escape(expandedId)}"]`)
          : null;
        if (prev) {
          const prevArticle = rows.find((x) => x.id === expandedId);
          if (prevArticle) setCardExpanded(prev, prevArticle, false);
        }
        expandedId = id;
        setCardExpanded(card, a, true);
      });

      li.append(card);
      list.append(li);
    }
    body.append(list);
  }

  /**
   * @param {object} j
   */
  function applyPayload(j) {
    lastPayload = j;
    const articles = Array.isArray(j.articles) ? j.articles : [];
    renderFeed(articles);

    if (relevancePollTimer) {
      window.clearTimeout(relevancePollTimer);
      relevancePollTimer = null;
    }
    const pendingRelevance =
      j.relevanceEnabled && articles.some((a) => a.relevancePending);
    if (pendingRelevance) {
      relevancePollTimer = window.setTimeout(() => {
        void refresh();
      }, 10_000);
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/local-news', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      applyPayload(j);
      msg.hidden = true;
    } catch (e) {
      if (body.querySelector('.main-news__list') || body.querySelector('.main-news__empty')) return;
      msg.textContent =
        e && typeof e === 'object' && 'message' in e ? String(e.message) : 'Could not load news';
      msg.hidden = false;
    }
  }

  const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
  if (cached && typeof cached === 'object') applyPayload(cached);

  refresh();
  window.setInterval(refresh, REFRESH_MS);
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

  const filterActions = document.createElement('div');
  filterActions.className = 'local-news__filter-actions';

  const showSkippedBtn = document.createElement('button');
  showSkippedBtn.type = 'button';
  showSkippedBtn.className = 'events-finder__show-skipped';
  showSkippedBtn.textContent = 'Show skipped';
  showSkippedBtn.title = 'Recover articles you skipped';
  showSkippedBtn.setAttribute('aria-pressed', 'false');

  filterActions.append(showSkippedBtn);

  const body = document.createElement('div');
  body.className = 'local-news__body';

  const msg = document.createElement('p');
  msg.className = 'local-news__status';
  msg.hidden = true;
  msg.setAttribute('aria-live', 'polite');

  root.append(suggestionMount, filterActions, body, msg);

  let busy = false;
  let showSkipped = readShowSkipped();
  let skippedCount = 0;
  let relevancePollTimer = null;
  /** @type {{ lookFor: string, skip: string, blacklist: string }} */
  let taste = { lookFor: '', skip: '', blacklist: '' };
  /** @type {object | null} */
  let lastPayload = null;

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
    lastPayload = j;
    if (j.criteria && typeof j.criteria === 'object') {
      taste = {
        lookFor: j.criteria.lookFor ?? '',
        skip: j.criteria.skip ?? '',
        blacklist: j.criteria.blacklist ?? '',
      };
    }
    skippedCount = Number(j.skippedCount) || (Array.isArray(j.skippedArticles) ? j.skippedArticles.length : 0);
    syncShowSkippedButton();

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
    if (showSkipped) {
      const note = document.createElement('p');
      note.className = 'events-finder__skipped-note muted';
      note.textContent = 'Most recent skip first — tap Unskip to restore.';
      body.append(note);
    }
    const articles = showSkipped
      ? (Array.isArray(j.skippedArticles) ? j.skippedArticles : [])
      : (Array.isArray(j.articles) ? j.articles : []);
    renderArticleList(body, articles, {
      taste,
      showSkipped,
      onSave: saveTaste,
      onSkip: skipArticle,
      onUnskip: unskipArticle,
    });

    if (relevancePollTimer) {
      window.clearTimeout(relevancePollTimer);
      relevancePollTimer = null;
    }
    const pendingRelevance =
      j.relevanceEnabled
      && !showSkipped
      && Array.isArray(j.articles)
      && j.articles.some((a) => a.relevancePending);
    if (pendingRelevance) {
      relevancePollTimer = window.setTimeout(() => {
        void refresh();
      }, 10_000);
    }
  }

  function syncShowSkippedButton() {
    showSkippedBtn.textContent = showSkipped
      ? `Hide skipped${skippedCount ? ` (${skippedCount})` : ''}`
      : `Show skipped${skippedCount ? ` (${skippedCount})` : ''}`;
    showSkippedBtn.setAttribute('aria-pressed', showSkipped ? 'true' : 'false');
    showSkippedBtn.classList.toggle('events-finder__show-skipped--on', showSkipped);
  }

  showSkippedBtn.addEventListener('click', () => {
    showSkipped = !showSkipped;
    writeShowSkipped(showSkipped);
    if (lastPayload) applyPayload(lastPayload);
  });

  /**
   * @param {object} a
   */
  async function skipArticle(a) {
    const id = String(a?.id || '').trim();
    if (!id || busy) return;
    busy = true;
    try {
      await saveTaste({ hiddenArticleIds: [id] });
    } finally {
      busy = false;
    }
  }

  /**
   * @param {object} a
   */
  async function unskipArticle(a) {
    const id = String(a?.id || '').trim();
    if (!id || busy) return;
    busy = true;
    try {
      await saveTaste({ unhideArticleIds: [id] });
    } finally {
      busy = false;
    }
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
      throw e;
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
