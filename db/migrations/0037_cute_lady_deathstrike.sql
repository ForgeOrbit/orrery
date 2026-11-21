CREATE TABLE "issue_labels" (
	"issue_id" text NOT NULL,
	"label_id" text NOT NULL,
	CONSTRAINT "issue_labels_issue_id_label_id_pk" PRIMARY KEY("issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "project_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_by_human_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_labels_name_nonempty" CHECK (btrim("project_labels"."name") <> ''),
	CONSTRAINT "project_labels_color" CHECK ("project_labels"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "project_labels_created_by_actor" CHECK (("project_labels"."created_by_human_id" is not null) <> ("project_labels"."created_by_agent_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "parent_issue_id" text;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_id_project_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."project_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_created_by_human_id_humans_id_fk" FOREIGN KEY ("created_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_labels_label" ON "issue_labels" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_label_name_per_project" ON "project_labels" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "project_labels_project" ON "project_labels" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_parent" ON "issues" USING btree ("project_id","parent_issue_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_no_self_parent" CHECK ("issues"."parent_issue_id" is null or "issues"."parent_issue_id" <> "issues"."id");--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'project_label_created', 'project_label_edited', 'project_label_deleted', 'issue_label_added', 'issue_label_removed', 'issue_parent_changed', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed', 'project_label_created', 'project_label_edited', 'project_label_deleted') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'issue_label_added', 'issue_label_removed', 'issue_parent_changed') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));