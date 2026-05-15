import { Router } from 'express';
import { execFile } from 'node:child_process';
import net from 'node:net';

const router = Router();

function execText(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout || '').trim());
    });
  });
}

function parsePingMs(stdout) {
  const m = stdout.match(/time[=<]([\d.]+)\s*ms/i);
  if (m) {
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

async function icmpPingMs(host) {
  const out = await execText('ping', ['-c', '1', '-W', '2', host], 3500);
  if (!out) return null;
  return parsePingMs(out);
}

function tcpConnectMs(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port }, () => {
      const ms = Date.now() - t0;
      sock.destroy();
      resolve(ms);
    });
    sock.on('error', () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(null);
    });
    sock.setTimeout(timeoutMs, () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(null);
    });
  });
}

async function measureDownloadMbps() {
  const bytes = Math.min(
    Math.max(50_000, parseInt(process.env.NET_HEALTH_DOWN_BYTES || '180000', 10)),
    500_000,
  );
  const url = `https://speed.cloudflare.com/__down?bytes=${bytes}`;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const size = buf.byteLength;
    if (size < 2000) return null;
    const sec = Math.max((Date.now() - t0) / 1000, 0.001);
    const mbps = (size * 8) / (sec * 1_000_000);
    return Math.round(mbps * 10) / 10;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function measureUploadMbps() {
  const len = Math.min(
    Math.max(8192, parseInt(process.env.NET_HEALTH_UP_BYTES || '98304', 10)),
    256_000,
  );
  const buf = Buffer.alloc(len, 0x41);
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch('https://speed.cloudflare.com/__up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
      signal: ac.signal,
      redirect: 'follow',
    });
    await r.arrayBuffer();
    const sec = Math.max((Date.now() - t0) / 1000, 0.001);
    const mbps = (len * 8) / (sec * 1_000_000);
    return Math.round(mbps * 10) / 10;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

router.get('/', async (_req, res) => {
  const pingHost = (process.env.NET_HEALTH_PING_HOST || '1.1.1.1').trim() || '1.1.1.1';
  const tcpHost = (process.env.NET_HEALTH_TCP_HOST || pingHost).trim() || pingHost;
  const tcpPort = parseInt(process.env.NET_HEALTH_TCP_PORT || '443', 10) || 443;

  const hints = [];

  let pingMs = await icmpPingMs(pingHost);
  let pingMethod = pingMs != null ? 'icmp' : null;
  if (pingMs == null) {
    pingMs = await tcpConnectMs(tcpHost, tcpPort);
    pingMethod = pingMs != null ? 'tcp' : null;
    if (pingMs == null) {
      hints.push('ICMP ping failed (common in Docker without CAP_NET_RAW). TCP connect fallback failed too.');
    } else {
      hints.push(`Latency is TCP connect time to ${tcpHost}:${tcpPort}, not ICMP RTT.`);
    }
  }

  const [downloadMbps, uploadMbps] = await Promise.all([measureDownloadMbps(), measureUploadMbps()]);
  if (downloadMbps == null) hints.push('Download probe failed (firewall, DNS, or no outbound HTTPS).');
  if (uploadMbps == null) hints.push('Upload probe failed (same causes, or Cloudflare blocked).');

  res.json({
    pingHost,
    tcpPort,
    pingMs,
    pingMethod,
    downloadMbps,
    uploadMbps,
    hints,
  });
});

export default router;
