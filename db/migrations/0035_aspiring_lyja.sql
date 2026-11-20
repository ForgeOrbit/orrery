ALTER TABLE "work_sessions" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "cost_usd_micros" integer;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_input_tokens_nonnegative" CHECK ("work_sessions"."input_tokens" is null or "work_sessions"."input_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_output_tokens_nonnegative" CHECK ("work_sessions"."output_tokens" is null or "work_sessions"."output_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_cost_usd_micros_nonnegative" CHECK ("work_sessions"."cost_usd_micros" is null or "work_sessions"."cost_usd_micros" >= 0);