/**
 * Do Random Task picker + project locations table.
 */
import { getDevicePlace } from './device-location.js';
import { isMobileView } from './view-mode.js';
import {
  patchBodyForTaskLocation,
  projectDefaultLocationLabel,
  TASK_LOCATION_OPTIONS,
} from './task-location-meta.js';

const DIFFICULTIES = [
  { id: 'low', label: 'Low' },
  { id: 'med', label: 'Med' },
  { id: 'high', label: 'High' },
];
const PRIORITIES = [
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

const FIELD_LABELS = {
  priority: 'Priority',
  difficulty: 'Difficulty',
  duration: 'Duration',
  locations: 'Location',
  times: 'When',
};

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function hasEffectiveLocation(taskMeta, projectMeta) {
  if (taskMeta?.locationAny) return true;
  if (typeof taskMeta?.location === 'string' && taskMeta.location) return true;
  if (Array.isArray(taskMeta?.locations) && taskMeta.locations.length) return true;
  if (typeof projectMeta?.location === 'string' && projectMeta.location) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function missingFieldsForCard(taskMeta, projectMeta) {
  /** @type {string[]} */
  const missing = [];
  if (!taskMeta?.priority) missing.push('priority');
  if (!taskMeta?.difficulty) missing.push('difficulty');
  if (!taskMeta?.duration) missing.push('duration');
  if (!hasEffectiveLocation(taskMeta, projectMeta)) missing.push('locations');
  if (!Array.isArray(taskMeta?.times) || !taskMeta.times.length) missing.push('times');
  return missing;
}

/**
 * @param {HTMLElement} parent
 * @param {string} title
 * @param {{ hideClose?: boolean }} [opts]
 */
function makeModalShell(parent, title, opts = {}) {
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
  head.append(h2);
  if (!opts.hideClose) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tasks-random__close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');
    head.append(closeBtn);
    closeBtn.addEventListener('click', () => close());
  }
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
 * @param {{
 *   body: HTMLElement,
 *   data: Record<string, unknown>,
 *   onHighlightTask?: (task: object) => void,
 *   onDone?: (id: string) => void | Promise<void>,
 *   onSkip: () => void,
 *   onSkipProject: () => void,
 *   closeCard: () => void,
 * }} opts
 */
async function renderTaskCardModal(opts) {
  const { body, data, onHighlightTask, onDone, onSkip, onSkipProject, closeCard } = opts;
  body.replaceChildren();

  if (!data?.matched || !data.task) {
    const empty = document.createElement('p');
    empty.className = 'tasks-random__empty muted';
    empty.textContent = data?.message || 'No tasks match — try relaxing filters or tag more tasks.';
    const actions = document.createElement('div');
    actions.className = 'tasks-random__actions';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tasks-random__secondary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeCard);
    actions.append(closeBtn);
    body.append(empty, actions);
    return;
  }

  const taskMeta = data.meta || null;
  const projectMeta = data.projectMeta || null;
  const missingFields = missingFieldsForCard(taskMeta, projectMeta);

  const card = document.createElement('div');
  card.className = 'tasks-random__card';

  const proj = document.createElement('p');
  proj.className = 'tasks-random__card-project-head';
  proj.textContent = data.task.projectTitle || 'Project';

  const title = document.createElement('h3');
  title.className = 'tasks-random__card-title';
  title.textContent = data.task.text;

  card.append(proj, title);

  if (missingFields.length) {
    const assignWrap = document.createElement('details');
    assignWrap.className = 'tasks-random__assign-details';
    assignWrap.open = true;
    const assignSummary = document.createElement('summary');
    assignSummary.className = 'tasks-random__assign-summary';
    assignSummary.textContent = 'Set task attributes';
    const assignRow = document.createElement('div');
    assignRow.className = 'tasks-random__assign';

    for (const field of missingFields) {
      const group = document.createElement('div');
      group.className = 'tasks-random__assign-group';
      const fl = document.createElement('span');
      fl.className = 'tasks-random__assign-field';
      fl.textContent = FIELD_LABELS[field] || field;
      group.append(fl);
      const fieldOpts =
        field === 'priority'
          ? PRIORITIES
          : field === 'difficulty'
            ? DIFFICULTIES
            : field === 'duration'
              ? DURATIONS
              : field === 'locations'
                ? [
                    {
                      id: '__inherit__',
                      label: `Default (${projectDefaultLocationLabel(projectMeta)})`,
                    },
                    { id: '__any__', label: 'Any location' },
                    ...TASK_LOCATION_OPTIONS,
                  ]
                : TIME_OPTIONS;
      for (const opt of fieldOpts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tasks-random__chip tasks-random__chip--sm';
        b.textContent = opt.label;
        b.addEventListener('click', async () => {
          /** @type {Record<string, unknown>} */
          const patch = {};
          if (field === 'priority') patch.priority = opt.id;
          else if (field === 'difficulty') patch.difficulty = opt.id;
          else if (field === 'duration') patch.duration = opt.id;
          else if (field === 'locations') Object.assign(patch, patchBodyForTaskLocation(opt.id));
          else if (field === 'times') patch.times = [opt.id];
          b.disabled = true;
          try {
            const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(data.task.id)}/meta`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
            if (!r.ok) throw new Error('save_failed');
            const j = await r.json();
            await renderTaskCardModal({
              ...opts,
              data: {
                ...data,
                meta: j.row || taskMeta,
              },
            });
          } catch {
            b.disabled = false;
          }
        });
        group.append(b);
      }
      assignRow.append(group);
    }

    assignWrap.append(assignSummary, assignRow);
    card.append(assignWrap);
  }

  const actions = document.createElement('div');
  actions.className = 'tasks-random__actions';
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'tasks-random__secondary';
  skipBtn.textContent = 'Skip';
  const skipProjectBtn = document.createElement('button');
  skipProjectBtn.type = 'button';
  skipProjectBtn.className = 'tasks-random__secondary';
  skipProjectBtn.textContent = 'Skip project';
  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'tasks-random__secondary';
  goBtn.textContent = 'Go to task';
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'tasks-random__secondary';
  doneBtn.textContent = 'Mark done';
  actions.append(skipBtn, skipProjectBtn, goBtn, doneBtn);
  card.append(actions);
  body.append(card);

  skipBtn.addEventListener('click', onSkip);
  skipProjectBtn.addEventListener('click', onSkipProject);
  goBtn.addEventListener('click', () => {
    onHighlightTask?.(data.task);
    closeCard();
  });
  doneBtn.addEventListener('click', async () => {
    doneBtn.disabled = true;
    await onDone?.(String(data.task.id));
    closeCard();
  });
}

/**
 * @param {{ root: HTMLElement, projects: Array<{ id: number, title: string }>, onHighlightTask?: (task: { id: string, projectId?: number | null }) => void, onDone?: (id: string) => void }} opts
 */
export function openRandomTaskPicker(opts) {
  const { root, onHighlightTask, onDone } = opts;

  /** @type {string | null} */
  let difficulty = null;
  /** @type {string | null} */
  let duration = null;

  const filterShell = makeModalShell(root, 'What can you do?');

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

  const filterHint = document.createElement('p');
  filterHint.className = 'tasks-random__hint muted';
  filterHint.textContent = 'Optional — leave blank for any. Tap Go when ready.';

  const filterActions = document.createElement('div');
  filterActions.className = 'tasks-random__filter-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tasks-random__secondary';
  cancelBtn.textContent = 'Cancel';
  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'tasks-random__primary';
  goBtn.textContent = 'Go';
  filterActions.append(cancelBtn, goBtn);

  filterShell.body.append(contextEl, filterWrap, filterHint, filterActions);

  void fetchContext().then((ctx) => {
    contextEl.textContent = ctx.label || 'Context ready';
  });

  cancelBtn.addEventListener('click', () => filterShell.close());

  goBtn.addEventListener('click', () => {
    filterShell.close();
    openTaskCardModal();
  });

  /** @type {string[]} */
  const excludeIds = [];
  /** @type {string[]} */
  const excludeProjectIds = [];

  async function fetchRandomTask() {
    const place = getDevicePlace();
    /** @type {Record<string, unknown>} */
    const bodyObj = {
      device: deviceKind(),
      excludeIds,
      excludeProjectIds,
    };
    if (difficulty) bodyObj.difficulty = difficulty;
    if (duration) bodyObj.duration = duration;
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
      bodyObj.lat = place.lat;
      bodyObj.lon = place.lon;
    }
    if (place?.timeZone) bodyObj.timeZone = place.timeZone;
    const r = await fetch('/api/vikunja/random-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.error || 'pick_failed');
    return j;
  }

  function openTaskCardModal() {
    const cardShell = makeModalShell(root, 'Your task');
    /** @type {string | null} */
    let currentTaskId = null;
    /** @type {number | null} */
    let currentProjectId = null;

    async function pickAndShow() {
      const loading = document.createElement('p');
      loading.className = 'tasks-random__status muted';
      loading.textContent = 'Picking a task…';
      cardShell.body.replaceChildren(loading);
      try {
        const j = await fetchRandomTask();
        currentTaskId = j.task?.id != null ? String(j.task.id) : null;
        currentProjectId =
          j.task?.projectId != null && Number.isFinite(Number(j.task.projectId))
            ? Number(j.task.projectId)
            : null;
        await renderTaskCardModal({
          body: cardShell.body,
          data: j,
          onHighlightTask,
          onDone,
          closeCard: cardShell.close,
          onSkip: () => {
            if (currentTaskId) excludeIds.push(currentTaskId);
            void pickAndShow();
          },
          onSkipProject: () => {
            if (currentProjectId != null) excludeProjectIds.push(String(currentProjectId));
            void pickAndShow();
          },
        });
      } catch (e) {
        cardShell.body.replaceChildren();
        const err = document.createElement('p');
        err.className = 'tasks-random__status tasks-random__status--err';
        err.textContent = String(e?.message || e || 'Could not pick a task.');
        const actions = document.createElement('div');
        actions.className = 'tasks-random__actions';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'tasks-random__secondary';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', cardShell.close);
        actions.append(closeBtn);
        cardShell.body.append(err, actions);
      }
    }

    void pickAndShow();
  }
}

/**
 * @param {{ root: HTMLElement, projects: Array<{ id: number, title: string }>, onMetaChange?: (meta: object) => void }} opts
 */
export async function openProjectLocationsTable(opts) {
  const { root, projects, onMetaChange } = opts;
  const { body, close } = makeModalShell(root, 'Project locations');

  const hint = document.createElement('p');
  hint.className = 'tasks-random__hint muted';
  hint.innerHTML =
    'Default location for tasks in each project (override per task in the list). Also editable in <code>data/task-project-locations.md</code>.';

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
          onMetaChange?.(meta);
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
      onMetaChange?.(meta);
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
