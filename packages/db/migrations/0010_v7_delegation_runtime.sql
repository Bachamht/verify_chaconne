-- v7（Lane I 2026-10-02，开发计划 §2.11）：委托、执行作业、托管 Agent 轮次、分页时间线、任务证据、事件实际值。
-- 只加表加列、换一个索引；无需回退（回滚 = 停新进程 + 关开关）。
CREATE TABLE "verify_execution_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"task_id" text,
	"mandate_id" text,
	"step_id" text,
	"step_index" integer,
	"owner_address" text NOT NULL,
	"token_address" text,
	"payload_json" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"claimed_by" text,
	"instance_id" text,
	"raw_tx" text,
	"raw_tx_hash" text,
	"tx_hash" text,
	"tx_nonce" text,
	"valid_until" timestamp with time zone,
	"fault_json" jsonb,
	"result_json" jsonb,
	"error_code" text,
	"error_detail" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_execution_jobs_step_uq" UNIQUE("step_id")
);
--> statement-breakpoint
CREATE INDEX "verify_execution_jobs_state_lease_idx" ON "verify_execution_jobs" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX "verify_execution_jobs_task_idx" ON "verify_execution_jobs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "verify_execution_jobs_mandate_step_idx" ON "verify_execution_jobs" USING btree ("mandate_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "verify_execution_jobs_permit_inflight_uq" ON "verify_execution_jobs" USING btree ("owner_address","token_address") WHERE "kind" = 'permit' AND "state" IN ('QUEUED','CLAIMED','SENDING','SENT');--> statement-breakpoint
CREATE TABLE "verify_permits" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"item_id" text,
	"owner_address" text NOT NULL,
	"token_address" text NOT NULL,
	"spender" text NOT NULL,
	"value" text NOT NULL,
	"nonce" text NOT NULL,
	"deadline" text NOT NULL,
	"typed_data_json" jsonb NOT NULL,
	"signature" text,
	"purpose" text NOT NULL,
	"job_id" text,
	"state" text NOT NULL,
	"tx_hash" text,
	"allowance_after" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verify_permits_owner_token_idx" ON "verify_permits" USING btree ("owner_address","token_address","state");--> statement-breakpoint
CREATE INDEX "verify_permits_task_idx" ON "verify_permits" USING btree ("task_id");--> statement-breakpoint
CREATE TABLE "verify_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"turn_version" integer NOT NULL,
	"reason" text NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"run_token_hash" text,
	"lease_until" timestamp with time zone,
	"worker" text,
	"model" text,
	"prompt_hash" text,
	"messages_json" jsonb,
	"action_json" jsonb,
	"decision_summary" text,
	"next_check_at" timestamp with time zone,
	"invalidation" text,
	"usage_json" jsonb,
	"cost_usd_micros" text,
	"prev_run_hash" text,
	"run_hash" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_agent_runs_task_turn_uq" UNIQUE("task_id","turn_version")
);
--> statement-breakpoint
CREATE INDEX "verify_agent_runs_state_lease_idx" ON "verify_agent_runs" USING btree ("state","lease_until");--> statement-breakpoint
CREATE TABLE "verify_agent_run_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"args_hash" text,
	"result_hash" text,
	"args_preview" text,
	"result_preview" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer NOT NULL,
	"error" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_agent_run_steps_uq" UNIQUE("run_id","attempt","seq")
);
--> statement-breakpoint
CREATE TABLE "verify_agent_memory" (
	"task_id" text PRIMARY KEY NOT NULL,
	"notes_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_agent_workers" (
	"worker" text PRIMARY KEY NOT NULL,
	"version" text,
	"model" text,
	"last_heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_task_timeline" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"ref" text,
	"note" text,
	"data_json" jsonb
);
--> statement-breakpoint
CREATE INDEX "verify_task_timeline_task_idx" ON "verify_task_timeline" USING btree ("task_id","id");--> statement-breakpoint
CREATE TABLE "verify_task_evidence" (
	"task_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"record_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_task_evidence_uq" UNIQUE("task_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "verify_executor_status" (
	"executor" text PRIMARY KEY NOT NULL,
	"mode" text,
	"active_instance" text,
	"instance_lease_until" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"gas_balance_wei" text,
	"chain_head" text,
	"version" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verify_mandate_steps" DROP CONSTRAINT "verify_mandate_steps_mandate_step_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "verify_mandate_steps_live_step_uq" ON "verify_mandate_steps" USING btree ("mandate_id","step_index") WHERE "state" IN ('PREPARED','SUBMITTED','REORG_PENDING','CONFIRMED','UNKNOWN');--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "agent_mode" text;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "executor_mode" text;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "next_agent_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "delegation_json" jsonb;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "sell_steps_confirmed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "paused_by" text;--> statement-breakpoint
ALTER TABLE "verify_mandates" ADD COLUMN "side" text DEFAULT 'buy' NOT NULL;--> statement-breakpoint
ALTER TABLE "verify_mandates" ADD COLUMN "asset_key" text;--> statement-breakpoint
ALTER TABLE "verify_mandates" ADD COLUMN "from_block" text;--> statement-breakpoint
UPDATE "verify_mandates" SET "side" = COALESCE("mandate_json"->>'side', 'buy');--> statement-breakpoint
UPDATE "verify_mandates" SET "asset_key" = CASE WHEN "side" = 'sell' THEN "mandate_json"->'legs'->0->>'outputAssetKey' ELSE "mandate_json"->>'inputAssetKey' END;--> statement-breakpoint
ALTER TABLE "verify_task_intents" ADD COLUMN "asset_key" text;--> statement-breakpoint
ALTER TABLE "verify_task_intents" ADD COLUMN "turn_version" integer;--> statement-breakpoint
ALTER TABLE "verify_task_intents" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "verify_task_intents" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "verify_task_intents" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verify_events" ADD COLUMN "outcome_json" jsonb;--> statement-breakpoint
ALTER TABLE "verify_events" ADD COLUMN "outcome_hash" text;--> statement-breakpoint
ALTER TABLE "verify_events" ADD COLUMN "outcome_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verify_events" ADD COLUMN "outcome_received_at" timestamp with time zone;--> statement-breakpoint
INSERT INTO "verify_task_timeline" ("task_id", "at", "actor", "type", "ref", "note", "data_json")
SELECT t."id", COALESCE(NULLIF(e.value->>'at', '')::timestamptz, t."created_at"), 'system', COALESCE(e.value->>'type', 'unknown'), e.value->>'ref', e.value->>'note', e.value
FROM "verify_tasks" t CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t."timeline_json") = 'array' THEN t."timeline_json" ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)
ORDER BY t."id", e.ord;
