/**
 * Lane D 测试用 DDL：与 packages/db/src/schema.ts「v6 Lane D」块一致。
 * 迁移 0018 由 Lane C 统一生成（多 lane 同时出迁移会撞号），测试里先用 IF NOT EXISTS 建表跑 Drizzle 存储用例。
 * **不在运行时执行**（会让 0018 的 CREATE TABLE 失败）。
 */
import { sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";

export const LANE_D_DDL = `
CREATE TABLE IF NOT EXISTS verify_events (
  id text PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  underlying_ids jsonb NOT NULL,
  scheduled_at_utc timestamptz,
  date_local text NOT NULL,
  date_precision text NOT NULL,
  session_hint text,
  status text NOT NULL,
  revision integer NOT NULL,
  revised_from jsonb,
  source text NOT NULL,
  source_fetched_at timestamptz NOT NULL,
  first_known_at timestamptz NOT NULL,
  released_at timestamptz,
  tz text NOT NULL,
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS verify_events_kind_date_idx ON verify_events (kind, date_local);
CREATE INDEX IF NOT EXISTS verify_events_status_idx ON verify_events (status);
CREATE TABLE IF NOT EXISTS verify_event_revisions (
  id serial PRIMARY KEY,
  event_id text NOT NULL,
  revision integer NOT NULL,
  event_json jsonb NOT NULL,
  changed_fields jsonb NOT NULL,
  changed_at timestamptz NOT NULL,
  CONSTRAINT verify_event_revisions_uq UNIQUE (event_id, revision)
);
CREATE TABLE IF NOT EXISTS verify_earnings_ingests (
  id text PRIMARY KEY,
  source text NOT NULL,
  symbol text NOT NULL,
  underlying_id text NOT NULL,
  http_status integer NOT NULL,
  ok boolean NOT NULL,
  row_count integer NOT NULL,
  raw_hash text NOT NULL,
  requested_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  from_date text NOT NULL,
  to_date text NOT NULL,
  event_ids jsonb NOT NULL,
  evidence_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS verify_earnings_ingests_underlying_idx ON verify_earnings_ingests (underlying_id, received_at);
CREATE TABLE IF NOT EXISTS verify_earnings_periods (
  match_key text PRIMARY KEY,
  event_id text NOT NULL,
  created_at timestamptz NOT NULL
);
`;

export async function ensureLaneDTables(db: Db): Promise<void> {
  for (const stmt of LANE_D_DDL.split(";").map((s) => s.trim()).filter(Boolean)) await db.execute(sql.raw(stmt));
}
