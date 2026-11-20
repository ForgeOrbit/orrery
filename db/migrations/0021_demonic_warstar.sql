ALTER TABLE "agent_key_events" DROP CONSTRAINT "agent_key_events_type";--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN "replaces_key_id" text;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_replaces_key_id_agent_api_keys_id_fk" FOREIGN KEY ("replaces_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_events" ADD CONSTRAINT "agent_key_events_type" CHECK ("agent_key_events"."type" in ('agent_key_created', 'agent_key_revoked', 'agent_key_rotated'));