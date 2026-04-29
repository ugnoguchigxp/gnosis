-- 0010_memory_refactoring.sql
ALTER TABLE vibe_memories
  ADD COLUMN IF NOT EXISTS memory_type text DEFAULT 'raw',
  ADD COLUMN IF NOT EXISTS source_task text,
  ADD COLUMN IF NOT EXISTS importance real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS compressed boolean DEFAULT false;

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS confidence real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS provenance text,
  ADD COLUMN IF NOT EXISTS freshness timestamp,
  ADD COLUMN IF NOT EXISTS scope text;

ALTER TABLE relations
  ADD COLUMN IF NOT EXISTS confidence real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS recorded_at timestamp DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source_task text,
  ADD COLUMN IF NOT EXISTS provenance text;

-- クエリで頻用されるカラムにインデックスを追加
CREATE INDEX IF NOT EXISTS vibe_memories_memory_type_idx
  ON vibe_memories (memory_type);
CREATE INDEX IF NOT EXISTS entities_scope_idx
  ON entities (scope) WHERE scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_type_confidence_idx
  ON entities (type, confidence);
