CREATE TABLE "project_transfer_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source_workspace_id" text NOT NULL,
	"destination_workspace_id" text NOT NULL,
	"authorized_by_human_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "project_transfer_authorizations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "project_transfer_authorizations_status" CHECK ("project_transfer_authorizations"."status" in ('pending', 'accepted', 'revoked', 'expired')),
	CONSTRAINT "project_transfer_authorizations_sides_differ" CHECK ("project_transfer_authorizations"."source_workspace_id" <> "project_transfer_authorizations"."destination_workspace_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_events" DROP CONSTRAINT "workspace_event_type";--> statement-breakpoint
ALTER TABLE "project_transfer_authorizations" ADD CONSTRAINT "project_transfer_authorizations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfer_authorizations" ADD CONSTRAINT "project_transfer_authorizations_source_workspace_id_workspaces_id_fk" FOREIGN KEY ("source_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfer_authorizations" ADD CONSTRAINT "project_transfer_authorizations_destination_workspace_id_workspaces_id_fk" FOREIGN KEY ("destination_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfer_authorizations" ADD CONSTRAINT "project_transfer_authorizations_authorized_by_human_id_humans_id_fk" FOREIGN KEY ("authorized_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_transfer_authorizations_project" ON "project_transfer_authorizations" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_event_type" CHECK ("workspace_events"."type" in ('workspace_created', 'member_joined', 'owner_appointed', 'member_removed', 'owner_removed', 'member_left', 'owner_left', 'create_projects_granted', 'create_projects_revoked', 'invite_members_granted', 'invite_members_revoked', 'remove_members_granted', 'remove_members_revoked', 'manage_member_permissions_granted', 'manage_member_permissions_revoked', 'project_transfer_authorized', 'project_transfer_received', 'project_transferred_out'));