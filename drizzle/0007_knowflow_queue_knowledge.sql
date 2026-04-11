CREATE TABLE IF NOT EXISTS "topic_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL CHECK ("status" IN ('pending', 'running', 'done', 'failed', 'deferred')),
	"priority" integer NOT NULL,
	"next_run_at" bigint,
	"locked_at" bigint,
	"lock_owner" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "topic_tasks_active_dedupe_idx"
	ON "topic_tasks" USING btree ("dedupe_key")
	WHERE "status" IN ('pending', 'running', 'deferred');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_tasks_status_next_run_priority_idx"
	ON "topic_tasks" USING btree ("status", "next_run_at", "priority", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_tasks_dedupe_key_idx"
	ON "topic_tasks" USING btree ("dedupe_key");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_topic" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"coverage" real DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_topics_canonical_topic_unique" UNIQUE("canonical_topic")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_topics_updated_idx"
	ON "knowledge_topics" USING btree ("updated_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"text" text NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" jsonb,
	"fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_claims_topic_fingerprint_unique" UNIQUE("topic_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "knowledge_claims" ADD COLUMN IF NOT EXISTS "embedding" jsonb;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_claims" ADD CONSTRAINT "knowledge_claims_topic_id_knowledge_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."knowledge_topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_claims_topic_idx"
	ON "knowledge_claims" USING btree ("topic_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"target_topic" text NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_relations_topic_fingerprint_unique" UNIQUE("topic_id","fingerprint")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_topic_id_knowledge_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."knowledge_topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_relations_topic_idx"
	ON "knowledge_relations" USING btree ("topic_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"domain" text,
	"fetched_at" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_sources_topic_source_unique" UNIQUE("topic_id","source_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_topic_id_knowledge_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."knowledge_topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_topic_idx"
	ON "knowledge_sources" USING btree ("topic_id");
