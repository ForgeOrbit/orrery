CREATE TABLE "work_session_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"work_session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_session_activities_kind" CHECK ("work_session_activities"."kind" in ('thought', 'action', 'status'))
);
--> statement-breakpoint
ALTER TABLE "work_session_activities" ADD CONSTRAINT "work_session_activities_work_session_id_work_sessions_id_fk" FOREIGN KEY ("work_session_id") REFERENCES "public"."work_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_activities" ADD CONSTRAINT "work_session_activities_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_session_activities_session_created" ON "work_session_activities" USING btree ("work_session_id","created_at");