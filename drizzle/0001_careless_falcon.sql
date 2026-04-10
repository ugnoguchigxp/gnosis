CREATE INDEX IF NOT EXISTS "vibe_memories_session_created_at_idx" ON "vibe_memories" USING btree ("session_id","created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relations" ADD CONSTRAINT "relations_source_target_type_unique" UNIQUE("source_id","target_id","relation_type");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
