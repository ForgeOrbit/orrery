CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event" text NOT NULL,
	"activity_id" text,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_status_code" integer,
	"last_duration_ms" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_event" CHECK ("webhook_deliveries"."event" in ('project_created', 'project_renamed', 'project_fallback_policy_changed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'issue_session_expired', 'project_label_created', 'project_label_edited', 'project_label_deleted', 'issue_label_added', 'issue_label_removed', 'issue_parent_changed', 'issue_deleted', 'issue_restored', 'knowledge_created', 'knowledge_edited', 'webhook.test')),
	CONSTRAINT "webhook_deliveries_test_activity" CHECK (("webhook_deliveries"."event" = 'webhook.test' and "webhook_deliveries"."activity_id" is null)
        or ("webhook_deliveries"."event" <> 'webhook.test' and "webhook_deliveries"."activity_id" is not null)),
	CONSTRAINT "webhook_deliveries_status" CHECK ("webhook_deliveries"."status" in ('pending', 'delivering', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_attempt_count_nonnegative" CHECK ("webhook_deliveries"."attempt_count" >= 0),
	CONSTRAINT "webhook_deliveries_last_duration_nonnegative" CHECK ("webhook_deliveries"."last_duration_ms" is null or "webhook_deliveries"."last_duration_ms" >= 0),
	CONSTRAINT "webhook_deliveries_delivering_lock" CHECK ("webhook_deliveries"."status" <> 'delivering' or "webhook_deliveries"."locked_until" is not null),
	CONSTRAINT "webhook_deliveries_delivered_at" CHECK ("webhook_deliveries"."status" <> 'delivered' or "webhook_deliveries"."delivered_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "webhook_projects" (
	"webhook_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "webhook_projects_webhook_id_project_id_pk" PRIMARY KEY("webhook_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"secret_encrypted" text NOT NULL,
	"all_projects" boolean DEFAULT true NOT NULL,
	"all_events" boolean DEFAULT true NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_by_human_id" text,
	"updated_by_human_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_url_scheme" CHECK ("webhooks"."url" ~ '^https?://'),
	CONSTRAINT "webhooks_consecutive_failures_nonnegative" CHECK ("webhooks"."consecutive_failures" >= 0),
	CONSTRAINT "webhooks_events_valid" CHECK ("webhooks"."events" <@ array['project_created', 'project_renamed', 'project_fallback_policy_changed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_review_handoff', 'issue_closed', 'issue_reopened', 'issue_dependency_added', 'issue_dependency_removed', 'issue_link_added', 'issue_link_removed', 'issue_question_asked', 'issue_question_answered', 'issue_question_paused', 'issue_question_fallback_used', 'issue_question_follow_up', 'issue_fallback_policy_override_changed', 'issue_stop_requested', 'issue_session_expired', 'project_label_created', 'project_label_edited', 'project_label_deleted', 'issue_label_added', 'issue_label_removed', 'issue_parent_changed', 'issue_deleted', 'issue_restored', 'knowledge_created', 'knowledge_edited']::text[]),
	CONSTRAINT "webhooks_disabled_fields" CHECK (("webhooks"."enabled" = true and "webhooks"."disabled_at" is null and "webhooks"."disabled_reason" is null)
        or ("webhooks"."enabled" = false and "webhooks"."disabled_at" is not null and "webhooks"."disabled_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_activity_id_project_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."project_activity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_projects" ADD CONSTRAINT "webhook_projects_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_projects" ADD CONSTRAINT "webhook_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_human_id_humans_id_fk" FOREIGN KEY ("created_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_updated_by_human_id_humans_id_fk" FOREIGN KEY ("updated_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_webhook_activity" ON "webhook_deliveries" USING btree ("webhook_id","activity_id") WHERE "webhook_deliveries"."activity_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_due" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_delivering_lock_due" ON "webhook_deliveries" USING btree ("locked_until") WHERE "webhook_deliveries"."status" = 'delivering';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_created" ON "webhook_deliveries" USING btree ("webhook_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created" ON "webhook_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_projects_project" ON "webhook_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "webhooks_workspace_created" ON "webhooks" USING btree ("workspace_id","created_at");