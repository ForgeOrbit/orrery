CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"question" text NOT NULL,
	"proposed_fallback" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"response_deadline_at" timestamp with time zone NOT NULL,
	"answer" text,
	"answered_by_human_id" text,
	"answered_at" timestamp with time zone,
	"follow_up" text,
	"follow_up_by_human_id" text,
	"follow_up_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_status" CHECK ("questions"."status" in ('open', 'answered', 'paused', 'fallback_used')),
	CONSTRAINT "questions_deadline_after_creation" CHECK ("questions"."response_deadline_at" > "questions"."created_at"),
	CONSTRAINT "questions_resolution_matches_status" CHECK ((
        ("questions"."status" = 'open' and "questions"."answer" is null and "questions"."answered_by_human_id" is null
          and "questions"."answered_at" is null and "questions"."resolved_at" is null
          and "questions"."follow_up" is null and "questions"."follow_up_by_human_id" is null and "questions"."follow_up_at" is null)
        or ("questions"."status" = 'answered' and "questions"."answer" is not null and "questions"."answered_by_human_id" is not null
          and "questions"."answered_at" is not null and "questions"."resolved_at" is not null
          and "questions"."follow_up" is null and "questions"."follow_up_by_human_id" is null and "questions"."follow_up_at" is null)
        or ("questions"."status" in ('paused', 'fallback_used') and "questions"."answer" is null
          and "questions"."answered_by_human_id" is null and "questions"."answered_at" is null and "questions"."resolved_at" is not null
          and (("questions"."follow_up" is null and "questions"."follow_up_by_human_id" is null and "questions"."follow_up_at" is null)
            or ("questions"."follow_up" is not null and "questions"."follow_up_by_human_id" is not null and "questions"."follow_up_at" is not null)))
      ))
);
--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_session_id_work_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."work_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answered_by_human_id_humans_id_fk" FOREIGN KEY ("answered_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_follow_up_by_human_id_humans_id_fk" FOREIGN KEY ("follow_up_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_question_per_issue" ON "questions" USING btree ("issue_id") WHERE "questions"."status" in ('open', 'paused');--> statement-breakpoint
CREATE INDEX "questions_issue_created" ON "questions" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "questions_workspace_created" ON "questions" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));