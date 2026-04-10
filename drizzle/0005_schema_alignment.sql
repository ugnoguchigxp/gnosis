CREATE TABLE IF NOT EXISTS "communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities"
ADD COLUMN IF NOT EXISTS "community_id" uuid,
ADD COLUMN IF NOT EXISTS "reference_count" integer DEFAULT 0 NOT NULL,
ADD COLUMN IF NOT EXISTS "last_referenced_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "vibe_memories"
ADD COLUMN IF NOT EXISTS "reference_count" integer DEFAULT 0 NOT NULL,
ADD COLUMN IF NOT EXISTS "last_referenced_at" timestamp DEFAULT now() NOT NULL,
ADD COLUMN IF NOT EXISTS "is_synthesized" boolean DEFAULT false NOT NULL;
