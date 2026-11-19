CREATE TABLE "workspace_invitation_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"invitation_id" text NOT NULL,
	"project_id" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "workspace_invitation_grants_level" CHECK ("workspace_invitation_grants"."level" in ('read', 'contribute', 'manage'))
);
--> statement-breakpoint
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_status";--> statement-breakpoint
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_status";--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_invitation_grants" ADD CONSTRAINT "workspace_invitation_grants_invitation_id_workspace_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."workspace_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitation_grants" ADD CONSTRAINT "workspace_invitation_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_invitation_grant_per_project" ON "workspace_invitation_grants" USING btree ("invitation_id","project_id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_status" CHECK ("invitations"."status" in ('pending', 'accepted', 'declined', 'expired', 'revoked'));--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_status" CHECK ("workspace_invitations"."status" in ('pending', 'accepted', 'declined', 'expired', 'revoked'));