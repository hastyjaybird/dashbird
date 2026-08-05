import { readPanelCache, writePanelCache } from '../lib/panel-cache.js';

const REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'job-watch';
const CACHE_MAX_MS = 30 * 60 * 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Grey status disc — target not open.
 * @returns {SVGSVGElement}
 */
function iconGrey() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('class', 'job-watch__icon job-watch__icon--closed');
  svg.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', '8');
  c.setAttribute('cy', '8');
  c.setAttribute('r', '5');
  c.setAttribute('fill', 'none');
  c.setAttribute('stroke', 'currentColor');
  c.setAttribute('stroke-width', '1.5');
  svg.append(c);
  return svg;
}

/**
 * Green dopamine-style sparkle star — target is open.
 * @returns {HTMLElement}
 */
function iconGreenStar() {
  const wrap = document.createElement('span');
  wrap.className = 'job-watch__star job-watch__star--green';
  wrap.setAttribute('aria-hidden', 'true');

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('class', 'job-watch__star-svg');

  const star = document.createElementNS(SVG_NS, 'path');
  star.setAttribute(
    'd',
    'M12 2.6l2.4 5.3 5.8.6-4.4 3.8 1.3 5.7L12 15.2 6.9 18l1.3-5.7L3.8 8.5l5.8-.6L12 2.6z',
  );
  star.setAttribute('class', 'job-watch__star-path');
  svg.append(star);

  // Sparkle ticks
  for (const [x, y] of [
    [3, 4],
    [20, 5],
    [19, 18],
  ]) {
    const tick = document.createElementNS(SVG_NS, 'path');
    tick.setAttribute('d', `M${x} ${y - 1.4} V${y + 1.4} M${x - 1.4} ${y} H${x + 1.4}`);
    tick.setAttribute('class', 'job-watch__star-spark');
    tick.setAttribute('stroke-width', '1.2');
    tick.setAttribute('stroke-linecap', 'round');
    svg.append(tick);
  }

  wrap.append(svg);
  return wrap;
}

/**
 * Yellow review dot — unreviewed candidate.
 * @returns {HTMLElement}
 */
function iconYellowDot() {
  const span = document.createElement('span');
  span.className = 'job-watch__dot job-watch__dot--yellow';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * @param {object} assessment
 */
function fitLabel(assessment) {
  const close = assessment?.closeFit || 'none';
  const verdict = assessment?.verdict || 'pass';
  if (verdict === 'burn' && close === 'strong') return 'Strong fit — consider applying';
  if (verdict === 'canary') return 'Canary / leadership signal — do not apply yet';
  if (verdict === 'maybe') return 'Partial fit — review JD before burning cooldown';
  if (verdict === 'pass') return 'Not a fit — pass';
  return 'Needs review';
}

/**
 * @param {object} candidate
 * @param {() => void} onDone
 */
function openFitModal(candidate, onDone) {
  const a = candidate.assessment || {};
  const backdrop = document.createElement('div');
  backdrop.className = 'events-finder__modal-backdrop job-watch__modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'events-finder__modal job-watch__modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Job fit recommendation');

  const title = document.createElement('h3');
  title.className = 'events-finder__modal-title';
  title.textContent = candidate.title || 'Role';

  const meta = document.createElement('p');
  meta.className = 'events-finder__modal-hint';
  const bits = [];
  if (candidate.location) bits.push(candidate.location);
  if (a.verdict) bits.push(`verdict: ${a.verdict}`);
  if (Number.isFinite(a.score)) bits.push(`score ${a.score}/10`);
  if (a.closeFit) bits.push(`close-fit: ${a.closeFit}`);
  meta.textContent = bits.join(' · ') || 'Fit assessment';

  const verdict = document.createElement('p');
  verdict.className = 'job-watch__modal-verdict';
  verdict.textContent = fitLabel(a);

  const body = document.createElement('p');
  body.className = 'job-watch__modal-body';
  body.textContent = a.recommendation || 'No recommendation text yet.';

  if (Array.isArray(a.reasons) && a.reasons.length) {
    const ul = document.createElement('ul');
    ul.className = 'job-watch__modal-reasons';
    for (const r of a.reasons) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.append(li);
    }
    modal.append(title, meta, verdict, body, ul);
  } else {
    modal.append(title, meta, verdict, body);
  }

  const actions = document.createElement('div');
  actions.className = 'events-finder__modal-actions';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'events-finder__modal-btn';
  closeBtn.textContent = 'Close';

  const link = document.createElement('a');
  link.className = 'events-finder__modal-btn job-watch__modal-link';
  link.href = candidate.url || '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open posting';

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'events-finder__modal-btn';
  dismissBtn.textContent = 'Dismiss';

  actions.append(closeBtn, link, dismissBtn);
  modal.append(actions);
  backdrop.append(modal);
  document.body.append(backdrop);

  const cleanup = () => {
    backdrop.remove();
    onDone?.();
  };

  closeBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/job-watch/candidates/${encodeURIComponent(candidate.id)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
    cleanup();
  });

  dismissBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/job-watch/candidates/${encodeURIComponent(candidate.id)}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
    cleanup();
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeBtn.click();
  });
}

