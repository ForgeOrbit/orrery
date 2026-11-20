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
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_blocked_by_issue_id_issues_id_fk" FOREIGN KEY ("blocked_by_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_created_by_human_id_humans_id_fk" FOREIGN KEY ("created_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_blocked_by_per_issue" ON "issue_dependencies" USING btree ("issue_id","blocked_by_issue_id");--> statement-breakpoint
CREATE INDEX "issue_dependencies_blocked_by" ON "issue_dependencies" USING btree ("blocked_by_issue_id");--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));