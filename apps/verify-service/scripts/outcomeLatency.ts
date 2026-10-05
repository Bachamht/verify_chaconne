/**
 * v7 Lane D · D5：实际值时延（官方发布 → crowsnest fetchedAt → verify outcome_received_at → data_arrived 轮次 → 轮次开始）。
 * 只读本地 JSONL，不联网、不需要凭据。逻辑在 src/events/latency.ts（有单测）。
 *
 * 用法：
 *   pnpm --filter @chaconne/verify-service exec tsx scripts/outcomeLatency.ts \
 *     "../../.probes/2026-10-02_NFP/events.jsonl" "../../.probes/2026-10-02_NFP/context.jsonl" \
 *     [db-export.jsonl] [--event <eventId>]... [--json]
 *   db-export.jsonl 可选：服务器上
 *     psql -At -c "select row_to_json(t) from (select id, outcome_received_at, outcome_revision from verify_events where outcome_json is not null) t"
 *   的输出（给出精确的 outcome_received_at；没有时只能给轮询上界 / 下界）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeOutcomeLatency, latencyMarkdown, type LatencyLine } from "../src/events/latency";

const args = process.argv.slice(2);
const eventIds: string[] = [];
const files: string[] = [];
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--event") eventIds.push(args[++i] ?? "");
  else if (a === "--json") json = true;
  else files.push(a);
}
if (files.length === 0) {
  console.error("用法：tsx scripts/outcomeLatency.ts <file.jsonl>... [--event <id>]... [--json]");
  process.exit(2);
}
const lines: LatencyLine[] = files.flatMap((f) =>
  readFileSync(resolve(f), "utf8")
    .split("\n")
    .map((text, i) => ({ file: f, lineNo: i + 1, text })),
);
const rows = computeOutcomeLatency(lines, eventIds.length ? { eventIds } : {});
if (json) console.info(JSON.stringify(rows, null, 2));
else {
  console.info(latencyMarkdown(rows));
  if (rows.length === 0) console.info("\n（没有找到带到达信号的 MACRO_TIER1 事件；可用 --event 指定 id）");
}
