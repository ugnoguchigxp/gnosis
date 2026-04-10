ALTER TABLE "vibe_memories"
ADD COLUMN IF NOT EXISTS "dedupe_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vibe_memories_session_dedupe_key_unique"
ON "vibe_memories" ("session_id", "dedupe_key");
