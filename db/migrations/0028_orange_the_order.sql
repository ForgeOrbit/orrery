ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "stop_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "stop_requested_by_human_id" text;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_stop_requested_by_human_id_humans_id_fk" FOREIGN KEY ("stop_requested_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_stop_requested', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_stop_requested') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_stop_request" CHECK ((
        ("work_sessions"."stop_requested_at" is null and "work_sessions"."stop_requested_by_human_id" is null and "work_sessions"."stop_reason" is null)
        or ("work_sessions"."stop_requested_at" is not null and "work_sessions"."stop_requested_by_human_id" is not null)
      ));