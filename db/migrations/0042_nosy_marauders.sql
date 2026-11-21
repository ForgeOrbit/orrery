CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" in ('handoff', 'needs_input', 'session_expired'))
);
--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_activity_id_project_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."project_activity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_notification_per_human_and_activity" ON "notifications" USING btree ("human_id","activity_id");--> statement-breakpoint
CREATE INDEX "notifications_human_created" ON "notifications" USING btree ("human_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_human_unread" ON "notifications" USING btree ("human_id","created_at" DESC NULLS LAST) WHERE "notifications"."read_at" is null;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'issue_session_expired', 'project_label_created', 'project_label_edited', 'project_label_deleted', 'issue_label_added', 'issue_label_removed', 'issue_parent_changed', 'issue_deleted', 'issue_restored', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed', 'project_label_created', 'project_label_edited', 'project_label_deleted') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'issue_session_expired', 'issue_label_added', 'issue_label_removed', 'issue_parent_changed', 'issue_deleted', 'issue_restored') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));