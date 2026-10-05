-- v7 费用预算（运营者确认 2026-10-02 14:00，D-089 修订：主要保护是费用而不是笔数）。
-- verify_fee_ledger：执行身份每一笔广播的 OKB 费用。发送提交点（CLAIMED → SENDING）按 gasLimit × maxFeePerGas 预留（RESERVED），
-- 回执到达按 gasUsed × effectiveGasPrice + l1Fee 结算（SETTLED）；广播后结果不明（EXPIRED / FAILED）继续按预留额计入（HELD）。
-- verify_permits.submitted_at：permit 代付限频按提交时刻计数（不再用会随状态变化的 updated_at）。
-- 只加表加列；无需回退（回滚 = 关开关）。
CREATE TABLE "verify_fee_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"task_id" text,
	"owner_address" text NOT NULL,
	"mandate_id" text,
	"step_index" integer,
	"executor" text,
	"day" text NOT NULL,
	"state" text NOT NULL,
	"reserved_wei" numeric(78, 0) NOT NULL,
	"actual_wei" numeric(78, 0),
	"reserve_basis" text NOT NULL,
	"gas_limit" text,
	"max_fee_per_gas" text,
	"raw_tx_hash" text,
	"tx_hash" text,
	"gas_used" text,
	"effective_gas_price" text,
	"l1_fee" text,
	"outcome" text,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verify_fee_ledger_job_uq" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE INDEX "verify_fee_ledger_owner_day_idx" ON "verify_fee_ledger" USING btree ("owner_address","day");--> statement-breakpoint
CREATE INDEX "verify_fee_ledger_task_idx" ON "verify_fee_ledger" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "verify_fee_ledger_day_idx" ON "verify_fee_ledger" USING btree ("day");--> statement-breakpoint
CREATE INDEX "verify_fee_ledger_state_idx" ON "verify_fee_ledger" USING btree ("state");--> statement-breakpoint
ALTER TABLE "verify_permits" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "verify_permits" SET "submitted_at" = "updated_at" WHERE "signature" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "verify_permits_submitted_idx" ON "verify_permits" USING btree ("owner_address","submitted_at");
