CREATE TABLE "verify_budget_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"task_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"requested_raw" text NOT NULL,
	"reserved_raw" text DEFAULT '0' NOT NULL,
	"spent_raw" text DEFAULT '0' NOT NULL,
	"pending_raw" text DEFAULT '0' NOT NULL,
	"state" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"release_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_budget_allocations_group_mandate_uq" UNIQUE("group_id","mandate_id")
);
--> statement-breakpoint
CREATE TABLE "verify_budget_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"name" text NOT NULL,
	"input_asset_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"cap_raw" text NOT NULL,
	"cash_floor_raw" text DEFAULT '0' NOT NULL,
	"priority_rule" text DEFAULT 'priority_then_created' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_budget_groups_period_chk" CHECK ("verify_budget_groups"."period_end" > "verify_budget_groups"."period_start")
);
--> statement-breakpoint
CREATE TABLE "verify_budget_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"allocation_id" text,
	"kind" text NOT NULL,
	"amount_raw" text NOT NULL,
	"spent_after_raw" text NOT NULL,
	"reserved_after_raw" text NOT NULL,
	"invariant_ok" boolean NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_context_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"producer" text NOT NULL,
	"public_key_id" text,
	"packaged_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"signature_valid" boolean DEFAULT false NOT NULL,
	"context_hash" text,
	"provenance_mode" text,
	"field_status" jsonb NOT NULL,
	"context_json" jsonb,
	"evidence_json" jsonb NOT NULL,
	"raw_hash" text NOT NULL,
	"source_endpoint" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_cost_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"asset_key" text NOT NULL,
	"qty_raw" text NOT NULL,
	"cost_raw" text NOT NULL,
	"input_asset_key" text NOT NULL,
	"source" text DEFAULT 'user_reported' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_earnings_ingests" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	"underlying_id" text NOT NULL,
	"http_status" integer NOT NULL,
	"ok" boolean NOT NULL,
	"row_count" integer NOT NULL,
	"raw_hash" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"event_ids" jsonb NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_earnings_periods" (
	"match_key" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_event_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"revision" integer NOT NULL,
	"event_json" jsonb NOT NULL,
	"changed_fields" jsonb NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_event_revisions_uq" UNIQUE("event_id","revision")
);
--> statement-breakpoint
CREATE TABLE "verify_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"underlying_ids" jsonb NOT NULL,
	"scheduled_at_utc" timestamp with time zone,
	"date_local" text NOT NULL,
	"date_precision" text NOT NULL,
	"session_hint" text,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"revised_from" jsonb,
	"source" text NOT NULL,
	"source_fetched_at" timestamp with time zone NOT NULL,
	"first_known_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"tz" text NOT NULL,
	"event_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_executor_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"executor_id" text NOT NULL,
	"path" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_executor_heartbeats_mandate_executor_uq" UNIQUE("mandate_id","executor_id")
);
--> statement-breakpoint
CREATE TABLE "verify_missions" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text,
	"owner_address" text,
	"kind" text NOT NULL,
	"event_id" text,
	"asset_key" text,
	"date_label" text NOT NULL,
	"mode" text NOT NULL,
	"mission_json" jsonb NOT NULL,
	"created_task_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"kind" text NOT NULL,
	"target" text,
	"secret" text,
	"state" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"link_code" text,
	"link_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"owner_address" text NOT NULL,
	"type" text NOT NULL,
	"entity_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_notification_outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "verify_policy_comparisons" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"task_id" text NOT NULL,
	"evidence_snapshot_id" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"comparison_json" jsonb NOT NULL,
	"result_json" jsonb NOT NULL,
	"evaluator_id" text NOT NULL,
	"mode" text DEFAULT 'SIMULATION' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_rebalance_legs" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"leg_index" integer NOT NULL,
	"side" text NOT NULL,
	"asset_key" text NOT NULL,
	"amount_raw" text NOT NULL,
	"est_usd" text NOT NULL,
	"state" text NOT NULL,
	"mandate_id" text,
	"draft_json" jsonb,
	"result_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_rebalance_legs_plan_leg_uq" UNIQUE("plan_id","leg_index")
);
--> statement-breakpoint
CREATE TABLE "verify_rebalance_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"task_id" text,
	"budget_group_id" text,
	"input_asset_key" text NOT NULL,
	"cash_floor_raw" text NOT NULL,
	"targets_json" jsonb NOT NULL,
	"preview_json" jsonb NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"policy_json" jsonb NOT NULL,
	"state" text NOT NULL,
	"phase" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_rebalance_plans_caller_req_uq" UNIQUE("caller_id","client_request_id")
);
--> statement-breakpoint
CREATE TABLE "verify_recaps" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"ny_date" text NOT NULL,
	"generate_after" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"recap_json" jsonb NOT NULL,
	"share_id" text,
	"public" boolean DEFAULT false NOT NULL,
	"hide_assets" boolean DEFAULT true NOT NULL,
	"hide_amounts" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_recaps_owner_date_uq" UNIQUE("caller_id","owner_address","ny_date")
);
--> statement-breakpoint
CREATE TABLE "verify_replays" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text,
	"asset_key" text NOT NULL,
	"playbook_id" text NOT NULL,
	"conditions_hash" text NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	"run_json" jsonb NOT NULL,
	"result_json" jsonb NOT NULL,
	"evaluator_id" text NOT NULL,
	"mode" text DEFAULT 'REPLAY' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_task_blockers" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"blockers_json" jsonb NOT NULL,
	"blocker_set_key" text NOT NULL,
	"next_check_at" timestamp with time zone,
	"evaluation_json" jsonb NOT NULL,
	"records_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "verify_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"playbook_id" text NOT NULL,
	"playbook_version" text NOT NULL,
	"params_json" jsonb NOT NULL,
	"goal_json" jsonb NOT NULL,
	"conditions_json" jsonb NOT NULL,
	"conditions_hash" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"mandate_ids" jsonb NOT NULL,
	"thesis_id" text,
	"budget_group_id" text,
	"blockers_json" jsonb NOT NULL,
	"next_check_at" timestamp with time zone,
	"last_evaluation_json" jsonb,
	"plan_id" text,
	"plan_json" jsonb,
	"mandate_draft_json" jsonb,
	"budget_allocation_json" jsonb,
	"timeline_json" jsonb NOT NULL,
	"exit_draft_json" jsonb,
	"steps_confirmed" integer DEFAULT 0 NOT NULL,
	"steps_planned" integer NOT NULL,
	"last_confirmed_step_at" timestamp with time zone,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_tasks_caller_req_uq" UNIQUE("caller_id","client_request_id")
);
--> statement-breakpoint
CREATE TABLE "verify_theses" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"goal" text NOT NULL,
	"rationale" text NOT NULL,
	"premises_json" jsonb NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"on_invalidation" text NOT NULL,
	"status" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_thesis_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"thesis_id" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"premises_json" jsonb NOT NULL,
	"action_taken" text,
	"evidence_ids" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verify_mandates" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "verify_mandates" ADD COLUMN "conditions_hash" text;--> statement-breakpoint
