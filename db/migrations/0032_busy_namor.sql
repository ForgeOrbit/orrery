-- #95 project key: add the column nullable first so existing rows can be backfilled.
ALTER TABLE "projects" ADD COLUMN "key" text;