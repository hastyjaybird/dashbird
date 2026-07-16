/**
 * Smoke: parse QR payloads + decode a generated QR image (when jsqr+sharp available).
 * Usage: node scripts/smoke-qr-decode.mjs
 */
import { createRequire } from 'node:module';
import {
  applyQrFactsToContactPatch,
  parseQrContactPayload,
} from '../src/lib/network-qr-decode.js';

const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  const p = parseQrContactPayload('https://acme.example/team/jane');
  assert(p.urls[0] === 'https://acme.example/team/jane', 'plain url');
  assert(!p.linkedin, 'not linkedin');
}

{
  const p = parseQrContactPayload('https://www.linkedin.com/in/jane-doe');
  assert(p.linkedin?.includes('linkedin.com/in/jane-doe'), 'linkedin url');
  assert(p.urls.length === 0, 'linkedin not in urls');
}

{
  const p = parseQrContactPayload(`BEGIN:VCARD
VERSION:3.0
FN:Jane Doe
URL:https://jane.example
EMAIL:jane@example.com
TEL:+1-555-0100
END:VCARD`);
  assert(p.urls.includes('https://jane.example/'), 'vcard url');
  assert(p.emails.includes('jane@example.com'), 'vcard email');
  assert(p.phones.some((x) => x.includes('555')), 'vcard phone');
}

{
  const p = parseQrContactPayload('MECARD:N:Doe,Jane;TEL:+15550100;EMAIL:j@ex.com;URL:https://ex.com;;');
  assert(p.urls[0]?.startsWith('https://ex.com'), 'mecard url');
  assert(p.emails.includes('j@ex.com'), 'mecard email');
}

{
  const patch = { enrichment: { sources: [] } };
  const contact = { channels: { urls: [] } };
  applyQrFactsToContactPatch(contact, patch, {
    urls: ['https://acme.example'],
    linkedin: 'https://www.linkedin.com/in/jane-doe',
    emails: ['jane@example.com'],
    phones: [],
  });
  assert(patch.channels.urls.includes('https://acme.example'), 'patch urls');
  assert(patch.channels.linkedin.includes('linkedin.com/in/jane-doe'), 'patch linkedin');
  assert(patch.channels.email === 'jane@example.com', 'patch email');
}

let decodedOk = false;
try {
  // Optional: generate a QR PNG with a tiny inline encoder only if deps exist.
  const jsQR = require('jsqr');
  const sharp = require('sharp');
  // Minimal 1-module test: paint a known-good QR via online-less approach —
  // if qrcode package missing, skip image roundtrip (parse tests above still run).
  void jsQR;
  void sharp;
  const { decodeContactQrFromImage } = await import('../src/lib/network-qr-decode.js');

  // Build a QR using a tiny pure dependency-free pattern? Prefer optional `qrcode`.
  let qrcode;
  try {
    qrcode = require('qrcode');
  } catch {
    qrcode = null;
  }
  if (qrcode) {
    const png = await qrcode.toBuffer('https://smoke.example/qr-card', {
      type: 'png',
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    const got = await decodeContactQrFromImage(png);
    assert(got.urls.some((u) => u.includes('smoke.example/qr-card')), `decode got ${JSON.stringify(got)}`);
    decodedOk = true;
  } else {
    console.log('skip image roundtrip (qrcode package not installed)');
  }
} catch (e) {
  if (String(e?.message || e).includes('Cannot find module')) {
    console.log('skip image roundtrip (jsqr/sharp not in host node_modules)');
  } else {
    throw e;
  }
}

console.log('smoke-qr-decode: ok', decodedOk ? '(with image decode)' : '(parse only)');
