-- #88: board importance and position. Priority has a literal default. sortOrder has no
-- meaningful constant default: existing cards must keep their relative order, so add it
-- nullable, backfill from each issue's project-local number, then make it required. The
-- generated statements are finalized here; the snapshot records the final NOT NULL shape.
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "priority" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "sort_order" double precision;--> statement-breakpoint
UPDATE "issues" SET "sort_order" = "number" * 65535 WHERE "sort_order" IS NULL;--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "sort_order" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "issues_project_sort_order" ON "issues" USING btree ("project_id","sort_order","created_at");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_priority" CHECK ("issues"."priority" in ('urgent', 'high', 'medium', 'low', 'none'));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_sort_order_finite" CHECK ("issues"."sort_order" > '-Infinity'::double precision and "issues"."sort_order" < 'Infinity'::double precision);