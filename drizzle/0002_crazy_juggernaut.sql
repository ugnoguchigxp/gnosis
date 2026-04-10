ALTER TABLE "relations"
ALTER COLUMN "weight"
SET DATA TYPE real
USING CASE
	WHEN "weight" IS NULL THEN NULL
	WHEN trim(("weight")::text) ~ '^[+-]?([0-9]*[.])?[0-9]+$' THEN trim(("weight")::text)::real
	ELSE NULL
END;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "embedding" vector(384);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_embedding_hnsw_idx" ON "entities" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vibe_memories_embedding_hnsw_idx" ON "vibe_memories" USING hnsw ("embedding" vector_cosine_ops);
