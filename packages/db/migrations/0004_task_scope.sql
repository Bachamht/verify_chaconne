ALTER TABLE "verify_tasks" ADD COLUMN "scope_json" jsonb;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "scope_hash" text;