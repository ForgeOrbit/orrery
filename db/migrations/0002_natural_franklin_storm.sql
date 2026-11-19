CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_human_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_email_normalized" CHECK ("invitations"."email" = lower(btrim("invitations"."email"))),
	CONSTRAINT "invitations_status" CHECK ("invitations"."status" in ('pending', 'accepted'))
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_human_id_humans_id_fk" FOREIGN KEY ("invited_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_pending_invitation_per_email" ON "invitations" USING btree ("email") WHERE "invitations"."status" = 'pending';