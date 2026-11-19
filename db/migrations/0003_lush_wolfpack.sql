CREATE TABLE "workspace_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_human_id" text NOT NULL,
	"subject_human_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_event_type" CHECK ("workspace_events"."type" in ('workspace_created', 'member_joined', 'owner_appointed', 'member_removed', 'owner_removed'))
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"status" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_human_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"delivery_status" text,
	"delivery_attempted_at" timestamp with time zone,
	CONSTRAINT "workspace_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invitations_email_normalized" CHECK ("workspace_invitations"."email" = lower(btrim("workspace_invitations"."email"))),
	CONSTRAINT "workspace_invitations_status" CHECK ("workspace_invitations"."status" in ('pending', 'accepted', 'expired')),
	CONSTRAINT "workspace_invitations_delivery_status" CHECK (("workspace_invitations"."delivery_status" is null or "workspace_invitations"."delivery_status" in ('sent', 'failed')))
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"human_id" text NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_actor_human_id_humans_id_fk" FOREIGN KEY ("actor_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_subject_human_id_humans_id_fk" FOREIGN KEY ("subject_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_human_id_humans_id_fk" FOREIGN KEY ("invited_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_events_workspace_created" ON "workspace_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_pending_workspace_invitation_per_email" ON "workspace_invitations" USING btree ("workspace_id","email") WHERE "workspace_invitations"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "one_membership_per_workspace_and_human" ON "workspace_memberships" USING btree ("workspace_id","human_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_human_id" ON "workspace_memberships" USING btree ("human_id");