ALTER TABLE "sync_state"
ADD COLUMN IF NOT EXISTS "cursor" jsonb DEFAULT '{}'::jsonb NOT NULL;
