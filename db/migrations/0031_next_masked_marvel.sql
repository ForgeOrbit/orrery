CREATE TABLE "issue_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"blocked_by_issue_id" text NOT NULL,
	"created_by_human_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_dependencies_no_self_link" CHECK ("issue_dependencies"."issue_id" <> "issue_dependencies"."blocked_by_issue_id"),
	CONSTRAINT "issue_dependencies_created_by_actor" CHECK (("issue_dependencies"."created_by_human_id" is not null) <> ("issue_dependencies"."created_by_agent_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "issue_links" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"created_by_human_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_links_created_by_actor" CHECK (("issue_links"."created_by_human_id" is not null) <> ("issue_links"."created_by_agent_id" is not null)),
	CONSTRAINT "issue_links_kind" CHECK ("issue_links"."kind" in ('pr', 'commit', 'doc', 'link')),
	CONSTRAINT "issue_links_url_http_s" CHECK ("issue_links"."url" ~* '^https?://')
);
--> statement-breakpoint
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
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "priority" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "sort_order" double precision;--> statement-breakpoint
UPDATE "issues" SET "sort_order" = "number" * 65535 WHERE "sort_order" IS NULL;--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "sort_order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "assignee_type" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "stop_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "stop_requested_by_human_id" text;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_blocked_by_issue_id_issues_id_fk" FOREIGN KEY ("blocked_by_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_created_by_human_id_humans_id_fk" FOREIGN KEY ("created_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_human_id_humans_id_fk" FOREIGN KEY ("created_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_activities" ADD CONSTRAINT "work_session_activities_work_session_id_work_sessions_id_fk" FOREIGN KEY ("work_session_id") REFERENCES "public"."work_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_activities" ADD CONSTRAINT "work_session_activities_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_blocked_by_per_issue" ON "issue_dependencies" USING btree ("issue_id","blocked_by_issue_id");--> statement-breakpoint
CREATE INDEX "issue_dependencies_blocked_by" ON "issue_dependencies" USING btree ("blocked_by_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_link_per_issue_and_url" ON "issue_links" USING btree ("issue_id","url");--> statement-breakpoint
CREATE INDEX "issue_links_issue_created" ON "issue_links" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "work_session_activities_session_created" ON "work_session_activities" USING btree ("work_session_id","created_at");--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_stop_requested_by_human_id_humans_id_fk" FOREIGN KEY ("stop_requested_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_project_sort_order" ON "issues" USING btree ("project_id","sort_order","created_at");--> statement-breakpoint
CREATE INDEX "issues_assignee" ON "issues" USING btree ("assignee_type","assignee_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_priority" CHECK ("issues"."priority" in ('urgent', 'high', 'medium', 'low', 'none'));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_pair" CHECK (("issues"."assignee_type" is null) = ("issues"."assignee_id" is null));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_type" CHECK (("issues"."assignee_type" is null or "issues"."assignee_type" in ('human', 'agent')));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_sort_order_finite" CHECK ("issues"."sort_order" > '-Infinity'::double precision and "issues"."sort_order" < 'Infinity'::double precision);--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_stop_request" CHECK ((
        ("work_sessions"."stop_requested_at" is null and "work_sessions"."stop_requested_by_human_id" is null and "work_sessions"."stop_reason" is null)
        or ("work_sessions"."stop_requested_at" is not null and "work_sessions"."stop_requested_by_human_id" is not null)
      ));