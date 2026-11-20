CREATE TABLE "work_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"progress" text DEFAULT '' NOT NULL,
	"progress_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "work_sessions_status" CHECK ("work_sessions"."status" in ('active', 'completed', 'released', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "needs_input" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_work_session_per_issue" ON "work_sessions" USING btree ("issue_id") WHERE "work_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "work_sessions_agent_created" ON "work_sessions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "work_sessions_run_created" ON "work_sessions" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "work_sessions_issue_created" ON "work_sessions" USING btree ("issue_id","created_at");