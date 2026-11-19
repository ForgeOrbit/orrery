CREATE TABLE "workspace_ownership_guards" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_ownership_guards" ADD CONSTRAINT "workspace_ownership_guards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;