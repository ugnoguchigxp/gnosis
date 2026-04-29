CREATE TABLE "knowflow_keyword_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"topic" text NOT NULL,
	"category" text NOT NULL,
	"why_research" text NOT NULL,
	"search_score" real NOT NULL,
	"term_difficulty_score" real NOT NULL,
	"uncertainty_score" real NOT NULL,
	"threshold" real DEFAULT 6.5 NOT NULL,
	"decision" text NOT NULL,
	"enqueued_task_id" uuid,
	"model_alias" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowflow_keyword_eval_run_source_topic_unique" UNIQUE("run_id","source_type","source_id","topic"),
	CONSTRAINT "knowflow_keyword_eval_source_type_check" CHECK ("knowflow_keyword_evaluations"."source_type" IN ('experience')),
	CONSTRAINT "knowflow_keyword_eval_decision_check" CHECK ("knowflow_keyword_evaluations"."decision" IN ('enqueued', 'skipped')),
	CONSTRAINT "knowflow_keyword_eval_model_alias_check" CHECK ("knowflow_keyword_evaluations"."model_alias" IN ('bonsai', 'gemma4', 'bedrock', 'openai')),
	CONSTRAINT "knowflow_keyword_eval_search_score_check" CHECK ("knowflow_keyword_evaluations"."search_score" >= 0 AND "knowflow_keyword_evaluations"."search_score" <= 10),
	CONSTRAINT "knowflow_keyword_eval_term_difficulty_score_check" CHECK ("knowflow_keyword_evaluations"."term_difficulty_score" >= 0 AND "knowflow_keyword_evaluations"."term_difficulty_score" <= 10),
	CONSTRAINT "knowflow_keyword_eval_uncertainty_score_check" CHECK ("knowflow_keyword_evaluations"."uncertainty_score" >= 0 AND "knowflow_keyword_evaluations"."uncertainty_score" <= 10)
);
--> statement-breakpoint
ALTER TABLE "knowflow_keyword_evaluations" ADD CONSTRAINT "knowflow_keyword_evaluations_enqueued_task_id_topic_tasks_id_fk" FOREIGN KEY ("enqueued_task_id") REFERENCES "public"."topic_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowflow_keyword_eval_run_decision_created_idx" ON "knowflow_keyword_evaluations" USING btree ("run_id","decision","created_at");--> statement-breakpoint
CREATE INDEX "knowflow_keyword_eval_source_created_idx" ON "knowflow_keyword_evaluations" USING btree ("source_type","source_id","created_at");--> statement-breakpoint
CREATE INDEX "knowflow_keyword_eval_topic_created_idx" ON "knowflow_keyword_evaluations" USING btree ("topic","created_at");--> statement-breakpoint
CREATE INDEX "knowflow_keyword_eval_enqueued_task_idx" ON "knowflow_keyword_evaluations" USING btree ("enqueued_task_id") WHERE "knowflow_keyword_evaluations"."enqueued_task_id" IS NOT NULL;
