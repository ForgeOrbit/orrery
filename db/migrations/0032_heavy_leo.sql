ALTER TABLE "issues" DROP CONSTRAINT "issues_status";--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_closed_at_matches_status";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
-- #94 backfill: map the binary statuses to the six-state workflow after the old CHECKs
-- are dropped and before the new ones are added. The old `issues_status` CHECK allows
-- only open/closed, and the old `issues_closed_at_matches_status` CHECK keys off the
-- literal 'closed', so neither new status can be written while either old check exists.
-- Old `open` rows have closed_at null (todo is valid); old `closed` rows have closed_at
-- set (done is valid), so the new closed_at invariant holds for both after the backfill.
UPDATE "issues" SET "status" = 'todo' WHERE "status" = 'open';--> statement-breakpoint
UPDATE "issues" SET "status" = 'done' WHERE "status" = 'closed';--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_status" CHECK ("issues"."status" in ('backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_closed_at_matches_status" CHECK (("issues"."status" in ('done', 'cancelled')) = ("issues"."closed_at" is not null));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed', 'project_fallback_policy_changed') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));