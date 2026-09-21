CREATE TABLE "verify_mandate_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"report_json" jsonb,
	"job_json" jsonb,
	"report_hash" text,
	"evidence_json" jsonb NOT NULL,
	"reasons_json" jsonb NOT NULL,
	"delta_json" jsonb,
	"prepared_step_index" integer
);
--> statement-breakpoint
CREATE TABLE "verify_mandate_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"evaluation_id" text,
	"state" text NOT NULL,
	"step_json" jsonb NOT NULL,
	"step_digest" text NOT NULL,
	"certificate_json" jsonb NOT NULL,
	"certificate_signature" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"pulled_at" timestamp with time zone,
	"tx_hash" text,
	"receipt_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_mandate_steps_mandate_step_uq" UNIQUE("mandate_id","step_index")
);
--> statement-breakpoint
CREATE TABLE "verify_mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"plan_id" text,
	"job_id" text,
	"owner_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"plan_guard_address" text NOT NULL,
	"mandate_json" jsonb NOT NULL,
	"mandate_digest" text NOT NULL,
	"signature" text NOT NULL,
	"policy_definition_hash" text NOT NULL,
	"effective_policy_hash" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"registry_hash" text NOT NULL,
	"state" text NOT NULL,
	"budget_cap" text NOT NULL,
	"spent" text DEFAULT '0' NOT NULL,
	"steps_done" integer DEFAULT 0 NOT NULL,
	"max_steps" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_mandates_mandate_digest_unique" UNIQUE("mandate_digest"),
	CONSTRAINT "verify_mandates_caller_req_uq" UNIQUE("caller_id","client_request_id")
);
--> statement-breakpoint
CREATE TABLE "verify_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"goal_json" jsonb NOT NULL,
	"goal_hash" text NOT NULL,
	"plan_json" jsonb NOT NULL,
	"plan_hash" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"registry_hash" text NOT NULL,
	"policy_definition_hash" text NOT NULL,
	"effective_policy_hash" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_plans_caller_req_uq" UNIQUE("caller_id","client_request_id")
);
--> statement-breakpoint
CREATE TABLE "verify_profiles" (
	"owner_address" text PRIMARY KEY NOT NULL,
	"persona_id" text NOT NULL,
	"name" text NOT NULL,
	"tone" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_shares" (
	"share_id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"privacy_json" jsonb NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_shares_ref_uq" UNIQUE("kind","ref_id")
);
--> statement-breakpoint
CREATE TABLE "verify_simulations" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"persona_id" text,
	"goal_json" jsonb NOT NULL,
	"plan_json" jsonb NOT NULL,
	"plan_hash" text NOT NULL,
	"evidence_mode" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"author_address" text NOT NULL,
	"author_name" text,
	"kind" text NOT NULL,
	"template_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verify_orders" ADD COLUMN "ref_kind" text DEFAULT 'job' NOT NULL;--> statement-breakpoint
ALTER TABLE "verify_orders" ADD COLUMN "sku" text DEFAULT 'verify_once' NOT NULL;--> statement-breakpoint
CREATE INDEX "verify_mandate_evaluations_mandate_idx" ON "verify_mandate_evaluations" USING btree ("mandate_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "verify_mandate_steps_state_idx" ON "verify_mandate_steps" USING btree ("state");--> statement-breakpoint
CREATE INDEX "verify_mandates_state_idx" ON "verify_mandates" USING btree ("state");--> statement-breakpoint
CREATE INDEX "verify_plans_owner_idx" ON "verify_plans" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "verify_shares_public_idx" ON "verify_shares" USING btree ("public","created_at");--> statement-breakpoint
CREATE INDEX "verify_simulations_owner_idx" ON "verify_simulations" USING btree ("owner_address");