/** v7 MCP 工具（interfaces §12.10）：7 个新工具、submit_trade_intent / report_agent_status / add_thesis_review_item / execute_trade_intent 的 v7 字段，VerifyClient 的 x-agent-run-token */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVerifyMcpServer, TOOL_NAMES } from "../src/server";
import { VerifyClient } from "../src/client";
import { TOOL_NAMES_V7 } from "../src/toolsV7";

const STOCK = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: unknown }> = [];
let server: Server;
let url = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      const u = req.url!;
      if (u.endsWith("/agent-context")) return send(200, { turn: { version: 4, reason: "data_arrived", blockers: [] }, session: { label: "US_REGULAR" }, budget: { buyRemainingRaw: "40000000", buyStepsLeft: 3 }, evidence: [{ evidenceId: "ev_1" }] });
      if (u.endsWith("/quotes")) return send(200, { items: [{ side: "buy", amountInRaw: "5000000", executableUsdPerShare: "230.1", priceImpactBps: 12, verdict: "ELIGIBLE", cached: false }], quotaRemaining: 19 });
      if (u.includes("/activity")) return send(200, { items: [{}, {}], nextCursor: "c2" });
      if (u.endsWith("/positions")) return send(404, { error: "not_found" });
      if (u.endsWith("/runs")) return send(200, { runs: [{}] });
      if (u.endsWith("/delegation")) return send(200, { complete: false, counts: { signaturesNeeded: 2, signaturesDone: 1 }, buyReady: false });
      if (u.endsWith("/memory")) return send(201, { duplicate: false, notes: 3 });
      if (u.endsWith("/intents") && req.method === "POST") return body?.clientRequestId === "dup" ? send(409, { error: "turn_already_answered", message: "turn 4 already has a terminal action", details: { recordedAction: { kind: "status", status: "declined" } } }) : send(201, { intent: { id: "int_1", status: "simulated", checks: [] }, taskStatus: "ACTIVE" });
      if (u.endsWith("/agent-status")) return send(200, { agentTurn: { version: 4 }, task: { status: "ACTIVE" } });
      if (u.includes("/review-items")) return send(201, { id: "ths_1" });
      if (u.includes("/intents/int_h?step=1")) return send(409, { error: "platform_executes", message: "platform executes" });
      send(404, { error: "not_found" });
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function connect(runToken?: string | null) {
  const client = new VerifyClient({ baseUrl: url, apiKey: "svc-key", payer: null, runToken });
  const s = createVerifyMcpServer({ client, wallet: null, heartbeat: null });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  const c = new Client({ name: "v7", version: "0" });
  await c.connect(ct);
  return { c, close: async () => { await c.close(); await s.close(); } };
}
const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, unknown>;
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

