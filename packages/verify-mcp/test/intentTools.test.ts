/** CV-D16 批次 4：submit_trade_intent / get_task_intents / withdraw_trade_intent / report_agent_status / execute_trade_intent（假服务） */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVerifyMcpServer } from "../src/server";
import { VerifyClient } from "../src/client";
import { startFakeService } from "../../verify-sdk/test/fakeService";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STOCK = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
let svc: Awaited<ReturnType<typeof startFakeService>>;
beforeAll(async () => { svc = await startFakeService(); });
afterAll(async () => { await svc.close(); });

async function connect(url: string) {
  const client = new VerifyClient({ baseUrl: url, apiKey: "k", caller: OWNER, payer: null });
  const server = createVerifyMcpServer({ client, wallet: null, chainId: 196, heartbeat: null });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "ti", version: "0" });
  await c.connect(ct);
  return { client: c, close: async () => { await c.close(); await server.close(); } };
}
const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, unknown>;
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;
const decision = { rationale: "regular session, low premium", claims: [{ kind: "agent_data", text: "other feed premium 0.2%", source: { name: "feed" } }] };

describe("意图工具", () => {
  it("submit → certified（摘要说明签证书 ≠ 发交易）；agent_research 在 platform_only 下 → 422 但 isError=false 且记录在案；list / get(withStep) / withdraw；report_agent_status 四种；execute 无钱包拒绝", async () => {
    const { client, close } = await connect(svc.url);
    await client.callTool({ name: "create_task", arguments: { clientRequestId: "i1", ownerAddress: OWNER, playbookId: "session_dca", params: { steps: 2, perStepAmountRaw: "5000000" }, conditions: { version: "conditions/1", items: [{ type: "min_gap_trading_days", days: 1 }] }, mode: "LIVE", scope: { issuance: "agent", trustTier: "agent_data" } } });
    const ok = await client.callTool({ name: "submit_trade_intent", arguments: { taskId: "tsk_i1", clientRequestId: "c1", outputAssetKey: STOCK, amountInRaw: "5000000", decision } });
    expect(ok.isError).toBeFalsy();
    expect(sc(ok)["httpStatus"]).toBe(201);
    expect(sc(ok)["status"]).toBe("READY");
    expect(text(ok)).toMatch(/certified/);
    expect(text(ok)).toMatch(/not sending a transaction/);
    const rejected = await client.callTool({ name: "submit_trade_intent", arguments: { taskId: "tsk_i1", clientRequestId: "c2", outputAssetKey: STOCK, amountInRaw: "5000000", decision: { rationale: "gut feeling", claims: [{ kind: "agent_research", text: "will go up" }] } } });
    expect(rejected.isError).toBeFalsy();
    expect(sc(rejected)["httpStatus"]).toBe(422);
    expect(text(rejected)).toMatch(/rejected/);
    expect(text(rejected)).toMatch(/facts\(DECISION_BASIS_NOT_ADMISSIBLE\)/);
    const list = await client.callTool({ name: "get_task_intents", arguments: { taskId: "tsk_i1" } });
    expect(text(list)).toMatch(/2 intent\(s\)/);
    const one = await client.callTool({ name: "get_task_intents", arguments: { taskId: "tsk_i1", intentId: "int_c1", withStep: true } });
    expect(text(one)).toMatch(/READY body attached/);
    const noWallet = await client.callTool({ name: "execute_trade_intent", arguments: { taskId: "tsk_i1", intentId: "int_c1" } });
    expect(noWallet.isError).toBe(true);
    expect(sc(noWallet)["error"]).toBe("agent_wallet_disabled");
    const w = await client.callTool({ name: "withdraw_trade_intent", arguments: { taskId: "tsk_i1", intentId: "int_c1" } });
    expect(w.isError).toBeFalsy();
    expect(text(w)).toMatch(/withdrawn; pending certificate voided/);
    const noName = await client.callTool({ name: "report_agent_status", arguments: { taskId: "tsk_i1", status: "accepted", note: "taking over" } });
    expect(noName.isError).toBe(true);
    const acc = await client.callTool({ name: "report_agent_status", arguments: { taskId: "tsk_i1", status: "accepted", note: "taking over", agent: { name: "demo-agent" }, plan: { text: "research CPI first" } } });
    expect(acc.isError).toBeFalsy();
    expect(text(acc)).toMatch(/agent accepted recorded/);
    const goal = await client.callTool({ name: "create_task", arguments: { clientRequestId: "g1", ownerAddress: OWNER, mode: "SIMULATION", strategy: "own strategy", scope: { objective: "add on dips", outputAssetKeys: [STOCK], budgetCapRaw: "10000000", perStepCapRaw: "2000000" } } });
    expect(goal.isError).toBeFalsy();
    const ne = await client.callTool({ name: "report_agent_status", arguments: { taskId: "tsk_i1", status: "needs_evidence", note: "want earnings coverage", requestedEvidence: ["earnings coverage"] } });
    expect(ne.isError).toBeFalsy();
    expect(text(ne)).toMatch(/agent needs_evidence recorded/);
    const locked = await client.callTool({ name: "report_agent_status", arguments: { taskId: "tsk_i1", status: "plan_revised", note: "x", plan: { conditions: [{ type: "session", allow: ["US_REGULAR", "US_POST"] }] } } });
    expect(locked.isError).toBe(true);
    expect(sc(locked)["error"]).toBe("scope_locked");
    const ended = await client.callTool({ name: "report_agent_status", arguments: { taskId: "tsk_i1", status: "ended", note: "done" } });
    expect(text(ended)).toMatch(/task PAUSED/);
    await close();
  });
});
