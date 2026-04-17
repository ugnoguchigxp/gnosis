-- 0012_entities_fk_index.sql
-- Add missing FK-supporting index for entities.community_id.

CREATE INDEX IF NOT EXISTS "entities_community_id_idx"
  ON "entities" ("community_id");
