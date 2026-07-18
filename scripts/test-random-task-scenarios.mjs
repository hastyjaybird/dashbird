#!/usr/bin/env node
/**
 * Multi-scenario random task picker exhaust tests.
 */
import { listAllPanelTodos, listPanelProjects } from '../src/lib/vikunja-client.js';
import { loadTaskRandomMeta } from '../src/lib/task-random-meta-store.js';
import {
  pickRandomTask,
  taskMatchesRandomFilters,
  effectiveTaskLocations,
  effectiveTaskTimes,
} from '../src/lib/task-random.js';

async function simulateSkipUntilEmpty(tasks, meta, filters) {
  const excludeIds = [];
  const excludeProjectIds = [];
  const seen = new Set();
  let picks = 0;
  while (picks < 5000) {
    const result = pickRandomTask(tasks, meta, { ...filters, excludeIds, excludeProjectIds });
    if (!result.task) return { seen, picks, excludeIds, excludeProjectIds };
    seen.add(String(result.task.id));
    excludeIds.push(String(result.task.id));
    picks++;
  }
  return { seen, picks, excludeIds, excludeProjectIds, truncated: true };
}

function eligibleSet(tasks, meta, filters) {
  return new Set(
    tasks
      .filter((t) => {
        const taskMeta = meta.byTaskId[String(t.id)] || null;
        const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
        return taskMatchesRandomFilters(taskMeta, projectMeta, filters);
      })
      .map((t) => String(t.id)),
  );
}

const [tasks, meta] = await Promise.all([listAllPanelTodos(), loadTaskRandomMeta()]);
const projects = await listPanelProjects();

const scenarios = [
  { name: 'no filters', filters: {} },
  { name: 'difficulty=low', filters: { difficulties: ['low'] } },
  { name: 'duration=10m', filters: { durations: ['10m'] } },
  { name: 'location=home', filters: { locations: ['home'] } },
  { name: 'time=weekday_9_5', filters: { times: ['weekday_9_5'] } },
  { name: 'priority=high + effort=med', filters: { priorities: ['high'], difficulties: ['med'] } },
];

console.log('=== Multi-scenario exhaust tests ===');
console.log('Total open tasks (listAllPanelTodos):', tasks.length, '| Projects:', projects.length);
console.log('');

for (const sc of scenarios) {
  const filters = {
    priorities: [],
    difficulties: [],
    durations: [],
    locations: [],
    times: [],
    excludeIds: [],
    excludeProjectIds: [],
    ...(sc.filters || {}),
  };
  const eligible = eligibleSet(tasks, meta, filters);
  const { seen, picks } = await simulateSkipUntilEmpty(tasks, meta, filters);
  const gap = [...eligible].filter((id) => !seen.has(id));
  const status = gap.length === 0 && seen.size === eligible.size ? 'OK' : 'GAP';
  console.log(`[${status}] ${sc.name}`);
  console.log(`  eligible=${eligible.size} seen=${seen.size} picks=${picks} missing=${gap.length}`);
  if (gap.length) console.log(`  missing ids: ${gap.slice(0, 10).join(', ')}`);
  console.log('');
}

const filters = {
  priorities: [],
  difficulties: [],
  durations: [],
  locations: [],
  times: [],
  excludeIds: [],
  excludeProjectIds: [],
};
console.log('=== Per-project (no filters) ===');
for (const p of projects) {
  const projTasks = tasks.filter((t) => t.projectId === p.id);
  const eligible = projTasks.filter((t) => {
    const taskMeta = meta.byTaskId[String(t.id)] || null;
    const projectMeta = meta.byProjectId[String(p.id)] || null;
    return taskMatchesRandomFilters(taskMeta, projectMeta, filters);
  });
  if (projTasks.length === 0 && eligible.length === 0) continue;
  const flag = projTasks.length > 0 && eligible.length === 0 ? ' *** ALL FILTERED OUT ***' : '';
  console.log(`  ${p.title}: ${eligible.length}/${projTasks.length} eligible${flag}`);
}

console.log('');
console.log('=== Filtered-out tasks (no filters, not eligible) ===');
const filtered = tasks.filter((t) => {
  const taskMeta = meta.byTaskId[String(t.id)] || null;
  const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
  return !taskMatchesRandomFilters(taskMeta, projectMeta, filters);
});
for (const t of filtered.slice(0, 15)) {
  const taskMeta = meta.byTaskId[String(t.id)] || null;
  const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
  const locs = effectiveTaskLocations(taskMeta, projectMeta);
  const times = effectiveTaskTimes(taskMeta);
  console.log(`  #${t.id} [${t.projectTitle}] locs=${locs.join(',') || 'none'} times=${times.join(',') || 'any'} timeAny=${!!taskMeta?.timeAny}`);
}
if (filtered.length > 15) console.log(`  ... and ${filtered.length - 15} more`);

console.log('');
console.log('=== Skip-project path (exclude whole project each pick) ===');
{
  const excludeIds = [];
  const excludeProjectIds = [];
  const seenProjects = new Set();
  let rounds = 0;
  while (rounds < 100) {
    const result = pickRandomTask(tasks, meta, { ...filters, excludeIds, excludeProjectIds });
    if (!result.task) break;
    const pid = String(result.task.projectId);
    seenProjects.add(pid);
    excludeProjectIds.push(pid);
    rounds++;
  }
  const projectsWithEligible = new Set();
  for (const t of tasks) {
    const taskMeta = meta.byTaskId[String(t.id)] || null;
    const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
    if (taskMatchesRandomFilters(taskMeta, projectMeta, filters)) {
      projectsWithEligible.add(String(t.projectId));
    }
  }
  console.log(`  Projects with ≥1 eligible task: ${projectsWithEligible.size}`);
  console.log(`  Skip-project rounds until empty: ${rounds}`);
  console.log(`  Projects visited: ${seenProjects.size}`);
  const missed = [...projectsWithEligible].filter((p) => !seenProjects.has(p));
  if (missed.length) console.log(`  Projects never picked from: ${missed.length} (random order — may miss on short runs)`);
}
