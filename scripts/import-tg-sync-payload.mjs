#!/usr/bin/env node
/**
 * One-shot: import contacts/events from data/tg-sync-payload.json (cloud → LAN).
 * Usage: node scripts/import-tg-sync-payload.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addContact, getContactById } from '../src/lib/network-contacts-store.js';
import { upsertEventsFinderEvents, getEventsFinderEventById } from '../src/lib/events-finder-store.js';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const payloadPath = path.join(root, 'data', 'tg-sync-payload.json');

const raw = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const contacts = Array.isArray(raw.contacts) ? raw.contacts : [];
const events = Array.isArray(raw.events) ? raw.events : [];

const results = { contacts: [], events: [] };

for (const row of contacts) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const id = String(row.id || payload?.id || '').trim();
  const existing = id ? await getContactById(id) : null;
  if (existing?.id) {
    results.contacts.push({ id: existing.id, displayName: existing.displayName, action: 'exists' });
    continue;
  }
  const saved = await addContact(
    {
      ...payload,
      id,
      displayName: row.display_name || payload.displayName,
      org: row.org || payload.org || '',
      createdAt: row.created_at || payload.createdAt,
      source: payload.source || 'telegram',
    },
    process.env,
  );
  const verified = await getContactById(saved.id);
  results.contacts.push({
    id: verified?.id || saved.id,
    displayName: verified?.displayName || saved.displayName,
    action: String(verified?.id) === id ? 'imported' : 'merged',
  });
}

for (const row of events) {
  let payload = {};
  try {
    payload = JSON.parse(String(row.payload_json || '{}'));
  } catch {
    payload = {};
  }
  const event = {
    ...payload,
    id: row.id,
    source: row.source || payload.source || 'telegram',
    title: row.title || payload.title,
    start: row.start_at || payload.start || null,
    end: row.end_at || payload.end || null,
    venue: row.venue ?? payload.venue ?? null,
    city: row.city ?? payload.city ?? null,
    lat: row.lat ?? payload.lat ?? null,
    lon: row.lon ?? payload.lon ?? null,
    url: row.url || payload.url || '',
    online: Number(row.online) === 1 || Boolean(payload.online),
    description: row.description ?? payload.description ?? null,
    imageUrl: row.image_url || payload.imageUrl || null,
  };
  upsertEventsFinderEvents([event]);
  const verified = getEventsFinderEventById(event.id);
  results.events.push({
    id: event.id,
    title: verified?.title || event.title,
    action: verified?.id ? 'upserted' : 'missing',
  });
}

console.log(JSON.stringify(results, null, 2));
