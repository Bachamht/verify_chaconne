/** R-01 · Crew 台词只引用真实输出字段：模板变量 ⊆ 各角色声明的响应字段；字段缺失整句不出；真实响应样本渲染不含占位。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIELDS, LINES, linesFor, renderLine, templateVars } from "../components/agent/crew/lines";

/** 响应字段来源：core contracts v6 段（Task / MarketContext / MarketEvent / EventImpact / PolicyComparison）与 api-v2 v6 段（RecapView） */
const CONTRACT_KEYS: Record<string, string[]> = {
  "context": ["session", "events", "fed", "rates", "risk", "crossAsset", "driftVerdict", "packagedAt", "provenance", "schemaVersion", "producer"],
  "context.session": ["label", "usTradingDay", "holiday", "earlyClose", "hoursToUsOpen", "hoursToUsClose", "etDate"],
  "context.session.label": ["value", "source", "observedAt", "fetchedAt", "status", "purposes", "note"],
  "context.provenance": ["mode"],
  "nextEvent": ["id", "kind", "name", "underlyingIds", "scheduledAtUtc", "dateLocal", "datePrecision", "sessionHint", "status", "revision", "source", "sourceFetchedAt", "firstKnownAt", "tz"],
  "task": ["id", "owner", "playbookId", "goal", "conditions", "mandateIds", "thesisId", "budgetGroupId", "status", "blockers", "nextCheckAt", "executorPresence", "createdAt", "updatedAt"],
  "task.conditions": ["version", "items", "hash"],
  "comparison": ["id", "taskId", "evidenceSnapshotId", "variants", "diff", "mode"],
  "step": ["stepIndex", "state", "step", "stepDigest", "validUntil", "txHash", "receipt"],
  "mandate": ["mandateId", "state", "spent", "stepsDone", "maxSteps", "budgetCap", "perStepCap"],
  "bundle": ["schemaVersion", "kind", "id", "bundleHash"],
  "verify": ["ok", "passed", "total", "checks", "failedLayers"],
  "recap": ["id", "owner", "date", "modes", "sections", "ledger", "timeline", "milestones", "remixable", "share"],
  "recap.sections": ["handled", "waited", "trades", "remaining", "decisions"],
};
function pathOk(path: string): boolean {
  const segs = path.split(".");
  const last = segs[segs.length - 1]!;
  const parent = segs.slice(0, -1).join(".");
  if (last === "length") return pathOk(parent) || ["impacts", "events"].includes(parent);
  const keys = CONTRACT_KEYS[parent];
  return !!keys && keys.includes(last);
}

describe("R-01 · 台词模板变量必须来自响应字段", () => {
  it("每个模板的变量都在 FIELDS[role] 内，且每个 FIELDS 路径都能在契约键里找到", () => {
    for (const t of LINES) {
      for (const v of templateVars(t)) {
        expect(FIELDS[t.role], `${t.role}/${t.id}: {${v}}`).toContain(v);
      }
    }
    for (const [role, paths] of Object.entries(FIELDS)) for (const p of paths) expect(pathOk(p), `${role}: ${p}`).toBe(true);
  });

  it("字段缺失 → 整句不出（null），不补占位；字段齐 → 原样引用", () => {
    const scoutSession = LINES.find((l) => l.id === "session")!;
    expect(renderLine(scoutSession, {}, "zh")).toBeNull();
    expect(renderLine(scoutSession, { context: { session: { label: { value: "US_REGULAR" } } } }, "zh")).toBeNull(); // status / packagedAt 缺
    const full = { context: { session: { label: { value: "US_REGULAR", status: "ok" } }, packagedAt: "2026-09-23T10:00:00.000Z" } };
    expect(renderLine(scoutSession, full, "en")).toBe("Session is US_REGULAR (ok), packaged 2026-09-23 10:00:00Z.");
    const planner = LINES.find((l) => l.id === "task")!;
    expect(renderLine(planner, { task: { id: "tsk_1", playbookId: "session_dca", status: "WAITING", blockers: [{}, {}], nextCheckAt: "2026-09-24T13:30:00Z" } }, "zh")).toBe("任务 tsk_1（session_dca）状态 WAITING，2 个阻塞项；下次检查 2026-09-24 13:30:00Z。");
    expect(renderLine(planner, { task: { id: "tsk_1", playbookId: "session_dca", status: "WAITING", blockers: [], nextCheckAt: null } }, "zh")).toBeNull(); // nextCheckAt 未知不编
    expect(linesFor("auditor", {}, "en")).toEqual([]);
  });

  it("crowsnest 联调样本（provenance.mode=sample）渲染时把 sample 原样带出，不会写成 live", () => {
    const sample = JSON.parse(readFileSync(join(__dirname, "..", "components", "agent", "home", "sample_context.agent.json"), "utf8"));
    const lines = linesFor("scout", { context: sample }, "en");
    expect(lines.some((l) => l.includes("provenance: sample"))).toBe(true);
    expect(lines.some((l) => /provenance: live/.test(l))).toBe(false);
    // 数值 value 是十进制字符串（CV-D12），台词不经 Number() 改写
    expect(sample.rates.y10.value).toBe("4.96");
    expect(typeof sample.rates.y10.value).toBe("string");
  });
});
