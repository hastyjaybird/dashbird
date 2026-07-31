/**
 * Merge Anthropic BD taste seeds into Local News criteria (in-memory).
 * Seeds live in git; live data/local-news-criteria.json may be root-owned in Docker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEEDS_PATH = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'data',
  'local-news-bd-criteria-seeds.json',
);

/** @type {{ lookFor: string[], skip: string[], blacklist: string[] } | null} */
let seedsCache = null;

function loadSeeds() {
  if (seedsCache) return seedsCache;
  try {
    const raw = JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf8'));
    seedsCache = {
      lookFor: Array.isArray(raw?.lookFor) ? raw.lookFor.map(String) : [],
      skip: Array.isArray(raw?.skip) ? raw.skip.map(String) : [],
      blacklist: Array.isArray(raw?.blacklist) ? raw.blacklist.map(String) : [],
    };
  } catch {
    seedsCache = { lookFor: [], skip: [], blacklist: [] };
  }
  return seedsCache;
}

/**
 * @param {string} block
 * @param {string[]} adds
 */
function mergeBlock(block, adds) {
  const lines = String(block || '').split(/\r?\n/);
  const have = new Set(
    lines
      .map((ln) => ln.replace(/#.*$/, '').trim().toLowerCase())
      .filter((ln) => ln && !ln.startsWith('//')),
  );
  const out = [...lines];
  for (const a of adds || []) {
    const key = String(a || '').trim().toLowerCase();
    if (!key || have.has(key)) continue;
    out.push(String(a).trim());
    have.add(key);
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

/**
 * @param {object} criteria
 * @returns {object}
 */
export function mergeBdCriteriaSeeds(criteria = {}) {
  const seeds = loadSeeds();
  return {
    ...criteria,
    lookFor: mergeBlock(criteria.lookFor, seeds.lookFor),
    skip: mergeBlock(criteria.skip, seeds.skip),
    blacklist: mergeBlock(criteria.blacklist, seeds.blacklist),
  };
}
