#!/usr/bin/env node
/**
 * Simulate random task picker skip-until-empty and report gaps.
 * Run: docker compose exec dashboard node scripts/test-random-task-exhaust.mjs
 */
import { listAllPanelTodos, listPanelProjects, listPanelTodos } from '../src/lib/vikunja-client.js';
import { loadTaskRandomMeta } from '../src/lib/task-random-meta-store.js';
import { pickRandomTask, taskMatchesRandomFilters } from '../src/lib/task-random.js';

const filters = {
  priorities: [],
  difficulties: [],
  durations: [],
  locations: [],
  times: [],
  excludeIds: [],
  excludeProjectIds: [],
};
const [tasks, meta] = await Promise.all([listAllPanelTodos(), loadTaskRandomMeta()]);

const projects = await listPanelProjects();
const perProject = [];
for (const p of projects) {
  const items = await listPanelTodos(process.env, { projectId: p.id });
  perProject.push({ id: p.id, title: p.title, count: items.length });
}

const eligible = tasks.filter((t) => {
  const taskMeta = meta.byTaskId[String(t.id)] || null;
  const projectMeta = t.projectId != null ? meta.byProjectId[String(t.projectId)] || null : null;
  return taskMatchesRandomFilters(taskMeta, projectMeta, filters);
});

const eligibleIds = new Set(eligible.map((t) => String(t.id)));
const seen = new Set();
const excludeIds = [];
const excludeProjectIds = [];
let picks = 0;
let emptyAt = null;

while (picks < 2000) {
  const result = pickRandomTask(tasks, meta, { ...filters, excludeIds, excludeProjectIds });
  if (!result.task) {
    emptyAt = picks;
    break;
  }
  const id = String(result.task.id);
  seen.add(id);
  excludeIds.push(id);
  picks++;
}

const neverSeen = [...eligibleIds].filter((id) => !seen.has(id));
const inTasksNotEligible = tasks.filter((t) => !eligibleIds.has(String(t.id)));

console.log('=== Random task exhaust simulation ===');
console.log('Filters: none (all attributes allowed)');
console.log('Projects:', projects.length);
console.log('Per-project open counts (>100 = pagination gap):');
for (const row of perProject.sort((a, b) => b.count - a.count)) {
  const flag = row.count >= 100 ? ' *** AT 100 CAP ***' : '';
  console.log(`  ${row.id} ${row.title}: ${row.count}${flag}`);
}
console.log('Total in listAllPanelTodos:', tasks.length, '(cap 500)');
console.log('Eligible after filters:', eligible.length);
console.log('First pick poolSize would be:', pickRandomTask(tasks, meta, filters).poolSize);
console.log('Skip-until-empty picks:', emptyAt ?? picks);
console.log('Unique tasks seen:', seen.size);
console.log('Eligible never seen:', neverSeen.length);
if (neverSeen.length) {
  console.log('Missing task ids (first 30):', neverSeen.slice(0, 30).join(', '));
}
console.log('Tasks in pool but filtered out:', inTasksNotEligible.length);

let rawTotal = 0;
for (const row of perProject) rawTotal += row.count;
if (rawTotal > tasks.length) {
  console.log('WARNING: rawTotal open tasks', rawTotal, '> listAllPanelTodos', tasks.length, '(500 cap or early break)');
}
if (perProject.some((r) => r.count >= 100)) {
  console.log('WARNING: some projects hit per_page=100 — tasks beyond 100 are invisible to randomizer');
}
