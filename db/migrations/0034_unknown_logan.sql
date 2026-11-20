ALTER TABLE "projects" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "one_project_key_per_workspace" ON "projects" USING btree ("workspace_id","key");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_key_format" CHECK ("projects"."key" ~ '^[A-Z][A-Z0-9]{1,9}$');