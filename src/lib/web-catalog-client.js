/**
 * Optional Supabase client for the web-catalog project (separate from climate-dash).
 * When URL/key are unset, callers use the local JSON store instead.
 */
import { createClient } from '@supabase/supabase-js';

let cached = null;
/** Sticky: once schema is missing, stay on local JSON for this process. */
let forceLocalFallback = false;

/**
 * True when PostgREST/Supabase reports catalog tables are not in the schema cache.
 * @param {unknown} error
 */
export function isMissingCatalogSchemaError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    msg.includes('schema cache') ||
    msg.includes('could not find the table') ||
    (msg.includes('relation') && msg.includes('does not exist') && msg.includes('web_'))
  );
}

/**
 * Prefer local JSON for the rest of this process (e.g. migrations not applied).
 * @param {string} [reason]
 */
export function forceWebCatalogLocal(reason) {
  if (forceLocalFallback) return;
  forceLocalFallback = true;
  console.warn(
    '[web-catalog] Supabase catalog unavailable; using local JSON store.',
    reason ? String(reason) : '',
  );
}

export function webCatalogConfigured(env = process.env) {
  if (forceLocalFallback) return false;
  const url = String(env.WEB_CATALOG_SUPABASE_URL || '').trim();
  const key = String(
    env.WEB_CATALOG_SUPABASE_SERVICE_ROLE_KEY || env.WEB_CATALOG_SUPABASE_ANON_KEY || '',
  ).trim();
  return Boolean(url && key);
}

/**
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
export function getWebCatalogClient(env = process.env) {
  if (!webCatalogConfigured(env)) return null;
  if (cached) return cached;
  const url = String(env.WEB_CATALOG_SUPABASE_URL || '').trim();
  const key = String(
    env.WEB_CATALOG_SUPABASE_SERVICE_ROLE_KEY || env.WEB_CATALOG_SUPABASE_ANON_KEY || '',
  ).trim();
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
