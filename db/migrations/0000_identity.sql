CREATE TABLE "browser_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "browser_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "humans" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"is_system_administrator" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "humans_email_unique" UNIQUE("email"),
	CONSTRAINT "humans_email_normalized" CHECK ("humans"."email" = lower(btrim("humans"."email")))
);
--> statement-breakpoint
CREATE TABLE "instance_setup" (
	"id" boolean PRIMARY KEY NOT NULL,
	"administrator_human_id" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_setup_singleton" CHECK ("instance_setup"."id" = true)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"personal_owner_human_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_kind" CHECK (kind in ('personal', 'shared')),
	CONSTRAINT "workspace_owner_matches_kind" CHECK (("workspaces"."kind" = 'personal') = ("workspaces"."personal_owner_human_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_setup" ADD CONSTRAINT "instance_setup_administrator_human_id_humans_id_fk" FOREIGN KEY ("administrator_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_personal_owner_human_id_humans_id_fk" FOREIGN KEY ("personal_owner_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_personal_workspace_per_human" ON "workspaces" USING btree ("personal_owner_human_id") WHERE "workspaces"."kind" = 'personal';