describe("v7 工具", () => {
  it("56 个工具；7 个新工具都在", async () => {
    const { c, close } = await connect(null);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names.length).toBe(56);
    expect(TOOL_NAMES.length).toBe(56);
    for (const n of TOOL_NAMES_V7) expect(names).toContain(n);
    await close();
  });
  it("VERIFY_RUN_TOKEN：设置后每个带鉴权的请求都附 x-agent-run-token；未设置则不附", async () => {
    const a = await connect("rt1.run_abc.1.deadbeef");
    await a.c.callTool({ name: "get_turn_context", arguments: { taskId: "tsk_1" } });
    expect(seen.at(-1)!.headers["x-agent-run-token"]).toBe("rt1.run_abc.1.deadbeef");
    await a.close();
    const b = await connect(null);
    await b.c.callTool({ name: "get_turn_context", arguments: { taskId: "tsk_1" } });
    expect(seen.at(-1)!.headers["x-agent-run-token"]).toBeUndefined();
    await b.close();
  });
  it("新工具的路径与摘要；未部署的端点 → not_available", async () => {
    const { c, close } = await connect("t");
    expect(text(await c.callTool({ name: "get_turn_context", arguments: { taskId: "tsk_1" } }))).toMatch(/turn 4 \(data_arrived\)/);
    const q = await c.callTool({ name: "get_executable_quotes", arguments: { taskId: "tsk_1", items: [{ side: "buy", assetKey: STOCK, amountInRaw: "5000000" }] } });
    expect(text(q)).toMatch(/230.1/);
    expect(seen.at(-1)!.body).toEqual({ items: [{ side: "buy", assetKey: STOCK, amountInRaw: "5000000" }] });
    expect(text(await c.callTool({ name: "get_task_activity", arguments: { taskId: "tsk_1", since: "c1" } }))).toMatch(/2 activity/);
    expect(seen.at(-1)!.url).toBe("/v1/tasks/tsk_1/activity?since=c1");
    expect(sc(await c.callTool({ name: "get_task_positions", arguments: { taskId: "tsk_1" } }))["status"]).toBe("not_available");
    expect(text(await c.callTool({ name: "get_task_runs", arguments: { taskId: "tsk_1" } }))).toMatch(/1 run/);
    expect(text(await c.callTool({ name: "get_delegation_status", arguments: { taskId: "tsk_1" } }))).toMatch(/1\/2 signatures/);
    expect(text(await c.callTool({ name: "remember_note", arguments: { taskId: "tsk_1", text: "payrolls due 12:30 UTC", clientRequestId: "h:run_1:3" } }))).toMatch(/note recorded/);
    await close();
  });
  it("submit_trade_intent 带 turnVersion / nextCheckAt / 卖出 assetKey；409 turn_already_answered 原样带回；report_agent_status / add_thesis_review_item 带 v7 字段", async () => {
    const { c, close } = await connect("t");
    await c.callTool({ name: "submit_trade_intent", arguments: { taskId: "tsk_1", clientRequestId: "h:r:1", kind: "sell", assetKey: STOCK, amountInRaw: "10", decision: { rationale: "trim" }, turnVersion: 4, nextCheckAt: "2026-10-02T14:00:00Z" } });
    expect(seen.at(-1)!.body).toMatchObject({ kind: "sell", assetKey: STOCK, turnVersion: 4, nextCheckAt: "2026-10-02T14:00:00Z" });
    const noAsset = await c.callTool({ name: "submit_trade_intent", arguments: { taskId: "tsk_1", clientRequestId: "x", kind: "sell", amountInRaw: "10", decision: { rationale: "x" } } });
    expect(noAsset.isError).toBe(true);
    const dup = await c.callTool({ name: "submit_trade_intent", arguments: { taskId: "tsk_1", clientRequestId: "dup", outputAssetKey: STOCK, amountInRaw: "10", decision: { rationale: "x" } } });
    expect(dup.isError).toBe(true);
    expect(sc(dup)["error"]).toBe("turn_already_answered");
    await c.callTool({ name: "report_agent_status", arguments: { taskId: "tsk_1", status: "declined", note: "wait", turnVersion: 4, clientRequestId: "h:r:2", nextCheckAt: "2026-10-02T14:00:00Z", invalidation: "spread tightens" } });
    expect(seen.at(-1)!.body).toMatchObject({ turnVersion: 4, clientRequestId: "h:r:2", nextCheckAt: "2026-10-02T14:00:00Z", invalidation: "spread tightens" });
    await c.callTool({ name: "add_thesis_review_item", arguments: { thesisId: "ths_1", premiseId: "p1", side: "support", text: "BLS release", sourceUrl: "https://www.bls.gov/", clientRequestId: "h:r:3" } });
    expect(seen.at(-1)!.body).toMatchObject({ clientRequestId: "h:r:3", addedBy: "agent" });
    const desc = (await c.listTools()).tools.find((t) => t.name === "report_agent_status")!.description!;
    expect(desc).toMatch(/paused_by=agent/);
    expect(desc).toMatch(/NOT marked completed/);
    await close();
  });
  it("execute_trade_intent：托管执行任务 → not_applicable（platform executes），不要求钱包", async () => {
    const { c, close } = await connect("t");
    const r = await c.callTool({ name: "execute_trade_intent", arguments: { taskId: "tsk_1", intentId: "int_h" } });
    expect(r.isError).toBeFalsy();
    expect(sc(r)).toMatchObject({ status: "not_applicable", reason: "platform executes" });
    await close();
  });
});
