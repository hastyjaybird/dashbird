#!/usr/bin/env node
/**
 * Regression: Facebook-style Telegram profile screenshots must crop to the
 * centered icon bubble (not the chrome card). Uses known intake fixtures.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  detectProfileAvatarCrop,
  looksLikeSocialProfileScreenshot,
  resolveAvatarCrop,
  avatarLooksLikeProfileChrome,
} from '../src/lib/network-avatar-crop.js';
import { cropImageRegion } from '../src/lib/telegram-message-classify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = path.join(root, 'data', 'telegram-intake-media');

/** @type {{ name: string, file: string }[]} */
const fixtures = [
  { name: 'drea', file: 'u176263585_photo.jpg' },
  { name: 'reese', file: 'u176263581_photo.jpg' },
  { name: 'natasha', file: 'u176263583_photo.jpg' },
];

let failed = 0;

for (const fx of fixtures) {
  const buf = readFileSync(path.join(media, fx.file));
  const meta = await sharp(buf, { failOn: 'none' }).rotate().metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;

  const looks = await looksLikeSocialProfileScreenshot(buf);
  const resolved = await resolveAvatarCrop(buf, { kind: 'social_screenshot' });
  const detected = await detectProfileAvatarCrop(buf, { kind: 'social_screenshot' });

  if (!looks) {
    console.error(`FAIL ${fx.name}: expected looksLikeSocialProfileScreenshot`);
    failed += 1;
    continue;
  }
  if (!resolved.crop || !detected.ok) {
    console.error(`FAIL ${fx.name}: no crop`, resolved, detected);
    failed += 1;
    continue;
  }

  const cx = (resolved.crop.x + resolved.crop.w / 2) * W;
  const cy = (resolved.crop.y + resolved.crop.h / 2) * H;
  const side = resolved.crop.w * W;
  const offX = Math.abs(cx - W / 2);
  const aspect = resolved.crop.h / resolved.crop.w;
  // Normalized h/w should make a near-square in pixels: (h*H)/(w*W) ≈ 1
  const pixelAspect = (resolved.crop.h * H) / (resolved.crop.w * W);

  const cropped = await cropImageRegion(buf, resolved.crop);
  if (!cropped) {
    console.error(`FAIL ${fx.name}: cropImageRegion empty`);
    failed += 1;
    continue;
  }
  const chrome = await avatarLooksLikeProfileChrome(cropped);

  const okOff = offX <= W * 0.05;
  const okSquare = Math.abs(pixelAspect - 1) < 0.08;
  const okSize = side >= W * 0.2 && side <= W * 0.45;
  const okChrome = chrome === false;

  if (!okOff || !okSquare || !okSize || !okChrome) {
    console.error(`FAIL ${fx.name}`, {
      offX: +offX.toFixed(1),
      side: +side.toFixed(1),
      pixelAspect: +pixelAspect.toFixed(3),
      aspectNorm: +aspect.toFixed(3),
      chrome,
      source: resolved.source,
      cy: +cy.toFixed(1),
    });
    failed += 1;
    continue;
  }

  console.log(`ok ${fx.name}`, {
    source: resolved.source,
    offX: +offX.toFixed(1),
    side: +side.toFixed(1),
    cy: +cy.toFixed(1),
  });
}

if (failed) {
  console.error(`avatar-crop smoke: ${failed} failed`);
  process.exit(1);
}
console.log('avatar-crop smoke: all passed');
