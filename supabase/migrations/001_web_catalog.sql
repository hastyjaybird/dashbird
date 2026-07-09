-- Web Resource Catalog (Supabase project B — separate from climate-dash research)
-- Apply with: supabase db push (linked to the web-catalog project), or paste in SQL editor.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS web_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  canonical_host text,
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  kind_hints text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  icon_path text,
  logo_url text,
  snapshot_url text,
  proficient boolean NOT NULL DEFAULT false,
  watch_enabled boolean NOT NULL DEFAULT false,
  watch_mode text NOT NULL DEFAULT 'off'
    CHECK (watch_mode IN ('off', 'updown', 'change')),
  last_status text,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  content_fingerprint text,
  ingest_candidate boolean NOT NULL DEFAULT false,
  operating_systems text[] NOT NULL DEFAULT '{}',
  rating numeric,
  rating_source text,
  pricing jsonb NOT NULL DEFAULT '{}'::jsonb,
  features text[] NOT NULL DEFAULT '{}',
  pros text[] NOT NULL DEFAULT '{}',
  cons text[] NOT NULL DEFAULT '{}',
  legacy_tool_id text,
  added_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(summary, '')), 'B')
    || setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'A')
    || setweight(to_tsvector('english', coalesce(array_to_string(kind_hints, ' '), '')), 'C')
  ) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS web_resources_url_uidx ON web_resources (url);
CREATE INDEX IF NOT EXISTS web_resources_tags_gin ON web_resources USING gin (tags);
CREATE INDEX IF NOT EXISTS web_resources_kind_gin ON web_resources USING gin (kind_hints);
CREATE INDEX IF NOT EXISTS web_resources_search_idx ON web_resources USING gin (search_vector);
CREATE INDEX IF NOT EXISTS web_resources_proficient_idx ON web_resources (proficient) WHERE proficient = true;
CREATE INDEX IF NOT EXISTS web_resources_watch_idx ON web_resources (watch_enabled) WHERE watch_enabled = true;

CREATE TABLE IF NOT EXISTS project_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES web_resources (id) ON DELETE CASCADE,
  project text NOT NULL CHECK (project IN ('dashbird', 'portfolio', 'climate_bridge')),
  section text,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_id, project, section)
);

CREATE INDEX IF NOT EXISTS project_memberships_project_idx ON project_memberships (project);

CREATE TABLE IF NOT EXISTS review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_resource_id uuid REFERENCES web_resources (id) ON DELETE SET NULL,
  candidate_url text NOT NULL,
  candidate_title text NOT NULL DEFAULT '',
  candidate_summary text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS review_items_status_idx ON review_items (status);

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'alternatives'
    CHECK (kind IN ('alternatives', 'enrich', 'watch_check')),
  resource_id uuid REFERENCES web_resources (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'error')),
  error text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS discovery_jobs_status_idx ON discovery_jobs (status);

ALTER TABLE web_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_jobs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS. Anon: public read of proficient portfolio tools only.
CREATE POLICY web_resources_anon_read_proficient ON web_resources
  FOR SELECT TO anon
  USING (proficient = true);

CREATE POLICY project_memberships_anon_read_portfolio ON project_memberships
  FOR SELECT TO anon
  USING (project = 'portfolio');

-- Authenticated / service writes are done with service_role from dashbird server.
