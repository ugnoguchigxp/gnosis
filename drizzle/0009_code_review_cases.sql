CREATE TABLE IF NOT EXISTS "review_cases" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "repo_path" text NOT NULL,
  "base_ref" text,
  "head_ref" text,
  "task_goal" text,
  "trigger" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "risk_level" text,
  "review_status" text,
  "summary" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_review_cases_task" ON "review_cases" ("task_id");
CREATE INDEX IF NOT EXISTS "idx_review_cases_status" ON "review_cases" ("status");
CREATE INDEX IF NOT EXISTS "idx_review_cases_repo" ON "review_cases" ("repo_path", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "review_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_case_id" text NOT NULL REFERENCES "review_cases" ("id") ON DELETE CASCADE,
  "finding_id" text NOT NULL,
  "outcome_type" text NOT NULL,
  "followup_commit_hash" text,
  "resolution_timestamp" timestamptz,
  "guidance_ids" jsonb DEFAULT '[]'::jsonb,
  "false_positive" boolean DEFAULT false,
  "notes" text,
  "auto_detected" boolean DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz,
  CONSTRAINT "review_outcomes_case_finding_unique" UNIQUE ("review_case_id", "finding_id")
);

CREATE INDEX IF NOT EXISTS "idx_review_outcomes_case" ON "review_outcomes" ("review_case_id");
CREATE INDEX IF NOT EXISTS "idx_review_outcomes_outcome" ON "review_outcomes" ("outcome_type");
CREATE INDEX IF NOT EXISTS "idx_review_outcomes_fp" ON "review_outcomes" ("false_positive") WHERE "false_positive" = true;
