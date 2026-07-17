/**
 * Do Random Task picker + project locations table.
 */
import { getDevicePlace } from './device-location.js';
import { detectMobileDevice, isMobileView } from './view-mode.js';
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
  difficulty: 'Effort',
  duration: 'Duration',
  locations: 'Location',
  times: 'When',
};

const ALL_ASSIGN_FIELDS = ['priority', 'difficulty', 'duration', 'times', 'locations'];

/**
 * @param {string} field
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function fieldOptionsForAssign(field, taskMeta, projectMeta) {
  if (field === 'priority') return PRIORITIES;
  if (field === 'difficulty') return DIFFICULTIES;
  if (field === 'duration') return DURATIONS;
  if (field === 'locations') {
    return [
      {
        id: '__inherit__',
        label: `Default (${projectDefaultLocationLabel(projectMeta)})`,
      },
      { id: '__any__', label: 'Any location' },
      ...TASK_LOCATION_OPTIONS,
    ];
  }
  if (field === 'times') return [{ id: '__any__', label: 'Any time' }, ...TIME_OPTIONS];
  return [];
}

/**
 * @param {string} field
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 * @returns {string | null}
 */
function currentAssignFieldValue(field, taskMeta, projectMeta) {
  if (field === 'priority') return typeof taskMeta?.priority === 'string' ? taskMeta.priority : null;
  if (field === 'difficulty') return typeof taskMeta?.difficulty === 'string' ? taskMeta.difficulty : null;
  if (field === 'duration') return typeof taskMeta?.duration === 'string' ? taskMeta.duration : null;
  if (field === 'locations') {
    if (taskMeta?.locationAny) return '__any__';
    if (typeof taskMeta?.location === 'string' && taskMeta.location) return taskMeta.location;
    if (Array.isArray(taskMeta?.locations) && taskMeta.locations.length) {
      return String(taskMeta.locations[0]);
    }
    return hasEffectiveLocation(taskMeta, projectMeta) ? '__inherit__' : null;
  }
  if (field === 'times') {
    if (taskMeta?.timeAny) return '__any__';
    if (Array.isArray(taskMeta?.times) && taskMeta.times.length) return String(taskMeta.times[0]);
    return null;
  }
  return null;
}

/**
 * @param {string} field
 * @param {string} id
 */
function levelToneClass(field, id) {
  if ((field === 'priority' || field === 'difficulty') && (id === 'low' || id === 'med' || id === 'high')) {
    const tone = field === 'priority' ? 'priority' : 'effort';
    return `tasks-random__chip--${tone}-${id}`;
  }
  return '';
}

/**
 * @param {HTMLElement} el
 * @param {string} field
 * @param {string} id
 */
function applyLevelTone(el, field, id) {
  const cls = levelToneClass(field, id);
  if (cls) el.classList.add(cls);
}

/**
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 */
function assignSummaryEntries(taskMeta, projectMeta) {
  /** @type {Array<{ field: string, id: string, label: string }>} */
  const out = [];
  for (const field of ALL_ASSIGN_FIELDS) {
    const id = currentAssignFieldValue(field, taskMeta, projectMeta);
    if (id == null) continue;
    let label = id;
    if (field === 'priority') label = PRIORITIES.find((o) => o.id === id)?.label || id;
    else if (field === 'difficulty') label = DIFFICULTIES.find((o) => o.id === id)?.label || id;
    else if (field === 'duration') label = DURATIONS.find((o) => o.id === id)?.label || id;
    else if (field === 'locations') {
      if (id === '__any__') label = 'Any location';
      else if (id === '__inherit__') label = `Default (${projectDefaultLocationLabel(projectMeta)})`;
      else label = TASK_LOCATION_OPTIONS.find((o) => o.id === id)?.label || LOCATION_LABELS[id] || id;
    } else if (field === 'times') {
      if (id === '__any__') label = 'Any time';
      else label = TIME_OPTIONS.find((o) => o.id === id)?.label || TIME_LABELS[id] || id;
    }
    out.push({ field, id, label: `${FIELD_LABELS[field]}: ${label}` });
  }
  return out;
}

