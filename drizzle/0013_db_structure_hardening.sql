-- 0013_db_structure_hardening.sql
-- Enforce domain-like constraints and add hot-path indexes.

UPDATE "vibe_memories"
SET "memory_type" = 'raw'
WHERE "memory_type" IS NULL OR "memory_type" NOT IN ('raw');
--> statement-breakpoint

ALTER TABLE "vibe_memories"
  ALTER COLUMN "memory_type" SET DEFAULT 'raw',
  ALTER COLUMN "memory_type" SET NOT NULL;
ALTER TABLE "vibe_memories"
  DROP CONSTRAINT IF EXISTS "vibe_memories_memory_type_check";
ALTER TABLE "vibe_memories"
  ADD CONSTRAINT "vibe_memories_memory_type_check"
  CHECK ("memory_type" IN ('raw'));
--> statement-breakpoint

UPDATE "review_cases"
SET "status" = CASE
  WHEN "completed_at" IS NOT NULL THEN 'completed'
  ELSE 'running'
END
WHERE "status" IS NULL OR "status" NOT IN ('running', 'completed');
ALTER TABLE "review_cases"
  ALTER COLUMN "status" SET DEFAULT 'running';
ALTER TABLE "review_cases"
  DROP CONSTRAINT IF EXISTS "review_cases_status_check";
ALTER TABLE "review_cases"
  ADD CONSTRAINT "review_cases_status_check"
  CHECK ("status" IN ('running', 'completed'));
--> statement-breakpoint

UPDATE "review_outcomes"
SET "outcome_type" = 'pending'
WHERE "outcome_type" IS NULL
   OR "outcome_type" NOT IN ('pending', 'adopted', 'ignored', 'dismissed', 'resolved');
ALTER TABLE "review_outcomes"
  DROP CONSTRAINT IF EXISTS "review_outcomes_outcome_type_check";
ALTER TABLE "review_outcomes"
  ADD CONSTRAINT "review_outcomes_outcome_type_check"
  CHECK ("outcome_type" IN ('pending', 'adopted', 'ignored', 'dismissed', 'resolved'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "topic_tasks_pending_priority_created_idx"
  ON "topic_tasks" ("priority" DESC, "created_at" ASC)
  WHERE "status" = 'pending';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "topic_tasks_deferred_next_run_priority_created_idx"
  ON "topic_tasks" ("next_run_at" ASC, "priority" DESC, "created_at" ASC)
  WHERE "status" = 'deferred' AND "next_run_at" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "vibe_memories_metadata_gin_idx"
  ON "vibe_memories" USING gin ("metadata");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "vibe_memories_metadata_kind_idx"
  ON "vibe_memories" (("metadata"->>'kind'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "vibe_memories_guidance_session_created_idx"
  ON "vibe_memories" ("session_id", "created_at" DESC)
  WHERE "metadata" @> '{"kind":"guidance"}'::jsonb;
