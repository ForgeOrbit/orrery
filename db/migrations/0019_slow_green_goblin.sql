CREATE TABLE "run_children" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text,
	"agent_type" text,
	"child_run_id" text,
	"model" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "run_children_status" CHECK ("run_children"."status" in ('active', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "run_model_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"from_model" text,
	"to_model" text NOT NULL,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"harness" text,
	"harness_version" text,
	"native_session_id" text,
	"model" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	CONSTRAINT "runs_status" CHECK ("runs"."status" in ('active', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "run_children" ADD CONSTRAINT "run_children_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_model_changes" ADD CONSTRAINT "run_model_changes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_child_per_run_and_reported_identity" ON "run_children" USING btree ("run_id",coalesce("agent_id", ''),coalesce("agent_type", ''),coalesce("child_run_id", ''));--> statement-breakpoint
CREATE INDEX "run_children_run_started" ON "run_children" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "run_model_changes_run_created" ON "run_model_changes" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_run_per_agent_workspace_harness_session" ON "runs" USING btree ("agent_id","workspace_id",coalesce("harness", ''),coalesce("native_session_id", ''));--> statement-breakpoint
CREATE INDEX "runs_workspace_created" ON "runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_agent_created" ON "runs" USING btree ("agent_id","created_at");