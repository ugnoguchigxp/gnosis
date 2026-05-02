CREATE TABLE "session_distillations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_key" text NOT NULL,
	"transcript_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text NOT NULL,
	"model_provider" text,
	"model_name" text,
	"turn_count" integer NOT NULL,
	"message_count" integer NOT NULL,
	"kept_count" integer DEFAULT 0 NOT NULL,
	"dropped_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "session_distillations_session_hash_prompt_unique" UNIQUE("session_key","transcript_hash","prompt_version"),
	CONSTRAINT "session_distillations_status_check" CHECK ("session_distillations"."status" IN ('pending', 'running', 'succeeded', 'failed', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "session_knowledge_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"distillation_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"statement" text NOT NULL,
	"keep" boolean NOT NULL,
	"keep_reason" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"status" text NOT NULL,
	"promoted_note_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_knowledge_candidates_kind_check" CHECK ("session_knowledge_candidates"."kind" IN ('lesson', 'rule', 'procedure', 'candidate')),
	CONSTRAINT "session_knowledge_candidates_status_check" CHECK ("session_knowledge_candidates"."status" IN ('deterministic', 'llm_succeeded', 'llm_failed')),
	CONSTRAINT "session_knowledge_candidates_confidence_check" CHECK ("session_knowledge_candidates"."confidence" >= 0 AND "session_knowledge_candidates"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "session_knowledge_candidates" ADD CONSTRAINT "session_knowledge_candidates_distillation_id_session_distillations_id_fk" FOREIGN KEY ("distillation_id") REFERENCES "public"."session_distillations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_distillations_session_created_at_idx" ON "session_distillations" USING btree ("session_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "session_distillations_status_created_at_idx" ON "session_distillations" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "session_knowledge_candidates_distillation_turn_idx" ON "session_knowledge_candidates" USING btree ("distillation_id","turn_index");--> statement-breakpoint
CREATE INDEX "session_knowledge_candidates_kind_keep_idx" ON "session_knowledge_candidates" USING btree ("kind","keep");--> statement-breakpoint
CREATE INDEX "session_knowledge_candidates_promoted_note_id_idx" ON "session_knowledge_candidates" USING btree ("promoted_note_id");