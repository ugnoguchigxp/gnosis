-- 0011_table_efficiency.sql
-- Non-destructive performance tuning for frequently used query paths.

-- session-scoped raw memory scan
CREATE INDEX IF NOT EXISTS "vibe_memories_session_raw_pending_idx"
  ON "vibe_memories" ("session_id", "source_task", "created_at")
  WHERE "memory_type" = 'raw' AND "is_synthesized" = false;
--> statement-breakpoint

-- Graph and procedure traversals (outgoing/incoming relation lookups)
CREATE INDEX IF NOT EXISTS "relations_source_type_idx"
  ON "relations" ("source_id", "relation_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relations_target_type_idx"
  ON "relations" ("target_id", "relation_type");
--> statement-breakpoint

-- Worker startup stale-task recovery
CREATE INDEX IF NOT EXISTS "topic_tasks_running_updated_idx"
  ON "topic_tasks" ("updated_at")
  WHERE "status" = 'running';
--> statement-breakpoint

-- Guidance quality metrics query (guidance_ids @> ...)
CREATE INDEX IF NOT EXISTS "idx_review_outcomes_guidance_ids_gin"
  ON "review_outcomes" USING gin ("guidance_ids");
