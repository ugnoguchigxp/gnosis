CREATE TABLE IF NOT EXISTS "sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_synced_at" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_state"
ADD COLUMN IF NOT EXISTS "cursor" jsonb DEFAULT '{}'::jsonb NOT NULL;
