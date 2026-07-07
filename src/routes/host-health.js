import { Router } from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const router = Router();

function parseMeminfo(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s+kB\s*$/i.exec(line);
    if (m) map[m[1]] = parseInt(m[2], 10);
  }
  return map;
}

async function readMemory() {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const m = parseMeminfo(text);
    const memTotal = m.MemTotal;
    const memAvail = m.MemAvailable ?? m.MemFree;
    const swapTotal = m.SwapTotal ?? 0;
    const swapFree = m.SwapFree ?? 0;
    if (!Number.isFinite(memTotal) || memTotal <= 0) return null;
    const memUsedPct = Math.min(
      100,
      Math.max(0, 100 * (1 - (Number.isFinite(memAvail) ? memAvail : 0) / memTotal)),
    );
    let swapUsedPct = 0;
    if (Number.isFinite(swapTotal) && swapTotal > 0) {
      swapUsedPct = Math.min(100, Math.max(0, (100 * (swapTotal - (swapFree || 0))) / swapTotal));
    }
    const pressurePct = Math.min(100, Math.max(memUsedPct, swapUsedPct));
    return {
      memTotalKiB: memTotal,
      memAvailableKiB: Number.isFinite(memAvail) ? memAvail : null,
      memUsedPercent: memUsedPct,
      swapTotalKiB: swapTotal,
      swapUsedKiB: Number.isFinite(swapTotal) && swapTotal > 0 ? swapTotal - (swapFree || 0) : 0,
      swapUsedPercent: swapUsedPct,
      pressurePercent: pressurePct,
    };
  } catch {
    return null;
  }
}

router.get('/', async (_req, res) => {
  const inDocker = existsSync('/.dockerenv') || process.env.container === 'docker';
  const mem = await readMemory();

  const tips = [];
  if (inDocker) {
    tips.push(
      'Process is in a container: /proc/meminfo often reflects the container cgroup, not always the full host.',
    );
  }
  if (!mem) {
    tips.push('Could not read /proc/meminfo (very restricted environment).');
  }

  res.json({
    memory: mem,
    diagnostics: {
      inDocker,
      hasMeminfo: Boolean(mem),
      tips,
    },
  });
});

export default router;
