CREATE INDEX IF NOT EXISTS "knowledge_claims_text_fts_idx"
	ON "knowledge_claims" USING gin (to_tsvector('simple', "text"));
