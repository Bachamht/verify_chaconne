CREATE TABLE "verify_task_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"client_request_id" text NOT NULL,
	"kind" text NOT NULL,
	"output_asset_key" text NOT NULL,
	"amount_in_raw" text NOT NULL,
	"decision_json" jsonb NOT NULL,
	"triage_json" jsonb NOT NULL,
	"checks_json" jsonb NOT NULL,
	"plan_deviations_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"step_json" jsonb,
	"evidence_ids_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_task_intents_task_req_uq" UNIQUE("task_id","client_request_id")
);
--> statement-breakpoint
CREATE INDEX "verify_task_intents_task_idx" ON "verify_task_intents" USING btree ("task_id","created_at");