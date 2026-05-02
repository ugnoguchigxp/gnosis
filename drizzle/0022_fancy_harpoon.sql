ALTER TABLE "session_knowledge_candidates" ADD COLUMN "approval_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_knowledge_candidates" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "session_knowledge_candidates" ADD COLUMN "record_error" text;--> statement-breakpoint
ALTER TABLE "session_knowledge_candidates" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_knowledge_candidates" ADD COLUMN "rejected_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_knowledge_candidates" ADD CONSTRAINT "session_knowledge_candidates_approval_status_check" CHECK ("session_knowledge_candidates"."approval_status" IN ('pending', 'approved', 'rejected'));