/**
 * @param {HTMLElement | null} root
 */
export function mountJobWatch(root) {
  if (!root) return;

  const shell = document.createElement('div');
  shell.className = 'job-watch';

  const status = document.createElement('p');
  status.className = 'muted job-watch__status';
  status.textContent = 'Loading…';

  const list = document.createElement('ul');
  list.className = 'job-watch__list';

  const candLabel = document.createElement('p');
  candLabel.className = 'job-watch__section-label';
  candLabel.textContent = 'New / possible fits';
  candLabel.hidden = true;

  const candList = document.createElement('ul');
  candList.className = 'job-watch__list job-watch__list--candidates';

  const footer = document.createElement('div');
  footer.className = 'job-watch__footer';
  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.className = 'job-watch__scan-btn';
  scanBtn.textContent = 'Scan now';
  footer.append(scanBtn);

  shell.append(status, list, candLabel, candList, footer);
  root.replaceChildren(shell);

  let busy = false;
  let timer = null;

  /**
   * @param {object} data
   */
  function paint(data) {
    list.replaceChildren();
    candList.replaceChildren();

    const targets = Array.isArray(data?.targets) ? data.targets : [];
    for (const t of targets) {
      const li = document.createElement('li');
      li.className = 'job-watch__row';
      if (t.status === 'open') li.classList.add('job-watch__row--open');

      const icon = t.status === 'open' ? iconGreenStar() : iconGrey();
      const text = document.createElement('div');
      text.className = 'job-watch__row-text';

      const label = document.createElement(t.status === 'open' && t.job?.url ? 'a' : 'span');
      label.className = 'job-watch__label';
      label.textContent = t.label;
      if (label.tagName === 'A') {
        label.href = t.job.url;
        label.target = '_blank';
        label.rel = 'noopener noreferrer';
      }

      const sub = document.createElement('span');
      sub.className = 'muted job-watch__sub';
      if (t.status === 'open' && t.job) {
        sub.textContent = t.job.title + (t.job.location ? ` · ${t.job.location}` : '');
      } else {
        const p =
          t.priority === 1
            ? 'P1'
            : t.priority === 2
              ? 'P2'
              : t.priority === 'queued'
                ? 'Queued'
                : 'Watch';
        sub.textContent = `${p} · not posted`;
      }

      text.append(label, sub);
      li.append(icon, text);
      list.append(li);
    }

    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    const showCands = candidates.filter((c) => c.needsReview || c.assessment?.verdict === 'canary');
    candLabel.hidden = showCands.length === 0;

    for (const c of showCands) {
      const li = document.createElement('li');
      li.className = 'job-watch__row job-watch__row--candidate';
      if (c.needsReview) li.classList.add('job-watch__row--needs-review');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'job-watch__cand-btn';
      btn.append(iconYellowDot());

      const text = document.createElement('div');
      text.className = 'job-watch__row-text';
      const label = document.createElement('span');
      label.className = 'job-watch__label';
      label.textContent = c.title;
      const sub = document.createElement('span');
      sub.className = 'muted job-watch__sub';
      const fit = c.assessment?.closeFit || 'partial';
      sub.textContent = `${c.location || 'Location n/a'} · ${fit} fit — tap for recommendation`;
      text.append(label, sub);
      btn.append(text);

      btn.addEventListener('click', () => {
        openFitModal(c, () => {
          void refresh({ force: true });
        });
      });

      li.append(btn);
      candList.append(li);
    }

    const when = data?.lastScanAt ? new Date(data.lastScanAt) : null;
    const whenTxt =
      when && !Number.isNaN(when.getTime())
        ? when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '—';
    if (data?.lastScanError) {
      status.textContent = `Scan error · ${data.lastScanError}`;
    } else {
      status.textContent = `Anthropic · scanned ${whenTxt}`;
    }
  }

  /**
   * @param {{ force?: boolean }} [opts]
   */
  async function refresh(opts = {}) {
    if (busy) return;
    busy = true;
    try {
      if (!opts.force) {
        const cached = readPanelCache(CACHE_KEY, CACHE_MAX_MS);
        if (cached?.data) paint(cached.data);
      }
      const res = await fetch('/api/job-watch', { headers: { accept: 'application/json' } });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        status.textContent = data?.error || `HTTP ${res.status}`;
        return;
      }
      if (data.disabled) {
        status.textContent = 'Job Watch disabled';
        list.replaceChildren();
        return;
      }
      writePanelCache(CACHE_KEY, data);
      paint(data);
    } catch (e) {
      status.textContent = e?.message || 'Could not load Job Watch';
    } finally {
      busy = false;
    }
  }

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    status.textContent = 'Scanning Greenhouse…';
    try {
      const res = await fetch('/api/job-watch/scan', { method: 'POST' });
      const data = await res.json();
      if (data?.ok !== false) {
        writePanelCache(CACHE_KEY, data);
        paint(data);
      } else {
        status.textContent = data?.error || 'Scan failed';
      }
    } catch (e) {
      status.textContent = e?.message || 'Scan failed';
    } finally {
      scanBtn.disabled = false;
    }
  });

  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);

  return () => {
    if (timer) clearInterval(timer);
  };
}
