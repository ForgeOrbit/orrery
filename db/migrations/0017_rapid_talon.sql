ALTER TABLE "issue_comments" ALTER COLUMN "created_by_human_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "created_by_human_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "updated_by_human_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ALTER COLUMN "created_by_human_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ALTER COLUMN "updated_by_human_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_activity" ALTER COLUMN "actor_human_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "created_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "created_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "updated_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "created_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "updated_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "project_activity" ADD COLUMN "actor_agent_id" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_created_by_actor" CHECK (("issue_comments"."created_by_human_id" is not null) <> ("issue_comments"."created_by_agent_id" is not null));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_actor" CHECK (("issues"."created_by_human_id" is not null) <> ("issues"."created_by_agent_id" is not null));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_updated_by_actor" CHECK (("issues"."updated_by_human_id" is not null) <> ("issues"."updated_by_agent_id" is not null));--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_created_by_actor" CHECK (("knowledge_entries"."created_by_human_id" is not null) <> ("knowledge_entries"."created_by_agent_id" is not null));--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_updated_by_actor" CHECK (("knowledge_entries"."updated_by_human_id" is not null) <> ("knowledge_entries"."updated_by_agent_id" is not null));--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_actor" CHECK (("project_activity"."actor_human_id" is not null) <> ("project_activity"."actor_agent_id" is not null));