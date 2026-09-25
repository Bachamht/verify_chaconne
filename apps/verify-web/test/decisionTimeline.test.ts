import { describe, expect, it } from "vitest";
import type { AgentTradeIntent } from "@/lib/api-v2";
import { bucketLabel, claimLines, decisionEntries, entryLabel, intentStatusLabel, turnStateLabel } from "../components/agent/tasks/decisionTimelineLabels";

const intent: AgentTradeIntent = {
  id: "int_1", taskId: "tsk_1", clientRequestId: "c", kind: "buy", outputAssetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", amountInRaw: "1000000",
  decision: { rationale: "r", claims: [{ kind: "platform_fact", text: "VIX 低", source: { evidenceId: "ev_1" } }, { kind: "agent_data", text: "溢价 0.2%", source: { name: "feed" } }, { kind: "agent_research", text: "会涨" }] },
  triage: [{ index: 0, kind: "platform_fact", admissible: true, verified: true, label: "platform_verified" }, { index: 1, kind: "agent_data", admissible: true, verified: false, label: "agent_provided_unverified" }, { index: 2, kind: "agent_research", admissible: false, verified: null, label: "not_admissible" }],
  checks: [], status: "rejected", step: null, planDeviations: [], createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:00:00.000Z",
};

describe("决策时间线纯函数", () => {
  it("依据分三桶：我们核验的 / agent 提供的 / 不采信；来源取 evidenceId > url > name", () => {
    const lines = claimLines(intent);
    expect(lines.map((l) => l.bucket)).toEqual(["verified", "agent", "inadmissible"]);
    expect(lines.map((l) => l.source)).toEqual(["ev_1", "feed", null]);
    expect(bucketLabel("verified", "zh")).toBe("我们核验过");
    expect(bucketLabel("agent", "en")).toMatch(/unverified/);
    expect(bucketLabel("inadmissible", "zh")).toMatch(/不采信/);
  });
  it("时间线只留决策相关条目并按时间正序；文案映射", () => {
    const entries = decisionEntries([{ at: "2026-09-25T10:02:00Z", type: "intent_certified", note: "x" }, { at: "2026-09-25T10:00:00Z", type: "status", from: "ACTIVE", to: "WAITING" }, { at: "2026-09-25T10:01:00Z", type: "agent_turn", note: "y" }]);
    expect(entries.map((e) => e.type)).toEqual(["agent_turn", "intent_certified"]);
    expect(entryLabel("agent_no_response", "zh")).toBe("agent 未回应");
    expect(intentStatusLabel("certified", "en")).toBe("certified");
    expect(turnStateLabel("needs_evidence", "zh")).toBe("agent 要更多证据");
  });
});
