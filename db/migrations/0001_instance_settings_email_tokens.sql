CREATE TABLE "email_verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "email_verification_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" boolean PRIMARY KEY NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_security" text NOT NULL,
	"smtp_username" text,
	"smtp_password" text,
	"smtp_from" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_human_id" text NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK ("instance_settings"."id" = true),
	CONSTRAINT "instance_settings_smtp_security" CHECK ("instance_settings"."smtp_security" in ('none', 'starttls', 'tls'))
);
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_updated_by_human_id_humans_id_fk" FOREIGN KEY ("updated_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;