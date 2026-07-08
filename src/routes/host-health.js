import { Router } from 'express';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const router = Router();

const NV_QUERY = [
  '--query-gpu=temperature.gpu,memory.used,memory.total,utilization.gpu',
  '--format=csv,noheader,nounits',
];

function execText(cmd, args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout || '').trim());
    });
  });
}

async function readNvidiaGpu() {
  const candidates = [];
  const whichOut = await execText('which', ['nvidia-smi'], 2500);
  if (whichOut) {
    const line = whichOut.split('\n').map((s) => s.trim()).find(Boolean);
    if (line) candidates.push(line);
  }
  for (const p of ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', 'nvidia-smi']) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  for (const bin of candidates) {
    const out = await execText(bin, NV_QUERY);
    if (!out) continue;
    const line = out.split('\n')[0];
    if (!line) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 4) continue;
    const tempC = parseFloat(parts[0]);
    const memUsed = parseFloat(parts[1]);
    const memTotal = parseFloat(parts[2]);
    const util = parseFloat(parts[3]);
    if (!Number.isFinite(memTotal) || memTotal <= 0) continue;
    return {
      temperatureC: Number.isFinite(tempC) ? tempC : null,
      memoryUsedMiB: Number.isFinite(memUsed) ? memUsed : null,
      memoryTotalMiB: memTotal,
      memoryPercent: Number.isFinite(memUsed) ? Math.min(100, (memUsed / memTotal) * 100) : null,
      utilPercent: Number.isFinite(util) ? Math.min(100, Math.max(0, util)) : null,
      nvidiaSmiPath: bin,
    };
  }
  return null;
}

function cFromMillidegreesOrC(m) {
  if (!Number.isFinite(m)) return null;
  if (m > 500) return m / 1000;
  if (m >= 15 && m <= 200) return m;
  return null;
}

async function readHwmonTempMaxC() {
  const base = '/sys/class/hwmon';
  let entries;
  try {
    entries = await readdir(base);
  } catch {
    return null;
  }
  let maxC = null;
  for (const name of entries) {
    if (!name.startsWith('hwmon')) continue;
    const dir = path.join(base, name);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^temp\d+_input$/.test(f)) continue;
      try {
        const raw = (await readFile(path.join(dir, f), 'utf8')).trim();
        const m = parseInt(raw, 10);
        const c = cFromMillidegreesOrC(m);
        if (c == null || c < 15 || c > 118) continue;
        if (maxC == null || c > maxC) maxC = c;
      } catch {
        /* skip */
      }
    }
  }
  return maxC;
}

async function readThermalZonesMaxC() {
  const base = '/sys/class/thermal';
  let entries;
  try {
    entries = await readdir(base);
  } catch {
    return null;
  }
  let maxC = null;
  for (const name of entries) {
    if (!name.startsWith('thermal_zone')) continue;
    const tempPath = path.join(base, name, 'temp');
    try {
      const raw = (await readFile(tempPath, 'utf8')).trim();
      const m = parseInt(raw, 10);
      const c = cFromMillidegreesOrC(m);
      if (c == null || c < 15 || c > 118) continue;
      if (maxC == null || c > maxC) maxC = c;
    } catch {
      /* skip */
    }
  }
  return maxC;
}

async function readCpuSideTempC() {
  const hw = await readHwmonTempMaxC();
  const tz = await readThermalZonesMaxC();
  if (hw != null && tz != null) return Math.max(hw, tz);
  return hw ?? tz;
}

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

function buildDiagnostics(gpu, mem, cpuTemp, inDocker) {
  const tips = [];
  if (inDocker) {
    tips.push(
      'Process is in a container: /sys thermal paths and memory often reflect the container cgroup, not always the full host.',
    );
  }
  if (cpuTemp == null) {
    tips.push(
      'No CPU/GPU temp from /sys: VM or minimal images may hide hwmon/thermal. Host install usually exposes /sys/class/hwmon.',
    );
  }
  if (!mem) {
    tips.push('Could not read /proc/meminfo (very restricted environment).');
  }
  return {
    inDocker,
    hasNvidia: Boolean(gpu),
    hasCpuTemp: cpuTemp != null,
    hasMeminfo: Boolean(mem),
    tips,
  };
}

router.get('/', async (_req, res) => {
  const inDocker = existsSync('/.dockerenv') || process.env.container === 'docker';

  const [gpu, mem, cpuTempRaw] = await Promise.all([readNvidiaGpu(), readMemory(), readCpuSideTempC()]);

  let temperatureC = null;
  let temperatureSource = null;
  if (gpu?.temperatureC != null) {
    temperatureC = gpu.temperatureC;
    temperatureSource = 'gpu';
  } else if (cpuTempRaw != null) {
    temperatureC = cpuTempRaw;
    temperatureSource = 'cpu';
  }

  const tempPercent =
    temperatureC != null ? Math.min(100, Math.max(0, (temperatureC / 92) * 100)) : null;

  const { nvidiaSmiPath, ...gpuPublic } = gpu || {};
  const diagnostics = {
    ...buildDiagnostics(gpu, mem, cpuTempRaw, inDocker),
    nvidiaSmiFound: Boolean(gpu),
    nvidiaSmiPath: nvidiaSmiPath || null,
  };

  res.json({
    temperatureC,
    temperatureSource,
    temperaturePercent: tempPercent,
    gpu: gpu ? gpuPublic : null,
    memory: mem,
    diagnostics,
  });
});

export default router;
