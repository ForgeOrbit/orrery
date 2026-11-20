-- #46: scope project access-change events to the workspace that owned the project when
-- the change happened. Add the column nullable, backfill it from each event's project,
-- then make it required. Drizzle cannot express the backfill in a generated ADD COLUMN,
-- so the generated statement is finalized here (the snapshot still records the final
-- NOT NULL shape).--> statement-breakpoint
ALTER TABLE "project_access_events" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "project_access_events" e SET "workspace_id" = p."workspace_id" FROM "projects" p WHERE p."id" = e."project_id";--> statement-breakpoint
ALTER TABLE "project_access_events" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_access_events" ADD CONSTRAINT "project_access_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_events_workspace_created" ON "project_access_events" USING btree ("workspace_id","created_at");
