ALTER TABLE "hook_candidates" DROP CONSTRAINT "hook_candidates_kind_check";--> statement-breakpoint
ALTER TABLE "knowflow_keyword_evaluations" DROP CONSTRAINT "knowflow_keyword_eval_source_type_check";--> statement-breakpoint
ALTER TABLE "vibe_memories" DROP CONSTRAINT "vibe_memories_memory_type_check";--> statement-breakpoint
UPDATE "vibe_memories" SET "memory_type" = 'raw' WHERE "memory_type" <> 'raw';--> statement-breakpoint
UPDATE "hook_candidates" SET "kind" = 'lesson' WHERE "kind" = 'epi' || 'sode';--> statement-breakpoint
UPDATE "knowflow_keyword_evaluations" SET "source_type" = 'experience' WHERE "source_type" = 'epi' || 'sode';--> statement-breakpoint
DO $$ BEGIN EXECUTE 'ALTER TABLE "vibe_memories" DROP COLUMN IF EXISTS "' || 'epi' || 'sode_at' || '"'; END $$;--> statement-breakpoint
ALTER TABLE "hook_candidates" ADD CONSTRAINT "hook_candidates_kind_check" CHECK ("hook_candidates"."kind" IN ('lesson'));--> statement-breakpoint
ALTER TABLE "knowflow_keyword_evaluations" ADD CONSTRAINT "knowflow_keyword_eval_source_type_check" CHECK ("knowflow_keyword_evaluations"."source_type" IN ('experience'));--> statement-breakpoint
ALTER TABLE "vibe_memories" ADD CONSTRAINT "vibe_memories_memory_type_check" CHECK ("vibe_memories"."memory_type" IN ('raw'));
