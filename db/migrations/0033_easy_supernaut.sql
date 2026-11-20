ALTER TABLE "issues" ADD COLUMN "assignee_type" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "assignee_id" text;--> statement-breakpoint
CREATE INDEX "issues_assignee" ON "issues" USING btree ("assignee_type","assignee_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_pair" CHECK (("issues"."assignee_type" is null) = ("issues"."assignee_id" is null));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_type" CHECK (("issues"."assignee_type" is null or "issues"."assignee_type" in ('human', 'agent')));