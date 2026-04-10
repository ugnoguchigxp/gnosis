CREATE TABLE IF NOT EXISTS "experience_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"scenario_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"type" text NOT NULL,
	"failure_type" text,
	"content" text NOT NULL,
	"embedding" vector(384),
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_logs_session_scenario_idx"
	ON "experience_logs" USING btree ("session_id", "scenario_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_logs_embedding_hnsw_idx"
	ON "experience_logs" USING hnsw ("embedding" vector_cosine_ops);
