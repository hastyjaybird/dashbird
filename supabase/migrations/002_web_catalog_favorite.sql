-- Favorites flag for dashbird Tool Library / catalog filtering
ALTER TABLE web_resources
  ADD COLUMN IF NOT EXISTS favorite boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS web_resources_favorite_idx
  ON web_resources (favorite)
  WHERE favorite = true;
