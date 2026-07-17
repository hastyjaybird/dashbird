/**
 * Do Random Task picker + project locations table.
 */
import { getDevicePlace } from './device-location.js';
import { isMobileView } from './view-mode.js';

const DIFFICULTIES = [
  { id: 'low', label: 'Low' },
  { id: 'med', label: 'Med' },
  { id: 'high', label: 'High' },
];
const DURATIONS = [
  { id: '5m', label: '5 min' },
  { id: '15m', label: '15 min' },
  { id: '30m', label: '30 min' },
  { id: '1hr+', label: '1 hr+' },
];
const LOCATIONS = [
  { id: '', label: 'Any' },
  { id: 'home', label: 'Home' },
  { id: 'out', label: 'Out and about' },
  { id: 'makerfarm', label: 'Maker Farm' },
  { id: 'laptop', label: 'Laptop only' },
  { id: 'phone', label: 'Phone ok' },
];
const DIFFICULTY_LABELS = Object.fromEntries(DIFFICULTIES.map((d) => [d.id, d.label]));
const DURATION_LABELS = Object.fromEntries(DURATIONS.map((d) => [d.id, d.label]));
const LOCATION_LABELS = Object.fromEntries(LOCATIONS.filter((l) => l.id).map((l) => [l.id, l.label]));
const TIME_OPTIONS = [
  { id: 'weekday_9_5', label: 'Weekday 9–5' },
  { id: 'afterhours', label: 'After hours' },
  { id: 'weekend', label: 'Weekend' },
];
const TIME_LABELS = Object.fromEntries(TIME_OPTIONS.map((t) => [t.id, t.label]));

/**
 * @param {HTMLElement} parent
 * @param {string} title
 */
function makeModalShell(parent, title) {
  const backdrop = document.createElement('div');
  backdrop.className = 'tasks-random__backdrop';
  const modal = document.createElement('div');
  modal.className = 'tasks-random__modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const head = document.createElement('div');
  head.className = 'tasks-random__head';
  const h2 = document.createElement('h2');
  h2.className = 'tasks-random__title';
  h2.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tasks-random__close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  head.append(h2, closeBtn);
  const body = document.createElement('div');
  body.className = 'tasks-random__body';
  modal.append(head, body);
  backdrop.append(modal);
  parent.append(backdrop);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  return { backdrop, modal, body, close };
}

/**
 * @param {HTMLElement} row
 * @param {string} label
 * @param {Array<{ id: string, label: string }>} options
 * @param {string | null} selected
 * @param {(id: string | null) => void} onPick
 */
function chipRow(row, label, options, getSelected, onPick) {
  const lab = document.createElement('p');
  lab.className = 'tasks-random__row-label';
  lab.textContent = label;
  row.append(lab);
  const chips = document.createElement('div');
  chips.className = 'tasks-random__chips';
  function syncChips() {
    const sel = getSelected();
    for (const c of chips.querySelectorAll('.tasks-random__chip')) {
      c.classList.toggle('tasks-random__chip--on', c.dataset.id === (sel ?? ''));
    }
  }
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tasks-random__chip';
    btn.textContent = opt.label;
    btn.dataset.id = opt.id;
    btn.addEventListener('click', () => {
      const cur = getSelected();
      const next = cur === opt.id ? null : opt.id;
      onPick(next);
      syncChips();
    });
    chips.append(btn);
  }
  syncChips();
  row.append(chips);
}

function deviceKind() {
  return isMobileView() ? 'phone' : 'laptop';
}

async function fetchContext() {
  const place = getDevicePlace();
  const params = new URLSearchParams();
  params.set('device', deviceKind());
  if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    params.set('lat', String(place.lat));
    params.set('lon', String(place.lon));
  }
  if (place?.timeZone) params.set('timeZone', place.timeZone);
  const r = await fetch(`/api/vikunja/task-context?${params}`, { cache: 'no-store' });
  if (!r.ok) return { label: 'Context unavailable' };
  const j = await r.json();
  return j.context || { label: 'Context unavailable' };
}

/**
 * @param {{ root: HTMLElement, projects: Array<{ id: number, title: string }>, onHighlightTask?: (task: { id: string, projectId?: number | null }) => void, onDone?: (id: string) => void }} opts
 */
