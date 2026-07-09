/**
 * Optional Supabase client for the web-catalog project (separate from climate-dash).
 * When URL/key are unset, callers use the local JSON store instead.
 */
import { createClient } from '@supabase/supabase-js';

let cached = null;

export function webCatalogConfigured(env = process.env) {
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
