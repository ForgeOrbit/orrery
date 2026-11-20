CREATE TABLE "agent_api_key_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"project_id" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "agent_api_key_projects_level" CHECK ("agent_api_key_projects"."level" in ('read', 'contribute', 'manage'))
);
--> statement-breakpoint
CREATE TABLE "agent_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_human_id" text NOT NULL,
	"validity" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_human_id" text,
	CONSTRAINT "agent_api_keys_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agent_api_keys_validity" CHECK ("agent_api_keys"."validity" in ('7', '14', '30', '60', '90', 'never'))
);
--> statement-breakpoint
CREATE TABLE "agent_key_events" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_human_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_key_events_type" CHECK ("agent_key_events"."type" in ('agent_key_created', 'agent_key_revoked'))
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_api_key_projects" ADD CONSTRAINT "agent_api_key_projects_key_id_agent_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_key_projects" ADD CONSTRAINT "agent_api_key_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_created_by_human_id_humans_id_fk" FOREIGN KEY ("created_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_revoked_by_human_id_humans_id_fk" FOREIGN KEY ("revoked_by_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_events" ADD CONSTRAINT "agent_key_events_key_id_agent_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_events" ADD CONSTRAINT "agent_key_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_events" ADD CONSTRAINT "agent_key_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_events" ADD CONSTRAINT "agent_key_events_actor_human_id_humans_id_fk" FOREIGN KEY ("actor_human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_agent_key_project_per_project" ON "agent_api_key_projects" USING btree ("key_id","project_id");--> statement-breakpoint
CREATE INDEX "agent_api_keys_workspace_created" ON "agent_api_keys" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_api_keys_agent_created" ON "agent_api_keys" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_key_events_workspace_created" ON "agent_key_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_agent_name_per_human" ON "agents" USING btree ("human_id","name");--> statement-breakpoint
CREATE INDEX "agents_human_created" ON "agents" USING btree ("human_id","created_at");