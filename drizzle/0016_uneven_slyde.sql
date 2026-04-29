CREATE TABLE "hook_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"trace_id" text NOT NULL,
	"source_event" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"severity" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hook_candidates_kind_check" CHECK ("hook_candidates"."kind" IN ('lesson')),
	CONSTRAINT "hook_candidates_status_check" CHECK ("hook_candidates"."status" IN ('pending', 'scored', 'deduplicated', 'promoted', 'rejected')),
	CONSTRAINT "hook_candidates_severity_check" CHECK ("hook_candidates"."severity" IS NULL OR "hook_candidates"."severity" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "hook_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hook_executions_event_rule_unique" UNIQUE("event_id","rule_id"),
	CONSTRAINT "hook_executions_status_check" CHECK ("hook_executions"."status" IN ('started', 'succeeded', 'failed', 'blocked', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hook_candidates_active_dedupe_unique" ON "hook_candidates" USING btree ("kind","dedupe_key") WHERE "hook_candidates"."status" IN ('pending', 'scored', 'deduplicated');--> statement-breakpoint
CREATE INDEX "hook_candidates_trace_status_idx" ON "hook_candidates" USING btree ("trace_id","status");--> statement-breakpoint
CREATE INDEX "hook_candidates_source_event_idx" ON "hook_candidates" USING btree ("source_event");--> statement-breakpoint
CREATE INDEX "hook_executions_trace_status_idx" ON "hook_executions" USING btree ("trace_id","status");--> statement-breakpoint
CREATE INDEX "hook_executions_created_at_idx" ON "hook_executions" USING btree ("created_at");
