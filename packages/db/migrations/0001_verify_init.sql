CREATE TABLE "verify_entitlements" (
	"order_id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_refreshes" integer NOT NULL,
	"used_refreshes" integer DEFAULT 0 NOT NULL,
	"reserved_refreshes" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_entitlements_nonneg" CHECK ("verify_entitlements"."used_refreshes" >= 0 AND "verify_entitlements"."reserved_refreshes" >= 0),
	CONSTRAINT "verify_entitlements_cap" CHECK ("verify_entitlements"."used_refreshes" + "verify_entitlements"."reserved_refreshes" <= "verify_entitlements"."max_refreshes")
);
--> statement-breakpoint
CREATE TABLE "verify_evidence" (
	"evidence_id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"report_version" integer NOT NULL,
	"record" jsonb NOT NULL,
	"raw_ref" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_execution_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"refresh_key" text NOT NULL,
	"report_version" integer NOT NULL,
	"nonce" text NOT NULL,
	"intent_json" jsonb NOT NULL,
	"intent_digest" text NOT NULL,
	"calldata_hash" text NOT NULL,
	"certificate_json" jsonb,
	"certificate_signature" text,
	"valid_until" timestamp with time zone,
	"state" text NOT NULL,
	"tx_hash" text,
	"receipt_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_execution_attempts_refresh_uq" UNIQUE("job_id","refresh_key")
);
--> statement-breakpoint
CREATE TABLE "verify_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"job_json" jsonb NOT NULL,
	"policy_definition_hash" text NOT NULL,
	"effective_policy_hash" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"registry_version" text NOT NULL,
	"registry_hash" text NOT NULL,
	"execution_chain_id" integer NOT NULL,
	"guard_address" text,
	"owner_address" text NOT NULL,
	"execution_nonce" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_jobs_caller_req_uq" UNIQUE("caller_id","client_request_id"),
	CONSTRAINT "verify_jobs_nonce_uq" UNIQUE("execution_chain_id","guard_address","owner_address","execution_nonce")
);
--> statement-breakpoint
CREATE TABLE "verify_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"price_usd" text NOT NULL,
	"price_amount" text,
	"price_asset" text,
	"network" text NOT NULL,
	"merchant" text NOT NULL,
	"state" text NOT NULL,
	"settled_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_orders_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "verify_payment_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"proof_digest" text NOT NULL,
	"payer" text,
	"provider_reference" text,
	"network" text NOT NULL,
	"state" text NOT NULL,
	"error_code" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_payment_attempts_provider_reference_unique" UNIQUE("provider_reference"),
	CONSTRAINT "verify_payment_attempts_order_proof_uq" UNIQUE("order_id","proof_digest")
);
--> statement-breakpoint
CREATE TABLE "verify_payment_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_attempt_id" text,
	"source" text NOT NULL,
	"event_key" text NOT NULL,
	"digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_payment_events_source_key_uq" UNIQUE("source","event_key")
);
--> statement-breakpoint
CREATE TABLE "verify_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"request_id" text NOT NULL,
	"reason" text NOT NULL,
	"requested_amount" text NOT NULL,
	"currency" text NOT NULL,
	"state" text NOT NULL,
	"provider_reference" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_refunds_order_request_uq" UNIQUE("order_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "verify_reports" (
	"job_id" text NOT NULL,
	"version" integer NOT NULL,
	"report_json" jsonb NOT NULL,
	"report_hash" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"policy_definition_hash" text NOT NULL,
	"effective_policy_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_reports_job_id_version_pk" PRIMARY KEY("job_id","version")
);
--> statement-breakpoint
CREATE INDEX "verify_evidence_job_idx" ON "verify_evidence" USING btree ("job_id","report_version");--> statement-breakpoint
CREATE INDEX "verify_execution_attempts_job_idx" ON "verify_execution_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "verify_jobs_owner_idx" ON "verify_jobs" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "verify_payment_attempts_state_idx" ON "verify_payment_attempts" USING btree ("state");--> statement-breakpoint
CREATE INDEX "verify_payment_events_unprocessed_idx" ON "verify_payment_events" USING btree ("processed");