/**
 * @param {HTMLElement} assignRow
 * @param {string[]} fields
 * @param {Record<string, unknown> | null | undefined} taskMeta
 * @param {Record<string, unknown> | null | undefined} projectMeta
 * @param {Record<string, unknown>} data
 * @param {Parameters<typeof renderTaskCardModal>[0]} opts
 */
function appendAssignFields(assignRow, fields, taskMeta, projectMeta, data, opts) {
  for (const field of fields) {
    const group = document.createElement('div');
    group.className = 'tasks-random__assign-group';
    if (field === 'times') group.classList.add('tasks-random__assign-group--times');
    const fl = document.createElement('span');
    fl.className = 'tasks-random__assign-field';
    fl.textContent = FIELD_LABELS[field] || field;
    group.append(fl);
    /** @type {HTMLElement} */
    let chipContainer = group;
    if (field === 'times') {
      chipContainer = document.createElement('div');
      chipContainer.className = 'tasks-random__assign-chips';
      group.append(chipContainer);
    }
    const selected = currentAssignFieldValue(field, taskMeta, projectMeta);
    for (const opt of fieldOptionsForAssign(field, taskMeta, projectMeta)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tasks-random__chip tasks-random__chip--assign';
      b.textContent = opt.label;
      if (selected != null && opt.id === selected) {
        b.classList.add('tasks-random__chip--on');
        applyLevelTone(b, field, opt.id);
      }
      b.addEventListener('click', async () => {
        /** @type {Record<string, unknown>} */
        const patch = {};
        if (field === 'priority') patch.priority = opt.id;
        else if (field === 'difficulty') patch.difficulty = opt.id;
        else if (field === 'duration') patch.duration = opt.id;
        else if (field === 'locations') Object.assign(patch, patchBodyForTaskLocation(opt.id));
        else if (field === 'times') {
          if (opt.id === '__any__') patch.timeAny = true;
          else patch.times = [opt.id];
        }
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
      chipContainer.append(b);
    }
    assignRow.append(group);
  }
}

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

function hasEffectiveTime(taskMeta) {
  if (taskMeta?.timeAny) return true;
  if (Array.isArray(taskMeta?.times) && taskMeta.times.length) return true;
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
  if (!hasEffectiveTime(taskMeta)) missing.push('times');
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
  if (opts.hideTitle) head.classList.add('tasks-random__head--bare');
  if (!opts.hideTitle) {
    const h2 = document.createElement('h2');
    h2.className = 'tasks-random__title';
    h2.textContent = title;
    head.append(h2);
  }
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
  return isMobileView() || detectMobileDevice() ? 'phone' : 'laptop';
}

/**
 * @param {string} id
 */
async function archiveRandomTaskDone(id) {
  const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(id)}/done`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archive: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
}

/**
 * @param {HTMLElement} titleEl
 * @param {string} initial
 * @param {(next: string) => void | Promise<void>} onCommit
 */
function beginRandomTaskTitleEdit(titleEl, initial, onCommit) {
  if (titleEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tasks-random__card-title-input';
  input.value = initial;
  input.setAttribute('aria-label', 'Edit task text');
  titleEl.replaceChildren(input);
  input.focus();
  input.select();

  let closed = false;
  async function finish(save) {
    if (closed) return;
    closed = true;
    const next = input.value.trim();
    if (!save || !next) {
      titleEl.textContent = initial;
      return;
    }
    if (next === initial) {
      titleEl.textContent = initial;
      return;
    }
    titleEl.textContent = next;
    titleEl.classList.add('tasks-random__card-title--saving');
    try {
      await onCommit(next);
      titleEl.classList.remove('tasks-random__card-title--saving');
    } catch {
      titleEl.textContent = initial;
      titleEl.classList.remove('tasks-random__card-title--saving');
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => {
    void finish(true);
  });
}

/**
 * @param {string} taskId
 * @param {string} text
 */
async function saveRandomTaskText(taskId, text) {
  const r = await fetch(`/api/vikunja/todos/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(j.detail || j.error || `HTTP ${r.status}`);
  }
  return j.item || { id: taskId, text };
}