CREATE INDEX "verify_budget_allocations_group_idx" ON "verify_budget_allocations" USING btree ("group_id","state");--> statement-breakpoint
CREATE INDEX "verify_budget_allocations_mandate_idx" ON "verify_budget_allocations" USING btree ("mandate_id");--> statement-breakpoint
CREATE INDEX "verify_budget_groups_owner_idx" ON "verify_budget_groups" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "verify_budget_ledger_group_idx" ON "verify_budget_ledger" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "verify_context_snapshots_received_idx" ON "verify_context_snapshots" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "verify_context_snapshots_status_idx" ON "verify_context_snapshots" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "verify_cost_overrides_owner_idx" ON "verify_cost_overrides" USING btree ("owner_address","asset_key");--> statement-breakpoint
CREATE INDEX "verify_earnings_ingests_underlying_idx" ON "verify_earnings_ingests" USING btree ("underlying_id","received_at");--> statement-breakpoint
CREATE INDEX "verify_events_kind_date_idx" ON "verify_events" USING btree ("kind","date_local");--> statement-breakpoint
CREATE INDEX "verify_events_status_idx" ON "verify_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verify_executor_heartbeats_mandate_idx" ON "verify_executor_heartbeats" USING btree ("mandate_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "verify_missions_owner_idx" ON "verify_missions" USING btree ("owner_address","created_at");--> statement-breakpoint
CREATE INDEX "verify_notification_channels_owner_idx" ON "verify_notification_channels" USING btree ("owner_address","state");--> statement-breakpoint
CREATE INDEX "verify_notification_channels_link_idx" ON "verify_notification_channels" USING btree ("link_code");--> statement-breakpoint
CREATE INDEX "verify_notification_outbox_state_idx" ON "verify_notification_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "verify_notification_outbox_entity_idx" ON "verify_notification_outbox" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "verify_policy_comparisons_task_idx" ON "verify_policy_comparisons" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "verify_rebalance_legs_mandate_idx" ON "verify_rebalance_legs" USING btree ("mandate_id");--> statement-breakpoint
CREATE INDEX "verify_rebalance_plans_owner_idx" ON "verify_rebalance_plans" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "verify_recaps_share_idx" ON "verify_recaps" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "verify_replays_caller_idx" ON "verify_replays" USING btree ("caller_id","created_at");--> statement-breakpoint
CREATE INDEX "verify_task_blockers_task_idx" ON "verify_task_blockers" USING btree ("task_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "verify_tasks_owner_idx" ON "verify_tasks" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "verify_tasks_status_idx" ON "verify_tasks" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE INDEX "verify_theses_task_idx" ON "verify_theses" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "verify_theses_owner_idx" ON "verify_theses" USING btree ("owner_address");--> statement-breakpoint
CREATE INDEX "verify_thesis_checks_thesis_idx" ON "verify_thesis_checks" USING btree ("thesis_id","checked_at");--> statement-breakpoint
CREATE INDEX "verify_mandates_task_idx" ON "verify_mandates" USING btree ("task_id");