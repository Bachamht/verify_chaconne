/** C5 Missions：事件 × 资产覆盖 → 事件任务；无事件/事件源未接上 → 标注日期的回放任务（不伪装实时） */
import { afterEach, describe, expect, it } from "vitest";
import type { MarketEvent } from "@chaconne/core/verify";
import { buildMissions } from "../src/missions/build";
import { api, createTestEnv, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const NOW = new Date("2026-09-18T15:00:00Z");
const ASSETS = [
  { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", displaySymbol: "AAPLx", underlyingId: "us-stock:AAPL", executionAllowed: true },
  { assetKey: "eip155:196:0x0d3db2d6a4ca2c2b6a2ae9d4e2c3f7e6a1b2c3d4", displaySymbol: "NVDAx", underlyingId: "us-stock:NVDA", executionAllowed: true },
  { assetKey: "eip155:196:0x00000000000000000000000000000000000000ee", displaySymbol: "NKEx", underlyingId: "us-stock:NKE", executionAllowed: false },
];
const earnings: MarketEvent = { id: "finnhub:EARNINGS:2026-09-24:nvda", kind: "EARNINGS", name: "NVDA earnings", underlyingIds: ["us-stock:NVDA"], scheduledAtUtc: null, dateLocal: "2026-09-24", datePrecision: "day", sessionHint: "amc", status: "estimated", revision: 1, source: "finnhub", sourceFetchedAt: "2026-09-18T00:00:00Z", firstKnownAt: "2026-09-10T00:00:00Z", tz: "America/New_York" };
const cpi: MarketEvent = { id: "crowsnest:MACRO_TIER1:2026-09-22:cpi", kind: "MACRO_TIER1", name: "CPI", underlyingIds: [], scheduledAtUtc: "2026-09-22T12:30:00Z", dateLocal: "2026-09-22", datePrecision: "exact", sessionHint: null, status: "confirmed", revision: 1, source: "crowsnest", sourceFetchedAt: "2026-09-18T00:00:00Z", firstKnownAt: "2026-09-01T00:00:00Z", tz: "America/New_York" };
const nke: MarketEvent = { ...earnings, id: "finnhub:EARNINGS:2026-09-25:nke", underlyingIds: ["us-stock:NKE"], dateLocal: "2026-09-25" };
const FUNDING = { inputAssetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", perStepAmountRaw: "1000000", displaySymbol: "USDG" };

describe("buildMissions", () => {
  it("财报事件命中可执行资产 → event_aware_accumulate 草案（earnings_window + avoid_event_window）；未放行资产不出任务；宏观 → 对照任务", () => {
    const out = buildMissions({ now: NOW, events: [earnings, cpi, nke], assets: ASSETS, funding: FUNDING });
    const e = out.find((m) => m.eventId === earnings.id)!;
    expect(e).toBeTruthy();
    expect(e.assetKey).toBe(ASSETS[1]!.assetKey);
    expect(e.mode).toBe("SIMULATION");
    expect(e.dateLabel).toBe("2026-09-24");
    expect(e.eventStatus).toBe("estimated");
    expect(e.draft.playbookId).toBe("event_aware_accumulate");
    expect(e.draft.conditions.items.map((c) => c.type)).toEqual(["session", "avoid_event_window", "earnings_window"]);
    expect(e.draft.conditions.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.some((m) => m.eventId === nke.id)).toBe(false);
    const c = out.find((m) => m.eventId === cpi.id)!;
    expect(c.title.zh).toContain("模拟");
    expect(c.draft.mode).toBe("SIMULATION");
    // V-25：草案 = 可直接提交的任务体（资金侧缺省、clientRequestId、无 from/to）
    expect(e.draft.params).toEqual({ inputAssetKey: FUNDING.inputAssetKey, outputAssetKey: ASSETS[1]!.assetKey, steps: 3, perStepAmountRaw: "1000000" });
    expect(e.draft.clientRequestId).toMatch(/^draft-msn_/);
    expect(e.replay).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/will rise|will fall|涨|跌/);
  });

  it("无事件 / 事件源未接上 → 标注日期的回放任务（上一交易日），标 REPLAY，文案说明缺口如实", () => {
    const none = buildMissions({ now: NOW, events: [], assets: ASSETS, funding: FUNDING, owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(none).toHaveLength(1);
    expect(none[0]!.kind).toBe("replay");
    expect(none[0]!.mode).toBe("REPLAY");
    // 回放区间在 replay 字段；草案本身是 SIMULATION，params 不含 from/to（V-25）
    expect(none[0]!.draft.mode).toBe("SIMULATION");
    expect(none[0]!.draft.ownerAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(Object.keys(none[0]!.draft.params).sort()).toEqual(["inputAssetKey", "outputAssetKey", "perStepAmountRaw", "steps"]);
    expect(none[0]!.replay).toEqual({ assetKey: ASSETS[0]!.assetKey, from: "2026-09-17T00:00:00Z", to: "2026-09-17T23:59:59Z", url: none[0]!.href });
    expect(none[0]!.dateLabel).toBe("2026-09-17");
    expect(none[0]!.title.en).toContain("2026-09-17");
    const unavailable = buildMissions({ now: NOW, events: null, assets: ASSETS, focus: [ASSETS[1]!.assetKey], funding: FUNDING });
    expect(unavailable[0]!.why.zh).toContain("暂不可用");
    expect(unavailable[0]!.assetKey).toBe(ASSETS[1]!.assetKey);
    // 跨周末：周一看周五
    expect(buildMissions({ now: new Date("2026-09-21T10:00:00Z"), events: [], assets: ASSETS, funding: FUNDING })[0]!.dateLabel).toBe("2026-09-18");
  });
});

describe("GET /v1/missions", () => {
  it("事件钩子未接上 → eventsCoverage=unavailable + 回放任务", async () => {
    env = await createTestEnv();
    const r = await api(env, "GET", "/v1/missions");
    expect(r.status).toBe(200);
    expect(r.json["eventsCoverage"]).toBe("unavailable");
    expect((r.json["missions"] as Array<{ mode: string }>)[0]!.mode).toBe("REPLAY");
  });

  it("事件钩子接上 → 事件任务", async () => {
    env = await createTestEnv({ agentHooks: { events: async () => [{ ...earnings, underlyingIds: [], kind: "MACRO_TIER1", name: "FOMC", id: "crowsnest:MACRO_TIER1:2026-09-18:fomc", dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T18:00:00Z", datePrecision: "exact" }] } });
    const r2 = await api(env, "GET", "/v1/missions");
    expect(r2.json["eventsCoverage"]).toBe("ok");
    expect((r2.json["missions"] as Array<{ kind: string; eventId: string }>)[0]).toMatchObject({ kind: "event", eventId: "crowsnest:MACRO_TIER1:2026-09-18:fomc" });
  });
});