/**
 * @param {{
 *   body: HTMLElement,
 *   data: Record<string, unknown>,
 *   onHighlightTask?: (task: object) => void,
 *   onMarkDone?: (id: string) => void | Promise<void>,
 *   onTextChange?: (id: string, text: string, projectId?: number | null) => void,
 *   onSkip: () => void,
 *   onSkipProject: () => void,
 *   closeCard: () => void,
 * }} opts
 */
async function renderTaskCardModal(opts) {
  const { body, data, onMarkDone, onTextChange, onSkip, onSkipProject, closeCard } = opts;
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

  const title = document.createElement('h3');
  title.className = 'tasks-random__card-title';
  title.textContent = data.task.text;
  title.title = 'Double-click to edit';

  const proj = document.createElement('p');
  proj.className = 'tasks-random__card-project-head';
  const projEm = document.createElement('em');
  projEm.textContent = data.task.projectTitle || 'Project';
  proj.append(projEm);

  card.append(title, proj);

  title.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const taskId = String(data.task.id);
    const current = String(data.task.text || '');
    beginRandomTaskTitleEdit(title, current, async (next) => {
      await saveRandomTaskText(taskId, next);
      data.task.text = next;
      onTextChange?.(
        taskId,
        next,
        data.task.projectId != null ? Number(data.task.projectId) : null,
      );
    });
  });

  const assignWrap = document.createElement('details');
  assignWrap.className = 'tasks-random__assign-details';
  assignWrap.open = missingFields.length > 0;
  const assignSummary = document.createElement('summary');
  assignSummary.className = 'tasks-random__assign-summary';

  if (missingFields.length) {
    assignSummary.textContent = 'Set task attributes';
  } else {
    const summaryChips = document.createElement('span');
    summaryChips.className = 'tasks-random__assign-summary-chips';
    for (const entry of assignSummaryEntries(taskMeta, projectMeta)) {
      const chip = document.createElement('span');
      chip.className = 'tasks-random__summary-chip';
      chip.textContent = entry.label;
      applyLevelTone(chip, entry.field, entry.id);
      summaryChips.append(chip);
    }
    assignSummary.append(summaryChips);
  }

  const chevron = document.createElement('span');
  chevron.className = 'tasks-random__assign-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  assignSummary.append(chevron);

  const assignRow = document.createElement('div');
  assignRow.className = 'tasks-random__assign';
  appendAssignFields(assignRow, ALL_ASSIGN_FIELDS, taskMeta, projectMeta, data, opts);
  assignWrap.append(assignSummary, assignRow);
  card.append(assignWrap);

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
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'tasks-random__secondary';
  doneBtn.textContent = 'Mark done';
  actions.append(skipBtn, skipProjectBtn, doneBtn);
  card.append(actions);
  body.append(card);

  skipBtn.addEventListener('click', onSkip);
  skipProjectBtn.addEventListener('click', onSkipProject);
  doneBtn.addEventListener('click', async () => {
    doneBtn.disabled = true;
    try {
      await onMarkDone?.(String(data.task.id));
    } catch {
      doneBtn.disabled = false;
    }
  });
}

/**
 * @param {{ root: HTMLElement, projects: Array<{ id: number, title: string }>, onHighlightTask?: (task: { id: string, projectId?: number | null }) => void, onDone?: (id: string, projectId?: number | null) => void, onTextChange?: (id: string, text: string, projectId?: number | null) => void }} opts
 */
export function openRandomTaskPicker(opts) {
  const { root, onHighlightTask, onDone, onTextChange } = opts;

  /** @type {string | null} */
  let difficulty = null;
  /** @type {string | null} */
  let duration = null;

  const filterShell = makeModalShell(root, 'Random Task Options');

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

  filterShell.body.append(filterWrap, filterActions);

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
    const cardShell = makeModalShell(root, '', { hideTitle: true });
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
          closeCard: cardShell.close,
          onTextChange,
          onSkip: () => {
            if (currentTaskId) excludeIds.push(currentTaskId);
            void pickAndShow();
          },
          onSkipProject: () => {
            if (currentProjectId != null) excludeProjectIds.push(String(currentProjectId));
            void pickAndShow();
          },
          onMarkDone: async (id) => {
            if (id) excludeIds.push(id);
            await archiveRandomTaskDone(id);
            onDone?.(id, currentProjectId);
            await pickAndShow();
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