export function openRandomTaskPicker(opts) {
  const { root, projects, onHighlightTask, onDone } = opts;
  const { body, close } = makeModalShell(root, 'Pick something to do');

  /** @type {string | null} */
  let difficulty = null;
  /** @type {string | null} */
  let duration = null;
  /** @type {string[]} */
  const excludeIds = [];

  const contextEl = document.createElement('p');
  contextEl.className = 'tasks-random__context muted';
  contextEl.textContent = 'Loading context…';

  const filterWrap = document.createElement('div');
  filterWrap.className = 'tasks-random__filters';

  const diffRow = document.createElement('div');
  diffRow.className = 'tasks-random__filter-row';
  chipRow(diffRow, 'Difficulty', DIFFICULTIES, () => difficulty, (id) => {
    difficulty = id;
  });

  const durRow = document.createElement('div');
  durRow.className = 'tasks-random__filter-row';
  chipRow(durRow, 'Duration', DURATIONS, () => duration, (id) => {
    duration = id;
  });

  filterWrap.append(diffRow, durRow);

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'tasks-random__primary';
  pickBtn.textContent = 'Pick a task';

  const status = document.createElement('p');
  status.className = 'tasks-random__status';
  status.hidden = true;

  const resultWrap = document.createElement('div');
  resultWrap.className = 'tasks-random__result';
  resultWrap.hidden = true;

  body.append(contextEl, filterWrap, pickBtn, status, resultWrap);

  void fetchContext().then((ctx) => {
    contextEl.textContent = ctx.label || 'Context ready';
  });

  async function renderResult(data) {
    resultWrap.replaceChildren();
    resultWrap.hidden = false;
    if (!data?.matched || !data.task) {
      const p = document.createElement('p');
      p.className = 'tasks-random__empty muted';
      p.textContent = data?.message || 'No tasks match — try relaxing filters or tag more tasks.';
      resultWrap.append(p);
      return;
    }

    const card = document.createElement('div');
    card.className = 'tasks-random__card';
    const title = document.createElement('h3');
    title.className = 'tasks-random__card-title';
    title.textContent = data.task.text;
    const proj = document.createElement('p');
    proj.className = 'tasks-random__card-project muted';
    proj.textContent = data.task.projectTitle || 'Project';
    card.append(title, proj);

    if (data.missingFields?.length) {
      const missLab = document.createElement('p');
      missLab.className = 'tasks-random__assign-label';
      missLab.textContent = 'Tag this task (optional):';
      card.append(missLab);
      const assignRow = document.createElement('div');
      assignRow.className = 'tasks-random__assign';
      for (const field of data.missingFields) {
        const group = document.createElement('div');
        group.className = 'tasks-random__assign-group';
        const fl = document.createElement('span');
        fl.className = 'tasks-random__assign-field';
        fl.textContent = field;
        group.append(fl);
        const opts =
          field === 'difficulty'
            ? DIFFICULTIES
            : field === 'duration'
              ? DURATIONS
              : field === 'locations'
                ? LOCATIONS.filter((l) => l.id)
                : TIME_OPTIONS;
        for (const opt of opts) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'tasks-random__chip tasks-random__chip--sm';
          b.textContent = opt.label;
          b.addEventListener('click', async () => {
            /** @type {Record<string, unknown>} */
            const patch = {};
            if (field === 'difficulty') patch.difficulty = opt.id;
            else if (field === 'duration') patch.duration = opt.id;
            else if (field === 'locations') patch.locations = [opt.id];
            else if (field === 'times') patch.times = [opt.id];
            const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(data.task.id)}/meta`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
            if (r.ok) {
              b.classList.add('tasks-random__chip--on');
              b.disabled = true;
            }
          });
          group.append(b);
        }
        assignRow.append(group);
      }
      card.append(assignRow);
    }

    const actions = document.createElement('div');
    actions.className = 'tasks-random__actions';
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'tasks-random__secondary';
    skipBtn.textContent = 'Skip';
    const goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'tasks-random__secondary';
    goBtn.textContent = 'Go to task';
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'tasks-random__secondary';
    doneBtn.textContent = 'Mark done';
    actions.append(skipBtn, goBtn, doneBtn);
    card.append(actions);
    resultWrap.append(card);

    skipBtn.addEventListener('click', () => {
      excludeIds.push(String(data.task.id));
      void doPick();
    });
    goBtn.addEventListener('click', () => {
      onHighlightTask?.(data.task);
      close();
    });
    doneBtn.addEventListener('click', async () => {
      doneBtn.disabled = true;
      await onDone?.(String(data.task.id));
      close();
    });
  }

  async function doPick() {
    pickBtn.disabled = true;
    status.hidden = true;
    const place = getDevicePlace();
    /** @type {Record<string, unknown>} */
    const bodyObj = {
      device: deviceKind(),
      excludeIds,
    };
    if (difficulty) bodyObj.difficulty = difficulty;
    if (duration) bodyObj.duration = duration;
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
      bodyObj.lat = place.lat;
      bodyObj.lon = place.lon;
    }
    if (place?.timeZone) bodyObj.timeZone = place.timeZone;
    try {
      const r = await fetch('/api/vikunja/random-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || 'pick_failed');
      await renderResult(j);
    } catch (e) {
      status.hidden = false;
      status.textContent = String(e?.message || e || 'Could not pick a task.');
      status.classList.add('tasks-random__status--err');
    } finally {
      pickBtn.disabled = false;
    }
  }

  pickBtn.addEventListener('click', () => void doPick());
}

/**
 * @param {{ root: HTMLElement, projects: Array<{ id: number, title: string }> }} opts
 */
export async function openProjectLocationsTable(opts) {
  const { root, projects } = opts;
  const { body, close } = makeModalShell(root, 'Project locations');

  const hint = document.createElement('p');
  hint.className = 'tasks-random__hint muted';
  hint.innerHTML =
    'Default location for all tasks in each project. Also editable in <code>data/task-project-locations.md</code>.';

  const docLink = document.createElement('a');
  docLink.className = 'tasks-random__doc-link';
  docLink.href = '/api/vikunja/project-locations-md';
  docLink.target = '_blank';
  docLink.rel = 'noopener noreferrer';
  docLink.textContent = 'Open markdown document';

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'tasks-random__secondary';
  syncBtn.textContent = 'Sync from Vikunja';

  const toolbar = document.createElement('div');
  toolbar.className = 'tasks-random__toolbar';
  toolbar.append(docLink, syncBtn);

  const scroll = document.createElement('div');
  scroll.className = 'tasks-random__table-scroll';

  const table = document.createElement('table');
  table.className = 'tasks-random__table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Project</th><th>Location</th></tr>';
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  scroll.append(table);

  const status = document.createElement('p');
  status.className = 'tasks-random__status';
  status.hidden = true;

  body.append(hint, toolbar, scroll, status);

  let meta = { byProjectId: {} };
  try {
    const r = await fetch('/api/vikunja/task-meta', { cache: 'no-store' });
    if (r.ok) meta = await r.json();
  } catch {
    /* ignore */
  }

  function renderRows() {
    tbody.replaceChildren();
    for (const p of projects) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = p.title;
      const tdLoc = document.createElement('td');
      const sel = document.createElement('select');
      sel.className = 'tasks-random__select';
      for (const loc of LOCATIONS) {
        const opt = document.createElement('option');
        opt.value = loc.id;
        opt.textContent = loc.label;
        sel.append(opt);
      }
      const rowMeta = meta.byProjectId?.[String(p.id)] || {};
      sel.value = rowMeta.location || '';
      sel.addEventListener('change', async () => {
        tr.classList.add('tasks-random__row--saving');
        try {
          const r = await fetch(`/api/vikunja/projects/${encodeURIComponent(String(p.id))}/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: sel.value || null }),
          });
          if (!r.ok) throw new Error('save_failed');
          const j = await r.json();
          meta = j.meta || meta;
          tr.classList.remove('tasks-random__row--saving');
          tr.classList.add('tasks-random__row--saved');
          setTimeout(() => tr.classList.remove('tasks-random__row--saved'), 800);
        } catch {
          tr.classList.remove('tasks-random__row--saving');
          status.hidden = false;
          status.textContent = `Could not save location for ${p.title}.`;
          status.classList.add('tasks-random__status--err');
        }
      });
      tdLoc.append(sel);
      tr.append(tdName, tdLoc);
      tbody.append(tr);
    }
  }

  renderRows();

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    try {
      const r = await fetch('/api/vikunja/project-locations/sync', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'sync_failed');
      meta = j.meta || meta;
      renderRows();
      status.hidden = false;
      status.textContent = 'Synced project list to markdown.';
      status.classList.remove('tasks-random__status--err');
    } catch {
      status.hidden = false;
      status.textContent = 'Sync failed.';
      status.classList.add('tasks-random__status--err');
    } finally {
      syncBtn.disabled = false;
    }
  });
}

export { DIFFICULTY_LABELS, DURATION_LABELS, LOCATION_LABELS, TIME_LABELS };
