CREATE TABLE "failure_firewall_golden_paths" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"path_type" text NOT NULL,
	"applies_when" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"block_when_missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severity_when_missing" text DEFAULT 'warning' NOT NULL,
	"risk_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frameworks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_entity_id" text,
	"source_experience_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "failure_firewall_golden_paths_status_check" CHECK ("failure_firewall_golden_paths"."status" IN ('active', 'needs_review', 'deprecated')),
	CONSTRAINT "failure_firewall_golden_paths_severity_check" CHECK ("failure_firewall_golden_paths"."severity_when_missing" IN ('error', 'warning', 'info'))
);
--> statement-breakpoint
CREATE TABLE "failure_firewall_patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"pattern_type" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"risk_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frameworks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"match_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"golden_path_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"false_positive_count" integer DEFAULT 0 NOT NULL,
	"source_entity_id" text,
	"source_experience_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "failure_firewall_patterns_status_check" CHECK ("failure_firewall_patterns"."status" IN ('active', 'needs_review', 'deprecated')),
	CONSTRAINT "failure_firewall_patterns_severity_check" CHECK ("failure_firewall_patterns"."severity" IN ('error', 'warning', 'info')),
	CONSTRAINT "failure_firewall_patterns_false_positive_count_check" CHECK ("failure_firewall_patterns"."false_positive_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "failure_firewall_golden_paths_status_idx" ON "failure_firewall_golden_paths" USING btree ("status");--> statement-breakpoint
CREATE INDEX "failure_firewall_golden_paths_path_type_idx" ON "failure_firewall_golden_paths" USING btree ("path_type");--> statement-breakpoint
CREATE INDEX "failure_firewall_golden_paths_risk_signals_gin_idx" ON "failure_firewall_golden_paths" USING gin ("risk_signals");--> statement-breakpoint
CREATE INDEX "failure_firewall_patterns_status_idx" ON "failure_firewall_patterns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "failure_firewall_patterns_pattern_type_idx" ON "failure_firewall_patterns" USING btree ("pattern_type");--> statement-breakpoint
CREATE INDEX "failure_firewall_patterns_golden_path_idx" ON "failure_firewall_patterns" USING btree ("golden_path_id");--> statement-breakpoint
CREATE INDEX "failure_firewall_patterns_risk_signals_gin_idx" ON "failure_firewall_patterns" USING gin ("risk_signals");