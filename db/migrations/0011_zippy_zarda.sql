CREATE TABLE "project_access_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_human_id" text NOT NULL,
	"subject_human_id" text NOT NULL,
	"type" text NOT NULL,
	"level" text,
	"previous_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_events_type" CHECK ("project_access_events"."type" in ('project_access_granted', 'project_access_level_changed', 'project_access_revoked')),
	CONSTRAINT "project_access_events_level" CHECK (("project_access_events"."level" is null or "project_access_events"."level" in ('read', 'contribute', 'manage'))),
	CONSTRAINT "project_access_events_previous_level" CHECK (("project_access_events"."previous_level" is null or "project_access_events"."previous_level" in ('read', 'contribute', 'manage'))),
	CONSTRAINT "project_access_events_shape" CHECK ((
        ("project_access_events"."type" = 'project_access_granted'
          and "project_access_events"."level" is not null and "project_access_events"."previous_level" is null)
        or ("project_access_events"."type" = 'project_access_level_changed'
          and "project_access_events"."level" is not null and "project_access_events"."previous_level" is not null)
        or ("project_access_events"."type" = 'project_access_revoked'
          and "project_access_events"."level" is null and "project_access_events"."previous_level" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "project_access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"human_id" text NOT NULL,
	"level" text NOT NULL,
	"granted_by_human_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_grants_level" CHECK ("project_access_grants"."level" in ('read', 'contribute', 'manage'))
);
--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_type";--> statement-breakpoint
ALTER TABLE "project_activity" DROP CONSTRAINT "project_activity_target_matches_type";--> statement-breakpoint
ALTER TABLE "workspace_events" DROP CONSTRAINT "workspace_event_type";--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD COLUMN "can_create_projects" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_access_events" ADD CONSTRAINT "project_access_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_events" ADD CONSTRAINT "project_access_events_actor_human_id_humans_id_fk" FOREIGN KEY ("actor_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_events" ADD CONSTRAINT "project_access_events_subject_human_id_humans_id_fk" FOREIGN KEY ("subject_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_grants" ADD CONSTRAINT "project_access_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_grants" ADD CONSTRAINT "project_access_grants_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_grants" ADD CONSTRAINT "project_access_grants_granted_by_human_id_humans_id_fk" FOREIGN KEY ("granted_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_events_project_created" ON "project_access_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_project_access_grant_per_human" ON "project_access_grants" USING btree ("project_id","human_id");--> statement-breakpoint
CREATE INDEX "project_access_grants_human_id" ON "project_access_grants" USING btree ("human_id");--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_type" CHECK ("project_activity"."type" in ('project_created', 'project_renamed', 'issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened', 'knowledge_created', 'knowledge_edited'));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_target_matches_type" CHECK ((
        ("project_activity"."type" in ('project_created', 'project_renamed') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('issue_created', 'issue_edited', 'issue_commented', 'issue_closed', 'issue_reopened') and "project_activity"."issue_id" is not null and "project_activity"."knowledge_entry_id" is null)
        or ("project_activity"."type" in ('knowledge_created', 'knowledge_edited') and "project_activity"."issue_id" is null and "project_activity"."knowledge_entry_id" is not null)
      ));--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_event_type" CHECK ("workspace_events"."type" in ('workspace_created', 'member_joined', 'owner_appointed', 'member_removed', 'owner_removed', 'create_projects_granted', 'create_projects_revoked'));