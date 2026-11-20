ALTER TABLE "account_recovery_events" DROP CONSTRAINT "account_recovery_events_type";--> statement-breakpoint
ALTER TABLE "account_recovery_events" ADD COLUMN "actor_human_id" text;--> statement-breakpoint
ALTER TABLE "humans" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD COLUMN "is_former_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_recovery_events" ADD CONSTRAINT "account_recovery_events_actor_human_id_humans_id_fk" FOREIGN KEY ("actor_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_recovery_events" ADD CONSTRAINT "account_recovery_events_type" CHECK ("account_recovery_events"."type" in ('password_reset_requested', 'password_reset_completed', 'local_recovery_completed', 'account_deactivated', 'account_reactivated'));