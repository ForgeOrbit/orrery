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
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_human_id_humans_id_fk" FOREIGN KEY ("created_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_link_per_issue_and_url" ON "issue_links" USING btree ("issue_id","url");--> statement-breakpoint
CREATE INDEX "issue_links_issue_created" ON "issue_links" USING btree ("issue_id","created_at");--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));